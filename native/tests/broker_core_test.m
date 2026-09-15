#import <Foundation/Foundation.h>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "meta_broker_core.h"
#include "meta_ledger.h"

typedef struct {
  uint64_t now;
  MetaCaptureCompletion completion;
  MetaCaptureTaskStatus capture_status;
  int capture_storage;
  size_t capture_cancel_count;
} Fixture;

static uint64_t now_millis(void *context) {
  return ((Fixture *)context)->now;
}

static bool verify_target(void *context, const char *target_ref) {
  (void)context;
  return strcmp(target_ref, "window-1") == 0;
}

static bool persist(void *context,
                    const MetaLedgerPersistenceRequest *request,
                    MetaLedgerPersistenceAck *ack) {
  (void)context;
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
  snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s", digest);
  ack->revision = request->snapshot.revision;
  ack->persisted_at_unix_micros = 1;
  ack->durable = true;
  return true;
}

static bool post_held(void *context, MetaHeldEventKind kind, uint32_t code,
                      bool down, uint64_t tag) {
  (void)context;
  (void)kind;
  (void)code;
  (void)down;
  (void)tag;
  return true;
}

static MetaCaptureTaskRef capture_start(void *context,
                                        const MetaCaptureRequest *request,
                                        dispatch_queue_t queue,
                                        MetaCaptureCompletion completion) {
  Fixture *fixture = context;
  (void)request;
  (void)queue;
  fixture->completion = [completion copy];
  fixture->capture_status = (MetaCaptureTaskStatus){
      .revision = 1,
      .startPending = true,
      .cleanup = MetaCaptureCleanupPending,
  };
  return &fixture->capture_storage;
}

static bool post_cleanup(void *context, MetaHeldEventKind kind, uint32_t code, uint64_t tag) {
  return post_held(context, kind, code, false, tag);
}

static void capture_cancel(void *context, MetaCaptureTaskRef task) {
  Fixture *fixture = context;
  assert(task == &fixture->capture_storage);
  fixture->capture_cancel_count += 1;
  fixture->capture_status.stopRequested = true;
}

static bool capture_status(void *context, MetaCaptureTaskRef task,
                           MetaCaptureTaskStatus *status) {
  Fixture *fixture = context;
  assert(task == &fixture->capture_storage);
  *status = fixture->capture_status;
  return true;
}

static void capture_release(void *context, MetaCaptureTaskRef task) {
  Fixture *fixture = context;
  assert(task == &fixture->capture_storage);
}

static void result_release(void *context, MetaCaptureResult *result) {
  (void)context;
  free(result);
}

static MetaFence fence(void) {
  MetaFence result = {.counter = 1};
  snprintf(result.runtime_epoch, sizeof(result.runtime_epoch), "%s",
           "runtime-1");
  snprintf(result.login_session_id, sizeof(result.login_session_id), "%s",
           "login-1");
  snprintf(result.native_generation, sizeof(result.native_generation), "%s",
           "native-1");
  return result;
}

