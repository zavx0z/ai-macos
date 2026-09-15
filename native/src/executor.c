#include "meta_native.h"
#include "meta_ledger.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct MetaExecutor {
  char native_generation[META_NATIVE_REF_CAPACITY];
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char operation_id[META_NATIVE_REF_CAPACITY];
  char target_ref[META_NATIVE_REF_CAPACITY];
  uint64_t last_fence_counter;
  uint64_t active_fence_counter;
  uint64_t deadline_millis;
  uint64_t last_heartbeat_millis;
  uint64_t watchdog_timeout_millis;
  uint64_t synthetic_tag;
  uint64_t next_ledger_sequence;
  MetaExecutorBackend backend;
  MetaLedgerEntry *ledger;
  size_t ledger_count;
  MetaExecutorStatus status;
  MetaObserverState observer_state;
  bool active;
  bool rotation_sealed;
  MetaRecoveryLedgerStatus recovery_status;
  bool has_previous_ledger_digest;
  char previous_ledger_digest[65];
  struct {
    char runtime_epoch[META_NATIVE_REF_CAPACITY];
    char login_session_id[META_NATIVE_REF_CAPACITY];
  } *retired_generations;
  size_t retired_generation_count;
};

static void copy_text(char *target, size_t capacity, const char *source) {
  if (capacity == 0) return;
  if (source == NULL) source = "";
  snprintf(target, capacity, "%s", source);
}

static bool valid_identifier(const char *value, size_t maximum) {
  if (value == NULL || value[0] == '\0') return false;
  const size_t length = strnlen(value, maximum + 1);
  return length >= 1 && length <= maximum;
}

static uint64_t now_millis(const MetaExecutor *executor) {
  if (executor->backend.monotonic_millis == NULL) return 0;
  return executor->backend.monotonic_millis(executor->backend.context);
}

static uint64_t hash_text(uint64_t value, const char *text) {
  const unsigned char *cursor = (const unsigned char *)text;
  while (*cursor != '\0') {
    value ^= *cursor++;
    value *= 1099511628211ULL;
  }
  return value;
}

static bool persist_ledger(MetaExecutor *executor) {
  if (executor->backend.persist_ledger == NULL) return false;
  MetaLedgerPersistenceRequest request = {0};
  request.snapshot.revision = executor->status.ledger_revision + 1;
  request.snapshot.has_previous_snapshot_sha256 =
      executor->has_previous_ledger_digest;
  request.snapshot.entries = executor->ledger;
  request.snapshot.entry_count = executor->ledger_count;
  copy_text(request.snapshot.operation_id,
            sizeof(request.snapshot.operation_id), executor->operation_id);
  copy_text(request.snapshot.runtime_epoch,
            sizeof(request.snapshot.runtime_epoch), executor->runtime_epoch);
  copy_text(request.snapshot.login_session_id,
            sizeof(request.snapshot.login_session_id),
            executor->login_session_id);
  copy_text(request.snapshot.native_generation,
            sizeof(request.snapshot.native_generation),
            executor->native_generation);
  if (executor->has_previous_ledger_digest) {
    copy_text(request.snapshot.previous_snapshot_sha256,
              sizeof(request.snapshot.previous_snapshot_sha256),
              executor->previous_ledger_digest);
  }
  snprintf(request.request_id, sizeof(request.request_id),
           "ledger-%llu-%016llx",
           (unsigned long long)request.snapshot.revision,
           (unsigned long long)executor->synthetic_tag);
  char expected_digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(&request.snapshot, expected_digest)) {
    return false;
  }
  MetaLedgerPersistenceAck ack = {0};
  const bool persisted = executor->backend.persist_ledger(
      executor->backend.context, &request, &ack);
  if (!persisted || !ack.durable || ack.persisted_at_unix_micros == 0 ||
      strcmp(ack.request_id, request.request_id) != 0 ||
      strcmp(ack.operation_id, request.snapshot.operation_id) != 0 ||
      strcmp(ack.runtime_epoch, request.snapshot.runtime_epoch) != 0 ||
      strcmp(ack.login_session_id, request.snapshot.login_session_id) != 0 ||
      strcmp(ack.native_generation, request.snapshot.native_generation) != 0 ||
      ack.revision != request.snapshot.revision ||
      strcmp(ack.snapshot_sha256, expected_digest) != 0) {
    return false;
  }
  executor->status.ledger_revision = request.snapshot.revision;
  executor->has_previous_ledger_digest = true;
  copy_text(executor->previous_ledger_digest,
            sizeof(executor->previous_ledger_digest), expected_digest);
  return true;
}

