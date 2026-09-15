#include "meta_command_loop.h"
#include "meta_broker_transport.h"
#include "operation-receipts/meta_operation_receipts.h"
#include <stdatomic.h>
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

static BOOL json_safe(id value, NSUInteger depth) {
  if (depth > 32) return NO;
  if ([value isKindOfClass:NSDictionary.class]) {
    for (NSString *key in value) {
      if ([@[@"__proto__", @"constructor", @"prototype"] containsObject:key] ||
          !json_safe(value[key], depth + 1)) return NO;
    }
  } else if ([value isKindOfClass:NSArray.class]) {
    for (id child in value) if (!json_safe(child, depth + 1)) return NO;
  }
  return YES;
}

static BOOL identifier(id value, NSUInteger limit) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 || [value length] > limit) return NO;
  NSString *text = value;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  if ([text rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  unichar first = [text characterAtIndex:0];
  return (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || (first >= '0' && first <= '9');
}

static NSString *timestamp(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

static BOOL future_deadline(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date == nil) {
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    date = [formatter dateFromString:value];
  }
  return date != nil && date.timeIntervalSinceNow > 0;
}

static NSDictionary *failure(NSString *code, NSString *message) {
  return @{@"code": code, @"message": message, @"stage": @"native-command", @"retryable": @NO,
           @"replayAllowed": @NO, @"recoveryAction": @"inspect-health"};
}

@interface MetaCommandController : NSObject
@property(nonatomic, strong) MetaBrokerTransport *transport;
- (instancetype)initWithBackend:(id<MetaCommandBackend>)backend buildId:(NSString *)buildId
                    installRoot:(NSString *)installRoot generation:(NSString *)generation
                        control:(dispatch_queue_t)control;
- (void)handle:(NSDictionary *)frame;
- (void)shutdown:(int)code;
- (int)exitCode;
- (void)pumpObserver;
@end

@implementation MetaCommandController {
  id<MetaCommandBackend> _backend;
  NSString *_buildId;
  NSString *_installRoot;
  NSString *_generation;
  NSString *_runtimeEpoch;
  NSString *_loginSessionId;
  NSString *_startedAt;
  NSString *_nonce;
  dispatch_queue_t _control;
  dispatch_queue_t _actions;
  NSMutableSet<NSString *> *_requestIds;
  NSMutableDictionary<NSString *, NSNumber *> *_heartbeatIds;
  BOOL _admitted;
  BOOL _sealed;
  BOOL _busy;
  BOOL _observerCommandPending;
  BOOL _requiresRecoveryDomain;
  NSString *_activeOperation;
  MetaInputJob *_job;
  MetaOperationReceipts *_receipts;
  NSMutableSet<NSString *> *_cancelledOperations;
  NSUInteger _maintenanceCount;
  NSUInteger _maintenanceBytes;
  atomic_int _exitCode;
  int _requestedExit;
}

- (instancetype)initWithBackend:(id<MetaCommandBackend>)backend buildId:(NSString *)buildId
                    installRoot:(NSString *)installRoot generation:(NSString *)generation
                        control:(dispatch_queue_t)control {
  self = [super init];
  if (self) {
    _backend = backend;
    _buildId = buildId;
    _installRoot = installRoot;
    _generation = generation;
    _control = control;
    _actions = dispatch_queue_create("meta.native.actions", DISPATCH_QUEUE_SERIAL);
    _requestIds = [NSMutableSet set];
    _heartbeatIds = [NSMutableDictionary dictionary];
    _receipts = [[MetaOperationReceipts alloc] init];
    _cancelledOperations = [NSMutableSet set];
    _startedAt = timestamp();
    _nonce = NSUUID.UUID.UUIDString;
    atomic_init(&_exitCode, -1);
    _requestedExit = -1;
  }
  return self;
}

- (int)exitCode { return atomic_load(&_exitCode); }

- (void)pumpObserver {
  if (_requestedExit >= 0 || !_admitted || ![_backend respondsToSelector:@selector(takeObserverPush:)]) return;
  NSDictionary *batch = [_backend takeObserverPush:64];
  if (batch == nil) return;
  if (batch[@"gapReason"] != nil) { [self shutdown:75]; return; }
  NSArray *events = batch[@"events"];
  if (![events isKindOfClass:NSArray.class] || events.count > 64) { [self shutdown:70]; return; }
  for (NSDictionary *event in events) {
    [self send:@"event" payload:event];
    if (_requestedExit >= 0) return;
  }
}

- (void)shutdown:(int)code {
  if (_requestedExit >= 0) return;
  _sealed = YES;
  _requestedExit = code;
  [_job channelDisconnected];
  if (!_busy && _maintenanceCount == 0) {
    atomic_store(&_exitCode, code);
  } else {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1000000000), _control, ^{
      atomic_store(&self->_exitCode, self->_requestedExit);
    });
  }
}

