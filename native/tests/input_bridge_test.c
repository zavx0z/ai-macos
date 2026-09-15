#include "meta_input_bridge.h"
#include "meta_ledger.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  MetaExecutor *executor;
  uint64_t now;
  size_t wait_calls;
  size_t cancel_on_wait_call;
  size_t posted_clusters;
  uint16_t delivered[64];
  size_t delivered_count;
  MetaPointerEvent pointer_events[16];
  size_t pointer_event_count;
  MetaScrollEvent scroll_events[4];
  size_t scroll_event_count;
  uint64_t event_flags;
} FakeTextBackend;

static uint64_t fake_now(void *context) {
  return ((FakeTextBackend *)context)->now;
}

static bool fake_verify(void *context, const char *target_ref) {
  (void)context;
  return strcmp(target_ref, "window-1") == 0;
}

static bool fake_persist(void *context,
                         const MetaLedgerPersistenceRequest *request,
                         MetaLedgerPersistenceAck *ack) {
  (void)context;
  char digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(&request->snapshot, digest)) return false;
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
  snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s", digest);
  ack->revision = request->snapshot.revision;
  ack->persisted_at_unix_micros = 1;
  ack->durable = true;
  return true;
}

static bool fake_held(void *context, MetaHeldEventKind kind, uint32_t code,
                      bool down, uint64_t tag) {
  (void)context;
  (void)kind;
  (void)code;
  (void)down;
  (void)tag;
  return true;
}

static bool fake_text(void *context, const uint16_t *units, size_t count,
                      uint64_t tag) {
  FakeTextBackend *backend = context;
  assert(tag != 0);
  assert(backend->delivered_count + count <= 64);
  memcpy(&backend->delivered[backend->delivered_count], units,
         count * sizeof(*units));
  backend->delivered_count += count;
  backend->posted_clusters += 1;
  return true;
}

static bool fake_pointer(void *context, const MetaPointerEvent *event,
                         uint64_t tag) {
  FakeTextBackend *backend = context;
  assert(tag != 0);
  assert(backend->pointer_event_count < 16);
  backend->pointer_events[backend->pointer_event_count++] = *event;
  return true;
}

static bool fake_scroll(void *context, const MetaScrollEvent *event,
                        uint64_t tag) {
  FakeTextBackend *backend = context;
  assert(tag != 0);
  assert(backend->scroll_event_count < 4);
  backend->scroll_events[backend->scroll_event_count++] = *event;
  return true;
}

static bool fake_set_flags(void *context, uint64_t flags) {
  ((FakeTextBackend *)context)->event_flags = flags;
  return true;
}

static bool fake_wait(void *context, uint64_t deadline_millis) {
  FakeTextBackend *backend = context;
  backend->wait_calls += 1;
  backend->now = deadline_millis;
  if (backend->wait_calls == backend->cancel_on_wait_call) {
    meta_executor_cancel(backend->executor);
  }
  return true;
}

static MetaFence fence(void) {
  MetaFence value = {.counter = 1};
  snprintf(value.runtime_epoch, sizeof(value.runtime_epoch), "%s",
           "runtime-1");
  snprintf(value.login_session_id, sizeof(value.login_session_id), "%s",
           "login-1");
  snprintf(value.native_generation, sizeof(value.native_generation), "%s",
           "native-1");
  return value;
}

static MetaExecutor *create_executor(FakeTextBackend *backend) {
  MetaExecutorBackend callbacks = {
      .context = backend,
      .monotonic_millis = fake_now,
      .verify_target = fake_verify,
      .persist_ledger = fake_persist,
      .post_held_event = fake_held,
      .post_text_cluster = fake_text,
      .post_pointer_event = fake_pointer,
      .post_scroll_event = fake_scroll,
      .set_event_flags = fake_set_flags,
  };
  MetaExecutor *executor = meta_executor_create("native-1", 500, callbacks);
  backend->executor = executor;
  assert(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  assert(meta_executor_begin(executor, "operation-1", "window-1", fence(),
                             1000));
  return executor;
}

static void test_unicode_schedule(void) {
  FakeTextBackend backend = {.now = 100};
  MetaExecutor *executor = create_executor(&backend);
  const uint16_t latin[] = {0x0041};
  const uint16_t russian[] = {0x044f};
  const uint16_t emoji_zwj[] = {0xd83d, 0xdc69, 0x200d, 0xd83d, 0xdcbb};
  const uint16_t composed[] = {0x0065, 0x0301};
  const MetaTextCluster clusters[] = {
      {.utf16_units = latin, .utf16_count = 1, .offset_millis = 0},
      {.utf16_units = russian, .utf16_count = 1, .offset_millis = 10},
      {.utf16_units = emoji_zwj, .utf16_count = 5, .offset_millis = 20},
      {.utf16_units = composed, .utf16_count = 2, .offset_millis = 30},
  };
  MetaTextExecutionReport report = {0};
  MetaInputBridgeClock clock = {
      .context = &backend,
      .monotonic_millis = fake_now,
      .wait_until = fake_wait,
  };
  assert(meta_input_execute_text_schedule(executor, clusters, 4, 500, clock,
                                          &report));
  assert(report.completed_clusters == 4);
  assert(backend.posted_clusters == 4);
  assert(backend.delivered_count == 9);
  assert(memcmp(backend.delivered, (uint16_t[]){
                                       0x0041, 0x044f, 0xd83d, 0xdc69, 0x200d,
                                       0xd83d, 0xdcbb, 0x0065, 0x0301},
                9 * sizeof(uint16_t)) == 0);
  const MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.execution == META_EXECUTOR_FINISHED);
  assert(status.dispatch_attempts == 4);
  meta_executor_destroy(executor);
}

