#include "meta_application_controller.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t now;
  uint64_t lookup_step;
  MetaApplicationWorkspaceLaunchStart launch_start;
  MetaApplicationProcess launch_process;
  bool reused;
  bool complete_immediately;
  MetaApplicationLaunchCompletion launch_completion;
  void *launch_completion_context;
  MetaApplicationActivationStatus activation_status;
  size_t activation_calls;
  MetaApplicationWorkspaceTerminateStatus terminate_status;
  size_t terminate_calls;
  size_t lookup_calls;
  size_t disappear_after_lookup;
  bool replacement_after_terminate;
  MetaApplicationProcess current;
} Fixture;

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
  return ((Fixture *)context)->now;
}

static MetaApplicationWorkspaceLaunchStart start_launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationLaunchCompletion completion,
    void *completion_context) {
  Fixture *fixture = context;
  assert(strcmp(request->application_url, "/Applications/Fixture.app") == 0);
  fixture->launch_completion = completion;
  fixture->launch_completion_context = completion_context;
  if (fixture->complete_immediately &&
      fixture->launch_start == META_APPLICATION_LAUNCH_ENQUEUED) {
    completion(completion_context, META_APPLICATION_LAUNCH_CALLBACK_COMPLETED,
               &fixture->launch_process, fixture->reused, NULL);
  }
  return fixture->launch_start;
}

static MetaApplicationActivationStatus activate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  Fixture *fixture = context;
  fixture->activation_calls += 1;
  assert(fixture->now < deadline_millis);
  assert(expected->pid == fixture->launch_process.pid);
  return fixture->activation_status;
}

static MetaApplicationLookupStatus lookup(
    void *context,
    int32_t pid,
    MetaApplicationProcess *value) {
  Fixture *fixture = context;
  fixture->lookup_calls += 1;
  fixture->now += fixture->lookup_step;
  if (fixture->disappear_after_lookup > 0 &&
      fixture->lookup_calls >= fixture->disappear_after_lookup) {
    if (!fixture->replacement_after_terminate) {
      return META_APPLICATION_LOOKUP_ABSENT;
    }
    *value = process(pid, fixture->current.launch_time_micros + 1,
                     fixture->current.bundle_id);
    return META_APPLICATION_LOOKUP_FOUND;
  }
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
  fixture->terminate_calls += 1;
  assert(fixture->now < deadline_millis);
  assert(expected->pid == fixture->current.pid);
  assert(expected->launch_time_micros == fixture->current.launch_time_micros);
  return fixture->terminate_status;
}