- (void)send:(NSString *)channel payload:(NSDictionary *)payload {
  if (![_transport enqueueFrame:@{@"channel": channel, @"payload": payload}]) [self shutdown:74];
}

- (NSDictionary *)statusForOperation:(NSString *)operationId requestId:(NSString *)requestId {
  NSDictionary *current = [_job statusForRequest:requestId];
  NSDictionary *status = [operationId isEqual:_job.operation[@"operationId"]] ? current :
      [_receipts statusForOperation:operationId requestId:requestId];
  if (status == nil) return nil;
  NSMutableDictionary *updated = [status mutableCopy];
  if ([_cancelledOperations containsObject:operationId]) updated[@"cancellationRequested"] = @YES;
  if ([current[@"highWaterFence"][@"counter"] unsignedLongLongValue] > [status[@"highWaterFence"][@"counter"] unsignedLongLongValue]) {
    updated[@"highWaterFence"] = current[@"highWaterFence"];
    updated[@"restorationAllowed"] = @NO;
  }
  return [_backend supplementStatus:updated];
}

- (BOOL)maintenance:(NSDictionary *)payload work:(NSDictionary *(^)(void))work completed:(void (^)(NSDictionary *))completed {
  NSUInteger bytes = [NSJSONSerialization dataWithJSONObject:payload options:0 error:NULL].length;
  if (_maintenanceCount >= 128 || bytes > 4 * 1024 * 1024 || _maintenanceBytes > 4 * 1024 * 1024 - bytes) { [self shutdown:75]; return NO; }
  _maintenanceCount += 1;
  _maintenanceBytes += bytes;
  dispatch_async(_actions, ^{
    @autoreleasepool {
      NSDictionary *result = work();
      dispatch_async(self->_control, ^{
        self->_maintenanceCount -= 1;
        self->_maintenanceBytes -= bytes;
        if (self->_requestedExit >= 0) {
          if (!self->_busy && self->_maintenanceCount == 0) atomic_store(&self->_exitCode, self->_requestedExit);
          return;
        }
        completed(result);
      });
    }
  });
  return YES;
}