static size_t held_count(const MetaExecutor *executor) {
  size_t count = 0;
  for (size_t index = 0; index < executor->ledger_count; index += 1) {
    const MetaLedgerState state = executor->ledger[index].state;
    if (state == META_LEDGER_PENDING_DOWN ||
        state == META_LEDGER_CONFIRMED_DOWN ||
        state == META_LEDGER_PENDING_UP ||
        state == META_LEDGER_UNCERTAIN) {
      count += 1;
    }
  }
  return count;
}

static void quarantine(MetaExecutor *executor) {
  executor->status.execution = META_EXECUTOR_QUARANTINED;
  executor->status.dispatch = META_DISPATCH_UNKNOWN;
  executor->status.cleanup = META_CLEANUP_UNKNOWN;
  executor->status.quarantined = true;
  executor->active = false;
}

static bool release_confirmed_holds(MetaExecutor *executor) {
  bool complete = true;
  const uint64_t cleanup_deadline = now_millis(executor) + 1000;

  for (size_t offset = executor->ledger_count; offset > 0; offset -= 1) {
    MetaLedgerEntry *entry = &executor->ledger[offset - 1];
    if (entry->state == META_LEDGER_PENDING_DOWN ||
        entry->state == META_LEDGER_PENDING_UP ||
        entry->state == META_LEDGER_UNCERTAIN) {
      entry->state = META_LEDGER_UNCERTAIN;
      complete = false;
      continue;
    }
    if (entry->state != META_LEDGER_CONFIRMED_DOWN) continue;
    if (now_millis(executor) > cleanup_deadline) {
      entry->state = META_LEDGER_UNCERTAIN;
      complete = false;
      continue;
    }
    entry->state = META_LEDGER_PENDING_UP;
    if (!persist_ledger(executor)) {
      entry->state = META_LEDGER_UNCERTAIN;
      complete = false;
      continue;
    }
    const bool posted = executor->backend.post_held_event != NULL &&
                        executor->backend.post_held_event(
                            executor->backend.context, entry->kind, entry->code,
                            false, executor->synthetic_tag);
    executor->status.dispatch_attempts += 1;
    copy_text(executor->status.last_checkpoint,
              sizeof(executor->status.last_checkpoint), "cleanup-up");
    if (!posted) {
      entry->state = META_LEDGER_UNCERTAIN;
      persist_ledger(executor);
      complete = false;
      continue;
    }
    entry->state = META_LEDGER_RELEASED;
    if (!persist_ledger(executor)) {
      entry->state = META_LEDGER_UNCERTAIN;
      complete = false;
    }
  }

  executor->status.held_count = held_count(executor);
  if (!complete || executor->status.held_count > 0) {
    quarantine(executor);
    return false;
  }
  executor->status.cleanup = META_CLEANUP_COMPLETE;
  return true;
}

static bool stop_for_reason(MetaExecutor *executor,
                            MetaExecutorState terminal_state) {
  executor->status.execution = META_EXECUTOR_CANCELLING;
  if (!release_confirmed_holds(executor)) return false;
  executor->status.execution = terminal_state;
  executor->status.dispatch =
      executor->status.dispatch == META_DISPATCH_NONE
          ? META_DISPATCH_NONE
          : META_DISPATCH_PARTIAL;
  executor->active = false;
  return true;
}

