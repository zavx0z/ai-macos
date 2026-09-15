#include "meta_application_command.h"

#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <time.h>

typedef struct {
  uint64_t now;
  MetaApplicationLaunchCompletion completion;
  void *completion_context;
  MetaApplicationLaunchRequest captured_launch;
  size_t activation_calls;
  MetaApplicationProcess current;
  MetaApplicationWorkspaceTerminateStatus terminate_status;
} Fixture;

typedef struct {
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  bool block_clock;
  bool clock_entered;
  bool allow_clock;
  bool block_candidate;
  bool candidate_entered;
  bool allow_candidate;
} ConcurrentGate;

static ConcurrentGate concurrent_gate = {
    .mutex = PTHREAD_MUTEX_INITIALIZER,
    .condition = PTHREAD_COND_INITIALIZER,
};

static void reset_gate(void) {
  pthread_mutex_lock(&concurrent_gate.mutex);
  concurrent_gate.block_clock = false;
  concurrent_gate.clock_entered = false;
  concurrent_gate.allow_clock = false;
  concurrent_gate.block_candidate = false;
  concurrent_gate.candidate_entered = false;
  concurrent_gate.allow_candidate = false;
  pthread_mutex_unlock(&concurrent_gate.mutex);
}

static void wait_for_gate(bool *entered) {
  struct timespec deadline;
  assert(clock_gettime(CLOCK_REALTIME, &deadline) == 0);
  deadline.tv_sec += 2;
  pthread_mutex_lock(&concurrent_gate.mutex);
  while (!*entered) {
    int result = pthread_cond_timedwait(&concurrent_gate.condition,
                                        &concurrent_gate.mutex, &deadline);
    assert(result == 0);
  }
  pthread_mutex_unlock(&concurrent_gate.mutex);
}

static void open_gate(bool *allowed) {
  pthread_mutex_lock(&concurrent_gate.mutex);
  *allowed = true;
  pthread_cond_broadcast(&concurrent_gate.condition);
  pthread_mutex_unlock(&concurrent_gate.mutex);
}

static void candidate_checkpoint(void) {
  pthread_mutex_lock(&concurrent_gate.mutex);
  if (concurrent_gate.block_candidate) {
    concurrent_gate.candidate_entered = true;
    pthread_cond_broadcast(&concurrent_gate.condition);
    while (!concurrent_gate.allow_candidate) {
      pthread_cond_wait(&concurrent_gate.condition, &concurrent_gate.mutex);
    }
  }
  pthread_mutex_unlock(&concurrent_gate.mutex);
}

static void copy_text(char *target, size_t capacity, const char *source) {
  snprintf(target, capacity, "%s", source);
}

static MetaApplicationProcess process(int32_t pid,
                                      uint64_t started,
                                      const char *bundle) {
  MetaApplicationProcess value = {
      .pid = pid,
      .launch_time_micros = started,
  };
  copy_text(value.bundle_id, sizeof(value.bundle_id), bundle);
  return value;
}

static uint64_t now(void *context) {
  pthread_mutex_lock(&concurrent_gate.mutex);
  if (concurrent_gate.block_clock) {
    concurrent_gate.clock_entered = true;
    pthread_cond_broadcast(&concurrent_gate.condition);
    while (!concurrent_gate.allow_clock) {
      pthread_cond_wait(&concurrent_gate.condition, &concurrent_gate.mutex);
    }
  }
  pthread_mutex_unlock(&concurrent_gate.mutex);
  return ((Fixture *)context)->now;
}

static void wait_millis(void *context, uint64_t millis) {
  ((Fixture *)context)->now += millis;
}

static MetaApplicationWorkspaceLaunchStart start_launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationLaunchCompletion completion,
    void *completion_context) {
  Fixture *fixture = context;
  fixture->captured_launch = *request;
  fixture->completion = completion;
  fixture->completion_context = completion_context;
  return META_APPLICATION_LAUNCH_ENQUEUED;
}

