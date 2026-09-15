#include "meta_native.h"
#include "meta_ledger.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t now;
  bool target_valid;
  size_t persist_calls;
  size_t fail_persist_call;
  uint64_t fail_persist_advance_millis;
  size_t event_count;
  size_t cleanup_count;
  bool fail_cleanup;
  struct {
    MetaHeldEventKind kind;
    uint32_t code;
    bool down;
    bool cleanup;
  } events[32];
} FakeBackend;

static uint64_t fake_now(void *context) {
  return ((FakeBackend *)context)->now;
}

static bool fake_verify_target(void *context, const char *target_ref) {
  FakeBackend *backend = context;
  return backend->target_valid && strcmp(target_ref, "window-1") == 0;
}

static bool fake_persist(void *context,
                         const MetaLedgerPersistenceRequest *request,
                         MetaLedgerPersistenceAck *ack) {
  FakeBackend *backend = context;
  backend->persist_calls += 1;
  assert(request->snapshot.operation_id[0] != '\0');
  if (request->snapshot.entry_count > 0)
    assert(request->snapshot.entries != NULL);
  if (backend->persist_calls == backend->fail_persist_call) {
    backend->now += backend->fail_persist_advance_millis;
    return false;
  }
  char digest[65] = {0};
  assert(meta_ledger_snapshot_sha256(&request->snapshot, digest));
  snprintf(ack->request_id, sizeof(ack->request_id), "%s",
           request->request_id);
  snprintf(ack->operation_id, sizeof(ack->operation_id), "%s",
           request->snapshot.operation_id);
  snprintf(ack->runtime_epoch, sizeof(ack->runtime_epoch), "%s",
           request->snapshot.runtime_epoch);
  snprintf(ack->login_session_id, sizeof(ack->login_session_id), "%s",
           request->snapshot.login_session_id);
  snprintf(ack->native_generation, sizeof(ack->native_generation), "%s",
           request->snapshot.native_generation);
  ack->revision = request->snapshot.revision;
  snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s", digest);
  ack->persisted_at_unix_micros = 1;
  ack->durable = true;
  return true;
}

static bool fake_post(void *context, MetaHeldEventKind kind, uint32_t code,
                      bool down, uint64_t synthetic_tag) {
  FakeBackend *backend = context;
  assert(synthetic_tag != 0);
  assert(backend->event_count < 32);
  backend->events[backend->event_count].kind = kind;
  backend->events[backend->event_count].code = code;
  backend->events[backend->event_count].down = down;
  backend->events[backend->event_count].cleanup = false;
  backend->event_count += 1;
  return true;
}

static bool fake_cleanup_up(void *context, MetaHeldEventKind kind,
                            uint32_t code, uint64_t synthetic_tag) {
  FakeBackend *backend = context;
  assert(synthetic_tag != 0);
  assert(backend->event_count < 32);
  backend->events[backend->event_count].kind = kind;
  backend->events[backend->event_count].code = code;
  backend->events[backend->event_count].down = false;
  backend->events[backend->event_count].cleanup = true;
  backend->event_count += 1;
  backend->cleanup_count += 1;
  return !backend->fail_cleanup;
}

static MetaExecutor *executor(FakeBackend *backend,
                              const char *native_generation) {
  MetaExecutorBackend callbacks = {
      .context = backend,
      .monotonic_millis = fake_now,
      .verify_target = fake_verify_target,
      .persist_ledger = fake_persist,
      .post_held_event = fake_post,
      .post_cleanup_up = fake_cleanup_up,
  };
  return meta_executor_create(native_generation, 500, callbacks);
}

static MetaFence fence(const char *runtime_epoch,
                       const char *native_generation, uint64_t counter) {
  MetaFence value = {.counter = counter};
  snprintf(value.runtime_epoch, sizeof(value.runtime_epoch), "%s",
           runtime_epoch);
  snprintf(value.native_generation, sizeof(value.native_generation), "%s",
           native_generation);
  snprintf(value.login_session_id, sizeof(value.login_session_id), "%s",
           "login-1");
  return value;
}

static void test_known_failure_preserves_actual_dispatch(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "not-ready", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_fail(value, "readiness-precondition"));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_FAILED);
  assert(status.dispatch == META_DISPATCH_NONE && status.dispatch_attempts == 0);
  assert(status.cleanup == META_CLEANUP_COMPLETE && !status.quarantined);
  assert(!status.cancellation_requested && status.held_count == 0);
  assert(strcmp(status.last_checkpoint, "readiness-precondition") == 0);
  assert(backend.event_count == 0 && backend.persist_calls == 0);
  assert(!meta_executor_fail(value, "repeat"));
  assert(!meta_executor_finish(value));
  assert(meta_executor_begin(value, "failed-after-down", "window-1",
                             fence("runtime-1", "native-1", 2), 1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(meta_executor_fail(value, "known-refusal"));
  status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_FAILED);
  assert(status.dispatch == META_DISPATCH_PARTIAL && status.dispatch_attempts > 0);
  assert(status.cleanup == META_CLEANUP_COMPLETE && status.held_count == 0);
  assert(backend.event_count == 2 && backend.cleanup_count == 1);
  meta_executor_destroy(value);
}

