#include "meta_ledger.h"
#include "meta_native.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define CHECK(condition)                                                       \
  do {                                                                         \
    if (!(condition)) {                                                        \
      fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #condition); \
      return 1;                                                                \
    }                                                                          \
  } while (0)

typedef struct {
  uint64_t now;
  bool target_valid;
  size_t persist_calls;
  size_t fail_persist_call;
  size_t fail_persist_from_call;
  size_t event_count;
  struct {
    MetaHeldEventKind kind;
    uint32_t code;
    bool down;
  } events[32];
} InjectedBackend;

static uint64_t injected_now(void *context) {
  return ((InjectedBackend *)context)->now;
}

static bool injected_verify_target(void *context, const char *target_ref) {
  InjectedBackend *backend = context;
  return backend->target_valid && strcmp(target_ref, "window-1") == 0;
}

static bool injected_persist(void *context,
                             const MetaLedgerPersistenceRequest *request,
                             MetaLedgerPersistenceAck *ack) {
  InjectedBackend *backend = context;
  backend->persist_calls += 1;
  if (request == NULL || ack == NULL || request->request_id[0] == '\0' ||
      request->snapshot.operation_id[0] == '\0') {
    return false;
  }
  if (request->snapshot.entry_count > 0 &&
      request->snapshot.entries == NULL) {
    return false;
  }
  if (backend->persist_calls == backend->fail_persist_call) return false;
  if (backend->fail_persist_from_call > 0 &&
      backend->persist_calls >= backend->fail_persist_from_call) {
    return false;
  }
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
  ack->revision = request->snapshot.revision;
  snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s", digest);
  ack->persisted_at_unix_micros = 1;
  ack->durable = true;
  return true;
}

static bool injected_post(void *context, MetaHeldEventKind kind, uint32_t code,
                          bool down, uint64_t synthetic_tag) {
  InjectedBackend *backend = context;
  if (synthetic_tag == 0 || backend->event_count >= 32) return false;
  backend->events[backend->event_count].kind = kind;
  backend->events[backend->event_count].code = code;
  backend->events[backend->event_count].down = down;
  backend->event_count += 1;
  return true;
}

static MetaExecutor *create_executor(InjectedBackend *backend,
                                     const char *native_generation) {
  MetaExecutorBackend callbacks = {
      .context = backend,
      .monotonic_millis = injected_now,
      .verify_target = injected_verify_target,
      .persist_ledger = injected_persist,
      .post_held_event = injected_post,
  };
  return meta_executor_create(native_generation, 500, callbacks);
}

static MetaFence fence(const char *runtime_epoch,
                       const char *native_generation, uint64_t counter) {
  MetaFence value = {.counter = counter};
  snprintf(value.runtime_epoch, sizeof(value.runtime_epoch), "%s",
           runtime_epoch);
  snprintf(value.login_session_id, sizeof(value.login_session_id), "%s",
           "login-1");
  snprintf(value.native_generation, sizeof(value.native_generation), "%s",
           native_generation);
  return value;
}

