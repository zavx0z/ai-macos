#include "meta_input_readiness.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t tag;
  size_t cursor;
} FakeObservedEvent;

typedef struct {
  uint64_t now;
  bool target_valid;
  MetaReadinessSessionFacts session;
  MetaReadinessPermissions permissions;
  MetaReadinessPoint cursor;
  MetaReadinessDisplay display;
  size_t post_count;
  bool inject_user_takeover;
  bool lose_move_observation;
  FakeObservedEvent events[8];
  size_t event_count;
} Fixture;

static uint64_t now_millis(void *context) {
  return ((Fixture *)context)->now;
}

static bool verify_target(void *context, const char *target_ref) {
  Fixture *fixture = context;
  return fixture->target_valid && strcmp(target_ref, "display-1") == 0;
}

static bool persist_unused(void *context,
                           const MetaLedgerPersistenceRequest *request,
                           MetaLedgerPersistenceAck *ack) {
  (void)context;
  (void)request;
  (void)ack;
  assert(false && "pointer move не должен создавать held-input ledger");
  return false;
}

static bool post_held_unused(void *context, MetaHeldEventKind kind,
                             uint32_t code, bool down,
                             uint64_t synthetic_tag) {
  (void)context;
  (void)kind;
  (void)code;
  (void)down;
  (void)synthetic_tag;
  assert(false && "readiness probe не должен отправлять held events");
  return false;
}

static bool post_pointer(void *context, const MetaPointerEvent *event,
                         uint64_t synthetic_tag) {
  Fixture *fixture = context;
  assert(event->kind == META_POINTER_MOVE);
  assert(synthetic_tag != 0);
  assert(fixture->event_count < 8);
  fixture->post_count += 1;
  fixture->cursor = (MetaReadinessPoint){.x = event->x, .y = event->y};
  fixture->event_count += 1;
  fixture->events[fixture->event_count - 1] = (FakeObservedEvent){
      .tag = synthetic_tag,
      .cursor = fixture->event_count,
  };
  return true;
}

static bool read_session(void *context, MetaReadinessSessionFacts *facts) {
  *facts = ((Fixture *)context)->session;
  return true;
}

static bool read_permissions(void *context,
                             MetaReadinessPermissions *permissions) {
  *permissions = ((Fixture *)context)->permissions;
  return true;
}

static bool read_observer(void *context,
                          MetaReadinessObserverSnapshot *snapshot) {
  Fixture *fixture = context;
  *snapshot = (MetaReadinessObserverSnapshot){
      .ready = true,
      .continuous = true,
      .gap_detected = false,
  };
  snprintf(snapshot->cursor, sizeof(snapshot->cursor), "cursor-%zu",
           fixture->event_count);
  return true;
}

static bool read_cursor(void *context, MetaReadinessPoint *point) {
  *point = ((Fixture *)context)->cursor;
  return true;
}

static bool resolve_display(void *context, MetaReadinessPoint point,
                            MetaReadinessDisplay *display) {
  Fixture *fixture = context;
  assert(point.x == fixture->cursor.x && point.y == fixture->cursor.y);
  *display = fixture->display;
  return true;
}

static size_t cursor_number(const char *cursor) {
  size_t value = 0;
  assert(sscanf(cursor, "cursor-%zu", &value) == 1);
  return value;
}

static bool scan_events(void *context, const char *after_cursor,
                        uint64_t expected_synthetic_tag,
                        bool require_own_event, uint64_t timeout_millis,
                        MetaReadinessEventScan *scan) {
  Fixture *fixture = context;
  assert(timeout_millis > 0 && timeout_millis <= 250);
  const size_t after = cursor_number(after_cursor);
  if (fixture->lose_move_observation && require_own_event && after == 0) {
    *scan = (MetaReadinessEventScan){
        .state = META_READINESS_SCAN_UNKNOWN,
    };
    snprintf(scan->cursor, sizeof(scan->cursor), "cursor-%zu",
             fixture->event_count);
    return true;
  }
  if (fixture->inject_user_takeover && !require_own_event && after == 1) {
    fixture->event_count += 1;
    fixture->events[fixture->event_count - 1] = (FakeObservedEvent){
        .tag = 0,
        .cursor = fixture->event_count,
    };
    fixture->cursor.x += 20;
  }
  bool own = false;
  bool foreign = false;
  uint64_t foreign_tag = 0;
  for (size_t index = after; index < fixture->event_count; index += 1) {
    if (fixture->events[index].tag == expected_synthetic_tag) own = true;
    else {
      foreign = true;
      foreign_tag = fixture->events[index].tag;
    }
  }
  scan->state = foreign ? META_READINESS_SCAN_USER_TAKEOVER
                        : own ? META_READINESS_SCAN_OWN_EVENT_ONLY
                              : META_READINESS_SCAN_NO_EVENTS;
  scan->synthetic_tag = foreign ? foreign_tag : own ? expected_synthetic_tag : 0;
  snprintf(scan->cursor, sizeof(scan->cursor), "cursor-%zu",
           fixture->event_count);
  return !require_own_event || own || foreign;
}

