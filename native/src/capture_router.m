#import <Foundation/Foundation.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "meta_capture_router.h"

typedef struct {
  char task_ref[META_NATIVE_REF_CAPACITY];
  char operation_id[META_NATIVE_REF_CAPACITY];
  MetaCaptureTaskRef native_task;
  MetaCaptureResult *result;
  bool released;
  bool releasing;
  bool safe_to_forget;
  bool cancel_requested;
  size_t in_flight;
  size_t result_borrows;
  size_t null_result_borrows;
  bool callback_pending;
  bool has_last_status;
  MetaCaptureTaskStatus last_status;
  char pending_cleanup_request_id[META_NATIVE_REF_CAPACITY];
  bool has_release_receipt;
  MetaCaptureReleaseReceipt release_receipt;
} CaptureEntry;

struct MetaCaptureRouter {
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t next_task;
  MetaCaptureRouterBackend backend;
  NSCondition *lock;
  CaptureEntry **entries;
  size_t entry_count;
  bool rotation_sealed;
};

static bool valid_identifier(const char *value, size_t maximum) {
  if (value == NULL || value[0] == '\0') return false;
  const size_t length = strnlen(value, maximum + 1);
  return length >= 1 && length <= maximum;
}

static CaptureEntry *find_entry(MetaCaptureRouter *router,
                                const char *task_ref) {
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released && strcmp(entry->task_ref, task_ref) == 0) {
      return entry;
    }
  }
  return NULL;
}

static CaptureEntry *find_any_entry(MetaCaptureRouter *router,
                                    const char *task_ref) {
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (strcmp(entry->task_ref, task_ref) == 0) return entry;
  }
  return NULL;
}

static void release_in_flight(MetaCaptureRouter *router, CaptureEntry *entry) {
  [router->lock lock];
  if (entry->in_flight > 0) entry->in_flight -= 1;
  [router->lock broadcast];
  [router->lock unlock];
}

#ifndef META_CAPTURE_ROUTER_TESTING
static MetaCaptureTaskRef default_start(void *context,
                                        const MetaCaptureRequest *request,
                                        dispatch_queue_t callback_queue,
                                        MetaCaptureCompletion completion) {
  (void)context;
  return meta_capture_start(request, callback_queue, completion);
}

static void default_cancel(void *context, MetaCaptureTaskRef task) {
  (void)context;
  meta_capture_cancel(task);
}

static bool default_status(void *context, MetaCaptureTaskRef task,
                           MetaCaptureTaskStatus *status) {
  (void)context;
  return meta_capture_task_status(task, status);
}

static void default_release_task(void *context, MetaCaptureTaskRef task) {
  (void)context;
  meta_capture_task_release(task);
}

static void default_release_result(void *context, MetaCaptureResult *result) {
  (void)context;
  meta_capture_result_release(result);
}

MetaCaptureRouterBackend meta_capture_router_default_backend(void) {
  return (MetaCaptureRouterBackend){
      .start = default_start,
      .cancel = default_cancel,
      .status = default_status,
      .release_task = default_release_task,
      .release_result = default_release_result,
  };
}
#endif

MetaCaptureRouter *meta_capture_router_create(
    const char *native_generation,
    MetaCaptureRouterBackend backend) {
  if (!valid_identifier(native_generation, 64) || backend.start == NULL ||
      backend.cancel == NULL || backend.status == NULL ||
      backend.release_task == NULL || backend.release_result == NULL) {
    return NULL;
  }
  MetaCaptureRouter *router = calloc(1, sizeof(*router));
  if (router == NULL) return NULL;
  snprintf(router->native_generation, sizeof(router->native_generation), "%s",
           native_generation);
  router->backend = backend;
  router->next_task = 1;
  router->lock = [[NSCondition alloc] init];
  return router;
}

void meta_capture_router_destroy(MetaCaptureRouter *router) {
  if (router == NULL) return;
  MetaCaptureTaskRef active_tasks[128] = {0};
  size_t active_count = 0;
  [router->lock lock];
  bool has_active = false;
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released || entry->releasing || entry->in_flight > 0 ||
        entry->callback_pending) {
      has_active = true;
      if (!entry->released && entry->native_task != NULL && active_count < 128) {
        active_tasks[active_count++] = entry->native_task;
      }
    }
  }
  if (has_active) {
    [router->lock unlock];
    for (size_t index = 0; index < active_count; index += 1) {
      router->backend.cancel(router->backend.context, active_tasks[index]);
    }
    return;
  }
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    free(entry);
  }
  free(router->entries);
  [router->lock unlock];
  free(router);
}