static void test_cancel_before_first_event(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(value != NULL);
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-1", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_cancel(value));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.dispatch == META_DISPATCH_NONE);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(backend.event_count == 0);
  meta_executor_destroy(value);
}

static void test_cancel_releases_confirmed_down(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-2", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(meta_executor_cancel(value));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.dispatch == META_DISPATCH_PARTIAL);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(status.held_count == 0);
  assert(backend.event_count == 2);
  assert(status.dispatch_attempts == 2);
  assert(status.ledger_revision == 4);
  assert(status.has_accepted_fence);
  assert(status.accepted_fence.login_session_id[0] != '\0');
  assert(backend.events[0].down);
  assert(!backend.events[1].down);
  meta_executor_destroy(value);
}

static void test_confirmed_ack_failure_releases_live_owned_down_once(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 2,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-3", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(!meta_executor_post_down(value, META_EVENT_BUTTON, 0));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(backend.event_count == 2);
  assert(backend.events[0].down);
  assert(!backend.events[1].down);
  assert(backend.events[1].cleanup);
  assert(backend.cleanup_count == 1);
  MetaLedgerEntry ledger[1];
  assert(meta_executor_copy_ledger(value, ledger, 1) == 1);
  assert(ledger[0].state == META_LEDGER_UNCERTAIN);
  assert(!meta_executor_cancel(value));
  assert(backend.event_count == 2);
  assert(backend.cleanup_count == 1);
  meta_executor_destroy(value);
}

static void test_pending_down_ack_failure_posts_no_cleanup_up(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 1,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "pending-down-failure", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(!meta_executor_post_down(value, META_EVENT_KEY, 55));
  const MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.dispatch == META_DISPATCH_NONE);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(status.held_count == 1);
  assert(strcmp(status.last_checkpoint, "pending-down-ack-unknown") == 0);
  assert(backend.event_count == 0);
  assert(backend.cleanup_count == 0);
  MetaLedgerEntry ledger[1];
  assert(meta_executor_copy_ledger(value, ledger, 1) == 1);
  assert(ledger[0].state == META_LEDGER_UNCERTAIN);
  meta_executor_destroy(value);
}

static void test_pending_up_ack_failure_releases_live_owned_down_once(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 3,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "pending-up-failure", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_BUTTON, 0));
  assert(!meta_executor_post_up(value, META_EVENT_BUTTON, 0));
  const MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(backend.event_count == 2);
  assert(backend.events[0].down);
  assert(backend.events[1].cleanup);
  assert(backend.cleanup_count == 1);
  MetaLedgerEntry ledger[1];
  assert(meta_executor_copy_ledger(value, ledger, 1) == 1);
  assert(ledger[0].state == META_LEDGER_UNCERTAIN);
  assert(!meta_executor_cancel(value));
  assert(backend.cleanup_count == 1);
  meta_executor_destroy(value);
}

static void test_released_ack_failure_does_not_repeat_normal_up(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 4,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "released-ack-failure", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(!meta_executor_post_up(value, META_EVENT_KEY, 55));
  const MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(backend.event_count == 2);
  assert(backend.events[0].down);
  assert(!backend.events[1].down);
  assert(!backend.events[1].cleanup);
  assert(backend.cleanup_count == 0);
  MetaLedgerEntry ledger[1];
  assert(meta_executor_copy_ledger(value, ledger, 1) == 1);
  assert(ledger[0].state == META_LEDGER_UNCERTAIN);
  assert(!meta_executor_cancel(value));
  assert(backend.event_count == 2);
  meta_executor_destroy(value);
}

static void test_failed_cleanup_up_is_attempted_only_once(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_cleanup = true,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "cleanup-up-failure", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_BUTTON, 0));
  assert(!meta_executor_cancel(value));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(backend.cleanup_count == 1);
  assert(!meta_executor_cancel(value));
  assert(backend.cleanup_count == 1);
  meta_executor_destroy(value);
}

