#import <Foundation/Foundation.h>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "meta_capture_router.h"

typedef struct {
  MetaCaptureCompletion completion;
  MetaCaptureTaskStatus status;
  size_t cancel_count;
  size_t release_count;
  size_t result_release_count;
  int task_storage;
} FakeCapture;

static bool block_next_status = false;
static dispatch_semaphore_t status_entered;
static dispatch_semaphore_t status_continue;
static bool block_next_cancel = false;
static dispatch_semaphore_t cancel_entered;
static dispatch_semaphore_t cancel_continue;

static MetaCaptureTaskRef fake_start(void *context,
                                     const MetaCaptureRequest *request,
                                     dispatch_queue_t callback_queue,
                                     MetaCaptureCompletion completion) {
  FakeCapture *fake = context;
  (void)request;
  (void)callback_queue;
  fake->completion = [completion copy];
  fake->status = (MetaCaptureTaskStatus){
      .revision = 1,
      .startPending = true,
      .cleanup = MetaCaptureCleanupPending,
  };
  return &fake->task_storage;
}

static void fake_cancel(void *context, MetaCaptureTaskRef task) {
  FakeCapture *fake = context;
  assert(task == &fake->task_storage);
  fake->cancel_count += 1;
  if (block_next_cancel) {
    block_next_cancel = false;
    dispatch_semaphore_signal(cancel_entered);
    dispatch_semaphore_wait(cancel_continue, DISPATCH_TIME_FOREVER);
  }
  fake->status.stopRequested = true;
  fake->status.revision += 1;
}

static bool fake_status(void *context, MetaCaptureTaskRef task,
                        MetaCaptureTaskStatus *status) {
  FakeCapture *fake = context;
  assert(task == &fake->task_storage);
  if (block_next_status) {
    block_next_status = false;
    dispatch_semaphore_signal(status_entered);
    dispatch_semaphore_wait(status_continue, DISPATCH_TIME_FOREVER);
  }
  *status = fake->status;
  return true;
}

static void fake_release_task(void *context, MetaCaptureTaskRef task) {
  FakeCapture *fake = context;
  assert(task == &fake->task_storage);
  fake->release_count += 1;
}

static void fake_release_result(void *context, MetaCaptureResult *result) {
  FakeCapture *fake = context;
  free(result);
  fake->result_release_count += 1;
}