int main(void) {
  @autoreleasepool {
    Fixture fixture = {.now = 100};
    MetaExecutorBackend executor_backend = {
        .context = &fixture,
        .monotonic_millis = now_millis,
        .verify_target = verify_target,
        .persist_ledger = persist,
        .post_held_event = post_held,
        .post_cleanup_up = post_cleanup,
    };
    MetaExecutor *executor = meta_executor_create("native-1", 500,
                                                  executor_backend);
    assert(meta_executor_open_runtime_epoch(executor, "runtime-1", "login-1"));
    assert(meta_executor_begin(executor, "operation-lost-start", "window-1",
                               fence(), 1000));
    MetaCaptureRouterBackend capture_backend = {
        .context = &fixture,
        .start = capture_start,
        .cancel = capture_cancel,
        .status = capture_status,
        .release_task = capture_release,
        .release_result = result_release,
    };
    MetaCaptureRouter *capture_router =
        meta_capture_router_create("native-1", capture_backend);
    MetaCaptureRequest request = {
        .abiVersion = META_CAPTURE_ABI_VERSION,
        .source = MetaCaptureSourceDisplayComposite,
    };
    char ignored_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    MetaCaptureTaskStatus initial_status = {0};
    assert(meta_capture_router_start(capture_router, "operation-lost-start",
                                     &request, ignored_task_ref,
                                     &initial_status));
    MetaBrokerCore *broker = meta_broker_core_create(executor, capture_router);
    assert(meta_broker_core_begin_rotation(broker) == META_BROKER_ROTATION_SEALED_PENDING);
    MetaFence pending_fence = fence();
    pending_fence.counter = 2;
    assert(!meta_executor_begin(executor, "sealed-pending", "window-1", pending_fence, 1000));
    assert(!meta_capture_router_start(capture_router, "sealed-pending", &request,
                                     ignored_task_ref, &initial_status));
    MetaBrokerCancelResult cancelled = meta_broker_core_cancel_operation(
        broker, "operation-lost-start", fence());
    assert(cancelled.acknowledged);
    assert(cancelled.executor_stopped);
    assert(cancelled.capture_tasks_cancelled == 1);
    assert(!cancelled.all_capture_tasks_drained);
    assert(fixture.capture_cancel_count == 1);
    assert(meta_broker_core_release_drained_operation(
               broker, "operation-lost-start", true) == 0);
    MetaBrokerOperationStatus pending_status =
        meta_broker_core_operation_status(broker, "operation-lost-start");
    assert(pending_status.capture_task_count == 1);
    assert(!pending_status.all_capture_tasks_drained);
    assert(pending_status.cleanup != META_CLEANUP_COMPLETE);
    assert(pending_status.quarantined);
    assert(meta_capture_router_active_tasks(capture_router, NULL, 0) == 1);
    assert(meta_broker_core_begin_rotation(broker) == META_BROKER_ROTATION_SEALED_PENDING);
    assert(!meta_executor_begin(executor, "sealed-after-cancel", "window-1", pending_fence, 1000));
    assert(!meta_capture_router_start(capture_router, "sealed-after-cancel", &request,
                                     ignored_task_ref, &initial_status));

    MetaCaptureResult *late_result = calloc(1, sizeof(*late_result));
    late_result->outcome = MetaCaptureOutcomeCancelled;
    late_result->cleanup = MetaCaptureCleanupComplete;
    fixture.capture_status = (MetaCaptureTaskStatus){
        .revision = 2,
        .completionDelivered = true,
        .stopRequested = true,
        .streamStarted = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    fixture.completion(late_result);
    MetaBrokerOperationStatus status = meta_broker_core_operation_status(
        broker, "operation-lost-start");
    assert(status.capture_task_count == 1);
    assert(status.all_capture_tasks_drained);
    assert(status.cleanup == META_CLEANUP_COMPLETE);
    assert(meta_broker_core_begin_rotation(broker) == META_BROKER_ROTATION_SEALED_PENDING);
    assert(meta_broker_core_release_drained_operation(
               broker, "operation-lost-start", false) == 1);
    assert(meta_capture_router_active_tasks(capture_router, NULL, 0) == 0);
    assert(meta_broker_core_seal_for_rotation(broker));
    assert(meta_broker_core_begin_rotation(broker) == META_BROKER_ROTATION_READY);
    MetaFence next_fence = fence();
    next_fence.counter = 2;
    assert(!meta_executor_begin(executor, "after-seal", "window-1",
                                next_fence, 1000));
    assert(!meta_capture_router_start(capture_router, "after-seal", &request,
                                      ignored_task_ref, &initial_status));
    meta_broker_core_destroy(broker);
    meta_capture_router_destroy(capture_router);
    meta_executor_destroy(executor);
  }
  puts("broker core tests passed");
  return 0;
}