static MetaApplicationActivationStatus activate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  Fixture *fixture = context;
  assert(fixture->now < deadline_millis);
  assert(expected->pid == fixture->current.pid);
  fixture->activation_calls += 1;
  return META_APPLICATION_ACTIVATION_SUCCEEDED;
}

static MetaApplicationLookupStatus lookup(
    void *context,
    int32_t pid,
    MetaApplicationProcess *value) {
  Fixture *fixture = context;
  if (fixture->current.pid == 0) return META_APPLICATION_LOOKUP_ABSENT;
  assert(pid == fixture->current.pid);
  *value = fixture->current;
  return META_APPLICATION_LOOKUP_FOUND;
}

static MetaApplicationWorkspaceTerminateStatus terminate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  Fixture *fixture = context;
  assert(fixture->now < deadline_millis);
  assert(expected->pid == fixture->current.pid);
  return fixture->terminate_status;
}

static MetaApplicationBackend backend(Fixture *fixture) {
  return (MetaApplicationBackend){
      .context = fixture,
      .monotonic_millis = now,
      .start_launch = start_launch,
      .activate = activate,
      .lookup = lookup,
      .terminate = terminate,
      .wait_millis = wait_millis,
  };
}

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch": @"runtime-1",
    @"loginSessionId": @"login-1",
    @"nativeGeneration": @"native-1",
  };
}

static NSString *create_bundle(void) {
  NSString *root = [NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  NSString *bundle = [root stringByAppendingPathComponent:@"Fixture.app"];
  NSString *contents = [bundle stringByAppendingPathComponent:@"Contents"];
  assert([NSFileManager.defaultManager createDirectoryAtPath:contents
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:NULL]);
  NSDictionary *info = @{@"CFBundleIdentifier": @"com.example.fixture"};
  assert([info writeToFile:[contents stringByAppendingPathComponent:
                                      @"Info.plist"]
                atomically:YES]);
  return bundle;
}

static NSDictionary *operation(NSDictionary *target) {
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"operationId": @"operation-1",
    @"target": target,
    @"fence": @{
      @"runtimeEpoch": @"runtime-1",
      @"loginSessionId": @"login-1",
      @"nativeGeneration": @"native-1",
      @"counter": @7,
    },
  }];
  return value;
}

static NSDictionary *record(MetaApplicationProcess process) {
  return @{
    @"applicationRef": @"native-1:app:7",
    @"pid": @(process.pid),
    @"launchTimeMicros": @(process.launch_time_micros),
    @"launchedAt": @"2026-09-15T12:00:00.000Z",
    @"registrationNonce": @"app-7",
    @"bundleId": @(process.bundle_id),
  };
}

static MetaApplicationCommandBinder *binder(
    Fixture *fixture,
    MetaApplicationBundles *bundles,
    size_t *candidate_resolutions) {
  return [[MetaApplicationCommandBinder alloc]
      initWithGeneration:generation()
                  bundles:bundles
                  backend:backend(fixture)
        candidateResolver:^NSDictionary *(const MetaApplicationProcess *candidate,
                                           __unused NSDictionary *operation) {
          candidate_checkpoint();
          *candidate_resolutions += 1;
          return record(*candidate);
        }
        referenceResolver:^NSDictionary *(NSDictionary *reference) {
          if (![reference[@"applicationRef"] isEqual:@"native-1:app:7"])
            return nil;
          return record(fixture->current);
        }];
}

static NSDictionary *resolve_bundle(MetaApplicationCommandBinder *binder,
                                    NSString *path) {
  return [binder resolve:@{@"path": path,
                           @"bundleId": @"com.example.fixture"}
                 evidence:@{
                   @"sourceResponseRef": @"source-app-1",
                   @"inventoryId": @"inventory-1",
                   @"inventoryRevision": @3,
                   @"observedAt": @"2026-09-15T12:00:00.000Z",
                 }];
}