static void test_stale_fence_after_generation_change(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-2");
  assert(meta_executor_open_runtime_epoch(value, "runtime-2", "login-1"));
  assert(!meta_executor_begin(value, "operation-old", "window-1",
                              fence("runtime-1", "native-1", 1), 1000));
  assert(!meta_executor_begin(value, "operation-old-runtime", "window-1",
                              fence("runtime-1", "native-2", 1), 1000));
  assert(meta_executor_begin(value, "operation-new", "window-1",
                             fence("runtime-2", "native-2", 1), 1000));
  assert(meta_executor_finish(value));
  assert(!meta_executor_begin(value, "operation-replay", "window-1",
                              fence("runtime-2", "native-2", 1), 1000));
  meta_executor_destroy(value);
}

static void test_same_epoch_does_not_reset_fence_or_event_tag(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-1", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  const uint64_t first_tag = meta_executor_synthetic_tag(value);
  assert(first_tag != 0);
  assert(meta_executor_finish(value));
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(!meta_executor_begin(value, "operation-replay", "window-1",
                              fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_begin(value, "operation-2", "window-1",
                             fence("runtime-1", "native-1", 2), 1000));
  const uint64_t second_tag = meta_executor_synthetic_tag(value);
  assert(second_tag != first_tag);
  assert(meta_executor_finish(value));
  assert(meta_executor_open_runtime_epoch(value, "runtime-2", "login-1"));
  assert(!meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-3", "window-1",
                             fence("runtime-2", "native-1", 1), 1000));
  assert(meta_executor_synthetic_tag(value) != first_tag);
  assert(meta_executor_finish(value));
  meta_executor_destroy(value);
}

static void test_second_pending_down_failure_releases_existing_live_hold(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 3,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-7", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(!meta_executor_post_down(value, META_EVENT_KEY, 56));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(status.held_count == 2);
  assert(backend.event_count == 2);
  assert(backend.events[0].code == 55 && backend.events[0].down);
  assert(backend.events[1].code == 55 && !backend.events[1].down &&
         backend.events[1].cleanup);
  assert(backend.cleanup_count == 1);
  assert(!meta_executor_begin(value, "operation-8", "window-1",
                              fence("runtime-1", "native-1", 2), 1000));
  meta_executor_destroy(value);
}

static void test_broken_persistence_releases_all_live_owned_holds_once(void) {
  FakeBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 5,
      .fail_persist_advance_millis = 1001,
  };
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "multi-cleanup", "window-1",
                             fence("runtime-1", "native-1", 1), 10000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 56));
  assert(!meta_executor_cancel(value));
  const MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_QUARANTINED);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(status.held_count == 2);
  assert(backend.persist_calls == 5);
  assert(backend.event_count == 4);
  assert(backend.cleanup_count == 2);
  assert(backend.events[2].cleanup && backend.events[2].code == 56);
  assert(backend.events[3].cleanup && backend.events[3].code == 55);
  assert(!meta_executor_cancel(value));
  assert(backend.cleanup_count == 2);
  meta_executor_destroy(value);
}

static void test_target_change_stops_before_next_event(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "operation-4", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 56));
  backend.target_valid = false;
  assert(!meta_executor_checkpoint(value, "before-next-event"));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_FAILED);
  assert(status.target_verification == META_VERIFICATION_FAILED);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(backend.event_count == 2);
  meta_executor_destroy(value);
}

static void test_user_takeover_and_watchdog(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  meta_executor_set_observer_state(value, META_OBSERVER_READY);
  assert(meta_executor_begin(value, "operation-5", "window-1",
                             fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_post_down(value, META_EVENT_BUTTON, 0));
  assert(!meta_executor_note_observed_event(value, 0));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.user_interference == META_INTERFERENCE_OBSERVED);
  assert(!status.restoration_allowed);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(backend.event_count == 2);

  assert(meta_executor_open_runtime_epoch(value, "runtime-2", "login-1"));
  assert(meta_executor_begin(value, "operation-6", "window-1",
                             fence("runtime-2", "native-1", 1), 2000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 57));
  backend.now = 700;
  assert(meta_executor_watchdog_tick(value));
  status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(backend.event_count == 4);
  meta_executor_destroy(value);
}

