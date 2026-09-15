#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "application-bundles/meta_application_bundles.h"
#include "application-command/meta_application_command.h"
#include "recovery-domain/meta_recovery_domain.h"

#include <string.h>
#include <unistd.h>

typedef NS_ENUM(NSInteger, FixtureMode) {
  FixtureModeSuccess,
  FixtureModeCancel,
  FixtureModeDeadline,
  FixtureModeQuitUnknown,
};

typedef struct {
  uint64_t now;
  MetaApplicationLaunchCompletion completion;
  void *completion_context;
  MetaApplicationProcess current;
  FixtureMode mode;
  NSUInteger launch_calls;
  NSUInteger activation_calls;
  NSUInteger terminate_calls;
} FixtureState;

static void copy_text(char *target, size_t capacity, const char *source) {
  snprintf(target, capacity, "%s", source == NULL ? "" : source);
}

static MetaApplicationProcess fixture_process(void) {
  MetaApplicationProcess value = {
    .pid = 501,
    .launch_time_micros = 1000000,
  };
  copy_text(value.bundle_id, sizeof(value.bundle_id), "com.example.fixture");
  return value;
}

static uint64_t fixture_now(void *context) {
  return ((FixtureState *)context)->now;
}

static void fixture_wait(void *context, uint64_t millis) {
  FixtureState *state = context;
  state->now += millis;
  usleep(1000);
}

static MetaApplicationWorkspaceLaunchStart fixture_start_launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationLaunchCompletion completion,
    void *completion_context) {
  FixtureState *state = context;
  state->launch_calls += 1;
  state->completion = completion;
  state->completion_context = completion_context;
  if (state->mode == FixtureModeDeadline) {
    return META_APPLICATION_LAUNCH_ENQUEUED;
  }
  const uint64_t delay = state->mode == FixtureModeCancel ? 300 : 20;
  MetaApplicationProcess process = fixture_process();
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay * NSEC_PER_MSEC),
      dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        MetaApplicationLaunchCompletion callback = state->completion;
        if (callback == NULL) return;
        state->completion = NULL;
        state->current = process;
        callback(state->completion_context,
                 META_APPLICATION_LAUNCH_CALLBACK_COMPLETED,
                 &process,
                 false,
                 NULL);
      });
  (void)request;
  return META_APPLICATION_LAUNCH_ENQUEUED;
}

static MetaApplicationActivationStatus fixture_activate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  FixtureState *state = context;
  if (state->now >= deadline_millis || expected == NULL ||
      expected->pid != state->current.pid) {
    return META_APPLICATION_ACTIVATION_EXPIRED;
  }
  state->activation_calls += 1;
  return META_APPLICATION_ACTIVATION_SUCCEEDED;
}

static MetaApplicationLookupStatus fixture_lookup(
    void *context,
    int32_t pid,
    MetaApplicationProcess *process) {
  FixtureState *state = context;
  if (state->mode == FixtureModeQuitUnknown && state->terminate_calls > 0) {
    return META_APPLICATION_LOOKUP_FAILED;
  }
  if (state->current.pid == 0) return META_APPLICATION_LOOKUP_ABSENT;
  if (pid != state->current.pid) return META_APPLICATION_LOOKUP_FAILED;
  *process = state->current;
  return META_APPLICATION_LOOKUP_FOUND;
}

static MetaApplicationWorkspaceTerminateStatus fixture_terminate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  FixtureState *state = context;
  if (state->now >= deadline_millis || expected == NULL ||
      expected->pid != state->current.pid) {
    return META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH;
  }
  state->terminate_calls += 1;
  if (state->mode != FixtureModeQuitUnknown) state->current.pid = 0;
  return META_APPLICATION_TERMINATE_ACCEPTED;
}

static MetaApplicationBackend fixture_backend(FixtureState *state) {
  return (MetaApplicationBackend){
    .context = state,
    .monotonic_millis = fixture_now,
    .start_launch = fixture_start_launch,
    .activate = fixture_activate,
    .lookup = fixture_lookup,
    .terminate = fixture_terminate,
    .wait_millis = fixture_wait,
  };
}

static bool fixture_dispatch(void *context) {
  BOOL (^action)(void) = (__bridge BOOL (^)(void))context;
  return action();
}

@interface ApplicationFixtureBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithBundlePath:(NSString *)bundlePath
                               mode:(FixtureMode)mode;
@end