static MetaExecutor *active_executor(Fixture *fixture) {
  MetaExecutorBackend backend = {
      .context = fixture,
      .monotonic_millis = now_millis,
      .verify_target = verify_target,
      .persist_ledger = persist_unused,
      .post_held_event = post_held_unused,
      .post_pointer_event = post_pointer,
  };
  MetaExecutor *executor = meta_executor_create("native-1", 1000, backend);
  assert(executor != NULL);
  assert(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  meta_executor_set_observer_state(executor, META_OBSERVER_READY);
  MetaFence fence = {.counter = 1};
  snprintf(fence.runtime_epoch, sizeof(fence.runtime_epoch), "%s",
           "runtime-1");
  snprintf(fence.login_session_id, sizeof(fence.login_session_id), "%s",
           "login-1");
  snprintf(fence.native_generation, sizeof(fence.native_generation), "%s",
           "native-1");
  assert(meta_executor_begin(executor, "operation-readiness", "display-1",
                             fence, fixture->now + 1000));
  return executor;
}

static MetaInputReadinessBackend readiness_backend(Fixture *fixture) {
  return (MetaInputReadinessBackend){
      .context = fixture,
      .read_session = read_session,
      .read_permissions = read_permissions,
      .read_observer = read_observer,
      .read_cursor = read_cursor,
      .resolve_display = resolve_display,
      .scan_events = scan_events,
  };
}

static Fixture fixture(void) {
  Fixture value = {
      .now = 100,
      .target_valid = true,
      .session = {
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
      },
      .permissions = {
          .accessibility = true,
          .post_events = true,
          .listen_events = true,
      },
      .cursor = {.x = 100, .y = 50},
      .display = {.bounds = {.x = 0, .y = 0, .width = 200, .height = 100}},
  };
  snprintf(value.display.display_ref, sizeof(value.display.display_ref), "%s",
           "display-1");
  return value;
}

static void test_move_and_restore_are_both_confirmed(void) {
  Fixture value = fixture();
  MetaExecutor *executor = active_executor(&value);
  MetaInputReadinessResult result = {0};
  assert(meta_input_readiness_probe_active(
      executor, "display-1", readiness_backend(&value), &result));
  assert(result.input_ready);
  assert(!result.quarantined);
  assert(result.move_posted && result.move_observed &&
         result.move_readback_confirmed);
  assert(result.restore_posted && result.restore_observed &&
         result.restore_readback_confirmed);
  assert(result.probe_cursor.x == 101 && result.probe_cursor.y == 50);
  assert(value.cursor.x == 100 && value.cursor.y == 50);
  assert(value.post_count == 2);
  assert(result.dispatch == META_DISPATCH_FINISHED);
  assert(result.cleanup == META_CLEANUP_COMPLETE);
  assert(result.interference == META_INTERFERENCE_NONE_OBSERVED);
  assert(result.restoration == META_READINESS_RESTORE_RESTORED);
  assert(meta_executor_finish(executor));
  meta_executor_destroy(executor);
}

static void test_secure_input_stops_before_first_post(void) {
  Fixture value = fixture();
  value.session.secure_input = META_READINESS_SECURE_INPUT_ON;
  MetaExecutor *executor = active_executor(&value);
  MetaInputReadinessResult result = {0};
  assert(meta_input_readiness_probe_active(
      executor, "display-1", readiness_backend(&value), &result));
  assert(!result.input_ready);
  assert(value.post_count == 0);
  assert(result.dispatch == META_DISPATCH_NONE);
  assert(result.cleanup == META_CLEANUP_COMPLETE);
  assert(result.restoration == META_READINESS_RESTORE_NOT_ATTEMPTED);
  assert(meta_executor_finish(executor));
  meta_executor_destroy(executor);
}

static void test_foreign_resolved_display_stops_before_first_post(void) {
  Fixture value = fixture();
  snprintf(value.display.display_ref, sizeof(value.display.display_ref), "%s",
           "display-foreign");
  MetaExecutor *executor = active_executor(&value);
  MetaInputReadinessResult result = {0};
  assert(meta_input_readiness_probe_active(
      executor, "display-1", readiness_backend(&value), &result));
  assert(!result.input_ready);
  assert(value.post_count == 0);
  assert(result.cleanup == META_CLEANUP_COMPLETE);
  assert(result.restoration == META_READINESS_RESTORE_NOT_ATTEMPTED);
  assert(meta_executor_finish(executor));
  meta_executor_destroy(executor);
}

static void test_user_takeover_skips_restore_without_quarantine(void) {
  Fixture value = fixture();
  value.inject_user_takeover = true;
  MetaExecutor *executor = active_executor(&value);
  MetaInputReadinessResult result = {0};
  assert(meta_input_readiness_probe_active(
      executor, "display-1", readiness_backend(&value), &result));
  assert(!result.input_ready);
  assert(value.post_count == 1);
  assert(!result.restore_posted);
  assert(result.interference == META_INTERFERENCE_OBSERVED);
  assert(result.cleanup == META_CLEANUP_COMPLETE);
  assert(result.restoration ==
         META_READINESS_RESTORE_SKIPPED_USER_TAKEOVER);
  assert(!result.quarantined);
  MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.user_interference == META_INTERFERENCE_OBSERVED);
  meta_executor_destroy(executor);
}

static void test_unobserved_owned_move_is_unknown_and_quarantined(void) {
  Fixture value = fixture();
  value.lose_move_observation = true;
  MetaExecutor *executor = active_executor(&value);
  MetaInputReadinessResult result = {0};
  assert(!meta_input_readiness_probe_active(
      executor, "display-1", readiness_backend(&value), &result));
  assert(!result.input_ready);
  assert(value.post_count == 1);
  assert(result.move_posted && !result.move_observed);
  assert(result.cleanup == META_CLEANUP_UNKNOWN);
  assert(result.interference == META_INTERFERENCE_UNKNOWN);
  assert(result.restoration == META_READINESS_RESTORE_UNKNOWN);
  assert(result.quarantined);
  assert(meta_executor_status(executor).execution == META_EXECUTOR_QUARANTINED);
  meta_executor_destroy(executor);
}

int main(void) {
  test_move_and_restore_are_both_confirmed();
  test_secure_input_stops_before_first_post();
  test_foreign_resolved_display_stops_before_first_post();
  test_user_takeover_skips_restore_without_quarantine();
  test_unobserved_owned_move_is_unknown_and_quarantined();
  return 0;
}