bool meta_capture_router_start(
    MetaCaptureRouter *router,
    const char *operation_id,
    const MetaCaptureRequest *request,
    char task_ref[META_NATIVE_REF_CAPACITY],
    MetaCaptureTaskStatus *status) {
  if (router == NULL || request == NULL || task_ref == NULL || status == NULL ||
      !valid_identifier(operation_id, 127)) {
    return false;
  }
  CaptureEntry *entry = calloc(1, sizeof(*entry));
  if (entry == NULL) return false;
  snprintf(entry->operation_id, sizeof(entry->operation_id), "%s",
           operation_id);
  [router->lock lock];
  size_t operation_task_count = 0;
  for (size_t index = 0; index < router->entry_count; index += 1) {
    if (!router->entries[index]->released &&
        strcmp(router->entries[index]->operation_id, operation_id) == 0) {
      operation_task_count += 1;
    }
  }
  if (router->rotation_sealed || router->entry_count >= 10000 || operation_task_count >= 64) {
    [router->lock unlock];
    free(entry);
    return false;
  }
  snprintf(entry->task_ref, sizeof(entry->task_ref), "%s:capture:%llu",
           router->native_generation,
           (unsigned long long)router->next_task++);
  const size_t next_count = router->entry_count + 1;
  CaptureEntry **next =
      realloc(router->entries, next_count * sizeof(*next));
  if (next == NULL) {
    [router->lock unlock];
    free(entry);
    return false;
  }
  router->entries = next;
  router->entries[router->entry_count++] = entry;
  entry->in_flight = 1;
  entry->callback_pending = true;
  [router->lock unlock];

  MetaCaptureTaskRef native_task = router->backend.start(
      router->backend.context, request, NULL, ^(MetaCaptureResult *result) {
        MetaCaptureResult *duplicate = NULL;
        [router->lock lock];
        if (!entry->released && entry->result == NULL) {
          entry->result = result;
        } else if (result != NULL) {
          duplicate = result;
        }
        [router->lock unlock];
        if (duplicate != NULL) {
          router->backend.release_result(router->backend.context, duplicate);
        }
        [router->lock lock];
        entry->callback_pending = false;
        [router->lock broadcast];
        [router->lock unlock];
      });
  if (native_task == NULL) {
    [router->lock lock];
    entry->released = true;
    entry->in_flight = 0;
    entry->callback_pending = false;
    [router->lock broadcast];
    [router->lock unlock];
    return false;
  }
  [router->lock lock];
  entry->native_task = native_task;
  const bool cancel_after_start = entry->cancel_requested;
  snprintf(task_ref, META_NATIVE_REF_CAPACITY, "%s", entry->task_ref);
  [router->lock unlock];
  if (cancel_after_start) {
    router->backend.cancel(router->backend.context, native_task);
  }
  const bool status_ready =
      router->backend.status(router->backend.context, native_task, status);
  if (status_ready) {
    [router->lock lock];
    entry->last_status = *status;
    entry->has_last_status = true;
    [router->lock unlock];
  }
  release_in_flight(router, entry);
  return status_ready;
}

bool meta_capture_router_status(MetaCaptureRouter *router,
                                const char *task_ref,
                                MetaCaptureTaskStatus *status) {
  if (router == NULL || status == NULL ||
      !valid_identifier(task_ref, 127)) {
    return false;
  }
  [router->lock lock];
  CaptureEntry *entry = find_any_entry(router, task_ref);
  if (entry != NULL && entry->released && entry->has_last_status) {
    *status = entry->last_status;
    [router->lock unlock];
    return true;
  }
  if (entry != NULL && !entry->releasing) entry->in_flight += 1;
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (native_task == NULL) return false;
  const bool result =
      router->backend.status(router->backend.context, native_task, status);
  if (result) {
    [router->lock lock];
    entry->last_status = *status;
    entry->has_last_status = true;
    [router->lock unlock];
  }
  release_in_flight(router, entry);
  return result;
}