static void complete(Fixture *fixture, MetaApplicationProcess candidate) {
  assert(fixture->completion != NULL);
  MetaApplicationLaunchCompletion callback = fixture->completion;
  fixture->completion = NULL;
  callback(fixture->completion_context,
           META_APPLICATION_LAUNCH_CALLBACK_COMPLETED, &candidate, false,
           NULL);
}

typedef enum {
  CONCURRENT_LAUNCH_STATUS,
  CONCURRENT_LAUNCH_FINALIZE,
  CONCURRENT_LAUNCH_CANCEL,
} ConcurrentLaunchCallKind;

typedef struct {
  __unsafe_unretained MetaApplicationCommandBinder *binder;
  __unsafe_unretained NSString *task_ref;
  ConcurrentLaunchCallKind kind;
  bool result_present;
} ConcurrentLaunchCall;

static void *run_concurrent_launch_call(void *context) {
  ConcurrentLaunchCall *call = context;
  @autoreleasepool {
    NSDictionary *result = nil;
    switch (call->kind) {
      case CONCURRENT_LAUNCH_STATUS:
        result = [call->binder launchStatus:call->task_ref
                                  requestId:@"concurrent-status"];
        break;
      case CONCURRENT_LAUNCH_FINALIZE:
        result = [call->binder finalizeLaunch:call->task_ref
                                    requestId:@"concurrent-finalize"];
        break;
      case CONCURRENT_LAUNCH_CANCEL:
        result = [call->binder cancelLaunch:call->task_ref
                                  requestId:@"concurrent-cancel"];
        break;
    }
    call->result_present = result != nil;
  }
  return NULL;
}

static NSString *start_bound_launch(MetaApplicationCommandBinder *owner,
                                    NSDictionary *target,
                                    BOOL activate_requested,
                                    NSString *request_id) {
  NSDictionary *started = [owner startLaunch:@{
    @"bundle": target[@"ref"],
    @"activate": @(activate_requested),
    @"newInstance": @NO,
  } operation:operation(target) requestId:request_id
                         deadlineMillis:1000];
  assert(started != nil);
  return started[@"launchTaskRef"];
}

static void test_resolve_launch_finalize_activate(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
  };
  size_t resolutions = 0;
  NSString *bundlePath = create_bundle();
  MetaApplicationBundles *bundles = [[MetaApplicationBundles alloc]
      initWithGeneration:generation()];
  MetaApplicationCommandBinder *owner = binder(&fixture, bundles, &resolutions);
  NSDictionary *resolution = resolve_bundle(owner, bundlePath);
  assert([resolution[@"requestedPath"] isEqual:bundlePath]);
  NSDictionary *target = resolution[@"target"];
  NSDictionary *request = @{
    @"bundle": target[@"ref"],
    @"activate": @YES,
    @"newInstance": @NO,
  };
  NSDictionary *started = [owner startLaunch:request
                                    operation:operation(target)
                                    requestId:@"request-launch-1"
                               deadlineMillis:1000];
  NSString *taskRef = started[@"launchTaskRef"];
  assert([started[@"effectiveTerminal"] isEqual:@NO]);
  assert(!fixture.captured_launch.activate);
  complete(&fixture, fixture.current);
  NSDictionary *physical = [owner launchStatus:taskRef
                                      requestId:@"status-1"];
  assert([physical[@"drained"] isEqual:@YES]);
  assert([physical[@"effectiveTerminal"] isEqual:@NO]);
  assert(resolutions == 0);
  NSDictionary *mapped = [owner finalizeLaunch:taskRef
                                      requestId:@"status-2"];
  assert([mapped[@"value"][@"state"] isEqual:@"running"]);
  assert([mapped[@"effectiveTerminal"] isEqual:@NO]);
  assert(resolutions == 1);
  assert(![owner releaseLaunch:taskRef]);
  NSDictionary *activated = [owner activateLaunch:taskRef
                                    deadlineMillis:1000];
  assert([activated[@"effectiveTerminal"] isEqual:@YES]);
  assert([activated[@"parentActivationSucceeded"] isEqual:@YES]);
  assert(fixture.activation_calls == 1);
  assert([owner releaseLaunch:taskRef]);
  [NSFileManager.defaultManager removeItemAtPath:[bundlePath
      stringByDeletingLastPathComponent] error:NULL];
}

