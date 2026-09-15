#include "meta_input_job.h"
#include <stdatomic.h>
#include <time.h>

static uint64_t job_millis(void) {
  struct timespec now = {0};
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static NSDictionary *status_fence(MetaFence fence) {
  return @{@"runtimeEpoch": @(fence.runtime_epoch), @"loginSessionId": @(fence.login_session_id),
    @"nativeGeneration": @(fence.native_generation), @"counter": @(fence.counter)};
}

@implementation MetaInputJob {
  NSDictionary *_operation;
  NSString *_requestId;
  MetaInputJobEmitter _emitter;
  atomic_bool _cancel;
  atomic_bool _channelDisconnected;
  atomic_bool _heartbeatExpired;
  atomic_uint_fast64_t _lastHeartbeat;
  NSCondition *_condition;
  NSString *_awaitedLedger;
  NSDictionary *_ledgerAck;
  NSDictionary *_status;
}

- (instancetype)initWithRequest:(NSDictionary *)request emitter:(MetaInputJobEmitter)emitter {
  self = [super init];
  if (self) {
    _operation = [request[@"operation"] copy];
    _requestId = [request[@"requestId"] copy];
    _emitter = [emitter copy];
    _condition = [[NSCondition alloc] init];
    atomic_init(&_cancel, false);
    atomic_init(&_channelDisconnected, false);
    atomic_init(&_heartbeatExpired, false);
    atomic_init(&_lastHeartbeat, job_millis());
  }
  return self;
}
- (NSDictionary *)operation { return _operation; }
- (NSString *)requestId { return _requestId; }
- (BOOL)heartbeatExpired {
  [_condition lock];
  uint64_t last = atomic_load(&_lastHeartbeat), now = job_millis();
  if (now < last || now - last >= 1000) {
    atomic_store(&_heartbeatExpired, true);
    atomic_store(&_cancel, true);
  }
  BOOL expired = atomic_load(&_heartbeatExpired);
  [_condition unlock];
  return expired;
}
- (BOOL)cancelRequested { return [self heartbeatExpired] || atomic_load(&_cancel); }
- (BOOL)noteHeartbeat {
  [_condition lock];
  uint64_t last = atomic_load(&_lastHeartbeat), now = job_millis();
  if (now < last || now - last >= 1000) {
    atomic_store(&_heartbeatExpired, true);
    atomic_store(&_cancel, true);
  }
  BOOL accepted = !atomic_load(&_heartbeatExpired);
  if (accepted) atomic_store(&_lastHeartbeat, now);
  [_condition unlock];
  return accepted;
}
- (void)requestCancel {
  atomic_store(&_cancel, true);
  [_condition lock];
  [_condition broadcast];
  [_condition unlock];
}
- (void)channelDisconnected {
  atomic_store(&_channelDisconnected, true);
  [self requestCancel];
}

- (BOOL)deliverLedgerAck:(NSDictionary *)ack {
  [_condition lock];
  BOOL matches = _awaitedLedger != nil && [_awaitedLedger isEqual:ack[@"requestId"]] && _ledgerAck == nil;
  if (matches) {
    _ledgerAck = [ack copy];
    [_condition broadcast];
  }
  [_condition unlock];
  return matches;
}

- (BOOL)persistLedger:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack {
  if (atomic_load(&_channelDisconnected)) return NO;
  static NSString *states[] = {@"pending-down", @"confirmed-down", @"pending-up", @"released", @"uncertain"};
  NSMutableArray *entries = [NSMutableArray array];
  for (size_t i = 0; i < request->snapshot.entry_count; i += 1) {
    const MetaLedgerEntry *entry = &request->snapshot.entries[i];
    [entries addObject:@{@"sequence": @(entry->sequence), @"kind": entry->kind == META_EVENT_KEY ? @"key" : @"button",
      @"code": @(entry->code), @"state": states[entry->state]}];
  }
  NSMutableDictionary *snapshot = [@{@"canonicalVersion": @"1", @"operationId": @(request->snapshot.operation_id),
    @"runtimeEpoch": @(request->snapshot.runtime_epoch), @"loginSessionId": @(request->snapshot.login_session_id),
    @"nativeGeneration": @(request->snapshot.native_generation), @"revision": @(request->snapshot.revision), @"entries": entries} mutableCopy];
  if (request->snapshot.has_previous_snapshot_sha256) snapshot[@"previousSnapshotSha256"] = @(request->snapshot.previous_snapshot_sha256);
  [_condition lock];
  _awaitedLedger = @(request->request_id);
  _ledgerAck = nil;
  [_condition unlock];
  if (!_emitter(@{@"channel": @"ledger-persist", @"payload": @{@"requestId": @(request->request_id), @"snapshot": snapshot}})) return NO;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1];
  [_condition lock];
  while (_ledgerAck == nil && !atomic_load(&_channelDisconnected)) {
    if (![_condition waitUntilDate:deadline]) break;
  }
  NSDictionary *received = _ledgerAck;
  _awaitedLedger = nil;
  _ledgerAck = nil;
  [_condition unlock];
  if (received == nil) return NO;
  NSString *keys[] = {@"requestId", @"operationId", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"snapshotSha256"};
  char *destinations[] = {ack->request_id, ack->operation_id, ack->runtime_epoch, ack->login_session_id, ack->native_generation, ack->snapshot_sha256};
  for (size_t i = 0; i < 6; i += 1) {
    NSString *value = received[keys[i]];
    NSUInteger maximum = i == 5 ? 64 : 127;
    if (![value isKindOfClass:NSString.class] || [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maximum) return NO;
    snprintf(destinations[i], maximum + 1, "%s", value.UTF8String);
  }
  ack->revision = [received[@"revision"] unsignedLongLongValue];
  ack->durable = [received[@"durable"] isEqual:@YES];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *persistedAt = [formatter dateFromString:received[@"persistedAt"]];
  if (persistedAt == nil) return NO;
  ack->persisted_at_unix_micros = (uint64_t)(persistedAt.timeIntervalSince1970 * 1000000);
  return YES;
}

- (void)publishStatus:(MetaExecutorStatus)status {
  if (!status.has_accepted_fence) return;
  static NSString *executions[] = {@"idle", @"dispatching", @"cancelling", @"cancelled", @"finished", @"failed", @"interrupted-unknown", @"quarantined"};
  static NSString *dispatches[] = {@"none", @"attempted", @"partial", @"finished", @"unknown"};
  static NSString *cleanups[] = {@"complete", @"incomplete", @"unknown"};
  static NSString *verification[] = {@"unknown", @"verified", @"failed"};
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSString *now = [formatter stringFromDate:NSDate.date];
  NSDictionary *generation = @{@"runtimeEpoch": _operation[@"runtimeEpoch"], @"loginSessionId": _operation[@"loginSessionId"], @"nativeGeneration": _operation[@"nativeGeneration"]};
  NSMutableDictionary *observer = [generation mutableCopy];
  [observer addEntriesFromDictionary:@{@"state": @"unavailable", @"coverageStartCursor": @"observer-0", @"cursor": @"observer-0", @"nextSequence": @1,
    @"startedAt": now, @"coveredFrom": now, @"coveredThrough": now, @"heartbeatAt": now,
    @"coveredKinds": @[], @"droppedEvents": @0, @"gapDetected": @NO, @"reason": @"Native event observer ещё не подключён"}];
  NSMutableDictionary *value = [generation mutableCopy];
  [value addEntriesFromDictionary:@{@"requestId": _requestId, @"operationId": _operation[@"operationId"],
    @"acceptedFence": status_fence(status.accepted_fence), @"highWaterFence": status_fence(status.has_high_water_fence ? status.high_water_fence : status.accepted_fence),
    @"execution": executions[status.execution], @"dispatch": dispatches[status.dispatch], @"cleanup": cleanups[status.cleanup],
    @"targetVerified": verification[status.target_verification], @"cancellationRequested": status.cancellation_requested ? @YES : @NO,
    @"userInterference": @"unknown", @"restorationAllowed": @NO, @"quarantined": status.quarantined ? @YES : @NO,
    @"heldCount": @(status.held_count), @"dispatchAttempts": @(status.dispatch_attempts), @"ledgerRevision": @(status.ledger_revision), @"observer": observer}];
  if (status.last_checkpoint[0]) value[@"lastCheckpoint"] = @(status.last_checkpoint);
  [_condition lock];
  _status = [value copy];
  [_condition unlock];
}

- (NSDictionary *)statusForRequest:(NSString *)requestId {
  [_condition lock];
  NSMutableDictionary *result = [_status mutableCopy];
  [_condition unlock];
  if (result == nil) return nil;
  result[@"requestId"] = requestId;
  return result;
}
@end