static void test_restored_uncertain_ledger_starts_quarantined(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-after-crash");
  MetaLedgerEntry ledger[] = {
      {.sequence = 1,
       .kind = META_EVENT_KEY,
       .code = 55,
       .state = META_LEDGER_PENDING_DOWN},
  };
  MetaHeldInputLedgerSnapshot snapshot = {
      .revision = 7,
      .entries = ledger,
      .entry_count = 1,
  };
  snprintf(snapshot.operation_id, sizeof(snapshot.operation_id), "%s",
           "interrupted-operation");
  snprintf(snapshot.runtime_epoch, sizeof(snapshot.runtime_epoch), "%s",
           "runtime-before-crash");
  snprintf(snapshot.login_session_id, sizeof(snapshot.login_session_id), "%s",
           "login-before-crash");
  snprintf(snapshot.native_generation, sizeof(snapshot.native_generation),
           "%s", "native-before-crash");
  assert(meta_executor_restore_ledger(value, &snapshot));
  MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_IDLE);
  assert(status.dispatch == META_DISPATCH_UNKNOWN);
  assert(status.cleanup == META_CLEANUP_UNKNOWN);
  assert(status.quarantined);
  assert(status.held_count == 1);
  MetaRecoveryLedgerStatus recovery = meta_executor_recovery_status(value);
  assert(recovery.present);
  assert(recovery.ledger_revision == 7);
  assert(strcmp(recovery.source_native_generation,
                "native-before-crash") == 0);
  assert(!meta_executor_open_runtime_epoch(value, "runtime-after-crash",
                                           "login-after-crash"));
  assert(backend.event_count == 0);
  assert(backend.cleanup_count == 0);
  meta_executor_destroy(value);
}

static void test_native_id_limits_and_login_fence(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  char long_generation[66];
  memset(long_generation, 'g', 65);
  long_generation[65] = '\0';
  assert(executor(&backend, long_generation) == NULL);

  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  MetaFence foreign_login = fence("runtime-1", "native-1", 1);
  snprintf(foreign_login.login_session_id,
           sizeof(foreign_login.login_session_id), "%s", "login-2");
  assert(!meta_executor_begin(value, "operation-1", "window-1",
                              foreign_login, 1000));
  char long_operation[129];
  memset(long_operation, 'o', 128);
  long_operation[128] = '\0';
  assert(!meta_executor_begin(value, long_operation, "window-1",
                              fence("runtime-1", "native-1", 1), 1000));
  meta_executor_destroy(value);
}

static void test_advanced_fence_stops_old_operation_without_restore(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  const MetaFence accepted = fence("runtime-1", "native-1", 1);
  assert(meta_executor_begin(value, "operation-old", "window-1", accepted,
                             1000));
  assert(meta_executor_post_down(value, META_EVENT_KEY, 55));
  assert(!meta_executor_cancel_operation(
      value, "another-operation", accepted));
  const MetaFence newer = fence("runtime-1", "native-1", 2);
  assert(meta_executor_advance_fence(value, newer));
  const MetaExecutorStatus status = meta_executor_status(value);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.accepted_fence.counter == 1);
  assert(status.high_water_fence.counter == 2);
  assert(!status.restoration_allowed);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(status.held_count == 0);
  meta_executor_destroy(value);
}

static bool fake_action(void *context) {
  size_t *count = context;
  *count += 1;
  return true;
}

static void test_external_action_uses_same_fence(void) {
  FakeBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *value = executor(&backend, "native-1");
  size_t dispatches = 0;
  assert(meta_executor_open_runtime_epoch(value, "runtime-1", "login-1"));
  assert(meta_executor_begin(value, "window-show", "window-1", fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_dispatch_action(value, fake_action, &dispatches, "window-show"));
  assert(meta_executor_finish(value));
  assert(dispatches == 1 && meta_executor_status(value).dispatch_attempts == 1);
  assert(!meta_executor_begin(value, "replay", "window-1", fence("runtime-1", "native-1", 1), 1000));
  assert(meta_executor_begin(value, "window-focus", "window-1", fence("runtime-1", "native-1", 2), 1000));
  assert(meta_executor_cancel(value));
  assert(!meta_executor_dispatch_action(value, fake_action, &dispatches, "cancelled"));
  assert(dispatches == 1);
  meta_executor_destroy(value);
}

int main(void) {
  test_known_failure_preserves_actual_dispatch();
  test_external_action_uses_same_fence();
  test_cancel_before_first_event();
  test_cancel_releases_confirmed_down();
  test_confirmed_ack_failure_releases_live_owned_down_once();
  test_pending_down_ack_failure_posts_no_cleanup_up();
  test_pending_up_ack_failure_releases_live_owned_down_once();
  test_released_ack_failure_does_not_repeat_normal_up();
  test_failed_cleanup_up_is_attempted_only_once();
  test_stale_fence_after_generation_change();
  test_same_epoch_does_not_reset_fence_or_event_tag();
  test_second_pending_down_failure_releases_existing_live_hold();
  test_broken_persistence_releases_all_live_owned_holds_once();
  test_target_change_stops_before_next_event();
  test_user_takeover_and_watchdog();
  test_restored_uncertain_ledger_starts_quarantined();
  test_native_id_limits_and_login_fence();
  test_advanced_fence_stops_old_operation_without_restore();
  puts("executor tests passed");
  return 0;
}
