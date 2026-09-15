#include "meta_input_executor.h"
#include "meta_ledger.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static size_t posts = 0, cleanups = 0;
static uint64_t registeredTag = 0;
static BOOL simultaneousCancel = NO;
static bool post(void *context, MetaHeldEventKind kind, uint32_t code, bool down, uint64_t tag) {
  (void)context; (void)kind; (void)code; (void)down;
  assert(registeredTag != 0 && tag == registeredTag);
  posts += 1;
  if (simultaneousCancel && down) [(__bridge MetaInputJob *)context requestCancel];
  return true;
}
static bool cleanup(void *context, MetaHeldEventKind kind, uint32_t code, uint64_t tag) {
  cleanups += 1;
  return post(context, kind, code, false, tag);
}
static bool flags(void *context, uint64_t value) { (void)context; (void)value; return true; }

@interface ObserverFixtureJob : MetaInputJob
@end
@implementation ObserverFixtureJob
- (BOOL)persistLedger:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack {
  snprintf(ack->request_id, sizeof(ack->request_id), "%s", request->request_id);
  snprintf(ack->operation_id, sizeof(ack->operation_id), "%s", request->snapshot.operation_id);
  snprintf(ack->runtime_epoch, sizeof(ack->runtime_epoch), "%s", request->snapshot.runtime_epoch);
  snprintf(ack->login_session_id, sizeof(ack->login_session_id), "%s", request->snapshot.login_session_id);
  snprintf(ack->native_generation, sizeof(ack->native_generation), "%s", request->snapshot.native_generation);
  ack->revision = request->snapshot.revision;
  ack->durable = true;
  ack->persisted_at_unix_micros = 1;
  return meta_ledger_snapshot_sha256(&request->snapshot, ack->snapshot_sha256);
}
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *mode = argc > 1 ? @(argv[1]) : @"own";
    simultaneousCancel = [mode isEqual:@"foreign-cancel"];
    NSDictionary *generation = @{@"runtimeEpoch": @"runtime", @"loginSessionId": @"login", @"nativeGeneration": @"native"};
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSString *now = [formatter stringFromDate:NSDate.date];
    NSString *deadline = [formatter stringFromDate:[NSDate dateWithTimeIntervalSinceNow:5]];
    NSMutableDictionary *targetRef = [generation mutableCopy];
    targetRef[@"windowRef"] = @"window";
    NSDictionary *target = @{@"kind": @"window", @"ref": targetRef};
    NSMutableDictionary *fence = [generation mutableCopy]; fence[@"counter"] = @1;
    NSMutableDictionary *operation = [generation mutableCopy];
    [operation addEntriesFromDictionary:@{@"operationId": @"operation", @"fence": fence, @"target": target, @"deadlineAt": deadline}];
    NSMutableDictionary *request = [generation mutableCopy];
    [request addEntriesFromDictionary:@{@"requestId": @"request", @"operation": operation, @"deadlineAt": deadline,
      @"payload": @{@"actionDeadlineAt": deadline, @"action": @{@"kind": @"key", @"stroke": @{@"keyCode": @0, @"flags": @0}}}}];
    ObserverFixtureJob *job = [[ObserverFixtureJob alloc] initWithRequest:request emitter:^BOOL(NSDictionary *frame) { (void)frame; return YES; }];
    __block BOOL gap = NO;
    [job setObserverCoverageProvider:^NSDictionary * {
      NSMutableDictionary *coverage = [generation mutableCopy];
      [coverage addEntriesFromDictionary:@{@"state": gap ? @"revoked" : @"ready", @"coverageStartCursor": @"start", @"cursor": @"cursor", @"nextSequence": @1,
        @"startedAt": now, @"coveredFrom": now, @"coveredThrough": now, @"heartbeatAt": now,
        @"coveredKinds": @[@"input", @"focus", @"window-structure", @"lifecycle"], @"droppedEvents": @0, @"gapDetected": gap ? @YES : @NO}];
      if (gap) coverage[@"reason"] = @"Fixture observer gap";
      return coverage;
    }];
    MetaExecutorBackend sink = {.context = (__bridge void *)job, .post_held_event = post, .post_cleanup_up = cleanup, .set_event_flags = flags};
    MetaInputExecutor *input = [[MetaInputExecutor alloc] initWithGeneration:@"native" sink:sink verify:^BOOL(NSString *ref) { return [ref isEqual:@"window"]; }];
    meta_executor_set_observer_state([input executorOnActionWorker], META_OBSERVER_READY);
    [input setInputObserverAfterBegin:^BOOL(MetaExecutor *executor, MetaInputJob *current) {
      assert(current == job);
      if ([mode isEqual:@"missing"]) return NO;
      registeredTag = meta_executor_synthetic_tag(executor);
      return registeredTag != 0;
    } poll:^MetaInputObserverDecision {
      if (posts == 0 || [mode isEqual:@"own"]) return MetaInputObserverContinue;
      if ([mode isEqual:@"foreign"] || [mode isEqual:@"foreign-cancel"]) return MetaInputObserverForeignEvent;
      gap = YES;
      return MetaInputObserverUnavailable;
    }];
    NSDictionary *report = [input execute:request job:job];
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"report": report, @"posts": @(posts), @"cleanups": @(cleanups)} options:0 error:NULL];
    assert(json != nil);
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
