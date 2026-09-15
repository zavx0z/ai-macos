#include "meta_command_loop.h"
#include "meta_broker_transport.h"
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
  NSString *_activeOperation;
  MetaInputJob *_job;
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
    _startedAt = timestamp();
    _nonce = NSUUID.UUID.UUIDString;
    atomic_init(&_exitCode, -1);
    _requestedExit = -1;
  }
  return self;
}

- (int)exitCode { return atomic_load(&_exitCode); }

- (void)shutdown:(int)code {
  if (_requestedExit >= 0) return;
  _sealed = YES;
  _requestedExit = code;
  [_job requestCancel];
  if (!_busy) {
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

- (void)handle:(NSDictionary *)frame {
  if (_requestedExit >= 0) return;
  if (!json_safe(frame, 0)) { [self shutdown:65]; return; }
  NSString *channel = frame[@"channel"];
  NSDictionary *payload = frame[@"payload"];
  if (![channel isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  NSString *requestId = payload[@"requestId"];
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
    NSDictionary *capabilities = @{@"schemaVersion": @"1", @"scope": @"adapter", @"producerRef": _generation,
      @"capabilities": @[@{@"id": @"runtime.identity", @"state": @"ready"},
                          @{@"id": @"input.pointer", @"state": @"unavailable", @"reason": @"Broker input dispatch integration pending"},
                          @{@"id": @"capture.window", @"state": @"unavailable", @"reason": @"Broker capture dispatch integration pending"}]};
    [self send:@"handshake" payload:@{
      @"kind": @"handshake-response", @"protocolVersion": @"1", @"requestId": requestId,
      @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId, @"nativeGeneration": _generation,
      @"nativeBuildId": _buildId, @"capabilitySchemaVersion": @"1", @"installRoot": _installRoot,
      @"process": @{@"pid": @(getpid()), @"startedAt": _startedAt, @"nonce": _nonce}, @"capabilities": capabilities,
      @"session": session,
    }];
    return;
  }
  if (!_admitted || ![payload[@"runtimeEpoch"] isEqual:_runtimeEpoch] || ![payload[@"loginSessionId"] isEqual:_loginSessionId]
      || ![payload[@"nativeGeneration"] isEqual:_generation] || !future_deadline(payload[@"deadlineAt"])) { [self shutdown:65]; return; }
  NSDictionary *identity = @{@"requestId": requestId, @"runtimeEpoch": _runtimeEpoch, @"loginSessionId": _loginSessionId, @"nativeGeneration": _generation};
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
  if ([channel isEqual:@"status"]) {
    if (_job == nil || ![payload[@"operationId"] isEqual:_job.operation[@"operationId"]]) { [self shutdown:65]; return; }
    NSDictionary *status = [_job statusForRequest:requestId];
    if (status == nil) { [self shutdown:65]; return; }
    [self send:channel payload:status];
    return;
  }
  if ([channel isEqual:@"cancel"]) {
    if (_job == nil || ![payload[@"operationId"] isEqual:_job.operation[@"operationId"]] || ![payload[@"fence"] isEqual:_job.operation[@"fence"]]) { [self shutdown:65]; return; }
    [_job requestCancel];
    NSDictionary *status = [_job statusForRequest:requestId];
    BOOL stopped = status != nil && [@[@"finished", @"cancelled", @"failed"] containsObject:status[@"execution"]];
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
    BOOL ready = !_busy && [_backend beginRotation];
    NSMutableDictionary *ack = [identity mutableCopy];
    [ack addEntriesFromDictionary:@{@"accepted": @YES, @"activeOperationIds": _activeOperation == nil ? @[] : @[_activeOperation],
      @"cleanup": ready ? @"complete" : @"unknown", @"quarantined": ready ? @NO : @YES}];
    [self send:channel payload:ack];
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
  BOOL window = [payload[@"method"] isEqual:@"window.transition"] && [payload[@"intent"] isEqual:@"mutation"];
  BOOL inventory = [payload[@"method"] isEqual:@"window.inventory"] && [payload[@"intent"] isEqual:@"read"] && operation == nil;
  BOOL inspection = [payload[@"method"] isEqual:@"ax.inspect"] && [payload[@"intent"] isEqual:@"read"] && operation == nil;
  NSDictionary *command = payload[@"command"];
  if (clipboard) {
    NSDictionary *target = operation[@"target"];
    NSDictionary *ref = [target isKindOfClass:NSDictionary.class] ? target[@"ref"] : nil;
    if (![ref isKindOfClass:NSDictionary.class] || ![operation[@"kind"] isEqual:@"clipboard"]
        || ![target[@"kind"] isEqual:@"clipboard"] || ![ref[@"clipboardRef"] isEqual:@"system"]
        || ![ref[@"runtimeEpoch"] isEqual:_runtimeEpoch] || ![ref[@"loginSessionId"] isEqual:_loginSessionId]
        || ![command isKindOfClass:NSDictionary.class]) { [self shutdown:65]; return; }
  }
  if (input || window) {
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
  if (!clipboard && !inventory && !input && !inspection && !window) {
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
        result = input ? [self->_backend executeInput:payload job:job] : window ? [self->_backend executeWindow:payload job:job] : clipboard ? [self->_backend clipboard:command] :
            inspection ? [self->_backend inspect:payload] : [self->_backend inventory];
      }
      dispatch_async(self->_control, ^{
        if ((input || window) && [job heartbeatExpired]) self->_sealed = YES;
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
  while ([controller exitCode] < 0) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  [transport close];
  controller.transport = nil;
  return [controller exitCode];
}
