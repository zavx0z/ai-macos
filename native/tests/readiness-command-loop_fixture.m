#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "meta_readiness_command.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  bool observer_ready;
  MetaReadinessPoint cursor;
  size_t posts;
  uint64_t tags[2];
} FixtureState;

static uint64_t fixture_clock(void *context) {
  (void)context;
  return 100;
}

static bool fixture_verify(void *context, const char *target) {
  (void)context;
  return target != NULL && strcmp(target, "display-1") == 0;
}

static bool fixture_pointer(void *context,
                            const MetaPointerEvent *event,
                            uint64_t tag) {
  FixtureState *state = context;
  if (event == NULL || event->kind != META_POINTER_MOVE || tag == 0 ||
      state->posts >= 2) {
    return false;
  }
  state->tags[state->posts++] = tag;
  state->cursor = (MetaReadinessPoint){event->x, event->y};
  return true;
}

static bool fixture_session(void *context,
                            MetaReadinessSessionFacts *facts) {
  (void)context;
  *facts = (MetaReadinessSessionFacts){
    .audit_identity_verified = true,
    .audit_session_matches = true,
    .real_uid = 501,
    .effective_uid = 501,
    .audit_uid = 501,
    .session_uid = 501,
    .active_console = true,
    .on_console = true,
    .login_done = true,
    .lock_state = META_READINESS_LOCK_UNKNOWN,
    .secure_input = META_READINESS_SECURE_INPUT_OFF,
  };
  return true;
}

static bool fixture_permissions(void *context,
                                MetaReadinessPermissions *permissions) {
  (void)context;
  *permissions = (MetaReadinessPermissions){true, true, true};
  return true;
}

static bool fixture_observer(void *context,
                             MetaReadinessObserverSnapshot *snapshot) {
  FixtureState *state = context;
  *snapshot = (MetaReadinessObserverSnapshot){
    .ready = state->observer_ready,
    .continuous = state->observer_ready,
  };
  snprintf(snapshot->cursor, sizeof(snapshot->cursor), "cursor-%zu",
           state->posts);
  return true;
}

static bool fixture_cursor(void *context, MetaReadinessPoint *point) {
  *point = ((FixtureState *)context)->cursor;
  return true;
}

static bool fixture_display(void *context,
                            MetaReadinessPoint point,
                            MetaReadinessDisplay *display) {
  (void)context;
  if (point.x < 0 || point.y < 0 || point.x >= 200 || point.y >= 100) {
    return false;
  }
  *display = (MetaReadinessDisplay){
    .bounds = {0, 0, 200, 100},
  };
  snprintf(display->display_ref, sizeof(display->display_ref), "display-1");
  return true;
}

static bool fixture_scan(void *context,
                         const char *after,
                         uint64_t tag,
                         bool requireOwn,
                         uint64_t timeout,
                         MetaReadinessEventScan *scan) {
  FixtureState *state = context;
  if (after == NULL || tag == 0 || timeout == 0 || timeout > 250) {
    return false;
  }
  const char *expected = state->posts == 1 && requireOwn
                             ? "cursor-0"
                             : "cursor-1";
  if (strcmp(after, expected) != 0) return false;
  *scan = (MetaReadinessEventScan){
    .state = requireOwn ? META_READINESS_SCAN_OWN_EVENT_ONLY
                        : META_READINESS_SCAN_NO_EVENTS,
    .synthetic_tag = requireOwn ? tag : 0,
  };
  if (requireOwn && state->tags[state->posts - 1] != tag) return false;
  snprintf(scan->cursor, sizeof(scan->cursor), "cursor-%zu", state->posts);
  return true;
}

static NSDictionary *fixture_coverage(NSDictionary *generation,
                                      BOOL ready,
                                      NSUInteger posts) {
  NSString *now = @"2026-09-15T10:00:00.000Z";
  NSMutableDictionary *coverage = [generation mutableCopy];
  [coverage addEntriesFromDictionary:@{
    @"state" : ready ? @"ready" : @"unavailable",
    @"coverageStartCursor" : @"cursor-0",
    @"cursor" : [NSString stringWithFormat:@"cursor-%lu",
                                            (unsigned long)posts],
    @"nextSequence" : @(posts + 1),
    @"startedAt" : now,
    @"coveredFrom" : now,
    @"coveredThrough" : now,
    @"heartbeatAt" : now,
    @"coveredKinds" : ready
        ? @[@"input", @"focus", @"window-structure", @"lifecycle"]
        : @[],
    @"droppedEvents" : @0,
    @"gapDetected" : @NO,
  }];
  if (!ready) coverage[@"reason"] = @"Fixture observer unavailable";
  return coverage;
}