static int scenario_a04_target_checkpoint(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a04", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(meta_executor_post_down(executor, META_EVENT_KEY, 55));
  backend.target_valid = false;
  CHECK(!meta_executor_checkpoint(executor, "acceptance-before-next-event"));
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(status.execution == META_EXECUTOR_FAILED);
  CHECK(status.target_verification == META_VERIFICATION_FAILED);
  CHECK(status.cleanup == META_CLEANUP_COMPLETE);
  CHECK(backend.event_count == 2);
  CHECK(backend.events[0].down && !backend.events[1].down);
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a06_cancel_before_event(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a06", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(meta_executor_cancel(executor));
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(status.execution == META_EXECUTOR_CANCELLED);
  CHECK(status.dispatch == META_DISPATCH_NONE);
  CHECK(status.cleanup == META_CLEANUP_COMPLETE);
  CHECK(backend.event_count == 0);
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a07_cancel_after_down(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a07", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(meta_executor_post_down(executor, META_EVENT_KEY, 55));
  CHECK(meta_executor_cancel(executor));
  MetaLedgerEntry entries[4] = {0};
  const size_t entry_count =
      meta_executor_copy_ledger(executor, entries, 4);
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(status.execution == META_EXECUTOR_CANCELLED);
  CHECK(status.dispatch == META_DISPATCH_PARTIAL);
  CHECK(status.cleanup == META_CLEANUP_COMPLETE);
  CHECK(status.held_count == 0);
  CHECK(entry_count == 1 && entries[0].state == META_LEDGER_RELEASED);
  CHECK(backend.event_count == 2);
  CHECK(backend.events[0].down && !backend.events[1].down);
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a08_lost_down_ack(void) {
  InjectedBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 2,
  };
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a08-ack", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(!meta_executor_post_down(executor, META_EVENT_BUTTON, 0));
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(status.execution == META_EXECUTOR_QUARANTINED);
  CHECK(status.dispatch == META_DISPATCH_UNKNOWN);
  CHECK(status.cleanup == META_CLEANUP_UNKNOWN);
  CHECK(status.quarantined);
  CHECK(backend.event_count == 1 && backend.events[0].down);
  CHECK(!meta_executor_begin(executor, "operation-replay", "window-1",
                             fence("runtime-1", "native-1", 2), 1000));
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a08_persist_failure_with_existing_hold(void) {
  InjectedBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_call = 3,
  };
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a08-held", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(meta_executor_post_down(executor, META_EVENT_KEY, 55));
  CHECK(!meta_executor_post_down(executor, META_EVENT_KEY, 56));
  MetaLedgerEntry entries[4] = {0};
  const size_t entry_count =
      meta_executor_copy_ledger(executor, entries, 4);
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(entry_count == 1 && entries[0].code == 55);
  CHECK(entries[0].state == META_LEDGER_RELEASED);
  CHECK(status.held_count == 0);
  CHECK(!status.quarantined);
  CHECK(status.cleanup == META_CLEANUP_COMPLETE);
  CHECK(backend.event_count == 2);
  CHECK(backend.events[0].code == 55 && backend.events[0].down);
  CHECK(backend.events[1].code == 55 && !backend.events[1].down);
  CHECK(meta_executor_begin(executor, "operation-after-cleanup", "window-1",
                            fence("runtime-1", "native-1", 2), 1000));
  CHECK(meta_executor_cancel(executor));
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a08_persist_cleanup_unknown(void) {
  InjectedBackend backend = {
      .now = 100,
      .target_valid = true,
      .fail_persist_from_call = 3,
  };
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a08-unknown", "window-1",
                            fence("runtime-1", "native-1", 1), 1000));
  CHECK(meta_executor_post_down(executor, META_EVENT_KEY, 55));
  CHECK(!meta_executor_post_down(executor, META_EVENT_KEY, 56));
  MetaLedgerEntry entries[4] = {0};
  const size_t entry_count =
      meta_executor_copy_ledger(executor, entries, 4);
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(entry_count >= 1 && entries[0].code == 55);
  CHECK(entries[0].state == META_LEDGER_UNCERTAIN);
  CHECK(status.held_count == 1);
  CHECK(status.quarantined);
  CHECK(status.cleanup == META_CLEANUP_UNKNOWN);
  CHECK(backend.event_count == 1);
  CHECK(backend.events[0].code == 55 && backend.events[0].down);
  CHECK(!meta_executor_begin(executor, "operation-after-unknown", "window-1",
                             fence("runtime-1", "native-1", 2), 1000));
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a09_watchdog(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-a09", "window-1",
                            fence("runtime-1", "native-1", 1), 2000));
  CHECK(meta_executor_post_down(executor, META_EVENT_KEY, 57));
  backend.now = 700;
  CHECK(meta_executor_watchdog_tick(executor));
  const MetaExecutorStatus status = meta_executor_status(executor);
  CHECK(status.execution == META_EXECUTOR_CANCELLED);
  CHECK(status.cleanup == META_CLEANUP_COMPLETE);
  CHECK(status.held_count == 0);
  CHECK(backend.event_count == 2);
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a09_recovery_ledger(const char *directory) {
  char path[1024] = {0};
  CHECK(snprintf(path, sizeof(path), "%s/held-input.ledger", directory) > 0);
  MetaLedgerStore *store = meta_ledger_store_create(path);
  CHECK(store != NULL);
  MetaLedgerEntry pending = {
      .sequence = 9,
      .kind = META_EVENT_KEY,
      .code = 55,
      .state = META_LEDGER_PENDING_DOWN,
  };
  MetaLedgerPersistenceRequest persistence = {0};
  snprintf(persistence.request_id, sizeof(persistence.request_id), "%s",
           "acceptance-ledger-request");
  snprintf(persistence.snapshot.operation_id,
           sizeof(persistence.snapshot.operation_id), "%s",
           "interrupted-operation");
  snprintf(persistence.snapshot.runtime_epoch,
           sizeof(persistence.snapshot.runtime_epoch), "%s",
           "runtime-before-crash");
  snprintf(persistence.snapshot.login_session_id,
           sizeof(persistence.snapshot.login_session_id), "%s",
           "login-before-crash");
  snprintf(persistence.snapshot.native_generation,
           sizeof(persistence.snapshot.native_generation), "%s",
           "native-before-crash");
  persistence.snapshot.revision = 7;
  persistence.snapshot.entries = &pending;
  persistence.snapshot.entry_count = 1;
  MetaLedgerPersistenceAck persistence_ack = {0};
  CHECK(meta_ledger_store_persist(store, &persistence, &persistence_ack));
  CHECK(persistence_ack.durable);
  struct stat details = {0};
  CHECK(stat(path, &details) == 0);
  CHECK((details.st_mode & 0777) == 0600);
  char operation_id[META_NATIVE_REF_CAPACITY] = {0};
  MetaLedgerEntry loaded[4] = {0};
  size_t loaded_count = 0;
  CHECK(meta_ledger_store_load(store, operation_id, loaded, 4, &loaded_count) ==
        META_LEDGER_LOAD_READY);
  CHECK(strcmp(operation_id, "interrupted-operation") == 0);
  CHECK(loaded_count == 1);

  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-2");
  CHECK(executor != NULL);
  MetaHeldInputLedgerSnapshot recovery_snapshot = persistence.snapshot;
  recovery_snapshot.entries = loaded;
  recovery_snapshot.entry_count = loaded_count;
  CHECK(meta_executor_restore_ledger(executor, &recovery_snapshot));
  const MetaExecutorStatus status = meta_executor_status(executor);
  const MetaRecoveryLedgerStatus recovery =
      meta_executor_recovery_status(executor);
  CHECK(status.execution == META_EXECUTOR_IDLE);
  CHECK(status.cleanup == META_CLEANUP_UNKNOWN);
  CHECK(status.quarantined);
  CHECK(status.held_count == 1);
  CHECK(recovery.present);
  CHECK(recovery.ledger_revision == 7);
  CHECK(strcmp(recovery.operation_id, "interrupted-operation") == 0);
  CHECK(strcmp(recovery.source_runtime_epoch, "runtime-before-crash") == 0);
  CHECK(strcmp(recovery.source_login_session_id, "login-before-crash") == 0);
  CHECK(strcmp(recovery.source_native_generation, "native-before-crash") == 0);
  CHECK(backend.event_count == 0);
  CHECK(!meta_executor_open_runtime_epoch(executor, "runtime-new", "login-new"));
  meta_executor_destroy(executor);
  meta_ledger_store_destroy(store);
  return 0;
}

static int scenario_a10_same_epoch_fence(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-1");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(meta_executor_begin(executor, "operation-first", "window-1",
                            fence("runtime-1", "native-1", 7), 1000));
  CHECK(meta_executor_cancel(executor));
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
  CHECK(!meta_executor_begin(executor, "operation-replay", "window-1",
                             fence("runtime-1", "native-1", 7), 1000));
  CHECK(meta_executor_begin(executor, "operation-next", "window-1",
                            fence("runtime-1", "native-1", 8), 1000));
  CHECK(meta_executor_cancel(executor));
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a10_generation_fence(void) {
  InjectedBackend backend = {.now = 100, .target_valid = true};
  MetaExecutor *executor = create_executor(&backend, "native-current");
  CHECK(executor != NULL);
  CHECK(meta_executor_open_runtime_epoch(executor, "runtime-current", "login-1"));
  CHECK(!meta_executor_begin(executor, "operation-old-runtime", "window-1",
                             fence("runtime-old", "native-current", 1), 1000));
  CHECK(!meta_executor_begin(executor, "operation-old-native", "window-1",
                             fence("runtime-current", "native-old", 1), 1000));
  CHECK(backend.event_count == 0);
  meta_executor_destroy(executor);
  return 0;
}