static void test_cancel_between_clusters(void) {
  FakeTextBackend backend = {.now = 100, .cancel_on_wait_call = 2};
  MetaExecutor *executor = create_executor(&backend);
  const uint16_t first[] = {0x0041};
  const uint16_t second[] = {0x0042};
  const MetaTextCluster clusters[] = {
      {.utf16_units = first, .utf16_count = 1, .offset_millis = 0},
      {.utf16_units = second, .utf16_count = 1, .offset_millis = 10},
  };
  MetaTextExecutionReport report = {0};
  MetaInputBridgeClock clock = {
      .context = &backend,
      .monotonic_millis = fake_now,
      .wait_until = fake_wait,
  };
  assert(!meta_input_execute_text_schedule(executor, clusters, 2, 500, clock,
                                           &report));
  assert(report.completed_clusters == 1);
  assert(backend.posted_clusters == 1);
  const MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.dispatch == META_DISPATCH_PARTIAL);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  meta_executor_destroy(executor);
}

static void test_drag_trajectory_and_modifiers(void) {
  FakeTextBackend backend = {.now = 100};
  MetaExecutor *executor = create_executor(&backend);
  const MetaTimedPointerPoint trajectory[] = {
      {.x = 10, .y = 20, .offset_millis = 0},
      {.x = 30, .y = 40, .offset_millis = 10},
      {.x = 50, .y = 60, .offset_millis = 20},
  };
  MetaInputBridgeClock clock = {
      .context = &backend,
      .monotonic_millis = fake_now,
      .wait_until = fake_wait,
  };
  size_t completed = 0;
  assert(meta_input_execute_drag(executor, trajectory, 3, META_POINTER_LEFT,
                                 0x00120000, 500, clock, &completed));
  assert(completed == 3);
  assert(backend.pointer_event_count == 3);
  assert(backend.pointer_events[0].kind == META_POINTER_MOVE);
  assert(backend.pointer_events[1].kind == META_POINTER_DRAG);
  assert(backend.pointer_events[2].x == 50);
  assert(backend.pointer_events[2].y == 60);
  assert(backend.pointer_events[2].flags == 0x00120000);
  const MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.execution == META_EXECUTOR_FINISHED);
  assert(status.dispatch_attempts == 5);
  assert(status.ledger_revision == 4);
  meta_executor_destroy(executor);
}

static void test_cancel_between_drag_points_releases_button(void) {
  FakeTextBackend backend = {.now = 100, .cancel_on_wait_call = 1};
  MetaExecutor *executor = create_executor(&backend);
  const MetaTimedPointerPoint trajectory[] = {
      {.x = 10, .y = 20, .offset_millis = 0},
      {.x = 30, .y = 40, .offset_millis = 10},
  };
  MetaInputBridgeClock clock = {
      .context = &backend,
      .monotonic_millis = fake_now,
      .wait_until = fake_wait,
  };
  size_t completed = 0;
  assert(!meta_input_execute_drag(executor, trajectory, 2, META_POINTER_LEFT,
                                  0, 500, clock, &completed));
  assert(completed == 1);
  assert(backend.pointer_event_count == 1);
  const MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.execution == META_EXECUTOR_CANCELLED);
  assert(status.cleanup == META_CLEANUP_COMPLETE);
  assert(status.held_count == 0);
  meta_executor_destroy(executor);
}

static void test_scroll_keeps_exact_anchor(void) {
  FakeTextBackend backend = {.now = 100};
  MetaExecutor *executor = create_executor(&backend);
  MetaScrollEvent event = {
      .x = -200,
      .y = 300,
      .dx = 1,
      .dy = -3,
      .unit = META_SCROLL_PIXEL,
      .flags = 0x00080000,
  };
  assert(meta_input_execute_scroll(executor, event));
  assert(backend.pointer_event_count == 1);
  assert(backend.pointer_events[0].x == -200);
  assert(backend.scroll_event_count == 1);
  assert(backend.scroll_events[0].y == 300);
  assert(backend.scroll_events[0].unit == META_SCROLL_PIXEL);
  assert(backend.scroll_events[0].flags == 0x00080000);
  meta_executor_destroy(executor);
}

static void test_shortcut_flags_and_offsets(void) {
  FakeTextBackend backend = {.now = 100};
  MetaExecutor *executor = create_executor(&backend);
  const MetaTimedKeyStroke strokes[] = {
      {.key_code = 37, .flags = 0x00100000, .offset_millis = 0},
      {.key_code = 36, .flags = 0, .offset_millis = 10},
  };
  MetaInputBridgeClock clock = {
      .context = &backend,
      .monotonic_millis = fake_now,
      .wait_until = fake_wait,
  };
  size_t completed = 0;
  assert(meta_input_execute_shortcut(executor, strokes, 2, 500, clock,
                                     &completed));
  assert(completed == 2);
  assert(backend.event_flags == 0);
  const MetaExecutorStatus status = meta_executor_status(executor);
  assert(status.dispatch_attempts == 4);
  assert(status.ledger_revision == 8);
  meta_executor_destroy(executor);
}

int main(void) {
  test_unicode_schedule();
  test_cancel_between_clusters();
  test_drag_trajectory_and_modifiers();
  test_cancel_between_drag_points_releases_button();
  test_scroll_keeps_exact_anchor();
  test_shortcut_flags_and_offsets();
  puts("input bridge tests passed");
  return 0;
}