int main(void) {
  @autoreleasepool {
    status_entered = dispatch_semaphore_create(0);
    status_continue = dispatch_semaphore_create(0);
    cancel_entered = dispatch_semaphore_create(0);
    cancel_continue = dispatch_semaphore_create(0);
    FakeCapture fake = {0};
    MetaCaptureRouterBackend backend = {
        .context = &fake,
        .start = fake_start,
        .cancel = fake_cancel,
        .status = fake_status,
        .release_task = fake_release_task,
        .release_result = fake_release_result,
    };
    MetaCaptureRouter *router =
        meta_capture_router_create("native-1", backend);
    assert(router != NULL);
    MetaCaptureRequest request = {
        .abiVersion = META_CAPTURE_ABI_VERSION,
        .source = MetaCaptureSourceDisplayComposite,
    };
    char task_ref[META_NATIVE_REF_CAPACITY] = {0};
    MetaCaptureTaskStatus status = {0};
    assert(meta_capture_router_start(router, "operation-1", &request,
                                     task_ref, &status));
    assert(task_ref[0] != '\0');
    assert(status.startPending);
    assert(!status.completionDelivered);
    assert(meta_capture_router_active_tasks(router, NULL, 0) == 1);
    assert(meta_capture_router_cancel(router, task_ref));
    assert(fake.cancel_count == 1);

    MetaCaptureResult *completion = calloc(1, sizeof(*completion));
    completion->outcome = MetaCaptureOutcomeCancelled;
    completion->cleanup = MetaCaptureCleanupUnknown;
    fake.status.startPending = false;
    fake.status.completionDelivered = true;
    fake.status.cleanup = MetaCaptureCleanupUnknown;
    fake.status.revision += 1;
    fake.completion(completion);
    const MetaCaptureResult *result = NULL;
    assert(meta_capture_router_result(router, task_ref, &status, &result));
    assert(result == completion);
    assert(status.cleanup == MetaCaptureCleanupUnknown);
    assert(meta_capture_router_result_done(router, task_ref, result));
    bool already_released = false;
    assert(!meta_capture_router_release(router, task_ref, false,
                                        &already_released));
    assert(!meta_capture_router_release(router, task_ref, true,
                                        &already_released));

    fake.status.streamStopped = true;
    fake.status.cleanup = MetaCaptureCleanupComplete;
    fake.status.drained = true;
    fake.status.revision += 1;
    assert(meta_capture_router_release(router, task_ref, false,
                                       &already_released));
    assert(!already_released);
    assert(fake.release_count == 1);
    assert(fake.result_release_count == 1);
    assert(meta_capture_router_active_tasks(router, NULL, 0) == 0);
    assert(meta_capture_router_release(router, task_ref, false,
                                       &already_released));
    assert(already_released);

    char lost_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-lost-ack", &request,
                                     lost_task_ref, &status));
    assert(meta_capture_router_cancel_operation(router,
                                                "operation-lost-ack") == 1);
    MetaCaptureResult *late_completion = calloc(1, sizeof(*late_completion));
    late_completion->outcome = MetaCaptureOutcomeCancelled;
    late_completion->cleanup = MetaCaptureCleanupComplete;
    fake.status.startPending = false;
    fake.status.completionDelivered = true;
    fake.status.streamStopped = true;
    fake.status.cleanup = MetaCaptureCleanupComplete;
    fake.status.drained = true;
    fake.status.revision += 1;
    fake.completion(late_completion);
    MetaCaptureOperationTaskRecord operation_tasks[2] = {0};
    assert(meta_capture_router_operation_tasks(
               router, "operation-lost-ack", operation_tasks, 2) == 1);
    assert(strcmp(operation_tasks[0].task_ref, lost_task_ref) == 0);
    assert(operation_tasks[0].status.drained);
    assert(operation_tasks[0].result_available);
    assert(meta_capture_router_release_drained_operation(
               router, "operation-lost-ack", false) == 1);
    assert(meta_capture_router_active_tasks(router, NULL, 0) == 0);
    MetaCaptureTaskStatus lost_ack_tombstone = {0};
    assert(meta_capture_router_status(router, lost_task_ref,
                                      &lost_ack_tombstone));
    assert(lost_ack_tombstone.completionDelivered);
    assert(lost_ack_tombstone.drained);
    memset(operation_tasks, 0, sizeof(operation_tasks));
    assert(meta_capture_router_operation_tasks(
               router, "operation-lost-ack", operation_tasks, 2) == 1);
    assert(operation_tasks[0].released);
    assert(operation_tasks[0].status.revision ==
           lost_ack_tombstone.revision);

    char null_borrow_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-null-borrow", &request,
                                     null_borrow_task_ref, &status));
    const MetaCaptureResult *empty_result = NULL;
    assert(meta_capture_router_result(router, null_borrow_task_ref, &status,
                                      &empty_result));
    assert(empty_result == NULL);
    MetaCaptureResult *raced_completion = calloc(1, sizeof(*raced_completion));
    raced_completion->cleanup = MetaCaptureCleanupComplete;
    fake.status = (MetaCaptureTaskStatus){
        .revision = 4,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    fake.completion(raced_completion);
    assert(meta_capture_router_result_done(router, null_borrow_task_ref,
                                           empty_result));
    assert(meta_capture_router_release(router, null_borrow_task_ref, false,
                                       &already_released));

    char concurrent_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-concurrent", &request,
                                     concurrent_task_ref, &status));
    fake.status = (MetaCaptureTaskStatus){
        .revision = 5,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    const char *concurrent_ref = concurrent_task_ref;
    block_next_status = true;
    dispatch_group_t group = dispatch_group_create();
    __block bool concurrent_status_ok = false;
    __block bool concurrent_release_ok = false;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      MetaCaptureTaskStatus concurrent_status = {0};
      concurrent_status_ok = meta_capture_router_status(
          router, concurrent_ref, &concurrent_status);
    });
    assert(dispatch_semaphore_wait(
               status_entered,
               dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    const size_t releases_before = fake.release_count;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      bool was_released = false;
      concurrent_release_ok = meta_capture_router_release(
          router, concurrent_ref, false, &was_released);
    });
    assert(fake.release_count == releases_before);
    dispatch_semaphore_signal(status_continue);
    assert(dispatch_group_wait(
               group, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert(concurrent_status_ok);
    assert(concurrent_release_ok);
    assert(fake.release_count == releases_before + 1);

    char result_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-result-race", &request,
                                     result_task_ref, &status));
    fake.status = (MetaCaptureTaskStatus){
        .revision = 6,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    MetaCaptureResult *result_completion = calloc(1, sizeof(*result_completion));
    fake.completion(result_completion);
    const MetaCaptureResult *result_view = NULL;
    assert(meta_capture_router_result(router, result_task_ref, &status,
                                      &result_view));
    assert(result_view == result_completion);
    const size_t result_release_before = fake.release_count;
    __block bool result_release_ok = false;
    const char *result_ref = result_task_ref;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      bool was_released = false;
      result_release_ok = meta_capture_router_release(
          router, result_ref, false, &was_released);
    });
    usleep(10000);
    assert(fake.release_count == result_release_before);
    assert(meta_capture_router_result_done(router, result_task_ref,
                                           result_view));
    assert(dispatch_group_wait(
               group, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert(result_release_ok);
    assert(fake.release_count == result_release_before + 1);

    char cancel_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-cancel-race", &request,
                                     cancel_task_ref, &status));
    fake.status = (MetaCaptureTaskStatus){
        .revision = 7,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    block_next_cancel = true;
    __block bool cancel_ok = false;
    __block bool cancel_release_ok = false;
    const char *cancel_ref = cancel_task_ref;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      cancel_ok = meta_capture_router_cancel(router, cancel_ref);
    });
    assert(dispatch_semaphore_wait(
               cancel_entered,
               dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    const size_t cancel_release_before = fake.release_count;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      bool was_released = false;
      cancel_release_ok = meta_capture_router_release(
          router, cancel_ref, false, &was_released);
    });
    assert(fake.release_count == cancel_release_before);
    dispatch_semaphore_signal(cancel_continue);
    assert(dispatch_group_wait(
               group, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert(cancel_ok && cancel_release_ok);
    assert(fake.release_count == cancel_release_before + 1);

    char authorized_task_ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(meta_capture_router_start(router, "operation-authorized", &request,
                                     authorized_task_ref, &status));
    fake.status = (MetaCaptureTaskStatus){
        .revision = 6,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    MetaCaptureReleaseAuthority authority = {
        .expected_status_revision = 6,
    };
    snprintf(authority.cleanup_request_id,
             sizeof(authority.cleanup_request_id), "%s", "cleanup-1");
    snprintf(authority.operation_id, sizeof(authority.operation_id), "%s",
             "operation-authorized");
    snprintf(authority.runtime_epoch, sizeof(authority.runtime_epoch), "%s",
             "runtime-1");
    snprintf(authority.login_session_id,
             sizeof(authority.login_session_id), "%s", "login-1");
    snprintf(authority.native_generation,
             sizeof(authority.native_generation), "%s", "native-1");
    snprintf(authority.task_ref, sizeof(authority.task_ref), "%s",
             authorized_task_ref);
    snprintf(authority.drained_evidence_ref,
             sizeof(authority.drained_evidence_ref), "%s", "drained-6");
    snprintf(authority.terminal_receipt_ref,
             sizeof(authority.terminal_receipt_ref), "%s", "terminal-6");
    snprintf(authority.accepted_fence.runtime_epoch,
             sizeof(authority.accepted_fence.runtime_epoch), "%s",
             "runtime-1");
    snprintf(authority.accepted_fence.login_session_id,
             sizeof(authority.accepted_fence.login_session_id), "%s",
             "login-1");
    snprintf(authority.accepted_fence.native_generation,
             sizeof(authority.accepted_fence.native_generation), "%s",
             "native-1");
    authority.accepted_fence.counter = 1;
    authority.current_high_water_fence = authority.accepted_fence;
    __block MetaCaptureReleaseReceipt first_receipt = {0};
    __block MetaCaptureReleaseReceipt second_receipt = {0};
    __block bool first_authorized_result = false;
    __block bool second_authorized_result = false;
    const size_t authorized_release_before = fake.release_count;
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      first_authorized_result = meta_capture_router_release_authorized(
          router, &authority, &first_receipt);
    });
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      second_authorized_result = meta_capture_router_release_authorized(
          router, &authority, &second_receipt);
    });
    assert(dispatch_group_wait(
               group, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert(first_authorized_result && second_authorized_result);
    assert(fake.release_count == authorized_release_before + 1);
    assert(first_receipt.already_released != second_receipt.already_released);
    const MetaCaptureReleaseReceipt *forget_receipt =
        first_receipt.already_released ? &second_receipt : &first_receipt;
    assert(!meta_capture_router_forget_released(router, forget_receipt));
    meta_capture_router_destroy(router);
    const size_t releases_before_late_callback = fake.result_release_count;
    MetaCaptureResult *delayed_result = calloc(1, sizeof(*delayed_result));
    fake.completion(delayed_result);
    assert(fake.result_release_count == releases_before_late_callback + 1);

    char first_retained_tombstone[META_NATIVE_REF_CAPACITY] = {0};
    for (size_t index = 0; index < 130; index += 1) {
      char retained_task_ref[META_NATIVE_REF_CAPACITY] = {0};
      char retained_operation[META_NATIVE_REF_CAPACITY] = {0};
      snprintf(retained_operation, sizeof(retained_operation),
               "operation-retained-%zu", index);
      assert(meta_capture_router_start(router, retained_operation, &request,
                                       retained_task_ref, &status));
      fake.completion(calloc(1, sizeof(MetaCaptureResult)));
      fake.status = (MetaCaptureTaskStatus){
          .revision = 7,
          .completionDelivered = true,
          .streamStopped = true,
          .cleanup = MetaCaptureCleanupComplete,
          .drained = true,
      };
      bool retained_already = false;
      assert(meta_capture_router_release(router, retained_task_ref, false,
                                         &retained_already));
      if (index == 0) {
        snprintf(first_retained_tombstone,
                 sizeof(first_retained_tombstone), "%s",
                 retained_task_ref);
      }
    }
    bool retained_already = false;
    assert(meta_capture_router_release(router, first_retained_tombstone, false,
                                       &retained_already));
    assert(retained_already);
    MetaCaptureReleaseReceipt retained_authorized_receipt = {0};
    assert(meta_capture_router_release_authorized(
        router, &authority, &retained_authorized_receipt));
    assert(retained_authorized_receipt.already_released);
    assert(meta_capture_router_forget_released(router, forget_receipt));
    meta_capture_router_destroy(router);
  }
  puts("capture router tests passed");
  return 0;
}
