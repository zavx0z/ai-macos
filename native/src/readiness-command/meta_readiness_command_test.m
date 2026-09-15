#include "meta_readiness_command.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  MetaReadinessPoint cursor;
  size_t posts;
  size_t reads;
  uint64_t tags[2];
  bool permitted;
  bool foreign_display;
  bool lose_event;
} Fixture;

static uint64_t clock_millis(void *context) { (void)context; return 100; }
static bool verify(void *context, const char *target) {
  (void)context; return strcmp(target, "display-1") == 0;
}
static bool persist(void *context, const MetaLedgerPersistenceRequest *request,
                    MetaLedgerPersistenceAck *ack) {
  (void)context; (void)request; (void)ack; assert(false); return false;
}
static bool held(void *context, MetaHeldEventKind kind, uint32_t code,
                 bool down, uint64_t tag) {
  (void)context; (void)kind; (void)code; (void)down; (void)tag;
  assert(false); return false;
}
static bool pointer(void *context, const MetaPointerEvent *event, uint64_t tag) {
  Fixture *fixture = context;
  assert(event->kind == META_POINTER_MOVE && tag != 0 && fixture->posts < 2);
  fixture->tags[fixture->posts++] = tag;
  fixture->cursor = (MetaReadinessPoint){event->x, event->y};
  return true;
}
static bool session(void *context, MetaReadinessSessionFacts *facts) {
  ((Fixture *)context)->reads += 1;
  *facts = (MetaReadinessSessionFacts){
    .audit_identity_verified = true, .audit_session_matches = true,
    .real_uid = 501, .effective_uid = 501, .audit_uid = 501, .session_uid = 501,
    .active_console = true, .on_console = true, .login_done = true,
    .lock_state = META_READINESS_LOCK_UNKNOWN, .secure_input = META_READINESS_SECURE_INPUT_OFF,
  };
  return true;
}
static bool permissions(void *context, MetaReadinessPermissions *facts) {
  bool allowed = ((Fixture *)context)->permitted;
  *facts = (MetaReadinessPermissions){allowed, allowed, allowed};
  return true;
}
static bool observer(void *context, MetaReadinessObserverSnapshot *snapshot) {
  *snapshot = (MetaReadinessObserverSnapshot){.ready = true, .continuous = true};
  snprintf(snapshot->cursor, sizeof(snapshot->cursor), "cursor-%zu", ((Fixture *)context)->posts);
  return true;
}
static bool cursor(void *context, MetaReadinessPoint *point) {
  *point = ((Fixture *)context)->cursor; return true;
}
static bool display(void *context, MetaReadinessPoint point, MetaReadinessDisplay *value) {
  (void)point;
  *value = (MetaReadinessDisplay){.bounds = {0, 0, 200, 100}};
  snprintf(value->display_ref, sizeof(value->display_ref), "%s",
      ((Fixture *)context)->foreign_display ? "display-foreign" : "display-1");
  return true;
}
static bool scan(void *context, const char *after, uint64_t tag,
                 bool require_own, uint64_t timeout, MetaReadinessEventScan *value) {
  Fixture *fixture = context;
  assert(timeout > 0 && timeout <= 250);
  const char *expected = fixture->posts == 1 && require_own ? "cursor-0" : "cursor-1";
  assert(strcmp(after, expected) == 0);
  *value = (MetaReadinessEventScan){.state = META_READINESS_SCAN_NO_EVENTS};
  if (require_own) {
    assert(fixture->tags[fixture->posts - 1] == tag);
    value->state = fixture->lose_event ? META_READINESS_SCAN_UNKNOWN : META_READINESS_SCAN_OWN_EVENT_ONLY;
    value->synthetic_tag = fixture->lose_event ? tag + 1 : tag;
  }
  snprintf(value->cursor, sizeof(value->cursor), "cursor-%zu", fixture->posts);
  return true;
}