static void test_pending_drain_and_late_candidate(void) {
  Fixture fixture = {
      .current = process(502, 2000000, "com.example.fixture"),
  };
  size_t resolutions = 0;
  NSString *bundlePath = create_bundle();
  MetaApplicationBundles *bundles = [[MetaApplicationBundles alloc]
      initWithGeneration:generation()];
  MetaApplicationCommandBinder *owner = binder(&fixture, bundles, &resolutions);
  NSDictionary *resolution = resolve_bundle(owner, bundlePath);
  NSDictionary *target = resolution[@"target"];
  NSDictionary *started = [owner startLaunch:@{
    @"bundle": target[@"ref"],
    @"activate": @NO,
    @"newInstance": @YES,
  } operation:operation(target) requestId:@"request-launch-2"
                         deadlineMillis:20];
  NSString *taskRef = started[@"launchTaskRef"];
  NSDictionary *drain = [owner drainLaunchesUntil:30];
  assert([drain[@"drained"] isEqual:@NO]);
  assert([drain[@"activeLaunchTaskRefs"] containsObject:taskRef]);
  assert(![owner releaseLaunch:taskRef]);
  complete(&fixture, fixture.current);
  NSDictionary *mapped = [owner finalizeLaunch:taskRef
                                      requestId:@"status-late"];
  assert([mapped[@"value"][@"state"] isEqual:@"unknown"]);
  assert(mapped[@"value"][@"candidate"] != nil);
  assert([mapped[@"effectiveTerminal"] isEqual:@YES]);
  assert(resolutions == 1 && [owner releaseLaunch:taskRef]);
  NSDictionary *afterDrain = [owner startLaunch:@{
    @"bundle": target[@"ref"], @"activate": @NO, @"newInstance": @NO,
  } operation:operation(target) requestId:@"request-after-drain"
               deadlineMillis:100];
  assert(afterDrain == nil);
  [NSFileManager.defaultManager removeItemAtPath:[bundlePath
      stringByDeletingLastPathComponent] error:NULL];
}