static void wait_millis(void *context, uint64_t millis) {
  ((Fixture *)context)->now += millis;
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

static MetaApplicationLaunchRequest launch_request(void) {
  MetaApplicationLaunchRequest request = {
      .activate = true,
      .fence_counter = 7,
      .deadline_millis = 1000,
  };
  copy_text(request.launch_task_ref, sizeof(request.launch_task_ref),
            "launch-task-1");
  copy_text(request.request_id, sizeof(request.request_id), "launch-request-1");
  copy_text(request.operation_id, sizeof(request.operation_id), "operation-1");
  copy_text(request.runtime_epoch, sizeof(request.runtime_epoch), "runtime-1");
  copy_text(request.login_session_id, sizeof(request.login_session_id), "login-1");
  copy_text(request.native_generation, sizeof(request.native_generation), "native-1");
  copy_text(request.application_url, sizeof(request.application_url),
            "/Applications/Fixture.app");
  copy_text(request.expected_bundle_id, sizeof(request.expected_bundle_id),
            "com.example.fixture");
  return request;
}

static MetaApplicationQuitRequest quit_request(void) {
  MetaApplicationQuitRequest request = {
      .process = process(501, 1000000, "com.example.fixture"),
      .deadline_millis = 100,
  };
  copy_text(request.application_ref, sizeof(request.application_ref),
            "native-1:app:7");
  copy_text(request.registration_nonce, sizeof(request.registration_nonce),
            "app-7");
  return request;
}

static void test_launch_immediate_completion_and_activation(void) {
  Fixture fixture = {
      .launch_start = META_APPLICATION_LAUNCH_ENQUEUED,
      .launch_process = process(501, 1000000, "com.example.fixture"),
      .reused = true,
      .complete_immediately = true,
      .activation_status = META_APPLICATION_ACTIVATION_SUCCEEDED,
  };
  MetaApplicationLaunchRequest request = launch_request();
  MetaApplicationLaunchTask *task =
      meta_application_launch_task_start(backend(&fixture), &request);
  assert(task != NULL);
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(task);
  assert(status.state == META_APPLICATION_LAUNCH_TASK_COMPLETED);
  assert(status.drained && status.callback_received && status.process_present);
  assert(status.reused_existing_process && status.process.pid == 501);
  assert(status.activation_requested && status.activation_attempted &&
         status.activation_succeeded && fixture.activation_calls == 1);
  assert(strcmp(status.operation_id, "operation-1") == 0 &&
         strcmp(status.launch_task_ref, "launch-task-1") == 0 &&
         status.fence_counter == 7);
  assert(meta_application_launch_task_release(task));
}

static void complete_launch(Fixture *fixture,
                            MetaApplicationWorkspaceLaunchCompletionStatus status,
                            const MetaApplicationProcess *process,
                            const char *error) {
  assert(fixture->launch_completion != NULL);
  MetaApplicationLaunchCompletion completion = fixture->launch_completion;
  fixture->launch_completion = NULL;
  completion(fixture->launch_completion_context, status, process,
             fixture->reused, error);
}

static void test_launch_timeout_retains_task_for_late_callback(void) {
  Fixture fixture = {
      .launch_start = META_APPLICATION_LAUNCH_ENQUEUED,
      .launch_process = process(501, 1000000, "com.example.fixture"),
      .activation_status = META_APPLICATION_ACTIVATION_SUCCEEDED,
  };
  MetaApplicationLaunchRequest request = launch_request();
  MetaApplicationLaunchTask *task =
      meta_application_launch_task_start(backend(&fixture), &request);
  assert(task != NULL);
  fixture.now = request.deadline_millis;
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(task);
  assert(status.state ==
         META_APPLICATION_LAUNCH_TASK_WAITING_LATE_CALLBACK);
  assert(status.timed_out && !status.drained && !status.callback_received &&
         status.revision == 2);
  MetaApplicationLaunchTaskStatus waited =
      meta_application_launch_task_wait(task, request.deadline_millis + 20);
  assert(!waited.drained && waited.revision == 2);
  assert(!meta_application_launch_task_release(task));
  complete_launch(&fixture, META_APPLICATION_LAUNCH_CALLBACK_COMPLETED,
                  &fixture.launch_process, NULL);
  status = meta_application_launch_task_status(task);
  assert(status.state == META_APPLICATION_LAUNCH_TASK_COMPLETED);
  assert(status.drained && status.late_completion && status.process_present &&
         status.revision == 4);
  assert(!status.activation_attempted && fixture.activation_calls == 0);
  assert(meta_application_launch_task_release(task));
}

static void test_cancel_waits_for_callback_and_skips_activation(void) {
  Fixture fixture = {
      .launch_start = META_APPLICATION_LAUNCH_ENQUEUED,
      .launch_process = process(501, 1000000, "com.example.fixture"),
      .activation_status = META_APPLICATION_ACTIVATION_SUCCEEDED,
  };
  MetaApplicationLaunchRequest request = launch_request();
  MetaApplicationLaunchTask *task =
      meta_application_launch_task_start(backend(&fixture), &request);
  assert(task != NULL && meta_application_launch_task_cancel(task));
  MetaApplicationLaunchTaskStatus pending =
      meta_application_launch_task_status(task);
  assert(pending.cancellation_requested && !pending.drained);
  complete_launch(&fixture, META_APPLICATION_LAUNCH_CALLBACK_COMPLETED,
                  &fixture.launch_process, NULL);
  MetaApplicationLaunchTaskStatus terminal =
      meta_application_launch_task_status(task);
  assert(terminal.state == META_APPLICATION_LAUNCH_TASK_COMPLETED);
  assert(terminal.cancellation_requested && terminal.drained);
  assert(!terminal.activation_attempted && fixture.activation_calls == 0);
  assert(meta_application_launch_task_release(task));
}

static void test_failed_callback_is_terminal_without_candidate(void) {
  Fixture fixture = {
      .launch_start = META_APPLICATION_LAUNCH_ENQUEUED,
  };
  MetaApplicationLaunchRequest request = launch_request();
  MetaApplicationLaunchTask *task =
      meta_application_launch_task_start(backend(&fixture), &request);
  assert(task != NULL);
  complete_launch(&fixture, META_APPLICATION_LAUNCH_CALLBACK_FAILED, NULL,
                  "injected callback failure");
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(task);
  assert(status.state ==
         META_APPLICATION_LAUNCH_TASK_FAILED_AFTER_DISPATCH);
  assert(status.drained && status.callback_received && !status.process_present);
  assert(strstr(status.error, "injected") != NULL);
  assert(meta_application_launch_task_release(task));
}

static void test_rejected_start_is_terminal_without_mutation(void) {
  Fixture fixture = {
      .launch_start = META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH,
  };
  MetaApplicationLaunchRequest request = launch_request();
  MetaApplicationLaunchTask *task =
      meta_application_launch_task_start(backend(&fixture), &request);
  assert(task != NULL);
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(task);
  assert(status.state ==
         META_APPLICATION_LAUNCH_TASK_REJECTED_NO_DISPATCH);
  assert(status.drained && !status.mutation_attempted &&
         !status.callback_received);
  assert(meta_application_launch_task_release(task));
}

static void test_quit_rejects_stale_without_mutation(void) {
  Fixture fixture = {
      .current = process(501, 2000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
  };
  MetaApplicationQuitRequest request = quit_request();
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_TARGET_STALE);
  assert(!result.mutation_attempted && fixture.terminate_calls == 0);
}

static void test_quit_observes_exact_termination(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
      .disappear_after_lookup = 3,
  };
  MetaApplicationQuitRequest request = quit_request();
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_TERMINATED);
  assert(result.mutation_attempted && result.termination_requested);
  assert(!result.process_running && fixture.terminate_calls == 1);
}