bool meta_capture_router_result(MetaCaptureRouter *router,
                                const char *task_ref,
                                MetaCaptureTaskStatus *status,
                                const MetaCaptureResult **result) {
  if (router == NULL || status == NULL || result == NULL ||
      !valid_identifier(task_ref, 127)) {
    return false;
  }
  [router->lock lock];
  CaptureEntry *entry = find_entry(router, task_ref);
  if (entry != NULL && !entry->releasing) entry->in_flight += 1;
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (native_task == NULL ||
      !router->backend.status(router->backend.context, native_task, status)) {
    if (native_task != NULL) release_in_flight(router, entry);
    return false;
  }
  [router->lock lock];
  entry->last_status = *status;
  entry->has_last_status = true;
  *result = entry->result;
  entry->result_borrows += 1;
  if (*result == NULL) entry->null_result_borrows += 1;
  [router->lock unlock];
  return true;
}

bool meta_capture_router_result_done(MetaCaptureRouter *router,
                                     const char *task_ref,
                                     const MetaCaptureResult *result) {
  if (router == NULL || !valid_identifier(task_ref, 127)) return false;
  [router->lock lock];
  CaptureEntry *entry = find_any_entry(router, task_ref);
  const bool matching_null_borrow = result == NULL && entry != NULL &&
      entry->null_result_borrows > 0;
  const bool matching_result_borrow = result != NULL && entry != NULL &&
      entry->result == result && entry->result_borrows > 0;
  if (entry == NULL || entry->in_flight == 0 ||
      (!matching_null_borrow && !matching_result_borrow)) {
    [router->lock unlock];
    return false;
  }
  entry->result_borrows -= 1;
  if (matching_null_borrow) entry->null_result_borrows -= 1;
  entry->in_flight -= 1;
  [router->lock broadcast];
  [router->lock unlock];
  return true;
}

bool meta_capture_router_cancel(MetaCaptureRouter *router,
                                const char *task_ref) {
  if (router == NULL || !valid_identifier(task_ref, 127)) return false;
  [router->lock lock];
  CaptureEntry *entry = find_entry(router, task_ref);
  if (entry != NULL && !entry->releasing) entry->in_flight += 1;
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (native_task == NULL) return false;
  router->backend.cancel(router->backend.context, native_task);
  release_in_flight(router, entry);
  return true;
}

size_t meta_capture_router_cancel_operation(MetaCaptureRouter *router,
                                            const char *operation_id) {
  if (router == NULL || !valid_identifier(operation_id, 127)) return 0;
  CaptureEntry *entries[128] = {0};
  MetaCaptureTaskRef tasks[128] = {0};
  size_t task_count = 0;
  [router->lock lock];
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released &&
        strcmp(entry->operation_id, operation_id) == 0) {
      entry->cancel_requested = true;
      if (entry->native_task == NULL) {
        task_count += 1;
        continue;
      }
      if (task_count < 128) {
        tasks[task_count] = entry->native_task;
        entries[task_count] = entry;
        entry->in_flight += 1;
        task_count += 1;
      }
    }
  }
  [router->lock unlock];
  const size_t posted_count = task_count < 128 ? task_count : 128;
  for (size_t index = 0; index < posted_count; index += 1) {
    if (tasks[index] == NULL) continue;
    router->backend.cancel(router->backend.context, tasks[index]);
    release_in_flight(router, entries[index]);
  }
  return task_count;
}