static void test_concurrent_borrows_block_terminal_release(void) {
  reset_gate();
  Fixture fixture = {
      .current = process(504, 4000000, "com.example.fixture"),
  };
  size_t resolutions = 0;
  NSString *bundlePath = create_bundle();
  MetaApplicationBundles *bundles = [[MetaApplicationBundles alloc]
      initWithGeneration:generation()];
  MetaApplicationCommandBinder *owner = binder(&fixture, bundles, &resolutions);
  NSDictionary *target = resolve_bundle(owner, bundlePath)[@"target"];

  NSString *statusTask = start_bound_launch(
      owner, target, NO, @"request-concurrent-status");
  pthread_mutex_lock(&concurrent_gate.mutex);
  concurrent_gate.block_clock = true;
  pthread_mutex_unlock(&concurrent_gate.mutex);
  ConcurrentLaunchCall statusCall = {
      .binder = owner,
      .task_ref = statusTask,
      .kind = CONCURRENT_LAUNCH_STATUS,
  };
  pthread_t statusThread;
  assert(pthread_create(&statusThread, NULL, run_concurrent_launch_call,
                        &statusCall) == 0);
  wait_for_gate(&concurrent_gate.clock_entered);
  assert(![owner releaseLaunch:statusTask]);
  open_gate(&concurrent_gate.allow_clock);
  assert(pthread_join(statusThread, NULL) == 0);
  assert(statusCall.result_present);
  reset_gate();
  complete(&fixture, fixture.current);
  assert([owner finalizeLaunch:statusTask requestId:@"status-final"] != nil);
  assert([owner releaseLaunch:statusTask]);

  NSString *finalizeTask = start_bound_launch(
      owner, target, NO, @"request-concurrent-finalize");
  complete(&fixture, fixture.current);
  pthread_mutex_lock(&concurrent_gate.mutex);
  concurrent_gate.block_candidate = true;
  pthread_mutex_unlock(&concurrent_gate.mutex);
  ConcurrentLaunchCall finalizeCall = {
      .binder = owner,
      .task_ref = finalizeTask,
      .kind = CONCURRENT_LAUNCH_FINALIZE,
  };
  pthread_t finalizeThread;
  assert(pthread_create(&finalizeThread, NULL, run_concurrent_launch_call,
                        &finalizeCall) == 0);
  wait_for_gate(&concurrent_gate.candidate_entered);
  assert(![owner releaseLaunch:finalizeTask]);
  open_gate(&concurrent_gate.allow_candidate);
  assert(pthread_join(finalizeThread, NULL) == 0);
  assert(finalizeCall.result_present);
  reset_gate();
  assert([owner releaseLaunch:finalizeTask]);

  NSString *cancelTask = start_bound_launch(
      owner, target, NO, @"request-concurrent-cancel");
  pthread_mutex_lock(&concurrent_gate.mutex);
  concurrent_gate.block_clock = true;
  pthread_mutex_unlock(&concurrent_gate.mutex);
  ConcurrentLaunchCall cancelCall = {
      .binder = owner,
      .task_ref = cancelTask,
      .kind = CONCURRENT_LAUNCH_CANCEL,
  };
  pthread_t cancelThread;
  assert(pthread_create(&cancelThread, NULL, run_concurrent_launch_call,
                        &cancelCall) == 0);
  wait_for_gate(&concurrent_gate.clock_entered);
  assert(![owner releaseLaunch:cancelTask]);
  open_gate(&concurrent_gate.allow_clock);
  assert(pthread_join(cancelThread, NULL) == 0);
  assert(cancelCall.result_present);
  reset_gate();
  complete(&fixture, fixture.current);
  assert([owner finalizeLaunch:cancelTask requestId:@"cancel-final"] != nil);
  assert([owner releaseLaunch:cancelTask]);
  assert([owner activeLaunchCount] == 0);
  [NSFileManager.defaultManager removeItemAtPath:[bundlePath
      stringByDeletingLastPathComponent] error:NULL];
}

static void test_quit_still_running_uses_exact_reference(void) {
  Fixture fixture = {
      .current = process(503, 3000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
  };
  size_t resolutions = 0;
  MetaApplicationBundles *bundles = [[MetaApplicationBundles alloc]
      initWithGeneration:generation()];
  MetaApplicationCommandBinder *owner = binder(&fixture, bundles, &resolutions);
  NSMutableDictionary *application = [generation() mutableCopy];
  [application addEntriesFromDictionary:@{
    @"applicationRef": @"native-1:app:7",
    @"pid": @(fixture.current.pid),
    @"launchedAt": @"2026-09-15T12:00:00.000Z",
    @"registrationNonce": @"app-7",
  }];
  NSDictionary *result = [owner quit:@{@"application": application}
                           operation:operation(@{
                             @"kind": @"application",
                             @"ref": application,
                           })
                      deadlineMillis:25];
  assert([result[@"value"][@"state"] isEqual:@"still-running"]);
  assert([result[@"value"][@"attentionMayBeRequired"] isEqual:@YES]);
}

int main(void) {
  @autoreleasepool {
    test_resolve_launch_finalize_activate();
    test_pending_drain_and_late_candidate();
    test_concurrent_borrows_block_terminal_release();
    test_quit_still_running_uses_exact_reference();
    puts("application command binder tests passed");
  }
  return 0;
}