@implementation ApplicationFixtureBackend {
  NSString *_bundlePath;
  FixtureState _state;
  MetaApplicationBundles *_bundles;
  MetaApplicationCommandBinder *_applications;
  MetaInputExecutor *_input;
}

- (instancetype)initWithBundlePath:(NSString *)bundlePath
                               mode:(FixtureMode)mode {
  self = [super init];
  if (self) {
    _bundlePath = [bundlePath copy];
    _state = (FixtureState){
      .now = 100,
      .mode = mode,
    };
    NSDictionary *generation = @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-application-fixture",
    };
    _bundles = [[MetaApplicationBundles alloc]
        initWithGeneration:generation];
    __weak ApplicationFixtureBackend *weakSelf = self;
    _applications = [[MetaApplicationCommandBinder alloc]
        initWithGeneration:generation
                    bundles:_bundles
                    backend:fixture_backend(&_state)
          candidateResolver:^NSDictionary *(
              const MetaApplicationProcess *candidate,
              __unused NSDictionary *operation) {
            ApplicationFixtureBackend *owner = weakSelf;
            if (owner == nil || candidate == NULL) return nil;
            return [owner recordForProcess:*candidate];
          }
          referenceResolver:^NSDictionary *(NSDictionary *reference) {
            ApplicationFixtureBackend *owner = weakSelf;
            if (owner == nil ||
                ![reference[@"applicationRef"]
                    isEqual:@"application-1"] ||
                owner->_state.current.pid == 0) {
              return nil;
            }
            return [owner recordForProcess:owner->_state.current];
          }];
    _input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-application-fixture"
                      sink:(MetaExecutorBackend){0}
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"application-1"] ||
                             [target hasPrefix:@"bundle-"];
                    }];
  }
  return self;
}

- (NSDictionary *)recordForProcess:(MetaApplicationProcess)process {
  return @{
    @"applicationRef" : @"application-1",
    @"pid" : @(process.pid),
    @"launchTimeMicros" : @(process.launch_time_micros),
    @"launchedAt" : @"2026-09-15T10:00:00.000Z",
    @"registrationNonce" : @"application-nonce-1",
    @"bundleId" : @(process.bundle_id),
  };
}

