#include "meta_application_controller.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t now;
  uint64_t launch_step;
  uint64_t lookup_step;
  MetaApplicationWorkspaceLaunchStatus launch_status;
  MetaApplicationProcess launch_process;
  bool reused;
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

static MetaApplicationWorkspaceLaunchStatus launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationProcess *value,
    bool *reused) {
  Fixture *fixture = context;
  assert(strcmp(request->application_url, "/Applications/Fixture.app") == 0);
  fixture->now += fixture->launch_step;
  *value = fixture->launch_process;
  *reused = fixture->reused;
  return fixture->launch_status;
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
      .launch = launch,
      .lookup = lookup,
      .terminate = terminate,
      .wait_millis = wait_millis,
  };
}

static MetaApplicationLaunchRequest launch_request(void) {
  MetaApplicationLaunchRequest request = {
      .activate = true,
      .deadline_millis = 1000,
  };
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

static void test_launch_exact_candidate(void) {
  Fixture fixture = {
      .launch_status = META_APPLICATION_LAUNCH_COMPLETED,
      .launch_process = process(501, 1000000, "com.example.fixture"),
      .reused = true,
  };
  MetaApplicationLaunchResult result = {0};
  MetaApplicationLaunchRequest request = launch_request();
  assert(meta_application_launch(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_LAUNCH_READY);
  assert(result.mutation_attempted && result.process_present);
  assert(result.reused_existing_process);
  assert(result.process.pid == 501);
}

static void test_launch_timeout_is_unknown(void) {
  Fixture fixture = {
      .launch_status = META_APPLICATION_LAUNCH_TIMED_OUT,
  };
  MetaApplicationLaunchResult result = {0};
  MetaApplicationLaunchRequest request = launch_request();
  assert(meta_application_launch(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN);
  assert(result.mutation_attempted && !result.process_present);
}

static void test_late_launch_preserves_candidate_without_false_ready(void) {
  Fixture fixture = {
      .launch_status = META_APPLICATION_LAUNCH_COMPLETED,
      .launch_process = process(501, 1000000, "com.example.fixture"),
      .launch_step = 1000,
  };
  MetaApplicationLaunchResult result = {0};
  MetaApplicationLaunchRequest request = launch_request();
  assert(meta_application_launch(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN);
  assert(result.mutation_attempted && result.process_present);
}

static void test_launch_foreign_process_is_unknown(void) {
  Fixture fixture = {
      .launch_status = META_APPLICATION_LAUNCH_COMPLETED,
      .launch_process = process(501, 1000000, "com.example.foreign"),
  };
  MetaApplicationLaunchResult result = {0};
  MetaApplicationLaunchRequest request = launch_request();
  assert(meta_application_launch(backend(&fixture), &request, &result));
  assert(result.outcome == META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN);
  assert(result.mutation_attempted && !result.process_present);
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
    test_launch_exact_candidate();
    test_launch_timeout_is_unknown();
    test_late_launch_preserves_candidate_without_false_ready();
    test_launch_foreign_process_is_unknown();
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
