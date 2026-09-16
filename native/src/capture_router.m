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
  bool layout;
  bool layout_start_failed;
  bool layout_start_settled;
  bool layout_composing;
  MetaCaptureTaskRef *child_tasks;
  MetaCaptureResult **child_results;
  MetaCaptureTaskStatus *child_statuses;
  bool *child_completed;
  size_t child_count;
  size_t started_child_count;
  CFStringRef layout_caption;
  double layout_output_scale;
  uint32_t layout_max_width_pixels;
  uint32_t layout_max_height_pixels;
  uint64_t layout_max_pixels;
  uint64_t layout_max_encoded_bytes;
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

static void free_entry(CaptureEntry *entry) {
  if (entry == NULL) return;
  if (entry->layout_caption != NULL) CFRelease(entry->layout_caption);
  free(entry->child_tasks);
  free(entry->child_results);
  free(entry->child_statuses);
  free(entry->child_completed);
  free(entry);
}

static size_t active_native_tasks(MetaCaptureRouter *router) {
  size_t count = 0;
  for (size_t index = 0; index < router->entry_count; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (entry->released) continue;
    count += entry->layout ? entry->child_count : 1;
  }
  return count;
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

static MetaCaptureResult *default_compose_layout(
    void *context, const MetaCaptureLayoutRequest *request) {
  (void)context;
  return meta_capture_compose_layout(request);
}

MetaCaptureRouterBackend meta_capture_router_default_backend(void) {
  return (MetaCaptureRouterBackend){
      .start = default_start,
      .cancel = default_cancel,
      .status = default_status,
      .release_task = default_release_task,
      .release_result = default_release_result,
      .compose_layout = default_compose_layout,
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
      if (!entry->released && entry->layout) {
        for (size_t child = 0;
             child < entry->started_child_count && active_count < 128;
             child += 1) {
          active_tasks[active_count++] = entry->child_tasks[child];
        }
      } else if (!entry->released && entry->native_task != NULL &&
                 active_count < 128) {
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
    free_entry(entry);
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
  if (router->rotation_sealed || router->entry_count >= 10000 ||
      operation_task_count >= 64 || active_native_tasks(router) >= 128) {
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

static MetaCaptureResult *layout_failure(CaptureEntry *entry,
                                         MetaCaptureOutcome outcome,
                                         MetaCaptureErrorCode code,
                                         NSString *message) {
  MetaCaptureResult *result = calloc(1, sizeof(*result));
  if (result == NULL) return NULL;
  result->outcome = outcome;
  result->cleanup = MetaCaptureCleanupComplete;
  result->errorCode = code;
  result->source = MetaCaptureSourceDisplayComposite;
  result->caption = CFRetain(entry->layout_caption);
  result->errorMessage = CFRetain((__bridge CFStringRef)message);
  result->frameStatus = -1;
  return result;
}

static bool same_task_status(MetaCaptureTaskStatus left,
                             MetaCaptureTaskStatus right) {
  return left.completionDelivered == right.completionDelivered &&
         left.stopRequested == right.stopRequested &&
         left.stopCallInFlight == right.stopCallInFlight &&
         left.stopAttemptCount == right.stopAttemptCount &&
         left.startPending == right.startPending &&
         left.streamStarted == right.streamStarted &&
         left.streamStopped == right.streamStopped &&
         left.encodingInFlight == right.encodingInFlight &&
         left.cleanup == right.cleanup && left.drained == right.drained;
}

static MetaCaptureTaskStatus layout_status_locked(CaptureEntry *entry) {
  MetaCaptureTaskStatus next = {0};
  bool all_stopped = true;
  bool all_drained = true;
  bool any_unknown = false;
  for (size_t index = 0; index < entry->started_child_count; index += 1) {
    MetaCaptureTaskStatus child = entry->child_statuses[index];
    next.stopRequested = next.stopRequested || child.stopRequested;
    next.stopCallInFlight = next.stopCallInFlight || child.stopCallInFlight;
    next.stopAttemptCount = MAX(next.stopAttemptCount, child.stopAttemptCount);
    next.startPending = next.startPending || child.startPending;
    next.streamStarted = next.streamStarted || child.streamStarted;
    next.encodingInFlight = next.encodingInFlight || child.encodingInFlight;
    all_stopped = all_stopped && child.streamStopped;
    all_drained = all_drained && child.drained &&
                  child.cleanup == MetaCaptureCleanupComplete;
    any_unknown = any_unknown || child.cleanup == MetaCaptureCleanupUnknown;
  }
  next.completionDelivered = entry->result != NULL;
  next.startPending = !next.completionDelivered &&
                      (next.startPending || entry->layout_start_failed ||
                       entry->started_child_count < entry->child_count);
  next.streamStopped = all_stopped;
  next.encodingInFlight = next.encodingInFlight || entry->layout_composing;
  next.drained = next.completionDelivered && all_drained;
  next.cleanup = next.drained ? MetaCaptureCleanupComplete
                              : any_unknown ? MetaCaptureCleanupUnknown
                                            : MetaCaptureCleanupPending;
  if (!entry->has_last_status) {
    next.revision = 1;
  } else {
    next.revision = entry->last_status.revision +
        (same_task_status(entry->last_status, next) ? 0 : 1);
  }
  entry->last_status = next;
  entry->has_last_status = true;
  return next;
}

static bool refresh_layout(MetaCaptureRouter *router, CaptureEntry *entry,
                           MetaCaptureTaskStatus *status) {
  MetaCaptureTaskRef child_tasks[64] = {0};
  MetaCaptureTaskStatus observed[64] = {0};
  [router->lock lock];
  const size_t snapshot_count = entry->started_child_count;
  const bool start_settled = entry->layout_start_settled;
  memcpy(child_tasks, entry->child_tasks,
         snapshot_count * sizeof(*child_tasks));
  [router->lock unlock];
  for (size_t index = 0; index < snapshot_count; index += 1) {
    if (!router->backend.status(router->backend.context,
                                child_tasks[index],
                                &observed[index])) {
      return false;
    }
  }
  bool compose = false;
  bool results_present = true;
  [router->lock lock];
  memcpy(entry->child_statuses, observed,
         snapshot_count * sizeof(*observed));
  const bool stable_start = start_settled && entry->layout_start_settled &&
                            entry->started_child_count == snapshot_count;
  bool callbacks_complete = true;
  bool children_drained = true;
  for (size_t index = 0; index < snapshot_count; index += 1) {
    callbacks_complete = callbacks_complete && entry->child_completed[index];
    results_present = results_present && entry->child_results[index] != NULL;
    children_drained = children_drained && observed[index].drained &&
        observed[index].cleanup == MetaCaptureCleanupComplete;
  }
  if (stable_start && snapshot_count == entry->child_count &&
      callbacks_complete && children_drained && entry->result == NULL &&
      !entry->layout_composing) {
    entry->layout_composing = true;
    compose = true;
  } else if (stable_start && entry->layout_start_failed && callbacks_complete &&
             children_drained && entry->result == NULL &&
             !entry->layout_composing) {
    entry->layout_composing = true;
    compose = true;
  }
  *status = layout_status_locked(entry);
  [router->lock unlock];
  if (!compose) return true;

  MetaCaptureResult *composed = NULL;
  if (entry->layout_start_failed || !results_present ||
      entry->started_child_count != entry->child_count) {
    composed = layout_failure(entry, MetaCaptureOutcomeFailed,
                              MetaCaptureErrorStreamFailed,
                              @"Не удалось запустить все layout child captures");
  } else {
    for (size_t index = 0; index < entry->child_count; index += 1) {
      const MetaCaptureResult *child = entry->child_results[index];
      if (child->outcome != MetaCaptureOutcomeSucceeded) {
        NSString *message = child->errorMessage == NULL
            ? @"Layout child capture завершился без frame"
            : (__bridge NSString *)child->errorMessage;
        composed = layout_failure(entry, child->outcome, child->errorCode,
                                  message);
        break;
      }
    }
    MetaCaptureResult *normalized = calloc(entry->child_count,
                                           sizeof(*normalized));
    const MetaCaptureResult **frames = calloc(entry->child_count,
                                              sizeof(*frames));
    if (composed == NULL && normalized != NULL && frames != NULL) {
      for (size_t index = 0; index < entry->child_count; index += 1) {
        normalized[index] = *entry->child_results[index];
        normalized[index].cleanup = MetaCaptureCleanupComplete;
        frames[index] = &normalized[index];
      }
      MetaCaptureLayoutRequest request = {
          .frames = frames,
          .frameCount = entry->child_count,
          .caption = entry->layout_caption,
          .outputScale = entry->layout_output_scale,
          .maxWidthPixels = entry->layout_max_width_pixels,
          .maxHeightPixels = entry->layout_max_height_pixels,
          .maxPixels = entry->layout_max_pixels,
          .maxEncodedBytes = entry->layout_max_encoded_bytes,
      };
      composed = router->backend.compose_layout(router->backend.context,
                                                &request);
    }
    free(frames);
    free(normalized);
    if (composed == NULL) {
      composed = layout_failure(entry, MetaCaptureOutcomeFailed,
                                MetaCaptureErrorEncodingFailed,
                                @"Layout compositor не вернул result");
    }
  }
  [router->lock lock];
  entry->result = composed;
  entry->layout_composing = false;
  *status = layout_status_locked(entry);
  [router->lock broadcast];
  [router->lock unlock];
  return composed != NULL;
}

bool meta_capture_router_start_layout(
    MetaCaptureRouter *router,
    const char *operation_id,
    const MetaCaptureLayoutTaskRequest *request,
    char task_ref[META_NATIVE_REF_CAPACITY],
    MetaCaptureTaskStatus *status) {
  if (router == NULL || request == NULL || task_ref == NULL || status == NULL ||
      !valid_identifier(operation_id, 127) || request->child_requests == NULL ||
      request->child_count == 0 || request->child_count > 64 ||
      request->caption == NULL || request->output_scale <= 0 ||
      request->output_scale > 1 || request->max_width_pixels == 0 ||
      request->max_height_pixels == 0 || request->max_pixels == 0 ||
      request->max_encoded_bytes == 0 ||
      router->backend.compose_layout == NULL) {
    return false;
  }
  CaptureEntry *entry = calloc(1, sizeof(*entry));
  if (entry == NULL) return false;
  entry->child_tasks = calloc(request->child_count,
                              sizeof(*entry->child_tasks));
  entry->child_results = calloc(request->child_count,
                                sizeof(*entry->child_results));
  entry->child_statuses = calloc(request->child_count,
                                 sizeof(*entry->child_statuses));
  entry->child_completed = calloc(request->child_count,
                                  sizeof(*entry->child_completed));
  if (entry->child_tasks == NULL || entry->child_results == NULL ||
      entry->child_statuses == NULL || entry->child_completed == NULL) {
    free_entry(entry);
    return false;
  }
  entry->layout = true;
  entry->child_count = request->child_count;
  entry->layout_caption = CFRetain(request->caption);
  entry->layout_output_scale = request->output_scale;
  entry->layout_max_width_pixels = request->max_width_pixels;
  entry->layout_max_height_pixels = request->max_height_pixels;
  entry->layout_max_pixels = request->max_pixels;
  entry->layout_max_encoded_bytes = request->max_encoded_bytes;
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
  if (router->rotation_sealed || router->entry_count >= 10000 ||
      operation_task_count >= 64 ||
      active_native_tasks(router) + request->child_count > 128) {
    [router->lock unlock];
    free_entry(entry);
    return false;
  }
  snprintf(entry->task_ref, sizeof(entry->task_ref), "%s:capture:%llu",
           router->native_generation,
           (unsigned long long)router->next_task++);
  CaptureEntry **next = realloc(router->entries,
      (router->entry_count + 1) * sizeof(*next));
  if (next == NULL) {
    [router->lock unlock];
    free_entry(entry);
    return false;
  }
  router->entries = next;
  router->entries[router->entry_count++] = entry;
  entry->in_flight = 1;
  entry->callback_pending = true;
  entry->last_status = (MetaCaptureTaskStatus){
      .revision = 1,
      .startPending = true,
      .cleanup = MetaCaptureCleanupPending,
  };
  entry->has_last_status = true;
  [router->lock unlock];

  for (size_t index = 0; index < request->child_count; index += 1) {
    MetaCaptureTaskRef child = router->backend.start(
        router->backend.context, &request->child_requests[index], NULL,
        ^(MetaCaptureResult *result) {
          MetaCaptureResult *duplicate = NULL;
          [router->lock lock];
          if (!entry->released && !entry->child_completed[index]) {
            entry->child_results[index] = result;
            entry->child_completed[index] = true;
          } else if (result != NULL) {
            duplicate = result;
          }
          bool pending = false;
          for (size_t child_index = 0;
               child_index < entry->started_child_count; child_index += 1) {
            pending = pending || !entry->child_completed[child_index];
          }
          entry->callback_pending = pending;
          [router->lock broadcast];
          [router->lock unlock];
          if (duplicate != NULL) {
            router->backend.release_result(router->backend.context, duplicate);
          }
        });
    if (child == NULL) {
      [router->lock lock];
      entry->layout_start_failed = true;
      [router->lock unlock];
      break;
    }
    [router->lock lock];
    entry->child_tasks[index] = child;
    entry->started_child_count += 1;
    const bool cancel_child = entry->cancel_requested;
    [router->lock unlock];
    if (cancel_child) {
      router->backend.cancel(router->backend.context, child);
    }
    MetaCaptureTaskStatus child_status = {0};
    if (!router->backend.status(router->backend.context, child,
                                &child_status)) {
      [router->lock lock];
      entry->layout_start_failed = true;
      [router->lock unlock];
      break;
    }
    [router->lock lock];
    entry->child_statuses[index] = child_status;
    [router->lock unlock];
  }
  if (entry->layout_start_failed) {
    for (size_t index = 0; index < entry->started_child_count; index += 1) {
      router->backend.cancel(router->backend.context, entry->child_tasks[index]);
    }
  }
  [router->lock lock];
  bool pending = false;
  for (size_t index = 0; index < entry->started_child_count; index += 1) {
    pending = pending || !entry->child_completed[index];
  }
  entry->callback_pending = pending;
  entry->layout_start_settled = true;
  snprintf(task_ref, META_NATIVE_REF_CAPACITY, "%s", entry->task_ref);
  *status = entry->last_status;
  [router->lock unlock];
  release_in_flight(router, entry);
  return true;
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
  if (entry != NULL && entry->layout && !entry->releasing) {
    entry->in_flight += 1;
    [router->lock unlock];
    const bool refreshed = refresh_layout(router, entry, status);
    release_in_flight(router, entry);
    return refreshed;
  }
  if (entry != NULL && !entry->releasing) entry->in_flight += 1;
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (native_task == NULL) {
    if (entry != NULL) release_in_flight(router, entry);
    return false;
  }
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

void meta_capture_router_wait_result(MetaCaptureRouter *router,
                                     const char *task_ref,
                                     double deadline_unix_seconds) {
  if (router == NULL || !valid_identifier(task_ref, 127)) return;
  NSDate *deadline = [NSDate dateWithTimeIntervalSince1970:deadline_unix_seconds];
  [router->lock lock];
  CaptureEntry *entry = find_entry(router, task_ref);
  if (entry == NULL || entry->releasing) { [router->lock unlock]; return; }
  entry->in_flight += 1;
  while (entry->result == NULL && !entry->released && !entry->releasing &&
         (!entry->layout || !entry->layout_start_settled || entry->callback_pending)) {
    if (![router->lock waitUntilDate:deadline]) break;
  }
  entry->in_flight -= 1;
  [router->lock broadcast];
  [router->lock unlock];
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
  const bool layout = entry != NULL && !entry->releasing && entry->layout;
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (layout) {
    if (!refresh_layout(router, entry, status)) {
      release_in_flight(router, entry);
      return false;
    }
    [router->lock lock];
    *result = entry->result;
    entry->result_borrows += 1;
    if (*result == NULL) entry->null_result_borrows += 1;
    [router->lock unlock];
    return true;
  }
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
  if (entry != NULL) entry->cancel_requested = true;
  MetaCaptureTaskRef child_tasks[64] = {0};
  size_t child_count = 0;
  if (entry != NULL && !entry->releasing && entry->layout) {
    child_count = entry->started_child_count;
    memcpy(child_tasks, entry->child_tasks,
           child_count * sizeof(*child_tasks));
  }
  MetaCaptureTaskRef native_task =
      entry == NULL || entry->releasing ? NULL : entry->native_task;
  [router->lock unlock];
  if (child_count > 0) {
    for (size_t index = 0; index < child_count; index += 1) {
      router->backend.cancel(router->backend.context, child_tasks[index]);
    }
    release_in_flight(router, entry);
    return true;
  }
  if (entry != NULL && entry->layout) {
    release_in_flight(router, entry);
    return true;
  }
  if (native_task == NULL) {
    if (entry != NULL) {
      release_in_flight(router, entry);
      return true;
    }
    return false;
  }
  router->backend.cancel(router->backend.context, native_task);
  release_in_flight(router, entry);
  return true;
}

size_t meta_capture_router_cancel_operation(MetaCaptureRouter *router,
                                            const char *operation_id) {
  if (router == NULL || !valid_identifier(operation_id, 127)) return 0;
  char task_refs[64][META_NATIVE_REF_CAPACITY] = {{0}};
  size_t task_count = 0;
  [router->lock lock];
  for (size_t index = 0;
       index < router->entry_count && task_count < 64; index += 1) {
    CaptureEntry *entry = router->entries[index];
    if (!entry->released &&
        strcmp(entry->operation_id, operation_id) == 0) {
      entry->cancel_requested = true;
      snprintf(task_refs[task_count++], META_NATIVE_REF_CAPACITY, "%s",
               entry->task_ref);
    }
  }
  [router->lock unlock];
  for (size_t index = 0; index < task_count; index += 1) {
    meta_capture_router_cancel(router, task_refs[index]);
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
  const bool layout = entry != NULL && entry->layout;
  [router->lock unlock];
  if (layout) {
    MetaCaptureTaskStatus layout_status = {0};
    if (!meta_capture_router_status(router, task_ref, &layout_status) ||
        !layout_status.drained ||
        layout_status.cleanup != MetaCaptureCleanupComplete) {
      return false;
    }
    [router->lock lock];
    entry = find_entry(router, task_ref);
    while (entry != NULL && entry->releasing) [router->lock wait];
    if (entry != NULL && entry->released) {
      *already_released = true;
      [router->lock unlock];
      return true;
    }
    if (entry == NULL) {
      CaptureEntry *released_entry = find_any_entry(router, task_ref);
      *already_released = released_entry != NULL && released_entry->released;
      [router->lock unlock];
      return *already_released;
    }
    entry->releasing = true;
    while (entry->in_flight > 0) [router->lock wait];
    if (!entry->has_last_status || !entry->last_status.drained ||
        entry->last_status.cleanup != MetaCaptureCleanupComplete) {
      entry->releasing = false;
      [router->lock broadcast];
      [router->lock unlock];
      return false;
    }
    MetaCaptureTaskRef *children = entry->child_tasks;
    MetaCaptureResult **child_results = entry->child_results;
    const size_t child_count = entry->started_child_count;
    MetaCaptureResult *result = entry->result;
    entry->child_tasks = NULL;
    entry->child_results = NULL;
    free(entry->child_statuses);
    free(entry->child_completed);
    entry->child_statuses = NULL;
    entry->child_completed = NULL;
    entry->result = NULL;
    entry->released = true;
    entry->safe_to_forget = true;
    [router->lock unlock];
    for (size_t index = 0; index < child_count; index += 1) {
      router->backend.release_task(router->backend.context, children[index]);
      if (child_results[index] != NULL) {
        router->backend.release_result(router->backend.context,
                                       child_results[index]);
      }
    }
    if (result != NULL) {
      router->backend.release_result(router->backend.context, result);
    }
    free(children);
    free(child_results);
    if (entry->layout_caption != NULL) {
      CFRelease(entry->layout_caption);
      entry->layout_caption = NULL;
    }
    [router->lock lock];
    entry->releasing = false;
    [router->lock broadcast];
    [router->lock unlock];
    return true;
  }
  [router->lock lock];
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
  free_entry(entry);
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
    } else if (count < capacity && count < 128 && !entry->released &&
               !entry->releasing && entry->layout) {
      entries[count] = entry;
      entry->in_flight += 1;
    }
    count += 1;
  }
  [router->lock unlock];
  const size_t copied = count < capacity ? count : capacity;
  for (size_t index = 0; index < copied && index < 128; index += 1) {
    if (entries[index] != NULL && entries[index]->layout) {
      refresh_layout(router, entries[index], &records[index].status);
      [router->lock lock];
      records[index].result_available = entries[index]->result != NULL;
      [router->lock unlock];
      release_in_flight(router, entries[index]);
    } else if (tasks[index] != NULL) {
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