@interface ReadinessFixtureBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithObserverReady:(BOOL)observerReady;
@end

@implementation ReadinessFixtureBackend {
  FixtureState _state;
  MetaInputExecutor *_input;
}

- (instancetype)initWithObserverReady:(BOOL)observerReady {
  self = [super init];
  if (self) {
    _state = (FixtureState){
      .observer_ready = observerReady,
      .cursor = {100, 50},
    };
    MetaExecutorBackend sink = {
      .context = &_state,
      .monotonic_millis = fixture_clock,
      .verify_target = fixture_verify,
      .post_pointer_event = fixture_pointer,
    };
    _input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-readiness-fixture"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"display-1"];
                    }];
    [_input setScopedPointVerifier:^BOOL(NSDictionary *target,
                                         double x,
                                         double y) {
      return [target[@"kind"] isEqual:@"display"] &&
             [target[@"ref"][@"displayRef"] isEqual:@"display-1"] &&
             x >= 0 && x < 200 && y >= 0 && y < 100;
    }];
  }
  return self;
}

- (NSDictionary *)sessionIdentity {
  return @{
    @"verified" : @NO,
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"reason" : @"Injected fixture не вызывает audit syscall",
  };
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation { return [_input sealForRotation]; }

- (NSDictionary *)executeReadiness:(NSDictionary *)request
                                job:(MetaInputJob *)job {
  NSDictionary *generation = @{
    @"runtimeEpoch" : request[@"runtimeEpoch"],
    @"loginSessionId" : request[@"loginSessionId"],
    @"nativeGeneration" : request[@"nativeGeneration"],
  };
  [job setObserverCoverageProvider:^NSDictionary * {
    return fixture_coverage(generation, self->_state.observer_ready,
                            self->_state.posts);
  }];
  MetaExecutor *executor = [_input executorOnActionWorker];
  meta_executor_set_observer_state(
      executor, _state.observer_ready ? META_OBSERVER_READY
                                      : META_OBSERVER_UNAVAILABLE);
  MetaInputReadinessBackend backend = {
    .context = &_state,
    .read_session = fixture_session,
    .read_permissions = fixture_permissions,
    .read_observer = fixture_observer,
    .read_cursor = fixture_cursor,
    .resolve_display = fixture_display,
    .scan_events = fixture_scan,
  };
  MetaReadinessCommandBinder *binder = [[MetaReadinessCommandBinder alloc]
      initWithGeneration:generation
                 backend:backend
                     now:^NSDate * { return NSDate.date; }];
  NSString *displayRef = request[@"payload"][@"expectedDisplayRef"][@"displayRef"];
  __block MetaReadinessCommandOutcome *outcome = nil;
  NSDictionary *execution = [_input
      executePrimitive:request
                   job:job
             targetRef:displayRef
                verify:^BOOL(NSString *target) {
                  return [target isEqual:@"display-1"];
                }
                action:^NSDictionary * {
                  outcome = [binder handleRequest:request
                                  currentRequestId:job.requestId
                                  currentOperation:job.operation
                                          executor:executor
                                             error:NULL];
                  if (outcome == nil) return nil;
                  if (![outcome.result[@"inputReady"] isEqual:@YES]) {
                    meta_executor_fail(executor, "readiness-not-ready");
                  }
                  return outcome.result;
                }];
  if (execution == nil || execution[@"value"] == nil ||
      execution[@"status"] == nil) {
    return nil;
  }
  return @{
    @"value" : execution[@"value"],
    @"status" : execution[@"status"],
  };
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    BOOL ready = !(argc == 2 &&
                   strcmp(argv[1], "--observer-unavailable") == 0);
    return meta_command_loop_run(
        [[ReadinessFixtureBackend alloc] initWithObserverReady:ready],
        @"readiness-fixture-build",
        @"/tmp/readiness-fixture",
        @"native-readiness-fixture",
        STDIN_FILENO,
        STDOUT_FILENO);
  }
}
