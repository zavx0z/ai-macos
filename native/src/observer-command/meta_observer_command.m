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

static BOOL request_before_deadline(NSDictionary *request) {
  NSString *value = request[@"deadlineAt"];
  if (![value isKindOfClass:NSString.class]) return NO;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *deadline = [formatter dateFromString:value];
  return deadline != nil && deadline.timeIntervalSinceNow > 0;
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
@property(nonatomic, copy, nullable) MetaObserverPreparedValidator preparedValidator;
@property(nonatomic, copy, nullable) MetaObserverIndexFailureProvider indexFailureProvider;
- (BOOL)prepareTokenIsCurrent:(NSObject *)token;
- (void)clearPendingObserver:(MetaNativeObserver *)observer
                       token:(NSObject *)token;
- (void)scheduleMainThreadStop:(MetaNativeObserver *)observer;
- (void)signalEventWaiters;
- (void)finishMainWork;
@end

@implementation MetaObserverCommandBinder {
  NSLock *_lock;
  NSCondition *_eventCondition;
  MetaNativeObserver *_observer;
  MetaNativeObserver *_pendingObserver;
  NSMutableArray<MetaNativeObserver *> *_cleanupPendingObservers;
  MetaObserverPreparedIndex *_prepared;
  NSObject *_prepareToken;
  NSString *_observerInstanceRef;
  NSString *_acceptingInstanceRef;
  NSString *_baselineCursor;
  NSMutableArray<NSDictionary *> *_history;
  NSMutableArray<NSDictionary *> *_pushQueue;
  NSUInteger _historyBytes;
  NSUInteger _pushBytes;
  NSUInteger _mainWorkOutstanding;
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
    _eventCondition = [[NSCondition alloc] init];
    _history = [NSMutableArray array];
    _pushQueue = [NSMutableArray array];
    _cleanupPendingObservers = [NSMutableArray array];
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

- (void)setPreparedValidator:(MetaObserverPreparedValidator)validator {
  [_lock lock];
  _preparedValidator = [validator copy];
  [_lock unlock];
}

- (void)setIndexFailureProvider:(MetaObserverIndexFailureProvider)provider {
  [_lock lock];
  _indexFailureProvider = [provider copy];
  [_lock unlock];
}

- (BOOL)mergeTargetRecords:(NSArray<MetaObserverTargetRecord *> *)records
                inventoryId:(NSString *)inventoryId
          inventoryRevision:(uint64_t)inventoryRevision {
  if (![records isKindOfClass:NSArray.class] || !identifier(inventoryId, 127) ||
      inventoryRevision > 9007199254740991ULL) return NO;
  [_lock lock];
  MetaObserverPreparedIndex *prepared = _prepared;
  BOOL available = prepared != nil && _observer != nil && _gapReason == nil &&
      _prepareToken == nil && prepared.indexRevision < 9007199254740991ULL;
  if (!available || ![prepared.index mergeRecords:records]) {
    [_lock unlock];
    return NO;
  }
  MetaObserverPreparedIndex *updated = meta_observer_prepared_index_create(
      prepared.index, inventoryId, inventoryRevision,
      prepared.indexRevision + 1);
  if (updated == nil) {
    [_lock unlock];
    return NO;
  }
  _prepared = updated;
  [_lock unlock];
  return YES;
}

- (NSDictionary *)indexFailure {
  [_lock lock];
  MetaObserverIndexFailureProvider provider = _indexFailureProvider;
  [_lock unlock];
  NSDictionary *failure = provider == nil ? nil : provider();
  if (![failure isKindOfClass:NSDictionary.class]) {
    return @{@"reason" : @"Observer index diagnostics недоступны",
             @"stage" : @"index", @"transient" : @NO};
  }
  NSString *reason = failure[@"reason"];
  NSString *stage = failure[@"stage"];
  id transient = failure[@"transient"];
  if (
      ![reason isKindOfClass:NSString.class] || reason.length == 0 ||
      ![@[@"inventory", @"index"] containsObject:stage] ||
      transient == nil ||
      CFGetTypeID((__bridge CFTypeRef)transient) !=
          CFBooleanGetTypeID()) {
    return @{@"reason" : @"Observer index diagnostics недоступны",
             @"stage" : @"index", @"transient" : @NO};
  }
  return failure;
}

- (NSString *)cleanDispositionStopped:(BOOL)stopped {
  [_lock lock];
  BOOL clean = _prepareToken == nil && _pendingObserver == nil &&
               _observer == nil && _observerInstanceRef == nil &&
               _cleanupPendingObservers.count == 0 &&
               _mainWorkOutstanding == 0;
  [_lock unlock];
  return clean ? (stopped ? @"clean-stopped" : @"clean-no-instance")
               : @"unknown";
}

- (void)finishMainWork {
  [_lock lock];
  if (_mainWorkOutstanding > 0) _mainWorkOutstanding -= 1;
  [_lock unlock];
}

- (NSDictionary *)prepareFailureResponse:(NSDictionary *)request
                                    reason:(NSString *)reason
                                     stage:(NSString *)stage
                                 transient:(BOOL)transient
                                   stopped:(BOOL)stopped {
  NSMutableDictionary *response = [[self failureResponse:request
                                                   command:@"prepare"
                                                      code:@"capability-unavailable"
                                                    reason:reason] mutableCopy];
  NSString *disposition = [self cleanDispositionStopped:stopped];
  response[@"prepareFailure"] = @{
    @"stage" : stage,
    @"retryDisposition" : disposition,
    @"transient" : transient && ![disposition isEqual:@"unknown"] ? @YES : @NO,
  };
  return response;
}

- (BOOL)preparedStillValid:(MetaObserverPreparedIndex *)prepared {
  [_lock lock];
  MetaObserverPreparedValidator validator = _preparedValidator;
  [_lock unlock];
  return validator == nil || validator(prepared);
}

- (NSDictionary *)prepare:(NSDictionary *)request {
  NSString *previous = request[@"previousObserverInstanceRef"];
  [_lock lock];
  NSString *current = _observerInstanceRef;
  BOOL preparePending = _prepareToken != nil;
  [_lock unlock];
  if (preparePending) {
    return [self failureResponse:request
                         command:@"prepare"
                            code:@"operation-in-progress"
                          reason:@"Observer prepare уже выполняется"];
  }
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
  NSString *failureReason = nil;
  NSString *failureStage = @"index";
  BOOL failureTransient = NO;
  if (prepared == nil) {
    NSDictionary *failure = [self indexFailure];
    failureReason = failure[@"reason"];
    failureStage = failure[@"stage"];
    failureTransient = [failure[@"transient"] boolValue];
  } else if (![self preparedStillValid:prepared]) {
    failureReason = @"Observer prepared foreground receipt изменился до start";
    failureStage = @"inventory";
    failureTransient = YES;
  } else if (!identifier(instance, 127)) {
    failureReason = @"Observer instance identity недоступна";
  } else if (!dictionary(readiness)) {
    failureReason = @"Observer session readiness недоступна";
    failureStage = @"readiness";
    failureTransient = YES;
  } else if (!request_before_deadline(request)) {
    failureReason = @"Observer prepare deadline истёк до main-runloop start";
    failureStage = @"main-start";
  }
  if (failureReason != nil) {
    return [self prepareFailureResponse:request reason:failureReason
                                  stage:failureStage
                              transient:failureTransient stopped:NO];
  }
  NSObject *prepareToken = [[NSObject alloc] init];
  [_lock lock];
  if (_prepareToken != nil) {
    [_lock unlock];
    return [self failureResponse:request
                         command:@"prepare"
                            code:@"operation-in-progress"
                          reason:@"Observer prepare уже выполняется"];
  }
  _prepareToken = prepareToken;
  _pendingObserver = nil;
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
  [self signalEventWaiters];

  __block MetaNativeObserver *created = nil;
  __block NSString *baselineCursor = nil;
  __block BOOL candidateStopped = NO;
  __weak MetaObserverCommandBinder *weakSelf = self;
  [_lock lock];
  _mainWorkOutstanding += 1;
  [_lock unlock];
  BOOL executed = self.mainExecutor(^BOOL {
    MetaObserverCommandBinder *binder = weakSelf;
    if (binder == nil) return NO;
    @try {
      if (!request_before_deadline(request) ||
          ![binder preparedStillValid:prepared] ||
          ![binder prepareTokenIsCurrent:prepareToken]) {
        return NO;
      }
    [binder->_lock lock];
    MetaNativeObserver *previousObserver = binder->_observer;
    [binder->_lock unlock];
    if (previousObserver != nil) {
      [previousObserver setEventSink:nil];
      [previousObserver stop];
      [binder->_lock lock];
      if (binder->_observer == previousObserver &&
          binder->_prepareToken == prepareToken) {
        binder->_observer = nil;
        binder->_prepared = nil;
        binder->_observerInstanceRef = nil;
      }
      [binder->_lock unlock];
    }
    if (!request_before_deadline(request) ||
        ![binder preparedStillValid:prepared] ||
        ![binder prepareTokenIsCurrent:prepareToken]) return NO;
    created = binder.factory(binder.generation, prepared.index);
    if (created == nil) return NO;
    [binder->_lock lock];
    BOOL accepted = binder->_prepareToken == prepareToken;
    if (accepted) binder->_pendingObserver = created;
    [binder->_lock unlock];
    if (!accepted) return NO;
    [created recordCurrentSessionReadiness:readiness];
    if (!request_before_deadline(request) ||
        ![binder preparedStillValid:prepared] ||
        ![binder prepareTokenIsCurrent:prepareToken]) return NO;
    if (![created start]) {
      [created stop];
      candidateStopped = YES;
      [binder clearPendingObserver:created token:prepareToken];
      return NO;
    }
    if (![binder preparedStillValid:prepared]) {
      [created stop];
      candidateStopped = YES;
      [binder clearPendingObserver:created token:prepareToken];
      return NO;
    }
    if (!request_before_deadline(request) ||
        ![binder prepareTokenIsCurrent:prepareToken]) {
      [created stop];
      candidateStopped = YES;
      [binder clearPendingObserver:created token:prepareToken];
      return NO;
    }
    [created takeEvents];
    baselineCursor = created.coverage[@"cursor"];
    [created setEventSink:^(NSDictionary *event) {
      [weakSelf acceptEvent:event observerInstanceRef:instance];
    }];
    if (!request_before_deadline(request) ||
        ![binder preparedStillValid:prepared] ||
        ![binder prepareTokenIsCurrent:prepareToken]) {
      [created setEventSink:nil];
      [created stop];
      candidateStopped = YES;
      [binder clearPendingObserver:created token:prepareToken];
      return NO;
    }
    return YES;
    } @finally {
      [binder finishMainWork];
    }
  });
  BOOL finalPreparedValid = executed && [self preparedStillValid:prepared];
  [_lock lock];
  BOOL accepted = executed && created != nil && finalPreparedValid &&
                  identifier(baselineCursor, 127) &&
                  request_before_deadline(request) &&
                  _prepareToken == prepareToken &&
                  _pendingObserver == created;
  if (accepted) {
    _observer = created;
    _prepared = prepared;
    _observerInstanceRef = instance;
    _baselineCursor = baselineCursor;
    _pendingObserver = nil;
    _prepareToken = nil;
  } else if (_prepareToken == prepareToken) {
    _prepareToken = nil;
    _acceptingInstanceRef = nil;
    _gapReason = @"Observer main-runloop prepare failed";
  }
  MetaNativeObserver *pending = _pendingObserver == created ? created : nil;
  if (pending != nil) _pendingObserver = nil;
  [_lock unlock];
  [self signalEventWaiters];
  if (!accepted) {
    if (pending != nil) [self scheduleMainThreadStop:pending];
    return [self prepareFailureResponse:request
        reason:finalPreparedValid
            ? @"Observer main-runloop start/subscription failed"
            : @"Observer foreground receipt изменился во время main-runloop start"
        stage:pending != nil ? @"cleanup" : @"main-start"
        transient:NO
        stopped:candidateStopped && pending == nil];
  }
  return [self successResponse:request
                       command:@"prepare"
                      snapshot:[self currentSnapshot]
                        events:nil
                    fromCursor:nil];
}

- (BOOL)prepareTokenIsCurrent:(NSObject *)token {
  [_lock lock];
  BOOL current = _prepareToken == token;
  [_lock unlock];
  return current;
}

- (void)clearPendingObserver:(MetaNativeObserver *)observer
                       token:(NSObject *)token {
  [_lock lock];
  if (_prepareToken == token && _pendingObserver == observer) {
    _pendingObserver = nil;
  }
  [_lock unlock];
}

- (void)scheduleMainThreadStop:(MetaNativeObserver *)observer {
  if (observer == nil) return;
  [_lock lock];
  if (![_cleanupPendingObservers containsObject:observer]) {
    [_cleanupPendingObservers addObject:observer];
  }
  [_lock unlock];
  __weak MetaObserverCommandBinder *weakSelf = self;
  self.mainExecutor(^BOOL {
    [observer setEventSink:nil];
    [observer stop];
    MetaObserverCommandBinder *binder = weakSelf;
    if (binder != nil) {
      [binder->_lock lock];
      [binder->_cleanupPendingObservers removeObjectIdenticalTo:observer];
      [binder->_lock unlock];
    }
    return YES;
  });
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
  [self signalEventWaiters];
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

- (NSDictionary *)currentCoverageForObserverInstance:
    (NSString *)observerInstanceRef {
  [_lock lock];
  MetaNativeObserver *observer =
      [_observerInstanceRef isEqual:observerInstanceRef] &&
              [_acceptingInstanceRef isEqual:observerInstanceRef] &&
              _gapReason == nil
          ? _observer
          : nil;
  [_lock unlock];
  NSDictionary *coverage = observer == nil
                                ? nil
                                : immutable_json_copy(observer.coverage);
  [_lock lock];
  BOOL current = observer != nil && _observer == observer &&
                 [_observerInstanceRef isEqual:observerInstanceRef] &&
                 [_acceptingInstanceRef isEqual:observerInstanceRef] &&
                 _gapReason == nil;
  [_lock unlock];
  return current ? coverage : nil;
}

- (BOOL)registerSyntheticTag:(uint64_t)tag
                 operationId:(NSString *)operationId
               interactionId:(NSString *)interactionId
                      target:(NSDictionary *)target
         observerInstanceRef:(NSString *)observerInstanceRef {
  [_lock lock];
  MetaNativeObserver *observer =
      [_observerInstanceRef isEqual:observerInstanceRef] &&
              [_acceptingInstanceRef isEqual:observerInstanceRef] &&
              _gapReason == nil
          ? _observer
          : nil;
  [_lock unlock];
  if (observer == nil ||
      ![observer registerSyntheticTag:tag
                                operationId:operationId
                              interactionId:interactionId
                                     target:target]) {
    return NO;
  }
  [_lock lock];
  BOOL current = _observer == observer &&
                 [_observerInstanceRef isEqual:observerInstanceRef] &&
                 _gapReason == nil;
  [_lock unlock];
  if (!current) [observer unregisterSyntheticTag:tag];
  return current;
}

- (void)unregisterSyntheticTag:(uint64_t)tag
           observerInstanceRef:(NSString *)observerInstanceRef {
  [_lock lock];
  MetaNativeObserver *observer =
      [_observerInstanceRef isEqual:observerInstanceRef] ? _observer : nil;
  [_lock unlock];
  [observer unregisterSyntheticTag:tag];
}

static NSString *event_target_relation(NSDictionary *expected,
                                       NSDictionary *actual) {
  if (![expected isKindOfClass:NSDictionary.class] ||
      ![actual isKindOfClass:NSDictionary.class]) return @"missing";
  if ([expected isEqual:actual]) return @"exact";
  NSDictionary *expectedRef = expected[@"ref"];
  NSDictionary *actualRef = actual[@"ref"];
  if (![expectedRef isKindOfClass:NSDictionary.class] ||
      ![actualRef isKindOfClass:NSDictionary.class]) return @"unrelated";
  for (NSString *key in @[@"runtimeEpoch", @"loginSessionId",
                            @"nativeGeneration", @"applicationRef"]) {
    if (![expectedRef[key] isEqual:actualRef[key]]) return @"unrelated";
  }
  if ([expected[@"kind"] isEqual:@"window"] &&
      [actual[@"kind"] isEqual:@"surface"] &&
      [expectedRef[@"windowRef"] isEqual:actualRef[@"ownerWindowRef"]]) {
    return @"owned-descendant";
  }
  if ([expected[@"kind"] isEqual:@"surface"] &&
      [actual[@"kind"] isEqual:@"window"] &&
      [expectedRef[@"ownerWindowRef"] isEqual:actualRef[@"windowRef"]]) {
    return @"owner";
  }
  return @"unrelated";
}

- (NSDictionary *)scanInputEventsAfterCursor:(NSString *)cursor
                         expectedSyntheticTag:(uint64_t)tag
                               expectedTarget:(nullable NSDictionary *)target
                            allowRelatedFocus:(BOOL)allowRelatedFocus
                                ownInputArmed:(BOOL)ownInputArmed
                                timeoutMillis:(NSUInteger)timeoutMillis
                          observerInstanceRef:(NSString *)observerInstanceRef {
  if (!identifier(cursor, 127) || tag == 0 || timeoutMillis == 0 ||
      timeoutMillis > 250 || !identifier(observerInstanceRef, 127) ||
      (allowRelatedFocus && ![target isKindOfClass:NSDictionary.class])) {
    return nil;
  }
  NSString *expectedTag =
      [NSString stringWithFormat:@"event-%016llx", tag];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:
                                 (NSTimeInterval)timeoutMillis / 1000.0];
  [_eventCondition lock];
  while (YES) {
    [_lock lock];
    BOOL current = [_observerInstanceRef isEqual:observerInstanceRef] &&
                   [_acceptingInstanceRef isEqual:observerInstanceRef] &&
                   _observer != nil && _gapReason == nil;
    NSInteger start = NSNotFound;
    if (current && _baselineAvailable && [cursor isEqual:_baselineCursor]) {
      start = 0;
    } else if (current) {
      for (NSUInteger index = 0; index < _history.count; index += 1) {
        if ([_history[index][@"cursor"] isEqual:cursor]) {
          start = (NSInteger)index + 1;
          break;
        }
      }
    }
    NSArray<NSDictionary *> *events =
        start == NSNotFound
            ? nil
            : [_history subarrayWithRange:NSMakeRange(
                  (NSUInteger)start, _history.count - (NSUInteger)start)];
    [_lock unlock];
    if (events == nil) {
      [_eventCondition unlock];
      return nil;
    }
    if (events.count > 0) {
      BOOL armed = ownInputArmed;
      NSString *state = @"own-event-only";
      NSDictionary *decisive = nil;
      NSInteger decisiveRank = 0;
      for (NSDictionary *event in events) {
        NSString *kind = event[@"kind"];
        BOOL exactTag = [event[@"source"] isEqual:@"synthetic"] &&
            [event[@"syntheticTag"] isEqual:expectedTag];
        if (exactTag && [kind isEqual:@"input"]) {
          armed = YES;
          continue;
        }
        NSString *relation = event_target_relation(target, event[@"target"]);
        NSDictionary *candidate = @{
          @"eventKind" : [kind isKindOfClass:NSString.class] ? kind : @"unknown",
          @"source" : [event[@"source"] isKindOfClass:NSString.class]
              ? event[@"source"] : @"unknown",
          @"tagRelation" : exactTag ? @"exact" :
              event[@"syntheticTag"] == nil ? @"missing" : @"other",
          @"targetRelation" : relation,
          @"ownInputArmed" : armed ? @YES : @NO,
        };
        NSString *candidateState = @"ui-invalidation";
        NSInteger candidateRank = 2;
        if ([kind isEqual:@"input"]) {
          candidateState = @"physical-interference";
          candidateRank = 4;
        } else if ([kind isEqual:@"lifecycle"]) {
          candidateState = @"lifecycle-change";
          candidateRank = 3;
        } else if ([kind isEqual:@"focus"] && allowRelatedFocus && armed &&
                 [@[@"exact", @"owned-descendant", @"owner"]
                     containsObject:relation]) {
          candidateState = @"related-focus";
          candidateRank = 1;
        }
        if (candidateRank > decisiveRank) {
          decisiveRank = candidateRank;
          decisive = candidate;
          state = candidateState;
        }
      }
      NSDictionary *last = events.lastObject;
      NSMutableDictionary *result = [@{
        @"state" : state,
        @"cursor" : last[@"cursor"],
        @"ownInputArmed" : armed ? @YES : @NO,
      } mutableCopy];
      if ([state isEqual:@"own-event-only"] ||
          [state isEqual:@"related-focus"]) result[@"syntheticTag"] = expectedTag;
      if (decisive != nil) result[@"decision"] = decisive;
      [_eventCondition unlock];
      return result;
    }
    if (deadline.timeIntervalSinceNow <= 0) {
      NSDictionary *result = @{
        @"state" : @"no-events",
        @"cursor" : cursor,
        @"ownInputArmed" : ownInputArmed ? @YES : @NO,
      };
      [_eventCondition unlock];
      return result;
    }
    [_eventCondition waitUntilDate:deadline];
  }
}

- (NSDictionary *)scanEventsAfterCursor:(NSString *)cursor
                    expectedSyntheticTag:(uint64_t)tag
                         requireOwnEvent:(BOOL)requireOwnEvent
                           timeoutMillis:(NSUInteger)timeoutMillis
                     observerInstanceRef:(NSString *)observerInstanceRef {
  NSDictionary *result = [self
      scanInputEventsAfterCursor:cursor
           expectedSyntheticTag:tag
                 expectedTarget:nil
              allowRelatedFocus:NO
                  ownInputArmed:NO
                  timeoutMillis:timeoutMillis
            observerInstanceRef:observerInstanceRef];
  if (result == nil) return nil;
  NSString *state = result[@"state"];
  if ([state isEqual:@"physical-interference"]) {
    NSMutableDictionary *strict = [result mutableCopy];
    strict[@"state"] = @"user-takeover";
    return strict;
  }
  if ([state isEqual:@"ui-invalidation"] ||
      [state isEqual:@"lifecycle-change"]) {
    NSMutableDictionary *strict = [result mutableCopy];
    strict[@"state"] = @"unknown";
    return strict;
  }
  if (requireOwnEvent && [state isEqual:@"no-events"]) {
    NSMutableDictionary *strict = [result mutableCopy];
    strict[@"state"] = @"unknown";
    return strict;
  }
  return result;
}

- (NSDictionary *)historySnapshotForObserverInstance:
    (NSString *)observerInstanceRef
                                              maximumEvents:
    (NSUInteger)maximumEvents {
  if (!identifier(observerInstanceRef, 127) || maximumEvents == 0 ||
      maximumEvents > META_OBSERVER_COMMAND_MAX_EVENTS) {
    return nil;
  }
  [_lock lock];
  BOOL current = [_observerInstanceRef isEqual:observerInstanceRef] &&
                 [_acceptingInstanceRef isEqual:observerInstanceRef] &&
                 _observer != nil && _gapReason == nil &&
                 _history.count <= maximumEvents;
  NSDictionary *result = nil;
  if (current) {
    NSDictionary *coverage = immutable_json_copy(_observer.coverage);
    NSArray *events = immutable_json_copy(_history);
    NSDictionary *last = events.lastObject;
    NSNumber *nextSequence = coverage[@"nextSequence"];
    NSNumber *lastSequence = last[@"sequence"];
    BOOL coherent = coverage != nil && events != nil &&
        [coverage[@"state"] isEqual:@"ready"] &&
        ![coverage[@"gapDetected"] boolValue] &&
        [coverage[@"droppedEvents"] unsignedLongLongValue] == 0 &&
        [nextSequence isKindOfClass:NSNumber.class] &&
        ((last == nil && [coverage[@"cursor"] isEqual:_baselineCursor]) ||
         (last != nil && [last[@"cursor"] isEqual:coverage[@"cursor"]] &&
          [lastSequence isKindOfClass:NSNumber.class] &&
          lastSequence.unsignedLongLongValue < UINT64_MAX &&
          nextSequence.unsignedLongLongValue ==
              lastSequence.unsignedLongLongValue + 1));
    if (coherent) {
      result = @{
        @"observerInstanceRef" : observerInstanceRef,
        @"baselineCursor" : _baselineCursor,
        @"baselineAvailable" : _baselineAvailable ? @YES : @NO,
        @"coverage" : coverage,
        @"events" : events,
      };
    }
  }
  [_lock unlock];
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
    [self signalEventWaiters];
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
      [self signalEventWaiters];
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
  [self signalEventWaiters];
}

- (void)signalEventWaiters {
  [_eventCondition lock];
  [_eventCondition broadcast];
  [_eventCondition unlock];
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
  if ([command isEqual:@"prepare"]) {
    response[@"prepareFailure"] = @{
      @"stage" : @"cleanup",
      @"retryDisposition" : @"unknown",
      @"transient" : @NO,
    };
  }
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