MetaExecutor *meta_executor_create(const char *native_generation,
                                   uint64_t watchdog_timeout_millis,
                                   MetaExecutorBackend backend) {
  if (!valid_identifier(native_generation, 64) ||
      watchdog_timeout_millis == 0 || backend.monotonic_millis == NULL ||
      backend.verify_target == NULL || backend.persist_ledger == NULL ||
      backend.post_held_event == NULL) {
    return NULL;
  }
  MetaExecutor *executor = calloc(1, sizeof(*executor));
  if (executor == NULL) return NULL;
  copy_text(executor->native_generation, sizeof(executor->native_generation),
            native_generation);
  executor->watchdog_timeout_millis = watchdog_timeout_millis;
  executor->backend = backend;
  executor->status.execution = META_EXECUTOR_IDLE;
  executor->status.dispatch = META_DISPATCH_NONE;
  executor->status.cleanup = META_CLEANUP_COMPLETE;
  executor->status.restoration_allowed = true;
  executor->status.target_verification = META_VERIFICATION_UNKNOWN;
  executor->status.user_interference = META_INTERFERENCE_UNKNOWN;
  executor->observer_state = META_OBSERVER_UNAVAILABLE;
  executor->status.observer_state = META_OBSERVER_UNAVAILABLE;
  executor->next_ledger_sequence = 1;
  executor->has_previous_ledger_digest = false;
  executor->previous_ledger_digest[0] = '\0';
  return executor;
}

void meta_executor_destroy(MetaExecutor *executor) {
  if (executor == NULL) return;
  free(executor->ledger);
  free(executor->retired_generations);
  free(executor);
}

bool meta_executor_open_runtime_epoch(MetaExecutor *executor,
                                      const char *runtime_epoch,
                                      const char *login_session_id) {
  if (executor == NULL || !valid_identifier(runtime_epoch, 64) ||
      !valid_identifier(login_session_id, 64) ||
      executor->active || executor->status.quarantined || executor->rotation_sealed) {
    return false;
  }
  if (strcmp(executor->runtime_epoch, runtime_epoch) == 0 &&
      strcmp(executor->login_session_id, login_session_id) == 0) {
    executor->last_heartbeat_millis = now_millis(executor);
    return true;
  }
  if (strcmp(executor->runtime_epoch, runtime_epoch) == 0) return false;
  for (size_t index = 0; index < executor->retired_generation_count;
       index += 1) {
    if (strcmp(executor->retired_generations[index].runtime_epoch,
               runtime_epoch) == 0) {
      return false;
    }
  }
  if (executor->runtime_epoch[0] != '\0') {
    const size_t next_count = executor->retired_generation_count + 1;
    void *next = realloc(executor->retired_generations,
                         next_count * sizeof(*executor->retired_generations));
    if (next == NULL) return false;
    executor->retired_generations = next;
    copy_text(executor->retired_generations[next_count - 1].runtime_epoch,
              META_NATIVE_REF_CAPACITY, executor->runtime_epoch);
    copy_text(executor->retired_generations[next_count - 1].login_session_id,
              META_NATIVE_REF_CAPACITY, executor->login_session_id);
    executor->retired_generation_count = next_count;
  }
  copy_text(executor->runtime_epoch, sizeof(executor->runtime_epoch),
            runtime_epoch);
  copy_text(executor->login_session_id, sizeof(executor->login_session_id),
            login_session_id);
  executor->last_fence_counter = 0;
  executor->last_heartbeat_millis = now_millis(executor);
  executor->status = (MetaExecutorStatus){
      .execution = META_EXECUTOR_IDLE,
      .dispatch = META_DISPATCH_NONE,
      .cleanup = META_CLEANUP_COMPLETE,
      .target_verification = META_VERIFICATION_UNKNOWN,
      .user_interference = META_INTERFERENCE_UNKNOWN,
      .observer_state = executor->observer_state,
  };
  return true;
}