bool meta_capture_router_release(MetaCaptureRouter *router,
                                 const char *task_ref,
                                 bool recovery_authorized,
                                 bool *already_released) {
  if (router == NULL || already_released == NULL ||
      !valid_identifier(task_ref, 127)) return false;
  *already_released = false;
  (void)recovery_authorized;
  [router->lock lock];
  CaptureEntry *entry = find_any_entry(router, task_ref);
  while (entry != NULL && entry->releasing) {
    [router->lock wait];
  }
  if (entry != NULL && entry->released) {
    *already_released = true;
    [router->lock unlock];
    return true;
  }
  MetaCaptureTaskRef native_task =
      entry == NULL ? NULL : entry->native_task;
  if (entry != NULL) {
    entry->releasing = true;
    while (entry->in_flight > 0) [router->lock wait];
  }
  [router->lock unlock];
  MetaCaptureTaskStatus status = {0};
  if (native_task == NULL ||
      !router->backend.status(router->backend.context, native_task, &status) ||
      !status.drained || status.cleanup != MetaCaptureCleanupComplete) {
    if (entry != NULL) {
      [router->lock lock];
      entry->releasing = false;
      [router->lock broadcast];
      [router->lock unlock];
    }
    return false;
  }
  [router->lock lock];
  entry = find_entry(router, task_ref);
  if (entry == NULL || entry->native_task != native_task) {
    [router->lock unlock];
    return false;
  }
  MetaCaptureResult *result = entry->result;
  entry->last_status = status;
  entry->has_last_status = true;
  entry->result = NULL;
  entry->released = true;
  entry->safe_to_forget = status.drained &&
                          status.cleanup == MetaCaptureCleanupComplete &&
                          status.completionDelivered;
  const MetaCaptureRouterBackend backend = router->backend;
  [router->lock unlock];
  backend.release_task(backend.context, native_task);
  if (result != NULL) {
    backend.release_result(backend.context, result);
  }
  [router->lock lock];
  entry->releasing = false;
  [router->lock broadcast];
  [router->lock unlock];
  return true;
}

static bool same_fence(MetaFence left, MetaFence right) {
  return left.counter == right.counter &&
         strcmp(left.runtime_epoch, right.runtime_epoch) == 0 &&
         strcmp(left.login_session_id, right.login_session_id) == 0 &&
         strcmp(left.native_generation, right.native_generation) == 0;
}

static bool same_release_authority(
    const MetaCaptureReleaseAuthority *left,
    const MetaCaptureReleaseAuthority *right) {
  return strcmp(left->cleanup_request_id, right->cleanup_request_id) == 0 &&
         strcmp(left->operation_id, right->operation_id) == 0 &&
         strcmp(left->runtime_epoch, right->runtime_epoch) == 0 &&
         strcmp(left->login_session_id, right->login_session_id) == 0 &&
         strcmp(left->native_generation, right->native_generation) == 0 &&
         strcmp(left->task_ref, right->task_ref) == 0 &&
         same_fence(left->accepted_fence, right->accepted_fence) &&
         same_fence(left->current_high_water_fence,
                    right->current_high_water_fence) &&
         left->expected_status_revision == right->expected_status_revision &&
         strcmp(left->drained_evidence_ref,
                right->drained_evidence_ref) == 0 &&
         strcmp(left->terminal_receipt_ref,
                right->terminal_receipt_ref) == 0;
}

static bool valid_fence_fields(MetaFence fence) {
  return fence.counter > 0 &&
         valid_identifier(fence.runtime_epoch, 64) &&
         valid_identifier(fence.login_session_id, 64) &&
         valid_identifier(fence.native_generation, 64);
}

static bool valid_release_authority(
    MetaCaptureRouter *router,
    const MetaCaptureReleaseAuthority *authority) {
  return authority != NULL &&
         valid_identifier(authority->cleanup_request_id, 127) &&
         valid_identifier(authority->operation_id, 127) &&
         valid_identifier(authority->runtime_epoch, 64) &&
         valid_identifier(authority->login_session_id, 64) &&
         valid_identifier(authority->native_generation, 64) &&
         valid_identifier(authority->task_ref, 127) &&
         valid_identifier(authority->drained_evidence_ref, 127) &&
         valid_identifier(authority->terminal_receipt_ref, 127) &&
         valid_fence_fields(authority->accepted_fence) &&
         valid_fence_fields(authority->current_high_water_fence) &&
         strcmp(authority->native_generation,
                router->native_generation) == 0 &&
         authority->accepted_fence.counter <=
             authority->current_high_water_fence.counter &&
         strcmp(authority->accepted_fence.runtime_epoch,
                authority->runtime_epoch) == 0 &&
         strcmp(authority->accepted_fence.login_session_id,
                authority->login_session_id) == 0 &&
         strcmp(authority->accepted_fence.native_generation,
                authority->native_generation) == 0 &&
         strcmp(authority->current_high_water_fence.runtime_epoch,
                authority->runtime_epoch) == 0 &&
         strcmp(authority->current_high_water_fence.login_session_id,
                authority->login_session_id) == 0 &&
         strcmp(authority->current_high_water_fence.native_generation,
                authority->native_generation) == 0;
}

