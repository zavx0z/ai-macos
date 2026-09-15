#include "meta_observer_command.h"

#include <math.h>

#define META_OBSERVER_COMMAND_MAX_EVENTS 1000
#define META_OBSERVER_COMMAND_MAX_BYTES (1024 * 1024)

static BOOL dictionary(id value) {
  return [value isKindOfClass:NSDictionary.class];
}

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) {
    return NO;
  }
  NSString *text = value;
  unichar first = [text characterAtIndex:0];
  BOOL validFirst =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return validFirst &&
         [text rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static id immutable_json_copy(id value) {
  if (value == nil) return nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  if (data == nil) return nil;
  return [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
}

static NSString *bounded_reason(NSString *reason) {
  if (![reason isKindOfClass:NSString.class] || reason.length == 0) {
    return @"Observer command failed";
  }
  return reason.length <= 1024 ? [reason copy]
                               : [reason substringToIndex:1024];
}

@interface MetaObserverPreparedIndex ()
- (instancetype)initWithIndex:(MetaObserverTargetIndex *)index
                   inventoryId:(NSString *)inventoryId
             inventoryRevision:(uint64_t)inventoryRevision
                  indexRevision:(uint64_t)indexRevision;
@end

@implementation MetaObserverPreparedIndex

- (instancetype)initWithIndex:(MetaObserverTargetIndex *)index
                   inventoryId:(NSString *)inventoryId
             inventoryRevision:(uint64_t)inventoryRevision
                  indexRevision:(uint64_t)indexRevision {
  self = [super init];
  if (self) {
    _index = index;
    _inventoryId = [inventoryId copy];
    _inventoryRevision = inventoryRevision;
    _indexRevision = indexRevision;
  }
  return self;
}

@end

MetaObserverPreparedIndex *meta_observer_prepared_index_create(
    MetaObserverTargetIndex *index,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t indexRevision) {
  if (![index isKindOfClass:MetaObserverTargetIndex.class] ||
      !identifier(inventoryId, 127) || indexRevision == 0 ||
      inventoryRevision > 9007199254740991ULL ||
      indexRevision > 9007199254740991ULL) {
    return nil;
  }
  return [[MetaObserverPreparedIndex alloc]
      initWithIndex:index
         inventoryId:inventoryId
   inventoryRevision:inventoryRevision
        indexRevision:indexRevision];
}

@interface MetaObserverCommandBinder ()
@property(nonatomic, readonly) NSDictionary *generation;
@property(nonatomic, readonly) NSString *nativeBuildId;
@property(nonatomic, copy) MetaObserverIndexBuilder indexBuilder;
@property(nonatomic, copy) MetaObserverMainExecutor mainExecutor;
@property(nonatomic, copy) MetaObserverFactory factory;
@property(nonatomic, copy) MetaObserverReadinessProvider readinessProvider;
@property(nonatomic, copy) MetaObserverInstanceIdProvider instanceIdProvider;
@end

@implementation MetaObserverCommandBinder {
  NSLock *_lock;
  MetaNativeObserver *_observer;
  MetaObserverPreparedIndex *_prepared;
  NSString *_observerInstanceRef;
  NSString *_acceptingInstanceRef;
  NSString *_baselineCursor;
  NSMutableArray<NSDictionary *> *_history;
  NSMutableArray<NSDictionary *> *_pushQueue;
  NSUInteger _historyBytes;
  NSUInteger _pushBytes;
  uint64_t _lastPushedSequence;
  BOOL _baselineAvailable;
  BOOL _pushActive;
  NSString *_gapReason;
}

- (instancetype)initWithGeneration:(NSDictionary *)generation
                      nativeBuildId:(NSString *)nativeBuildId
                        indexBuilder:(MetaObserverIndexBuilder)indexBuilder
                        mainExecutor:(MetaObserverMainExecutor)mainExecutor
                             factory:(MetaObserverFactory)factory
                   readinessProvider:(MetaObserverReadinessProvider)readinessProvider
                  instanceIdProvider:(MetaObserverInstanceIdProvider)instanceIdProvider {
  if (!dictionary(generation) ||
      !identifier(generation[@"runtimeEpoch"], 64) ||
      !identifier(generation[@"loginSessionId"], 64) ||
      !identifier(generation[@"nativeGeneration"], 64) ||
      !identifier(nativeBuildId, 127) || indexBuilder == nil ||
      mainExecutor == nil || factory == nil || readinessProvider == nil ||
      instanceIdProvider == nil) {
    return nil;
  }
  self = [super init];
  if (self) {
    _generation = immutable_json_copy(generation);
    _nativeBuildId = [nativeBuildId copy];
    _indexBuilder = [indexBuilder copy];
    _mainExecutor = [mainExecutor copy];
    _factory = [factory copy];
    _readinessProvider = [readinessProvider copy];
    _instanceIdProvider = [instanceIdProvider copy];
    _lock = [[NSLock alloc] init];
    _history = [NSMutableArray array];
    _pushQueue = [NSMutableArray array];
  }
  return self;
}

- (NSDictionary *)handleRequest:(NSDictionary *)request {
  if (![self validRequest:request]) {
    return [self failureResponse:request
                         command:[request[@"command"] isKindOfClass:NSString.class]
                                     ? request[@"command"]
                                     : @"coverage"
                            code:@"invalid-request"
                          reason:@"Malformed observer command"];
  }
  NSString *command = request[@"command"];
  if ([command isEqual:@"prepare"]) return [self prepare:request];
  if (![self matchesCurrentInstance:request[@"observerInstanceRef"]]) {
    return [self failureResponse:request
                         command:command
                            code:@"target-stale"
                          reason:@"Observer instance больше не является current"];
  }
  if ([command isEqual:@"coverage"]) {
    return [self successResponse:request
                         command:command
                        snapshot:[self currentSnapshot]
                          events:nil
                      fromCursor:nil];
  }
  if ([command isEqual:@"events"]) return [self backfill:request];
  if ([command isEqual:@"stop"]) return [self stop:request];
  return [self failureResponse:request
                       command:command
                          code:@"invalid-request"
                        reason:@"Unknown observer command"];
}

- (NSDictionary *)prepare:(NSDictionary *)request {
  NSString *previous = request[@"previousObserverInstanceRef"];
  [_lock lock];
  NSString *current = _observerInstanceRef;
  [_lock unlock];
  if ((current == nil && previous != nil) ||
      (current != nil && ![current isEqual:previous])) {
    return [self failureResponse:request
                         command:@"prepare"
                            code:@"target-stale"
                          reason:@"Prepare previous observer instance mismatch"];
  }
  MetaObserverPreparedIndex *prepared = self.indexBuilder();
  NSString *instance = self.instanceIdProvider();
  NSDictionary *readiness = self.readinessProvider();
  if (prepared == nil || !identifier(instance, 127) ||
      !dictionary(readiness)) {
    return [self failureResponse:request
                         command:@"prepare"
                            code:@"capability-unavailable"
                          reason:@"Observer index, identity или readiness недоступны"];
  }
  [_lock lock];
  [_history removeAllObjects];
  [_pushQueue removeAllObjects];
  _historyBytes = 0;
  _pushBytes = 0;
  _lastPushedSequence = 0;
  _baselineAvailable = YES;
  _pushActive = NO;
  _gapReason = nil;
  _acceptingInstanceRef = instance;
  [_lock unlock];

  __block MetaNativeObserver *created = nil;
  __weak MetaObserverCommandBinder *weakSelf = self;
  BOOL executed = self.mainExecutor(^BOOL {
    MetaObserverCommandBinder *binder = weakSelf;
    if (binder == nil) return NO;
    if (binder->_observer != nil) {
      [binder->_observer setEventSink:nil];
      [binder->_observer stop];
    }
    created = binder.factory(binder.generation, prepared.index);
    if (created == nil) return NO;
    [created recordCurrentSessionReadiness:readiness];
    [created start];
    [created takeEvents];
    binder->_baselineCursor = created.coverage[@"cursor"];
    [created setEventSink:^(NSDictionary *event) {
      [weakSelf acceptEvent:event observerInstanceRef:instance];
    }];
    return YES;
  });
  if (!executed || created == nil || !identifier(_baselineCursor, 127)) {
    [_lock lock];
    _acceptingInstanceRef = nil;
    _gapReason = @"Observer main-runloop prepare failed";
    [_lock unlock];
    return [self failureResponse:request
                         command:@"prepare"
                            code:@"capability-unavailable"
                          reason:@"Observer main-runloop prepare failed"];
  }
  [_lock lock];
  _observer = created;
  _prepared = prepared;
  _observerInstanceRef = instance;
  [_lock unlock];
  return [self successResponse:request
                       command:@"prepare"
                      snapshot:[self currentSnapshot]
                        events:nil
                    fromCursor:nil];
}

- (NSDictionary *)backfill:(NSDictionary *)request {
  NSString *after = request[@"afterCursor"];
  [_lock lock];
  NSInteger start = NSNotFound;
  if (_baselineAvailable && [after isEqual:_baselineCursor]) {
    start = 0;
  } else {
    for (NSUInteger index = 0; index < _history.count; index += 1) {
      if ([_history[index][@"cursor"] isEqual:after]) {
        start = (NSInteger)index + 1;
        break;
      }
    }
  }
  NSArray *events =
      start == NSNotFound ? nil
                          : [_history subarrayWithRange:NSMakeRange(
                                (NSUInteger)start, _history.count - (NSUInteger)start)];
  [_lock unlock];
  if (events == nil) {
    return [self failureResponse:request
                         command:@"events"
                            code:@"receipt-expired"
                          reason:@"Observer backfill cursor отсутствует в bounded history"];
  }
  return [self successResponse:request
                       command:@"events"
                      snapshot:[self currentSnapshot]
                        events:immutable_json_copy(events)
                    fromCursor:after];
}

- (NSDictionary *)stop:(NSDictionary *)request {
  __block NSDictionary *snapshot = nil;
  __weak MetaObserverCommandBinder *weakSelf = self;
  BOOL executed = self.mainExecutor(^BOOL {
    MetaObserverCommandBinder *binder = weakSelf;
    if (binder == nil || binder->_observer == nil) return NO;
    [binder->_observer setEventSink:nil];
    [binder->_observer stop];
    snapshot = [binder snapshotForObserver:binder->_observer
                                  prepared:binder->_prepared
                                instanceRef:binder->_observerInstanceRef];
    return YES;
  });
  if (!executed || snapshot == nil) {
    return [self failureResponse:request
                         command:@"stop"
                            code:@"internal-error"
                          reason:@"Observer stop не завершён на main runloop"];
  }
  [_lock lock];
  _observer = nil;
  _prepared = nil;
  _observerInstanceRef = nil;
  _acceptingInstanceRef = nil;
  _pushActive = NO;
  [_lock unlock];
  return [self successResponse:request
                       command:@"stop"
                      snapshot:snapshot
                        events:nil
                    fromCursor:nil];
}

- (BOOL)activatePushForObserverInstance:(NSString *)observerInstanceRef {
  [_lock lock];
  BOOL accepted = _gapReason == nil &&
                  [_observerInstanceRef isEqual:observerInstanceRef] &&
                  [_acceptingInstanceRef isEqual:observerInstanceRef];
  if (accepted) _pushActive = YES;
  [_lock unlock];
  return accepted;
}

- (NSDictionary *)takePushEnvelopes:(NSUInteger)maximum {
  if (maximum == 0 || maximum > META_OBSERVER_COMMAND_MAX_EVENTS) {
    return @{ @"events" : @[], @"gapReason" : @"Invalid PUSH batch limit" };
  }
  [_lock lock];
  if (_observer.coverage[@"gapDetected"] != nil &&
      [_observer.coverage[@"gapDetected"] boolValue] && _gapReason == nil) {
    _gapReason = bounded_reason(_observer.coverage[@"reason"]);
  }
  NSUInteger count = _pushActive ? MIN(maximum, _pushQueue.count) : 0;
  NSArray *events = count == 0
                        ? @[]
                        : [_pushQueue subarrayWithRange:NSMakeRange(0, count)];
  if (count > 0) {
    for (NSDictionary *envelope in events) {
      NSUInteger bytes =
          [NSJSONSerialization dataWithJSONObject:envelope
                                           options:0
                                             error:NULL]
              .length;
      _pushBytes = bytes > _pushBytes ? 0 : _pushBytes - bytes;
      NSNumber *sequence = envelope[@"event"][@"sequence"];
      if ([sequence isKindOfClass:NSNumber.class]) {
        _lastPushedSequence = MAX(_lastPushedSequence,
                                  sequence.unsignedLongLongValue);
      }
    }
    [_pushQueue removeObjectsInRange:NSMakeRange(0, count)];
  }
  NSString *gap = _gapReason;
  [_lock unlock];
  NSMutableDictionary *result =
      [@{ @"events" : immutable_json_copy(events) } mutableCopy];
  if (gap != nil) result[@"gapReason"] = gap;
  return result;
}

- (void)acceptEvent:(NSDictionary *)event
    observerInstanceRef:(NSString *)observerInstanceRef {
  NSDictionary *immutable = immutable_json_copy(event);
  NSUInteger bytes =
      [NSJSONSerialization dataWithJSONObject:immutable options:0 error:NULL]
          .length;
  [_lock lock];
  if (![_acceptingInstanceRef isEqual:observerInstanceRef] ||
      _gapReason != nil) {
    [_lock unlock];
    return;
  }
  NSDictionary *envelope = @{
    @"observerInstanceRef" : observerInstanceRef,
    @"runtimeEpoch" : self.generation[@"runtimeEpoch"],
    @"loginSessionId" : self.generation[@"loginSessionId"],
    @"nativeGeneration" : self.generation[@"nativeGeneration"],
    @"event" : immutable,
  };
  NSUInteger envelopeBytes =
      [NSJSONSerialization dataWithJSONObject:envelope options:0 error:NULL]
          .length;
  if (_pushQueue.count >= META_OBSERVER_COMMAND_MAX_EVENTS ||
      envelopeBytes > META_OBSERVER_COMMAND_MAX_BYTES - _pushBytes) {
    _gapReason = @"Observer command unsent PUSH overflow";
    [_observer markUnavailable:_gapReason];
    [_lock unlock];
    return;
  }
  while (_history.count >= META_OBSERVER_COMMAND_MAX_EVENTS ||
         bytes > META_OBSERVER_COMMAND_MAX_BYTES - _historyBytes) {
    NSDictionary *oldest = _history.firstObject;
    NSNumber *sequence = oldest[@"sequence"];
    if (![sequence isKindOfClass:NSNumber.class] ||
        sequence.unsignedLongLongValue > _lastPushedSequence) {
      _gapReason = @"Observer command undelivered history overflow";
      [_observer markUnavailable:_gapReason];
      [_lock unlock];
      return;
    }
    NSUInteger oldestBytes =
        [NSJSONSerialization dataWithJSONObject:oldest options:0 error:NULL]
            .length;
    [_history removeObjectAtIndex:0];
    _historyBytes = oldestBytes > _historyBytes ? 0
                                                : _historyBytes - oldestBytes;
    _baselineAvailable = NO;
  }
  [_history addObject:immutable];
  [_pushQueue addObject:envelope];
  _historyBytes += bytes;
  _pushBytes += envelopeBytes;
  [_lock unlock];
}

- (NSDictionary *)currentSnapshot {
  [_lock lock];
  MetaNativeObserver *observer = _observer;
  MetaObserverPreparedIndex *prepared = _prepared;
  NSString *instance = _observerInstanceRef;
  [_lock unlock];
  return [self snapshotForObserver:observer
                          prepared:prepared
                        instanceRef:instance];
}

- (NSDictionary *)snapshotForObserver:(MetaNativeObserver *)observer
                              prepared:(MetaObserverPreparedIndex *)prepared
                            instanceRef:(NSString *)instanceRef {
  if (observer == nil || prepared == nil || instanceRef == nil) return nil;
  NSDictionary *readiness = self.readinessProvider();
  if (!dictionary(readiness)) {
    readiness = @{
      @"state" : @"unknown",
      @"lockState" : @"unknown",
      @"secureInput" : @"unknown",
      @"evidence" : @"Session readiness provider unavailable",
      @"observedAt" : @"1970-01-01T00:00:00.000Z",
    };
  }
  NSMutableDictionary *session = [readiness mutableCopy];
  NSString *secureInput = session[@"secureInput"];
  [session removeObjectForKey:@"secureInput"];
  return @{
    @"observerInstanceRef" : instanceRef,
    @"inventoryId" : prepared.inventoryId,
    @"inventoryRevision" : @(prepared.inventoryRevision),
    @"indexRevision" : @(prepared.indexRevision),
    @"coverage" : observer.coverage,
    @"sessionReadiness" : immutable_json_copy(session),
    @"secureInput" : [secureInput isKindOfClass:NSString.class]
                           ? secureInput
                           : @"unknown",
  };
}

- (BOOL)matchesCurrentInstance:(NSString *)instance {
  [_lock lock];
  BOOL matches = instance != nil && [_observerInstanceRef isEqual:instance];
  [_lock unlock];
  return matches;
}

- (BOOL)validRequest:(NSDictionary *)request {
  if (!dictionary(request) || ![request[@"kind"] isEqual:@"observer"] ||
      ![request[@"protocolVersion"] isEqual:@"1"] ||
      !identifier(request[@"requestId"], 127) ||
      !identifier(request[@"runtimeEpoch"], 64) ||
      !identifier(request[@"loginSessionId"], 64) ||
      !identifier(request[@"nativeGeneration"], 64) ||
      ![request[@"runtimeEpoch"] isEqual:self.generation[@"runtimeEpoch"]] ||
      ![request[@"loginSessionId"]
          isEqual:self.generation[@"loginSessionId"]] ||
      ![request[@"nativeGeneration"]
          isEqual:self.generation[@"nativeGeneration"]] ||
      ![request[@"command"] isKindOfClass:NSString.class] ||
      ![request[@"deadlineAt"] isKindOfClass:NSString.class]) {
    return NO;
  }
  NSString *command = request[@"command"];
  if (![@[@"prepare", @"coverage", @"events", @"stop"]
          containsObject:command]) {
    return NO;
  }
  if ([command isEqual:@"prepare"]) {
    return request[@"observerInstanceRef"] == nil &&
           request[@"afterCursor"] == nil;
  }
  if (!identifier(request[@"observerInstanceRef"], 127) ||
      request[@"previousObserverInstanceRef"] != nil) {
    return NO;
  }
  return [command isEqual:@"events"]
             ? identifier(request[@"afterCursor"], 127)
             : request[@"afterCursor"] == nil;
}

- (NSDictionary *)successResponse:(NSDictionary *)request
                           command:(NSString *)command
                          snapshot:(NSDictionary *)snapshot
                            events:(NSArray *)events
                        fromCursor:(NSString *)fromCursor {
  NSMutableDictionary *response = [[self responseBase:request
                                              command:command]
      mutableCopy];
  response[@"ok"] = @YES;
  response[@"snapshot"] = snapshot;
  if (events != nil) response[@"events"] = events;
  if (fromCursor != nil) response[@"fromCursor"] = fromCursor;
  return response;
}

- (NSDictionary *)failureResponse:(NSDictionary *)request
                           command:(NSString *)command
                              code:(NSString *)code
                            reason:(NSString *)reason {
  NSMutableDictionary *response = [[self responseBase:request
                                              command:command]
      mutableCopy];
  response[@"ok"] = @NO;
  response[@"error"] = @{
    @"code" : code,
    @"message" : bounded_reason(reason),
    @"stage" : @"native-observer-command",
    @"retryable" : @NO,
    @"replayAllowed" : @NO,
    @"recoveryAction" : @"inspect-health",
  };
  return response;
}

- (NSDictionary *)responseBase:(NSDictionary *)request
                        command:(NSString *)command {
  return @{
    @"kind" : @"observer-response",
    @"protocolVersion" : @"1",
    @"requestId" : identifier(request[@"requestId"], 127)
                           ? request[@"requestId"]
                           : @"invalid-request",
    @"runtimeEpoch" : self.generation[@"runtimeEpoch"],
    @"loginSessionId" : self.generation[@"loginSessionId"],
    @"nativeGeneration" : self.generation[@"nativeGeneration"],
    @"command" : [@[@"prepare", @"coverage", @"events", @"stop"]
                           containsObject:command]
                     ? command
                     : @"coverage",
    @"nativeBuildId" : self.nativeBuildId,
  };
}

@end