bool meta_executor_restore_ledger(
    MetaExecutor *executor,
    const MetaHeldInputLedgerSnapshot *persisted_snapshot) {
  if (executor == NULL || persisted_snapshot == NULL ||
      !valid_identifier(persisted_snapshot->operation_id, 127) ||
      !valid_identifier(persisted_snapshot->runtime_epoch, 64) ||
      !valid_identifier(persisted_snapshot->login_session_id, 64) ||
      !valid_identifier(persisted_snapshot->native_generation, 64) ||
      persisted_snapshot->revision == 0 ||
      persisted_snapshot->entry_count > 512 ||
      (persisted_snapshot->entry_count > 0 &&
       persisted_snapshot->entries == NULL) || executor->active ||
      executor->ledger_count > 0) {
    return false;
  }
  const size_t entry_count = persisted_snapshot->entry_count;
  const MetaLedgerEntry *entries = persisted_snapshot->entries;
  if (entry_count > 0) {
    executor->ledger = calloc(entry_count, sizeof(*executor->ledger));
    if (executor->ledger == NULL) return false;
    memcpy(executor->ledger, entries, entry_count * sizeof(*entries));
  }
  executor->ledger_count = entry_count;
  copy_text(executor->operation_id, sizeof(executor->operation_id),
            persisted_snapshot->operation_id);
  for (size_t index = 0; index < entry_count; index += 1) {
    if (entries[index].sequence >= executor->next_ledger_sequence) {
      executor->next_ledger_sequence = entries[index].sequence + 1;
    }
  }
  if (held_count(executor) == 0) return true;
  for (size_t index = 0; index < executor->ledger_count; index += 1) {
    if (executor->ledger[index].state != META_LEDGER_RELEASED) {
      executor->ledger[index].state = META_LEDGER_UNCERTAIN;
    }
  }
  executor->status.execution = META_EXECUTOR_IDLE;
  executor->status.dispatch = META_DISPATCH_UNKNOWN;
  executor->status.cleanup = META_CLEANUP_UNKNOWN;
  executor->status.quarantined = true;
  executor->status.user_interference = META_INTERFERENCE_UNKNOWN;
  executor->status.target_verification = META_VERIFICATION_UNKNOWN;
  executor->status.observer_state = executor->observer_state;
  executor->status.held_count = held_count(executor);
  executor->status.ledger_revision = persisted_snapshot->revision;
  executor->recovery_status = (MetaRecoveryLedgerStatus){
      .present = true,
      .ledger_revision = persisted_snapshot->revision,
      .held_count = held_count(executor),
      .cleanup = META_CLEANUP_UNKNOWN,
      .quarantined = true,
  };
  snprintf(executor->recovery_status.recovery_id,
           sizeof(executor->recovery_status.recovery_id),
           "recovery-%016llx",
           (unsigned long long)hash_text(1469598103934665603ULL,
                                         persisted_snapshot->operation_id));
  copy_text(executor->recovery_status.operation_id,
            sizeof(executor->recovery_status.operation_id),
            persisted_snapshot->operation_id);
  copy_text(executor->recovery_status.source_runtime_epoch,
            sizeof(executor->recovery_status.source_runtime_epoch),
            persisted_snapshot->runtime_epoch);
  copy_text(executor->recovery_status.source_login_session_id,
            sizeof(executor->recovery_status.source_login_session_id),
            persisted_snapshot->login_session_id);
  copy_text(executor->recovery_status.source_native_generation,
            sizeof(executor->recovery_status.source_native_generation),
            persisted_snapshot->native_generation);
  return true;
}