bool meta_capture_router_release_authorized(
    MetaCaptureRouter *router,
    const MetaCaptureReleaseAuthority *authority,
    MetaCaptureReleaseReceipt *receipt) {
  if (router == NULL || receipt == NULL ||
      !valid_release_authority(router, authority)) {
    return false;
  }
  [router->lock lock];
  CaptureEntry *entry = find_any_entry(router, authority->task_ref);
  if (entry == NULL ||
      strcmp(entry->operation_id, authority->operation_id) != 0) {
    [router->lock unlock];
    return false;
  }
  if (entry->has_release_receipt) {
    if (!same_release_authority(&entry->release_receipt.authority,
                                authority)) {
      [router->lock unlock];
      return false;
    }
    *receipt = entry->release_receipt;
    receipt->already_released = true;
    [router->lock unlock];
    return true;
  }
  if (entry->released) {
    if (!entry->has_last_status ||
        entry->last_status.revision != authority->expected_status_revision ||
        !entry->last_status.completionDelivered ||
        !entry->last_status.drained ||
        entry->last_status.cleanup != MetaCaptureCleanupComplete) {
      [router->lock unlock];
      return false;
    }
    entry->release_receipt = (MetaCaptureReleaseReceipt){
        .authority = *authority,
        .status_revision = entry->last_status.revision,
        .already_released = true,
        .cleanup_complete = true,
        .drained = true,
    };
    entry->has_release_receipt = true;
    *receipt = entry->release_receipt;
    [router->lock unlock];
    return true;
  }
  if (entry->pending_cleanup_request_id[0] != '\0') {
    if (strcmp(entry->pending_cleanup_request_id,
               authority->cleanup_request_id) != 0) {
      [router->lock unlock];
      return false;
    }
    while (!entry->has_release_receipt &&
           entry->pending_cleanup_request_id[0] != '\0') {
      [router->lock wait];
    }
    if (entry->has_release_receipt &&
        same_release_authority(&entry->release_receipt.authority,
                               authority)) {
      *receipt = entry->release_receipt;
      receipt->already_released = true;
      [router->lock unlock];
      return true;
    }
    [router->lock unlock];
    return false;
  }
  snprintf(entry->pending_cleanup_request_id,
           sizeof(entry->pending_cleanup_request_id), "%s",
           authority->cleanup_request_id);
  [router->lock unlock];

  MetaCaptureTaskStatus verified_status = {0};
  if (!meta_capture_router_status(router, authority->task_ref,
                                  &verified_status) ||
      verified_status.revision != authority->expected_status_revision ||
      !verified_status.drained ||
      verified_status.cleanup != MetaCaptureCleanupComplete) {
    [router->lock lock];
    entry->pending_cleanup_request_id[0] = '\0';
    [router->lock broadcast];
    [router->lock unlock];
    return false;
  }
  bool already_released = false;
  if (!meta_capture_router_release(router, authority->task_ref, false,
                                   &already_released)) {
    [router->lock lock];
    entry->pending_cleanup_request_id[0] = '\0';
    [router->lock broadcast];
    [router->lock unlock];
    return false;
  }
  [router->lock lock];
  if (!entry->released) {
    entry->pending_cleanup_request_id[0] = '\0';
    [router->lock unlock];
    return false;
  }
  entry->release_receipt = (MetaCaptureReleaseReceipt){
      .authority = *authority,
      .status_revision = verified_status.revision,
      .already_released = already_released,
      .cleanup_complete = true,
      .drained = true,
  };
  entry->has_release_receipt = true;
  entry->pending_cleanup_request_id[0] = '\0';
  *receipt = entry->release_receipt;
  [router->lock broadcast];
  [router->lock unlock];
  return true;
}