- (NSString *)recoveryDomainVersion { return @"1"; }
- (BOOL)validateRecoveryRequest:(NSDictionary *)request {
  return meta_recovery_domain_validate_request(
      request, @"application-fixture-build", NULL, NULL);
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
- (NSArray<NSDictionary *> *)capabilityCatalog {
  return @[
    @{@"id" : @"runtime.identity", @"state" : @"ready"},
    @{@"id" : @"desktop.applications", @"state" : @"ready"},
    @{@"id" : @"desktop.application.lifecycle", @"state" : @"ready"},
  ];
}

- (NSDictionary *)resolveApplication:(NSDictionary *)request {
  if (![request[@"payload"][@"path"] isEqual:_bundlePath]) return nil;
  return [_applications
      resolve:request[@"payload"]
      evidence:@{
        @"sourceResponseRef" : @"application-source-1",
        @"inventoryId" : @"inventory-1",
        @"inventoryRevision" : @7,
        @"observedAt" : @"2026-09-15T10:00:00.000Z",
      }];
}

- (NSDictionary *)executeApplication:(NSDictionary *)request
                                  job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  NSDictionary *payload = request[@"payload"];
  BOOL launch = [request[@"method"] isEqual:@"application.launch"];
  NSDictionary *reference = launch ? payload[@"bundle"]
                                   : payload[@"application"];
  NSString *targetRef = launch ? reference[@"bundleRef"]
                               : reference[@"applicationRef"];
  if (![reference isEqual:operation[@"target"][@"ref"]] ||
      ![operation[@"inventoryId"] isEqual:@"inventory-1"] ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != 7 ||
      ![targetRef isKindOfClass:NSString.class]) {
    return nil;
  }
  const uint64_t budget = _state.mode == FixtureModeDeadline ? 40 : 1000;
  const uint64_t deadline = _state.now + budget;
  __block NSString *taskRef = nil;
  __block BOOL quitConfirmed = NO;
  NSDictionary *execution = [_input
      executeExternal:request
                   job:job
             targetRef:targetRef
                verify:^BOOL(NSString *value) {
                  if (![value isEqual:targetRef]) return NO;
                  return launch
                             ? [self->_bundles validateReference:reference]
                             : quitConfirmed ||
                                   self->_state.current.pid ==
                                       [reference[@"pid"] intValue];
                }
                action:^NSDictionary * {
                  if (!launch) {
                    NSDictionary *quit = [self->_applications
                        quit:payload
                        operation:operation
                        deadlineMillis:deadline];
                    quitConfirmed = [quit[@"value"][@"state"]
                        isEqual:@"terminated"];
                    return quit;
                  }
                  NSDictionary *state = [self->_applications
                      startLaunch:payload
                      operation:operation
                      requestId:job.requestId
                      deadlineMillis:deadline];
                  taskRef = state[@"launchTaskRef"];
                  while (![state[@"drained"] boolValue] &&
                         ![job cancelRequested] &&
                         self->_state.now < deadline) {
                    fixture_wait(&self->_state, 10);
                    state = [self->_applications
                        launchStatus:taskRef
                        requestId:job.requestId];
                  }
                  if (![state[@"drained"] boolValue] ||
                      [job cancelRequested]) {
                    [job requestCancel];
                    [self->_applications cancelLaunch:taskRef
                                            requestId:job.requestId];
                  }
                  state = [self->_applications
                      finalizeLaunch:taskRef
                      requestId:job.requestId];
                  if ([payload[@"activate"] boolValue] &&
                      [state[@"value"][@"state"] isEqual:@"running"] &&
                      ![job cancelRequested]) {
                    BOOL (^activate)(void) = ^BOOL {
                      return [self->_applications
                                 activateLaunch:taskRef
                                 deadlineMillis:deadline] != nil;
                    };
                    meta_executor_dispatch_action(
                        [self->_input executorOnActionWorker],
                        fixture_dispatch,
                        (__bridge void *)activate,
                        "application-activate-fixture");
                    state = [self->_applications
                        finalizeLaunch:taskRef
                        requestId:job.requestId];
                  }
                  return state;
                }];
  if (execution == nil) return nil;
  NSDictionary *state = execution[@"value"];
  NSDictionary *value = state[@"value"];
  if (launch) {
    if (value == nil ||
        ([value[@"state"] isEqual:@"running"] &&
         ![execution[@"finished"] boolValue])) {
      NSString *reason = @"Launch callback, cancellation или deadline не подтвердили running outcome";
      NSMutableDictionary *unknown = [@{
        @"state" : @"unknown",
        @"reason" : reason,
        @"errors" : @[@{
          @"code" : @"operation-outcome-unknown",
          @"message" : reason,
          @"stage" : @"application-launch-fixture",
          @"retryable" : @NO,
          @"replayAllowed" : @NO,
          @"recoveryAction" : @"get-operation",
        }],
      } mutableCopy];
      if ([value[@"application"] isKindOfClass:NSDictionary.class])
        unknown[@"candidate"] = value[@"application"];
      value = unknown;
    }
    if ([state[@"effectiveTerminal"] boolValue])
      [_applications releaseLaunch:taskRef];
  } else if (value != nil &&
             ![value[@"state"] isEqual:@"unknown"] &&
             ![execution[@"finished"] boolValue]) {
    NSString *reason = @"Quit result вернулся без подтверждённого parent finish";
    value = @{
      @"state" : @"unknown",
      @"application" : reference,
      @"reason" : reason,
      @"errors" : @[@{
        @"code" : @"operation-outcome-unknown",
        @"message" : reason,
        @"stage" : @"application-quit-fixture",
        @"retryable" : @NO,
        @"replayAllowed" : @NO,
        @"recoveryAction" : @"get-operation",
      }],
    };
  }
  if (value == nil) return nil;
  return @{@"value" : value, @"status" : execution[@"status"]};
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request {
  (void)request;
  return @{};
}
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation {
  [_applications drainLaunchesUntil:_state.now + 50];
  return [_input sealForRotation];
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) return 64;
    FixtureMode mode = FixtureModeSuccess;
    if (argc == 3 && strcmp(argv[2], "--cancel") == 0)
      mode = FixtureModeCancel;
    else if (argc == 3 && strcmp(argv[2], "--deadline") == 0)
      mode = FixtureModeDeadline;
    else if (argc == 3 && strcmp(argv[2], "--quit-unknown") == 0)
      mode = FixtureModeQuitUnknown;
    return meta_command_loop_run(
        [[ApplicationFixtureBackend alloc]
            initWithBundlePath:@(argv[1])
                           mode:mode],
        @"application-fixture-build",
        @"/tmp/application-fixture",
        @"native-application-fixture",
        STDIN_FILENO,
        STDOUT_FILENO);
  }
}