bool meta_executor_begin(MetaExecutor *executor, const char *operation_id,
                         const char *target_ref, MetaFence fence,
                         uint64_t deadline_millis) {
  if (executor == NULL || !valid_identifier(operation_id, 127) ||
      !valid_identifier(target_ref, 127) || executor->active ||
      executor->rotation_sealed ||
      executor->status.quarantined ||
      !valid_identifier(fence.runtime_epoch, 64) ||
      !valid_identifier(fence.login_session_id, 64) ||
      !valid_identifier(fence.native_generation, 64) ||
      strcmp(fence.native_generation, executor->native_generation) != 0 ||
      strcmp(fence.runtime_epoch, executor->runtime_epoch) != 0 ||
      strcmp(fence.login_session_id, executor->login_session_id) != 0 ||
      fence.counter <= executor->last_fence_counter ||
      deadline_millis <= now_millis(executor)) {
    return false;
  }

  if (held_count(executor) > 0) {
    quarantine(executor);
    return false;
  }
  free(executor->ledger);
  executor->ledger = NULL;
  executor->ledger_count = 0;
  executor->next_ledger_sequence = 1;
  executor->has_previous_ledger_digest = false;
  executor->previous_ledger_digest[0] = '\0';
  copy_text(executor->operation_id, sizeof(executor->operation_id),
            operation_id);
  copy_text(executor->target_ref, sizeof(executor->target_ref), target_ref);
  executor->active_fence_counter = fence.counter;
  executor->last_fence_counter = fence.counter;
  executor->deadline_millis = deadline_millis;
  executor->last_heartbeat_millis = now_millis(executor);
  uint64_t synthetic_tag = 1469598103934665603ULL;
  synthetic_tag = hash_text(synthetic_tag, executor->native_generation);
  synthetic_tag = hash_text(synthetic_tag, executor->runtime_epoch);
  synthetic_tag = hash_text(synthetic_tag, executor->login_session_id);
  synthetic_tag = hash_text(synthetic_tag, executor->operation_id);
  synthetic_tag ^= fence.counter;
  synthetic_tag *= 1099511628211ULL;
  executor->synthetic_tag = synthetic_tag == 0 ? 1 : synthetic_tag;
  executor->status = (MetaExecutorStatus){
      .execution = META_EXECUTOR_DISPATCHING,
      .dispatch = META_DISPATCH_NONE,
      .cleanup = META_CLEANUP_COMPLETE,
      .target_verification = META_VERIFICATION_UNKNOWN,
      .user_interference = executor->observer_state == META_OBSERVER_READY
                               ? META_INTERFERENCE_NONE_OBSERVED
                               : META_INTERFERENCE_UNKNOWN,
      .restoration_allowed = executor->observer_state == META_OBSERVER_READY,
      .observer_state = executor->observer_state,
  };
  copy_text(executor->status.operation_id,
            sizeof(executor->status.operation_id), operation_id);
  executor->status.high_water_fence = fence;
  executor->status.accepted_fence = fence;
  executor->status.has_high_water_fence = true;
  executor->status.has_accepted_fence = true;
  copy_text(executor->status.last_checkpoint,
            sizeof(executor->status.last_checkpoint), "accepted");
  executor->active = true;
  if (!executor->backend.verify_target(executor->backend.context,
                                       executor->target_ref)) {
    executor->status.execution = META_EXECUTOR_FAILED;
    executor->status.target_verification = META_VERIFICATION_FAILED;
    executor->active = false;
    return false;
  }
  executor->status.target_verification = META_VERIFICATION_VERIFIED;
  return true;
}

bool meta_executor_checkpoint(MetaExecutor *executor, const char *stage) {
  if (executor == NULL || !executor->active ||
      !valid_identifier(stage, 127)) {
    return false;
  }
  copy_text(executor->status.last_checkpoint,
            sizeof(executor->status.last_checkpoint), stage);
  if (executor->status.cancellation_requested ||
      (executor->backend.should_cancel != NULL && executor->backend.should_cancel(executor->backend.context)) ||
      now_millis(executor) > executor->deadline_millis) {
    executor->status.cancellation_requested = true;
    stop_for_reason(executor, META_EXECUTOR_CANCELLED);
    return false;
  }
  if (!executor->backend.verify_target(executor->backend.context,
                                       executor->target_ref)) {
    executor->status.target_verification = META_VERIFICATION_FAILED;
    stop_for_reason(executor, META_EXECUTOR_FAILED);
    return false;
  }
  executor->status.target_verification = META_VERIFICATION_VERIFIED;
  return true;
}