static void test_quit_deadline_after_lookup_does_not_dispatch(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
      .lookup_step = 100,
  };
  MetaApplicationQuitRequest request = quit_request();
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_REJECTED);
  assert(!result.mutation_attempted && fixture.terminate_calls == 0);
}

static void test_rejected_terminate_reports_attempt_without_force(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_REJECTED,
  };
  MetaApplicationQuitRequest request = quit_request();
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_REJECTED);
  assert(result.mutation_attempted && !result.termination_requested);
  assert(result.process_running && fixture.terminate_calls == 1);
}

static void test_pid_reuse_does_not_retarget_quit(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
      .disappear_after_lookup = 2,
      .replacement_after_terminate = true,
  };
  MetaApplicationQuitRequest request = quit_request();
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_TERMINATED);
  assert(fixture.terminate_calls == 1);
}

static void test_still_running_requires_attention_without_force(void) {
  Fixture fixture = {
      .current = process(501, 1000000, "com.example.fixture"),
      .terminate_status = META_APPLICATION_TERMINATE_ACCEPTED,
  };
  MetaApplicationQuitRequest request = quit_request();
  request.deadline_millis = 25;
  MetaApplicationQuitResult result = {0};
  assert(meta_application_quit(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_QUIT_STILL_RUNNING);
  assert(result.process_running && result.attention_may_be_required);
  assert(result.mutation_attempted && result.termination_requested);
}

int main(void) {
  @autoreleasepool {
    test_launch_immediate_completion_and_activation();
    test_launch_timeout_retains_task_for_late_callback();
    test_cancel_waits_for_callback_and_skips_activation();
    test_failed_callback_is_terminal_without_candidate();
    test_rejected_start_is_terminal_without_mutation();
    test_quit_rejects_stale_without_mutation();
    test_quit_observes_exact_termination();
    test_quit_deadline_after_lookup_does_not_dispatch();
    test_rejected_terminate_reports_attempt_without_force();
    test_pid_reuse_does_not_retarget_quit();
    test_still_running_requires_attention_without_force();
    puts("application controller tests passed");
  }
  return 0;
}