bool meta_capture_router_forget_released(
    MetaCaptureRouter *router,
    const MetaCaptureReleaseReceipt *receipt) {
  if (router == NULL || receipt == NULL) return false;
  [router->lock lock];
  CaptureEntry *entry = find_any_entry(router, receipt->authority.task_ref);
  if (entry == NULL || !entry->released || !entry->safe_to_forget ||
      entry->releasing || entry->in_flight > 0 || entry->callback_pending ||
      !entry->has_release_receipt ||
      !same_release_authority(&entry->release_receipt.authority,
                              &receipt->authority)) {
    [router->lock unlock];
    return false;
  }
  size_t found_index = SIZE_MAX;
  for (size_t index = 0; index < router->entry_count; index += 1) {
    if (router->entries[index] == entry) {
      found_index = index;
      break;
    }
  }
  if (found_index == SIZE_MAX) {
    [router->lock unlock];
    return false;
  }
  for (size_t index = found_index + 1; index < router->entry_count;
       index += 1) {
    router->entries[index - 1] = router->entries[index];
  }
  router->entry_count -= 1;
  free(entry);
  [router->lock unlock];
  return true;
}

bool meta_capture_router_seal_for_rotation(MetaCaptureRouter *router) {
  if (router == NULL) return false;
  [router->lock lock];
  router->rotation_sealed = true;
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released || entry->releasing || entry->callback_pending ||
        entry->in_flight > 0 || entry->pending_cleanup_request_id[0] != '\0') {
      [router->lock unlock];
      return false;
    }
  }
  [router->lock unlock];
  return true;
}

size_t meta_capture_router_active_tasks(MetaCaptureRouter *router,
                                       char (*task_refs)[META_NATIVE_REF_CAPACITY],
                                       size_t capacity) {
  if (router == NULL) return 0;
  size_t count = 0;
  [router->lock lock];
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (entry->released) continue;
    if (task_refs != NULL && count < capacity) {
      snprintf(task_refs[count], META_NATIVE_REF_CAPACITY, "%s",
               entry->task_ref);
    }
    count += 1;
  }
  [router->lock unlock];
  return count;
}

size_t meta_capture_router_operation_tasks(
    MetaCaptureRouter *router,
    const char *operation_id,
    MetaCaptureOperationTaskRecord *records,
    size_t capacity) {
  if (router == NULL || !valid_identifier(operation_id, 127) ||
      (capacity > 0 && records == NULL)) return 0;
  CaptureEntry *entries[128] = {0};
  MetaCaptureTaskRef tasks[128] = {0};
  size_t count = 0;
  [router->lock lock];
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (strcmp(entry->operation_id, operation_id) != 0) continue;
    if (records != NULL && count < capacity && count < 128) {
      MetaCaptureOperationTaskRecord *record = &records[count];
      memset(record, 0, sizeof(*record));
      snprintf(record->task_ref, sizeof(record->task_ref), "%s",
               entry->task_ref);
      record->released = entry->released;
      record->result_available = entry->result != NULL;
      if (entry->released && entry->has_last_status) {
        record->status = entry->last_status;
      }
    }
    if (count < capacity && count < 128 && !entry->released &&
        !entry->releasing && entry->native_task != NULL) {
      entries[count] = entry;
      tasks[count] = entry->native_task;
      entry->in_flight += 1;
    }
    count += 1;
  }
  [router->lock unlock];
  const size_t copied = count < capacity ? count : capacity;
  for (size_t index = 0; index < copied && index < 128; index += 1) {
    if (tasks[index] != NULL) {
      router->backend.status(router->backend.context, tasks[index],
                             &records[index].status);
      release_in_flight(router, entries[index]);
    }
  }
  return count;
}

size_t meta_capture_router_release_drained_operation(
    MetaCaptureRouter *router,
    const char *operation_id,
    bool recovery_authorized) {
  if (router == NULL || !valid_identifier(operation_id, 127)) return 0;
  char task_refs[128][META_NATIVE_REF_CAPACITY] = {{0}};
  size_t task_count = 0;
  [router->lock lock];
  for (size_t index = 0; index < router->entry_count && task_count < 128;
       index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released &&
        strcmp(entry->operation_id, operation_id) == 0) {
      snprintf(task_refs[task_count++], META_NATIVE_REF_CAPACITY, "%s",
               entry->task_ref);
    }
  }
  [router->lock unlock];
  size_t released = 0;
  for (size_t index = 0; index < task_count; index += 1) {
    bool already_released = false;
    if (meta_capture_router_release(router, task_refs[index],
                                    recovery_authorized,
                                    &already_released)) {
      released += 1;
    }
  }
  return released;
}