bool meta_executor_post_down(MetaExecutor *executor, MetaHeldEventKind kind,
                             uint32_t code) {
  if (!meta_executor_checkpoint(executor, "before-down")) return false;
  for (size_t index = 0; index < executor->ledger_count; index += 1) {
    if (executor->ledger[index].kind == kind &&
        executor->ledger[index].code == code &&
        executor->ledger[index].state != META_LEDGER_RELEASED) {
      return false;
    }
  }

  const size_t next_count = executor->ledger_count + 1;
  MetaLedgerEntry *next =
      realloc(executor->ledger, next_count * sizeof(*next));
  if (next == NULL) {
    stop_for_reason(executor, META_EXECUTOR_FAILED);
    return false;
  }
  executor->ledger = next;
  MetaLedgerEntry *entry = &next[next_count - 1];
  *entry = (MetaLedgerEntry){
      .sequence = executor->next_ledger_sequence++,
      .kind = kind,
      .code = code,
      .state = META_LEDGER_PENDING_DOWN,
  };
  executor->ledger_count = next_count;
  if (!persist_ledger(executor)) {
    executor->ledger_count -= 1;
    stop_for_reason(executor, META_EXECUTOR_FAILED);
    return false;
  }

  if (!meta_executor_checkpoint(executor, "after-down-ledger-ack")) return false;

  const bool posted = executor->backend.post_held_event(
      executor->backend.context, kind, code, true, executor->synthetic_tag);
  executor->status.dispatch_attempts += 1;
  executor->status.dispatch = META_DISPATCH_ATTEMPTED;
  if (!posted) {
    entry->state = META_LEDGER_UNCERTAIN;
    persist_ledger(executor);
    quarantine(executor);
    return false;
  }
  entry->state = META_LEDGER_CONFIRMED_DOWN;
  if (!persist_ledger(executor)) {
    entry->state = META_LEDGER_UNCERTAIN;
    quarantine(executor);
    return false;
  }
  executor->status.held_count = held_count(executor);
  return true;
}

bool meta_executor_post_up(MetaExecutor *executor, MetaHeldEventKind kind,
                           uint32_t code) {
  if (!meta_executor_checkpoint(executor, "before-up")) return false;
  MetaLedgerEntry *entry = NULL;
  for (size_t offset = executor->ledger_count; offset > 0; offset -= 1) {
    MetaLedgerEntry *candidate = &executor->ledger[offset - 1];
    if (candidate->kind == kind && candidate->code == code &&
        candidate->state == META_LEDGER_CONFIRMED_DOWN) {
      entry = candidate;
      break;
    }
  }
  if (entry == NULL) return false;

  entry->state = META_LEDGER_PENDING_UP;
  if (!persist_ledger(executor)) {
    entry->state = META_LEDGER_UNCERTAIN;
    quarantine(executor);
    return false;
  }
  const bool posted = executor->backend.post_held_event(
      executor->backend.context, kind, code, false, executor->synthetic_tag);
  executor->status.dispatch_attempts += 1;
  executor->status.dispatch = META_DISPATCH_PARTIAL;
  if (!posted) {
    entry->state = META_LEDGER_UNCERTAIN;
    persist_ledger(executor);
    quarantine(executor);
    return false;
  }
  entry->state = META_LEDGER_RELEASED;
  if (!persist_ledger(executor)) {
    entry->state = META_LEDGER_UNCERTAIN;
    quarantine(executor);
    return false;
  }
  executor->status.held_count = held_count(executor);
  return true;
}

bool meta_executor_post_text_cluster(MetaExecutor *executor,
                                     const uint16_t *utf16_units,
                                     size_t utf16_count,
                                     const char *checkpoint) {
  if (executor == NULL || utf16_units == NULL || utf16_count == 0 ||
      utf16_count > 10000 || executor->backend.post_text_cluster == NULL ||
      !meta_executor_checkpoint(executor, checkpoint)) {
    return false;
  }
  const bool posted = executor->backend.post_text_cluster(
      executor->backend.context, utf16_units, utf16_count,
      executor->synthetic_tag);
  executor->status.dispatch_attempts += 1;
  executor->status.dispatch = META_DISPATCH_ATTEMPTED;
  if (!posted) {
    quarantine(executor);
    return false;
  }
  executor->status.dispatch = META_DISPATCH_PARTIAL;
  return executor->active;
}

bool meta_executor_post_pointer_event(MetaExecutor *executor,
                                      const MetaPointerEvent *event,
                                      const char *checkpoint) {
  if (executor == NULL || event == NULL ||
      executor->backend.post_pointer_event == NULL ||
      !meta_executor_checkpoint(executor, checkpoint)) {
    return false;
  }
  const bool posted = executor->backend.post_pointer_event(
      executor->backend.context, event, executor->synthetic_tag);
  executor->status.dispatch_attempts += 1;
  executor->status.dispatch = META_DISPATCH_ATTEMPTED;
  if (!posted) {
    quarantine(executor);
    return false;
  }
  executor->status.dispatch = META_DISPATCH_PARTIAL;
  return executor->active;
}

