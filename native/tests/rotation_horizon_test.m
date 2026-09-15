#import <Foundation/Foundation.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "meta_capture_router.h"

typedef struct {
  MetaCaptureCompletion completion;
  MetaCaptureTaskStatus status;
  int task;
  size_t releases;
} Fixture;

static MetaCaptureTaskRef start(void *context, const MetaCaptureRequest *request,
                                dispatch_queue_t queue, MetaCaptureCompletion completion) {
  (void)request;
  (void)queue;
  Fixture *fixture = context;
  fixture->completion = [completion copy];
  fixture->status = (MetaCaptureTaskStatus){.revision = 1, .startPending = true};
  return &fixture->task;
}

static void cancel(void *context, MetaCaptureTaskRef task) {
  (void)context;
  (void)task;
}

static bool status(void *context, MetaCaptureTaskRef task, MetaCaptureTaskStatus *output) {
  Fixture *fixture = context;
  assert(task == &fixture->task);
  *output = fixture->status;
  return true;
}

static void release_task(void *context, MetaCaptureTaskRef task) {
  Fixture *fixture = context;
  assert(task == &fixture->task);
  fixture->releases += 1;
}

static void release_result(void *context, MetaCaptureResult *result) {
  (void)context;
  free(result);
}

int main(void) {
  @autoreleasepool {
    Fixture fixture = {0};
    MetaCaptureRouterBackend backend = {
        .context = &fixture, .start = start, .cancel = cancel, .status = status,
        .release_task = release_task, .release_result = release_result,
    };
    MetaCaptureRouter *router = meta_capture_router_create("native-old", backend);
    MetaCaptureRequest request = {.abiVersion = META_CAPTURE_ABI_VERSION};
    char old_ref[META_NATIVE_REF_CAPACITY] = {0};
    MetaCaptureTaskStatus current = {0};
    for (size_t index = 0; index < 10000; index += 1) {
      char ref[META_NATIVE_REF_CAPACITY] = {0};
      assert(meta_capture_router_start(router, "operation", &request, ref, &current));
      if (index == 0) snprintf(old_ref, sizeof(old_ref), "%s", ref);
      fixture.status = (MetaCaptureTaskStatus){
          .revision = 2, .completionDelivered = true, .streamStopped = true,
          .cleanup = MetaCaptureCleanupComplete, .drained = true,
      };
      fixture.completion(calloc(1, sizeof(MetaCaptureResult)));
      bool already = false;
      assert(meta_capture_router_release(router, ref, false, &already));
      assert(!already);
    }
    char ref[META_NATIVE_REF_CAPACITY] = {0};
    assert(!meta_capture_router_start(router, "over-cap", &request, ref, &current));
    bool already = false;
    assert(meta_capture_router_release(router, old_ref, false, &already));
    assert(already);
    assert(meta_capture_router_seal_for_rotation(router));
    assert(!meta_capture_router_start(router, "sealed", &request, ref, &current));
    meta_capture_router_destroy(router);

    router = meta_capture_router_create("native-new", backend);
    assert(!meta_capture_router_status(router, old_ref, &current));
    assert(meta_capture_router_start(router, "new-operation", &request, ref, &current));
    assert(!meta_capture_router_seal_for_rotation(router));
    fixture.status = (MetaCaptureTaskStatus){
        .revision = 2, .completionDelivered = true, .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete, .drained = true,
    };
    assert(meta_capture_router_release(router, ref, false, &already));
    assert(!meta_capture_router_seal_for_rotation(router));
    meta_capture_router_destroy(router);
    fixture.completion(calloc(1, sizeof(MetaCaptureResult)));
    assert(meta_capture_router_seal_for_rotation(router));
    meta_capture_router_destroy(router);
    assert(fixture.releases == 10001);
    puts("rotation horizon tests passed");
  }
  return 0;
}