static NSDictionary *generation(void) {
  return @{@"runtimeEpoch" : @"runtime-1", @"loginSessionId" : @"login-1", @"nativeGeneration" : @"native-1"};
}
static NSDictionary *request(void) {
  NSMutableDictionary *ref = [generation() mutableCopy];
  ref[@"displayRef"] = @"display-1"; ref[@"displayLayoutRevision"] = @1;
  NSMutableDictionary *fence = [generation() mutableCopy]; fence[@"counter"] = @1;
  NSMutableDictionary *operation = [generation() mutableCopy];
  [operation addEntriesFromDictionary:@{
    @"kind" : @"native", @"operationId" : @"operation-1", @"fence" : fence,
    @"target" : @{@"kind" : @"display", @"ref" : ref},
    @"deadlineAt" : @"2030-01-01T00:00:01.000Z",
  }];
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"protocolVersion" : @"1", @"kind" : @"request", @"method" : @"input.readiness",
    @"intent" : @"mutation", @"requestId" : @"request-1", @"operation" : operation,
    @"deadlineAt" : operation[@"deadlineAt"], @"payload" : @{@"expectedDisplayRef" : ref},
  }];
  return value;
}
static MetaExecutor *executor(Fixture *fixture) {
  MetaExecutorBackend backend = {.context = fixture, .monotonic_millis = clock_millis,
    .verify_target = verify, .persist_ledger = persist, .post_held_event = held, .post_pointer_event = pointer};
  MetaExecutor *value = meta_executor_create("native-1", 1000, backend);
  assert(value != NULL && meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  meta_executor_set_observer_state(value, META_OBSERVER_READY);
  MetaFence fence = {.runtime_epoch = "runtime-1", .login_session_id = "login-1", .native_generation = "native-1", .counter = 1};
  assert(meta_executor_begin(value, "operation-1", "display-1", fence, 1000));
  return value;
}
static MetaReadinessCommandBinder *binder(Fixture *fixture, BOOL expired) {
  MetaInputReadinessBackend backend = {.context = fixture, .read_session = session,
    .read_permissions = permissions, .read_observer = observer, .read_cursor = cursor,
    .resolve_display = display, .scan_events = scan};
  return [[MetaReadinessCommandBinder alloc] initWithGeneration:generation() backend:backend now:^NSDate *{
    return [NSDate dateWithTimeIntervalSince1970:expired ? 1893456002 : 1893456000];
  }];
}

static bool execute_wrapped(void *context) {
  BOOL (^action)(void) = (__bridge id)context;
  return action();
}

static void prior_dispatch_is_rejected(void) {
  Fixture fixture = {.cursor = {100, 50}, .permitted = true};
  MetaExecutor *parent = executor(&fixture);
  NSDictionary *wire = request();
  MetaReadinessCommandBinder *command = binder(&fixture, NO);
  __block MetaReadinessCommandOutcome *outcome = nil;
  BOOL (^action)(void) = ^BOOL {
    outcome = [command handleRequest:wire currentRequestId:@"request-1"
        currentOperation:wire[@"operation"] executor:parent error:NULL];
    return YES;
  };
  assert(meta_executor_dispatch_action(parent, execute_wrapped, (__bridge void *)action, "native-action"));
  assert(outcome == nil);
  assert(fixture.posts == 0 && fixture.reads == 0);
  assert(meta_executor_finish(parent));
  meta_executor_destroy(parent);
}

static void rejected_requests(void) {
  for (NSString *scenario in @[@"intent", @"generation", @"request", @"operation", @"fence", @"target", @"deadline", @"expired", @"inactive"]) {
    Fixture fixture = {.cursor = {100, 50}, .permitted = true};
    MetaExecutor *parent = executor(&fixture);
    NSDictionary *current = request()[@"operation"];
    NSMutableDictionary *wire = [request() mutableCopy];
    NSMutableDictionary *operation = [wire[@"operation"] mutableCopy];
    wire[@"operation"] = operation;
    if ([scenario isEqual:@"intent"]) wire[@"intent"] = @"read";
    if ([scenario isEqual:@"generation"]) wire[@"runtimeEpoch"] = @"foreign";
    if ([scenario isEqual:@"request"]) wire[@"requestId"] = @"foreign";
    if ([scenario isEqual:@"operation"]) operation[@"operationId"] = @"foreign";
    if ([scenario isEqual:@"fence"]) {
      NSMutableDictionary *fence = [operation[@"fence"] mutableCopy]; fence[@"counter"] = @2;
      operation[@"fence"] = fence; current = operation;
    }
    if ([scenario isEqual:@"target"]) operation[@"target"] = @{@"kind" : @"desktop-layout"};
    if ([scenario isEqual:@"deadline"]) wire[@"deadlineAt"] = @"2031-01-01T00:00:01.000Z";
    if ([scenario isEqual:@"inactive"]) assert(meta_executor_finish(parent));
    NSError *error = nil;
    assert([binder(&fixture, [scenario isEqual:@"expired"]) handleRequest:wire
        currentRequestId:@"request-1" currentOperation:current executor:parent error:&error] == nil);
    assert(error != nil && fixture.posts == 0 && fixture.reads == 0);
    meta_executor_destroy(parent);
  }
}

int main(void) {
  @autoreleasepool {
    rejected_requests();
    prior_dispatch_is_rejected();
    for (NSString *scenario in @[@"ready", @"denied", @"foreign-display", @"lost-event"]) {
      Fixture fixture = {.cursor = {100, 50}, .permitted = ![scenario isEqual:@"denied"],
        .foreign_display = [scenario isEqual:@"foreign-display"], .lose_event = [scenario isEqual:@"lost-event"]};
      MetaExecutor *parent = executor(&fixture);
      NSDictionary *wire = request();
      MetaReadinessCommandOutcome *outcome = [binder(&fixture, NO) handleRequest:wire
          currentRequestId:@"request-1" currentOperation:wire[@"operation"] executor:parent error:NULL];
      assert(outcome != nil);
      for (NSString *field in @[
        @"inputReady", @"quarantined", @"movePosted", @"moveObserved",
        @"moveReadbackConfirmed", @"restorePosted", @"restoreObserved",
        @"restoreReadbackConfirmed"
      ]) {
        assert(CFGetTypeID((__bridge CFTypeRef)outcome.result[field]) ==
               CFBooleanGetTypeID());
      }
      assert([outcome.result[@"inputReady"] boolValue] == [scenario isEqual:@"ready"]);
      assert(outcome.executorStatus.dispatch_attempts == meta_executor_status(parent).dispatch_attempts);
      if ([scenario isEqual:@"ready"]) {
        assert(fixture.posts == 2 && fixture.cursor.x == 100 && fixture.cursor.y == 50);
        assert(outcome.executorStatus.execution == META_EXECUTOR_DISPATCHING);
        assert([outcome.result[@"dispatch"] isEqual:@"finished"]);
        assert([outcome.result[@"restoration"] isEqual:@"restored"]);
        assert([outcome.result[@"resolvedDisplayRef"] isEqual:wire[@"payload"][@"expectedDisplayRef"]]);
        assert(meta_executor_finish(parent));
      } else {
        assert([outcome.result[@"reason"] length] > 0);
        assert(fixture.posts == ([scenario isEqual:@"lost-event"] ? 1 : 0));
        assert([outcome.result[@"quarantined"] boolValue] == [scenario isEqual:@"lost-event"]);
      }
      meta_executor_destroy(parent);
    }
    puts("readiness command: injected tests passed; no live input");
  }
  return 0;
}