bool meta_executor_post_scroll_event(MetaExecutor *executor,
                                     const MetaScrollEvent *event,
                                     const char *checkpoint) {
  if (executor == NULL || event == NULL ||
      executor->backend.post_scroll_event == NULL ||
      !meta_executor_checkpoint(executor, checkpoint)) {
    return false;
  }
  const bool posted = executor->backend.post_scroll_event(
      executor->backend.context, event, executor->synthetic_tag);
  executor->status.dispatch_attempts += 1;
  executor->status.dispatch = META_DISPATCH_ATTEMPTED;
  if (!posted) {
    quarantine(executor);
    return false;
  }
  executor->status.dispatch = META_DISPATCH_PARTIAL;
  return executor->active;
}

bool meta_executor_set_event_flags(MetaExecutor *executor,
                                   uint64_t flags,
                                   const char *checkpoint) {
  if (executor == NULL || executor->backend.set_event_flags == NULL ||
      !meta_executor_checkpoint(executor, checkpoint)) {
    return false;
  }
  return executor->backend.set_event_flags(executor->backend.context, flags);
}

bool meta_executor_finish(MetaExecutor *executor) {
  if (executor == NULL || !executor->active ||
      !meta_executor_checkpoint(executor, "finish")) {
    return false;
  }
  if (held_count(executor) > 0) {
    stop_for_reason(executor, META_EXECUTOR_FAILED);
    return false;
  }
  executor->status.execution = META_EXECUTOR_FINISHED;
  executor->status.dispatch = executor->status.dispatch == META_DISPATCH_NONE
                                  ? META_DISPATCH_NONE
                                  : META_DISPATCH_FINISHED;
  executor->status.cleanup = META_CLEANUP_COMPLETE;
  executor->active = false;
  return true;
}

bool meta_executor_cancel(MetaExecutor *executor) {
  if (executor == NULL || !executor->active) return false;
  executor->status.cancellation_requested = true;
  copy_text(executor->status.last_checkpoint,
            sizeof(executor->status.last_checkpoint), "cancel-requested");
  return stop_for_reason(executor, META_EXECUTOR_CANCELLED);
}

static bool same_fence(MetaFence left, MetaFence right) {
  return left.counter == right.counter &&
         strcmp(left.runtime_epoch, right.runtime_epoch) == 0 &&
         strcmp(left.login_session_id, right.login_session_id) == 0 &&
         strcmp(left.native_generation, right.native_generation) == 0;
}

bool meta_executor_cancel_operation(MetaExecutor *executor,
                                    const char *operation_id,
                                    MetaFence accepted_fence) {
  if (executor == NULL || !executor->active ||
      !valid_identifier(operation_id, 127) ||
      strcmp(operation_id, executor->operation_id) != 0 ||
      !executor->status.has_accepted_fence ||
      !same_fence(accepted_fence, executor->status.accepted_fence)) {
    return false;
  }
  return meta_executor_cancel(executor);
}

bool meta_executor_advance_fence(MetaExecutor *executor,
                                 MetaFence high_water_fence) {
  if (executor == NULL ||
      !valid_identifier(high_water_fence.runtime_epoch, 64) ||
      !valid_identifier(high_water_fence.login_session_id, 64) ||
      !valid_identifier(high_water_fence.native_generation, 64) ||
      strcmp(high_water_fence.runtime_epoch, executor->runtime_epoch) != 0 ||
      strcmp(high_water_fence.login_session_id,
             executor->login_session_id) != 0 ||
      strcmp(high_water_fence.native_generation,
             executor->native_generation) != 0 ||
      high_water_fence.counter <= executor->last_fence_counter) {
    return false;
  }
  executor->last_fence_counter = high_water_fence.counter;
  executor->status.high_water_fence = high_water_fence;
  executor->status.has_high_water_fence = true;
  if (executor->status.has_accepted_fence &&
      executor->status.accepted_fence.counter < high_water_fence.counter) {
    executor->status.restoration_allowed = false;
  }
  if (executor->active) {
    executor->status.cancellation_requested = true;
    copy_text(executor->status.last_checkpoint,
              sizeof(executor->status.last_checkpoint), "fence-advanced");
    stop_for_reason(executor, META_EXECUTOR_CANCELLED);
  }
  return true;
}