static int scenario_a16_ambiguous_mapping(void) {
  MetaRegistry *registry = meta_registry_create("native-1");
  CHECK(registry != NULL);
  MetaApplicationInput application = {
      .pid = 10,
      .launch_time_micros = 100,
      .name = "Fixture",
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput ax_windows[2] = {
      {.pid = 10,
       .launch_time_micros = 100,
       .ax_token = 1,
       .title = "same",
       .frame = {0, 0, 500, 400}},
      {.pid = 10,
       .launch_time_micros = 100,
       .ax_token = 2,
       .title = "same",
       .frame = {0, 0, 500, 400}},
  };
  MetaCGWindowInput cg_window = {
      .window_id = 42,
      .pid = 10,
      .title = "same",
      .frame = {0, 0, 500, 400},
      .on_screen = META_TRUE,
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = ax_windows,
      .ax_window_count = 2,
      .cg_windows = &cg_window,
      .cg_window_count = 1,
      .source_complete = true,
  };
  CHECK(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  CHECK(snapshot->window_count == 3);
  CHECK(snapshot->windows[0].mapping == META_MAPPING_AMBIGUOUS);
  CHECK(snapshot->windows[1].mapping == META_MAPPING_AMBIGUOUS);
  CHECK(snapshot->windows[2].mapping == META_MAPPING_AMBIGUOUS);
  CHECK(snapshot->windows[0].cg_window_id == 0);
  CHECK(snapshot->windows[1].cg_window_id == 0);
  CHECK(snapshot->windows[2].cg_window_id == 42);
  meta_registry_destroy(registry);
  return 0;
}

int main(int argc, char **argv) {
  if (META_NATIVE_ABI_VERSION != 2) return 3;
  if (argc < 2) return 2;
  if (strcmp(argv[1], "a04-target-checkpoint") == 0)
    return scenario_a04_target_checkpoint();
  if (strcmp(argv[1], "a06-cancel-before-event") == 0)
    return scenario_a06_cancel_before_event();
  if (strcmp(argv[1], "a07-cancel-after-down") == 0)
    return scenario_a07_cancel_after_down();
  if (strcmp(argv[1], "a08-lost-down-ack") == 0)
    return scenario_a08_lost_down_ack();
  if (strcmp(argv[1], "a08-persist-existing-hold") == 0)
    return scenario_a08_persist_failure_with_existing_hold();
  if (strcmp(argv[1], "a08-persist-cleanup-unknown") == 0)
    return scenario_a08_persist_cleanup_unknown();
  if (strcmp(argv[1], "a09-watchdog") == 0)
    return scenario_a09_watchdog();
  if (strcmp(argv[1], "a09-recovery-ledger") == 0 && argc == 3)
    return scenario_a09_recovery_ledger(argv[2]);
  if (strcmp(argv[1], "a10-same-epoch-fence") == 0)
    return scenario_a10_same_epoch_fence();
  if (strcmp(argv[1], "a10-generation-fence") == 0)
    return scenario_a10_generation_fence();
  if (strcmp(argv[1], "a16-ambiguous-mapping") == 0)
    return scenario_a16_ambiguous_mapping();
  return 2;
}