- (void)handle:(NSDictionary *)frame {
  if (_requestedExit >= 0) return;
  if (!json_safe(frame, 0)) { [self shutdown:65]; return; }
  NSString *channel = frame[@"channel"];
  NSDictionary *payload = frame[@"payload"];
  if (![channel isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  NSDictionary *identityPayload = [channel isEqual:@"cleanup"] ? payload[@"control"] : payload;
  if (![identityPayload isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  NSString *requestId = identityPayload[@"requestId"];
  if ([channel isEqual:@"ledger-ack"]) {
    if (!identifier(requestId, 127)) { [self shutdown:65]; return; }
    [_job deliverLedgerAck:payload];
    return;
  }
  double now = NSProcessInfo.processInfo.systemUptime;
  for (NSString *key in _heartbeatIds.allKeys) if ([_heartbeatIds[key] doubleValue] <= now) [_heartbeatIds removeObjectForKey:key];
  if (!identifier(requestId, 127) || [_requestIds containsObject:requestId] || _heartbeatIds[requestId] != nil) { [self shutdown:65]; return; }
  if ([channel isEqual:@"heartbeat"]) {
    if (_heartbeatIds.count >= 128) { [self shutdown:75]; return; }
    _heartbeatIds[requestId] = @(now + 5);
  } else {
    if (_requestIds.count >= 10128 || (_requestIds.count >= 10000 && ![channel isEqual:@"drain"])) { [self shutdown:75]; return; }
    [_requestIds addObject:requestId];
  }
  if ([channel isEqual:@"handshake"]) {
    if (_runtimeEpoch != nil || !identifier(payload[@"runtimeEpoch"], 64) || !identifier(payload[@"loginSessionId"], 64)) { [self shutdown:65]; return; }
    _runtimeEpoch = payload[@"runtimeEpoch"];
    _loginSessionId = payload[@"loginSessionId"];
    _admitted = [payload[@"protocolVersion"] isEqual:@"1"] && [payload[@"capabilitySchemaVersion"] isEqual:@"1"] && [payload[@"expectedNativeBuildId"] isEqual:_buildId];
    NSDictionary *session = [_backend sessionIdentity];
    if ([session[@"verified"] isEqual:@YES]) {
      NSString *actualLogin = [NSString stringWithFormat:@"audit:%@:%@", session[@"uid"], session[@"auditSessionId"]];
      _admitted = _admitted && [actualLogin isEqual:_loginSessionId];
    }
    NSArray *catalog = [_backend respondsToSelector:@selector(capabilityCatalog)] ? [_backend capabilityCatalog] :
        @[@{@"id": @"runtime.identity", @"state": @"ready"}];
    NSDictionary *capabilities = @{@"schemaVersion": @"1", @"scope": @"adapter", @"producerRef": _generation,
      @"capabilities": catalog};
    NSString *recoveryVersion = [_backend respondsToSelector:@selector(recoveryDomainVersion)] &&
        [_backend respondsToSelector:@selector(validateRecoveryRequest:)] ? [_backend recoveryDomainVersion] : nil;
    _requiresRecoveryDomain = [recoveryVersion isEqual:@"1"];
    if (payload[@"requiredRecoveryDomainVersion"] != nil && ![payload[@"requiredRecoveryDomainVersion"] isEqual:recoveryVersion]) _admitted = NO;
    NSMutableDictionary *handshake = [@{
      @"kind": @"handshake-response", @"protocolVersion": @"1", @"requestId": requestId,
      @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId, @"nativeGeneration": _generation,
      @"nativeBuildId": _buildId, @"capabilitySchemaVersion": @"1", @"installRoot": _installRoot,
      @"process": @{@"pid": @(getpid()), @"startedAt": _startedAt, @"nonce": _nonce}, @"capabilities": capabilities,
      @"session": session,
    } mutableCopy];
    if (recoveryVersion != nil) handshake[@"recoveryDomainVersion"] = recoveryVersion;
    [self send:@"handshake" payload:handshake];
    return;
  }
  if (!_admitted || ![identityPayload[@"runtimeEpoch"] isEqual:_runtimeEpoch] || ![identityPayload[@"loginSessionId"] isEqual:_loginSessionId]
      || ![identityPayload[@"nativeGeneration"] isEqual:_generation] || !future_deadline(identityPayload[@"deadlineAt"])) { [self shutdown:65]; return; }
  NSDictionary *identity = @{@"requestId": requestId, @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId, @"nativeGeneration": _generation};
  if ([channel isEqual:@"observer"]) {
    BOOL sealedControl = [@[@"coverage", @"events", @"stop"] containsObject:payload[@"command"]];
    if ((_sealed && !sealedControl) || _observerCommandPending || ![_backend respondsToSelector:@selector(observer:)]) { [self shutdown:65]; return; }
    _observerCommandPending = YES;
    [self maintenance:payload work:^NSDictionary * {
      return [self->_backend observer:payload];
    } completed:^(NSDictionary *result) {
      self->_observerCommandPending = NO;
      if (result == nil) { [self shutdown:70]; return; }
      if (![self->_transport enqueueFrame:@{@"channel": @"observer", @"payload": result}]) { [self shutdown:74]; return; }
      if ([result[@"ok"] isEqual:@YES] && [result[@"command"] isEqual:@"prepare"]) {
        NSString *instance = result[@"snapshot"][@"observerInstanceRef"];
        if (![self->_backend respondsToSelector:@selector(activateObserverPush:)] ||
            ![self->_backend activateObserverPush:instance]) { [self shutdown:75]; return; }
      }
      [self pumpObserver];
    }];
    return;
  }
  if ([channel isEqual:@"permissions"]) {
    if (![payload[@"kind"] isEqual:@"permissions"] || ![payload[@"protocolVersion"] isEqual:@"1"]) { [self shutdown:65]; return; }
    NSDictionary *permissions = [_backend permissions];
    if (![permissions[@"accessibility"] isKindOfClass:NSNumber.class] ||
        ![permissions[@"postEvents"] isKindOfClass:NSNumber.class] ||
        ![permissions[@"screenRecording"] isKindOfClass:NSNumber.class]) { [self shutdown:70]; return; }
    NSMutableDictionary *result = [identity mutableCopy];
    [result addEntriesFromDictionary:@{@"kind": @"permissions-response", @"protocolVersion": @"1", @"nativeBuildId": _buildId,
      @"accessibility": [permissions[@"accessibility"] boolValue] ? @YES : @NO,
      @"postEvents": [permissions[@"postEvents"] boolValue] ? @YES : @NO,
      @"screenRecording": [permissions[@"screenRecording"] boolValue] ? @YES : @NO}];
    if ([permissions[@"codeIdentity"] isKindOfClass:NSDictionary.class]) result[@"codeIdentity"] = permissions[@"codeIdentity"];
    [self send:channel payload:result];
    return;
  }
  if ([channel isEqual:@"domain-recovery"]) {
    if (![_backend respondsToSelector:@selector(domainRecovery:owner:)]) { [self shutdown:70]; return; }
    NSDictionary *owner = @{@"protocolVersion": @"1", @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId,
      @"nativeGeneration": _generation, @"nativeBuildId": _buildId};
    [self maintenance:payload work:^NSDictionary * { return [self->_backend domainRecovery:payload owner:owner]; } completed:^(NSDictionary *result) {
      if (result == nil) [self shutdown:65];
      else [self send:channel payload:result];
    }];
    return;
  }
  if ([channel isEqual:@"held-recovery"]) {
    if (![_backend respondsToSelector:@selector(heldRecovery:owner:)]) { [self shutdown:70]; return; }
    NSDictionary *owner = @{@"protocolVersion": @"1", @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId,
      @"nativeGeneration": _generation, @"nativeBuildId": _buildId};
    [self maintenance:payload work:^NSDictionary * { return [self->_backend heldRecovery:payload owner:owner]; } completed:^(NSDictionary *result) {
      if (result == nil) [self shutdown:65];
      else [self send:channel payload:result];
    }];
    return;
  }
  if ([channel isEqual:@"status"]) {
    NSDictionary *status = [self statusForOperation:payload[@"operationId"] requestId:requestId];
    if (status == nil) { [self shutdown:65]; return; }
    if (_busy) [self send:channel payload:status];
    else [self maintenance:payload work:^NSDictionary * { return [self->_backend reconcileStatus:status]; } completed:^(NSDictionary *value) {
      if (value == nil) [self shutdown:70];
      else [self send:channel payload:value];
    }];
    return;
  }
  if ([channel isEqual:@"cancel"]) {
    BOOL current = [payload[@"operationId"] isEqual:_job.operation[@"operationId"]];
    NSDictionary *status = [self statusForOperation:payload[@"operationId"] requestId:requestId];
    NSDictionary *acceptedFence = current ? _job.operation[@"fence"] : status[@"acceptedFence"];
    if (acceptedFence == nil || ![payload[@"fence"] isEqual:acceptedFence]) { [self shutdown:65]; return; }
    [_cancelledOperations addObject:payload[@"operationId"]];
    if (current) [_job requestCancel];
    if (![self maintenance:payload work:^NSDictionary * { return [self->_backend cancel:payload]; } completed:^(__unused NSDictionary *value) {}]) return;
    BOOL stopped = status != nil && [@[@"finished", @"cancelled", @"failed"] containsObject:status[@"execution"]] &&
        [status[@"cleanup"] isEqual:@"complete"] && ![status[@"quarantined"] boolValue];
    NSMutableDictionary *ack = [identity mutableCopy];
    [ack addEntriesFromDictionary:@{@"operationId": payload[@"operationId"], @"fence": payload[@"fence"],
      @"acknowledged": @YES, @"stopped": stopped ? @YES : @NO,
      @"cleanup": stopped ? status[@"cleanup"] : @"unknown", @"quarantined": stopped ? status[@"quarantined"] : @YES,
      @"ledgerRevision": status[@"ledgerRevision"] ?: @0}];
    [self send:channel payload:ack];
    return;
  }
  if ([channel isEqual:@"heartbeat"]) {
    BOOL activeJob = _busy && _activeOperation != nil && [_activeOperation isEqual:_job.operation[@"operationId"]];
    if (activeJob && ![_job noteHeartbeat]) _sealed = YES;
    BOOL quarantined = [[_job statusForRequest:requestId][@"quarantined"] boolValue];
    NSMutableDictionary *ack = [identity mutableCopy];
    [ack addEntriesFromDictionary:@{@"accepted": _sealed || quarantined ? @NO : @YES, @"acknowledgedAt": timestamp(), @"quarantined": quarantined ? @YES : @NO}];
    [self send:channel payload:ack];
    return;
  }
  if ([channel isEqual:@"drain"]) {
    _sealed = YES;
    [_job requestCancel];
    BOOL ready = !_busy && _maintenanceCount == 0 && [_backend beginRotation];
    NSMutableSet *operations = [NSMutableSet setWithArray:[_backend pendingOperationIds]];
    if (_activeOperation != nil) [operations addObject:_activeOperation];
    NSMutableDictionary *ack = [identity mutableCopy];
    [ack addEntriesFromDictionary:@{@"accepted": @YES, @"activeOperationIds": operations.allObjects,
      @"cleanup": ready ? @"complete" : @"unknown", @"quarantined": ready ? @NO : @YES}];
    [self send:channel payload:ack];
    return;
  }
  if ([channel isEqual:@"cleanup"]) {
    MetaBrokerTransport *transport = _transport;
    [self maintenance:payload work:^NSDictionary * {
      return [self->_backend cleanupCapture:payload emitBinary:^BOOL(NSDictionary *header, NSData *bytes) { return [transport enqueueBinaryFrame:header bytes:bytes]; }];
    } completed:^(NSDictionary *result) {
      if (result == nil) [self shutdown:65];
      else [self send:@"cleanup" payload:result];
    }];
    return;
  }
  if (![channel isEqual:@"request"] && ![channel isEqual:@"clipboard"]) { [self shutdown:65]; return; }
  NSMutableDictionary *response = [identity mutableCopy];
  response[@"kind"] = @"response";
  response[@"protocolVersion"] = @"1";
  NSDictionary *operation = payload[@"operation"];
  if (operation != nil && ![operation isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  if (operation != nil) {
    if (!identifier(operation[@"operationId"], 127) || ![operation[@"runtimeEpoch"] isEqual:_runtimeEpoch]
        || ![operation[@"loginSessionId"] isEqual:_loginSessionId] || ![operation[@"deadlineAt"] isEqual:payload[@"deadlineAt"]]) { [self shutdown:65]; return; }
    response[@"operationId"] = operation[@"operationId"];
  }
  NSString *responseChannel = [channel isEqual:@"clipboard"] ? channel : @"response";
  if (_sealed || _busy) {
    response[@"ok"] = @NO;
    response[@"error"] = failure(_sealed ? @"capability-unavailable" : @"operation-in-progress",
                                  _sealed ? @"Native generation дренируется" : @"Native action уже выполняется");
    [self send:responseChannel payload:response];
    return;
  }
  BOOL clipboard = [channel isEqual:@"clipboard"];
  BOOL input = [payload[@"method"] isEqual:@"input.execute"] && [payload[@"intent"] isEqual:@"mutation"];
  BOOL readiness = [payload[@"method"] isEqual:@"input.readiness"] && [payload[@"intent"] isEqual:@"mutation"] &&
      [_backend respondsToSelector:@selector(executeReadiness:job:)];
  BOOL axPress = [payload[@"method"] isEqual:@"ax.press"] && [payload[@"intent"] isEqual:@"mutation"] &&
      [_backend respondsToSelector:@selector(executeAxPress:job:)];
  BOOL cursorDisplay = [payload[@"method"] isEqual:@"input.cursor-display"] && [payload[@"intent"] isEqual:@"read"] &&
      operation == nil && [_backend respondsToSelector:@selector(cursorDisplay:)];
  BOOL window = [payload[@"method"] isEqual:@"window.transition"] && [payload[@"intent"] isEqual:@"mutation"];
  BOOL capture = [payload[@"method"] isEqual:@"capture.start"] && [payload[@"intent"] isEqual:@"mutation"];
  BOOL application = [@[@"application.launch", @"application.quit"] containsObject:payload[@"method"]] && [payload[@"intent"] isEqual:@"mutation"];
  BOOL inventory = [payload[@"method"] isEqual:@"window.inventory"] && [payload[@"intent"] isEqual:@"read"] && operation == nil;
  BOOL inspection = [payload[@"method"] isEqual:@"ax.inspect"] && [payload[@"intent"] isEqual:@"read"] && operation == nil;
  BOOL applicationResolution = [payload[@"method"] isEqual:@"application.resolve"] && [payload[@"intent"] isEqual:@"read"] && operation == nil;
  BOOL hitTest = [payload[@"method"] isEqual:@"input.hit-test"] && [payload[@"intent"] isEqual:@"read"] && operation != nil;
  NSDictionary *command = payload[@"command"];
  if (clipboard) {
    NSDictionary *target = operation[@"target"];
    NSDictionary *ref = [target isKindOfClass:NSDictionary.class] ? target[@"ref"] : nil;
    if (![ref isKindOfClass:NSDictionary.class] || ![operation[@"kind"] isEqual:@"clipboard"]
        || ![target[@"kind"] isEqual:@"clipboard"] || ![ref[@"clipboardRef"] isEqual:@"system"]
        || ![ref[@"runtimeEpoch"] isEqual:_runtimeEpoch] || ![ref[@"loginSessionId"] isEqual:_loginSessionId]
        || ![command isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  }
  if (input || readiness || axPress || window || capture || application) {
    NSDictionary *actionPayload = payload[@"payload"];
    if (![operation[@"kind"] isEqual:@"native"] || ![operation[@"nativeGeneration"] isEqual:_generation]
        || ![operation[@"fence"] isKindOfClass:NSDictionary.class] || ![operation[@"target"] isKindOfClass:NSDictionary.class]
        || ![operation[@"target"][@"ref"] isKindOfClass:NSDictionary.class]
        || ![actionPayload isKindOfClass:NSDictionary.class] || (input && ![actionPayload[@"action"] isKindOfClass:NSDictionary.class])) { [self shutdown:65]; return; }
    MetaBrokerTransport *transport = _transport;
    _job = [[MetaInputJob alloc] initWithRequest:payload emitter:^(NSDictionary *message) { return [transport enqueueFrame:message]; }];
  }
  if (inspection) {
    NSDictionary *inspectPayload = payload[@"payload"];
    NSDictionary *target = [inspectPayload isKindOfClass:NSDictionary.class] ? inspectPayload[@"target"] : nil;
    NSDictionary *ref = [target isKindOfClass:NSDictionary.class] ? target[@"ref"] : nil;
    if (![ref isKindOfClass:NSDictionary.class] || ![ref[@"runtimeEpoch"] isEqual:_runtimeEpoch] ||
        ![ref[@"loginSessionId"] isEqual:_loginSessionId] || ![ref[@"nativeGeneration"] isEqual:_generation]) { [self shutdown:65]; return; }
  }
  if (!clipboard && !inventory && !input && !readiness && !axPress && !cursorDisplay && !inspection && !window && !applicationResolution && !capture && !hitTest && !application) {
    response[@"ok"] = @NO;
    response[@"error"] = failure(@"unsupported-capability", @"Native command ещё не подключена к broker");
    [self send:responseChannel payload:response];
    return;
  }
  _busy = YES;
  _activeOperation = operation[@"operationId"];
  MetaInputJob *job = _job;
  dispatch_async(_actions, ^{
    @autoreleasepool {
      __block BOOL allowed = NO;
      dispatch_sync(self->_control, ^{ allowed = !self->_sealed && self->_requestedExit < 0; });
      NSDictionary *result = nil;
      if (allowed && future_deadline(payload[@"deadlineAt"])) {
        BOOL mutation = [payload[@"intent"] isEqual:@"mutation"] || (clipboard && [command[@"method"] isEqual:@"clipboard.write"]);
        if (self->_requiresRecoveryDomain && mutation && ![self->_backend validateRecoveryRequest:payload]) {
          result = @{@"nativeError": failure(@"request-payload-mismatch", @"RecoveryDomain grant не подтверждает actual primitive plan; dispatch не начат")};
        } else result = axPress ? [self->_backend executeAxPress:payload job:job] : cursorDisplay ? [self->_backend cursorDisplay:payload] : readiness ? [self->_backend executeReadiness:payload job:job] : input ? [self->_backend executeInput:payload job:job] : window ? [self->_backend executeWindow:payload job:job] : capture ? [self->_backend startCapture:payload job:job] : application ? [self->_backend executeApplication:payload job:job] : clipboard ? [self->_backend clipboard:command] :
            inspection ? [self->_backend inspect:payload] : applicationResolution ? [self->_backend resolveApplication:payload] : hitTest ? [self->_backend hitTest:payload] : [self->_backend inventory];
      }
      dispatch_async(self->_control, ^{
        if (input || readiness || axPress || window || capture || application) {
          NSDictionary *terminal = [job statusForRequest:job.requestId];
          if (terminal != nil && ![self->_receipts recordStatus:terminal]) self->_sealed = YES;
        }
        if ((input || readiness || axPress || window || capture || application) && [job heartbeatExpired]) self->_sealed = YES;
        self->_busy = NO;
        self->_activeOperation = nil;
        if (self->_requestedExit >= 0) { atomic_store(&self->_exitCode, self->_requestedExit); return; }
        response[@"ok"] = result != nil ? @YES : @NO;
        if ([result[@"nativeError"] isKindOfClass:NSDictionary.class]) {
          response[@"ok"] = @NO;
          response[@"error"] = result[@"nativeError"];
          if ([result[@"nativeStatus"] isKindOfClass:NSDictionary.class]) response[@"nativeStatus"] = result[@"nativeStatus"];
        } else if (input && result != nil) {
          NSMutableDictionary *report = [result mutableCopy];
          BOOL finished = [report[@"finished"] boolValue];
          [report removeObjectForKey:@"finished"];
          response[@"ok"] = finished ? @YES : @NO;
          if (finished) response[@"result"] = report;
          else {
            NSDictionary *status = report[@"status"];
            NSString *code = [status[@"quarantined"] boolValue] ? @"resource-quarantined" :
                ![status[@"cleanup"] isEqual:@"complete"] ? @"cleanup-incomplete" :
                [status[@"targetVerified"] isEqual:@"failed"] ? @"target-stale" :
                [status[@"execution"] isEqual:@"cancelled"] ? @"cancelled" : @"internal-error";
            response[@"error"] = failure(code, @"Native input не завершён; сохранён точный execution status");
            response[@"nativeStatus"] = status;
          }
        } else if (result != nil) response[@"result"] = result;
        else response[@"error"] = failure(!allowed ? @"cancelled" : input ? @"target-stale" : inventory ? @"inventory-incomplete" : @"invalid-request",
                                             @"Native action не была принята или не вернула result");
        [self send:responseChannel payload:response];
      });
    }
  });
}
@end

int meta_command_loop_run(id<MetaCommandBackend> backend, NSString *buildId,
                          NSString *installRoot, NSString *nativeGeneration,
                          int inputDescriptor, int outputDescriptor) {
  if (backend == nil || !identifier(buildId, 127) || !identifier(nativeGeneration, 64)) return 64;
  dispatch_queue_t control = dispatch_queue_create("meta.native.control", DISPATCH_QUEUE_SERIAL);
  MetaCommandController *controller = [[MetaCommandController alloc] initWithBackend:backend buildId:buildId
    installRoot:installRoot generation:nativeGeneration control:control];
  MetaBrokerTransport *transport = [[MetaBrokerTransport alloc] initWithInput:inputDescriptor output:outputDescriptor callbackQueue:control
    onMessage:^(NSDictionary *message) { [controller handle:message]; }
    onFailure:^(__unused NSString *reason) { [controller shutdown:74]; }];
  if (transport == nil) return 70;
  controller.transport = transport;
  [transport start];
  dispatch_source_t observerTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, control);
  dispatch_source_set_timer(observerTimer, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), 20 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(observerTimer, ^{ [controller pumpObserver]; });
  dispatch_resume(observerTimer);
  while ([controller exitCode] < 0) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  dispatch_source_cancel(observerTimer);
  dispatch_sync(control, ^{});
  if ([backend respondsToSelector:@selector(stopObserver)]) [backend stopObserver];
  [transport close];
  controller.transport = nil;
  return [controller exitCode];
}