bool meta_executor_heartbeat(MetaExecutor *executor,
                             const char *runtime_epoch,
                             const char *login_session_id) {
  if (executor == NULL || runtime_epoch == NULL ||
      login_session_id == NULL ||
      strcmp(runtime_epoch, executor->runtime_epoch) != 0 ||
      strcmp(login_session_id, executor->login_session_id) != 0) {
    return false;
  }
  executor->last_heartbeat_millis = now_millis(executor);
  return true;
}

bool meta_executor_watchdog_tick(MetaExecutor *executor) {
  if (executor == NULL || !executor->active) return false;
  const uint64_t now = now_millis(executor);
  if (now < executor->last_heartbeat_millis ||
      now - executor->last_heartbeat_millis <=
          executor->watchdog_timeout_millis) {
    return false;
  }
  executor->status.cancellation_requested = true;
  copy_text(executor->status.last_checkpoint,
            sizeof(executor->status.last_checkpoint), "watchdog-expired");
  return stop_for_reason(executor, META_EXECUTOR_CANCELLED);
}

void meta_executor_set_observer_state(MetaExecutor *executor,
                                      MetaObserverState state) {
  if (executor == NULL) return;
  executor->observer_state = state;
  executor->status.observer_state = state;
  if (state != META_OBSERVER_READY) {
    executor->status.restoration_allowed = false;
  }
}

bool meta_executor_note_observed_event(MetaExecutor *executor,
                                       uint64_t synthetic_tag) {
  if (executor == NULL || !executor->active ||
      executor->observer_state != META_OBSERVER_READY) {
    return false;
  }
  if (synthetic_tag == executor->synthetic_tag) return true;
  executor->status.user_interference = META_INTERFERENCE_OBSERVED;
  executor->status.restoration_allowed = false;
  executor->status.cancellation_requested = true;
  stop_for_reason(executor, META_EXECUTOR_CANCELLED);
  return false;
}

uint64_t meta_executor_synthetic_tag(const MetaExecutor *executor) {
  return executor == NULL ? 0 : executor->synthetic_tag;
}

MetaExecutorStatus meta_executor_status(const MetaExecutor *executor) {
  if (executor == NULL) {
    return (MetaExecutorStatus){
        .execution = META_EXECUTOR_FAILED,
        .dispatch = META_DISPATCH_NONE,
        .cleanup = META_CLEANUP_UNKNOWN,
        .target_verification = META_VERIFICATION_UNKNOWN,
        .user_interference = META_INTERFERENCE_UNKNOWN,
        .quarantined = true,
    };
  }
  MetaExecutorStatus status = executor->status;
  status.held_count = held_count(executor);
  if (status.held_count > 0 && status.cleanup == META_CLEANUP_COMPLETE) {
    status.cleanup = META_CLEANUP_INCOMPLETE;
  }
  return status;
}

bool meta_executor_seal_for_rotation(MetaExecutor *executor) {
  if (executor == NULL) return false;
  executor->rotation_sealed = true;
  if (executor->active || executor->status.quarantined ||
      executor->status.cleanup != META_CLEANUP_COMPLETE ||
      held_count(executor) != 0 || executor->recovery_status.present) {
    return false;
  }
  return true;
}

MetaRecoveryLedgerStatus meta_executor_recovery_status(
    const MetaExecutor *executor) {
  if (executor == NULL) return (MetaRecoveryLedgerStatus){0};
  return executor->recovery_status;
}

size_t meta_executor_copy_ledger(const MetaExecutor *executor,
                                 MetaLedgerEntry *entries, size_t capacity) {
  if (executor == NULL) return 0;
  const size_t count = executor->ledger_count < capacity
                           ? executor->ledger_count
                           : capacity;
  if (entries != NULL && count > 0) {
    memcpy(entries, executor->ledger, count * sizeof(*entries));
  }
  return executor->ledger_count;
}
