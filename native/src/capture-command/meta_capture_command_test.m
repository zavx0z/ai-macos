#import <Foundation/Foundation.h>

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#import "meta_capture_command.h"

typedef struct {
  MetaCaptureCompletion completion;
  MetaCaptureTaskStatus status;
  MetaCaptureRequest accepted_request;
  int task_storage;
} FakeCaptureChild;

typedef struct {
  FakeCaptureChild children[16];
  size_t start_count;
  size_t release_task_count;
  size_t release_result_count;
  size_t compose_count;
} FakeCaptureBackend;

static MetaCaptureResult *fake_compose_layout(
    void *context, const MetaCaptureLayoutRequest *request);

MetaCaptureRequest meta_capture_request_default(void) {
  return (MetaCaptureRequest){
      .abiVersion = META_CAPTURE_ABI_VERSION,
      .outputScale = 1,
      .captureTimeoutMilliseconds = META_CAPTURE_DEFAULT_TIMEOUT_MS,
      .stopTimeoutMilliseconds = META_CAPTURE_DEFAULT_STOP_TIMEOUT_MS,
      .maxFrameAgeMilliseconds = META_CAPTURE_DEFAULT_MAX_FRAME_AGE_MS,
      .maxPixels = META_CAPTURE_DEFAULT_MAX_PIXELS,
      .maxEncodedBytes = META_CAPTURE_DEFAULT_MAX_ENCODED_BYTES,
  };
}

static MetaCaptureTaskRef fake_start(void *context,
                                     const MetaCaptureRequest *request,
                                     dispatch_queue_t callback_queue,
                                     MetaCaptureCompletion completion) {
  (void)callback_queue;
  FakeCaptureBackend *fake = context;
  assert(fake->start_count < 16);
  FakeCaptureChild *child = &fake->children[fake->start_count++];
  child->accepted_request = *request;
  child->completion = [completion copy];
  child->status = (MetaCaptureTaskStatus){
      .revision = 1,
      .startPending = true,
      .cleanup = MetaCaptureCleanupPending,
  };
  return &child->task_storage;
}

static FakeCaptureChild *fake_child(FakeCaptureBackend *fake,
                                    MetaCaptureTaskRef task) {
  for (size_t index = 0; index < fake->start_count; index += 1) {
    if (task == &fake->children[index].task_storage) {
      return &fake->children[index];
    }
  }
  return NULL;
}

static FakeCaptureChild *last_child(FakeCaptureBackend *fake) {
  assert(fake->start_count > 0);
  return &fake->children[fake->start_count - 1];
}

static void fake_cancel(void *context, MetaCaptureTaskRef task) {
  FakeCaptureBackend *fake = context;
  FakeCaptureChild *child = fake_child(fake, task);
  assert(child != NULL);
  child->status.stopRequested = true;
  child->status.revision += 1;
}

static bool fake_status(void *context, MetaCaptureTaskRef task,
                        MetaCaptureTaskStatus *status) {
  FakeCaptureBackend *fake = context;
  FakeCaptureChild *child = fake_child(fake, task);
  assert(child != NULL);
  *status = child->status;
  return true;
}

static void fake_release_task(void *context, MetaCaptureTaskRef task) {
  FakeCaptureBackend *fake = context;
  assert(fake_child(fake, task) != NULL);
  fake->release_task_count += 1;
}

static void fake_release_result(void *context, MetaCaptureResult *result) {
  FakeCaptureBackend *fake = context;
  if (result->caption != NULL) CFRelease(result->caption);
  if (result->pngData != NULL) CFRelease(result->pngData);
  free(result->regions);
  free(result);
  fake->release_result_count += 1;
}

static NSDictionary *display_ref(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"displayRef" : @"display-1",
    @"displayLayoutRevision" : @3,
  };
}

static NSDictionary *second_display_ref(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"displayRef" : @"display-2",
    @"displayLayoutRevision" : @3,
  };
}

static NSDictionary *display_target(void) {
  return @{ @"kind" : @"display", @"ref" : display_ref() };
}

static NSDictionary *window_ref(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"applicationRef" : @"application-1",
    @"windowRef" : @"window-1",
  };
}

static NSDictionary *window_target(void) {
  return @{ @"kind" : @"window", @"ref" : window_ref() };
}

static NSDictionary *fence(uint64_t counter) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"counter" : @(counter),
  };
}

static NSDictionary *start_request(NSString *inventory_id,
                                   uint64_t inventory_revision,
                                   NSString *target_kind,
                                   NSString *expires_at) {
  NSDictionary *target = [target_kind isEqual:@"desktop-layout"]
      ? @{
        @"kind" : @"desktop-layout",
        @"ref" : @{
          @"runtimeEpoch" : @"runtime-1",
          @"loginSessionId" : @"login-1",
          @"nativeGeneration" : @"native-1",
          @"layoutRef" : @"native-1:layout:3",
          @"displayLayoutRevision" : @3,
        },
      }
      : [target_kind isEqual:@"window"] ? window_target() : display_target();
  NSDictionary *target_wrapper = [target_kind isEqual:@"desktop-layout"]
      ? @{
        @"kind" : @"desktop-layout",
        @"target" : target,
        @"displays" : @[@{
          @"kind" : @"display",
          @"target" : display_target(),
          @"nativeDisplayId" : @10,
        }, @{
          @"kind" : @"display",
          @"target" : @{ @"kind" : @"display", @"ref" : second_display_ref() },
          @"nativeDisplayId" : @20,
        }],
      }
      : [target_kind isEqual:@"window"] ? @{
        @"kind" : @"window",
        @"target" : target,
        @"cgWindowId" : @77,
        @"ownerPid" : @42,
      } : @{
        @"kind" : @"display",
        @"target" : target,
        @"nativeDisplayId" : @10,
      };
  NSDictionary *mapping = [target_kind isEqual:@"desktop-layout"]
      ? @{
        @"kind" : @"desktop-layout",
        @"displays" : @[@{
          @"nativeDisplayId" : @10,
          @"ref" : display_ref(),
        }, @{
          @"nativeDisplayId" : @20,
          @"ref" : second_display_ref(),
        }],
      }
      : [target_kind isEqual:@"window"] ? @{
        @"kind" : @"window",
        @"cgWindowId" : @77,
        @"ownerPid" : @42,
        @"displays" : @[@{
          @"nativeDisplayId" : @10,
          @"ref" : display_ref(),
        }, @{
          @"nativeDisplayId" : @20,
          @"ref" : second_display_ref(),
        }],
      } : @{
        @"kind" : @"display",
        @"display" : @{
          @"nativeDisplayId" : @10,
          @"ref" : display_ref(),
        },
      };
  return @{
    @"kind" : @"request",
    @"intent" : @"mutation",
    @"method" : @"capture.start",
    @"protocolVersion" : @"1",
    @"requestId" : @"request-1",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"deadlineAt" : @"2099-09-15T10:00:10.000Z",
    @"operation" : @{
      @"kind" : @"native",
      @"operationId" : @"operation-1",
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"inventoryId" : inventory_id,
      @"inventoryRevision" : @(inventory_revision),
      @"target" : target,
      @"fence" : fence(1),
    },
    @"payload" : @{
      @"request" : @{
        @"source" : [target_kind isEqual:@"window"]
            ? @"window-isolated" : @"display-composite",
        @"caption" : @"Ожидаю основной дисплей",
        @"publication" : @{
          @"observationId" : @"observation-1",
          @"frameRef" : @"frame-1",
          @"runtimeEpoch" : @"runtime-1",
          @"loginSessionId" : @"login-1",
          @"nativeGeneration" : @"native-1",
          @"inventoryId" : inventory_id,
          @"inventoryRevision" : @(inventory_revision),
          @"displayLayoutRevision" : @3,
          @"expiresAt" : expires_at,
        },
        @"target" : target_wrapper,
        @"clip" : @{ @"kind" : @"full-target" },
        @"cursor" : @"exclude",
        @"output" : @{
          @"scale" : @1,
          @"maxWidthPx" : @1000,
          @"maxHeightPx" : @1000,
          @"maxPixels" : @1000000,
          @"maxEncodedBytes" : @1000000,
        },
      },
      @"nativeMapping" : mapping,
      @"captureTimeoutMs" : @1000,
      @"stopTimeoutMs" : @100,
    },
  };
}

static NSDictionary *cleanup_request(NSString *purpose,
                                     NSString *task_ref,
                                     uint64_t revision,
                                     NSString *drained_ref,
                                     NSString *cleanup_request_id) {
  return @{
    @"control" : @{
      @"kind" : @"cleanup-only",
      @"purpose" : purpose,
      @"requestId" : [NSString stringWithFormat:@"rpc-%@-%@", purpose,
          cleanup_request_id],
      @"cleanupRequestId" : cleanup_request_id,
      @"operationId" : @"operation-1",
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"acceptedFence" : fence(1),
      @"currentHighWaterFence" : fence(1),
      @"expectedStatusRevision" : @(revision),
      @"expectedDrainedEvidenceRef" : drained_ref,
    },
    @"payload" : @{ @"captureTaskRef" : task_ref },
  };
}

static MetaCaptureResult *successful_result(size_t region_count) {
  MetaCaptureResult *result = calloc(1, sizeof(*result));
  result->outcome = MetaCaptureOutcomeSucceeded;
  result->cleanup = MetaCaptureCleanupComplete;
  result->errorCode = MetaCaptureErrorNone;
  result->source = MetaCaptureSourceDisplayComposite;
  result->caption = CFStringCreateCopy(NULL, CFSTR("Ожидаю основной дисплей"));
  const uint8_t bytes[] = {0x89, 0x50, 0x4e, 0x47};
  result->pngData = CFDataCreate(NULL, bytes, sizeof(bytes));
  result->imageWidthPixels = 2;
  result->imageHeightPixels = 2;
  result->encodedBytes = sizeof(bytes);
  result->capturedAtUnixNanoseconds = 1789466400000000000ULL;
  result->requestedDisplayID = 10;
  result->shareableTargetMatched = true;
  result->beforeTargetMatched = true;
  result->afterTargetMatched = true;
  result->boundsUnchanged = true;
  result->regions = calloc(region_count, sizeof(*result->regions));
  result->regionCount = region_count;
  for (size_t index = 0; index < region_count; index += 1) {
    result->regions[index] = (MetaCaptureDisplayRegion){
        .displayID = 10,
        .displayBoundsPoints = CGRectMake(0, 0, 2, 2),
        .imageRectPixels = CGRectMake(0, 0, 2, 2),
        .destinationRectPoints = CGRectMake(0, 0, 2, 2),
        .imageToDestination = {.a = 1, .d = 1},
        .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
        .backingScaleX = 1,
        .backingScaleY = 1,
        .frameTimestampUnixNanoseconds = 1789466400000000000ULL,
    };
  }
  return result;
}

static MetaCaptureResult *successful_window_result(void) {
  MetaCaptureResult *result = successful_result(1);
  result->source = MetaCaptureSourceWindowIsolated;
  result->requestedDisplayID = 0;
  result->requestedWindowID = 77;
  result->requestedOwnerPID = 42;
  return result;
}

static MetaCaptureResult *successful_layout_child(
    uint32_t display_id, CGRect bounds, double backing_scale) {
  MetaCaptureResult *result = successful_result(1);
  result->requestedDisplayID = display_id;
  result->regions[0].displayID = display_id;
  result->regions[0].displayBoundsPoints = bounds;
  result->regions[0].destinationRectPoints = bounds;
  result->regions[0].backingScaleX = backing_scale;
  result->regions[0].backingScaleY = backing_scale;
  return result;
}

static MetaCaptureResult *fake_compose_layout(
    void *context, const MetaCaptureLayoutRequest *request) {
  FakeCaptureBackend *fake = context;
  assert(request != NULL);
  assert(request->frameCount == 2);
  assert(request->maxWidthPixels == 1000);
  assert(request->maxHeightPixels == 1000);
  assert(request->frames[0]->cleanup == MetaCaptureCleanupComplete);
  assert(request->frames[1]->cleanup == MetaCaptureCleanupComplete);
  fake->compose_count += 1;
  MetaCaptureResult *result = calloc(1, sizeof(*result));
  result->outcome = MetaCaptureOutcomeSucceeded;
  result->cleanup = MetaCaptureCleanupComplete;
  result->errorCode = MetaCaptureErrorNone;
  result->source = MetaCaptureSourceDisplayComposite;
  result->caption = CFRetain(request->caption);
  result->pngData = CFRetain(request->frames[0]->pngData);
  result->imageWidthPixels = 4;
  result->imageHeightPixels = 2;
  result->encodedBytes = CFDataGetLength(result->pngData);
  result->capturedAtUnixNanoseconds = 1789466400000000000ULL;
  result->frameStatus = 0;
  result->shareableTargetMatched = true;
  result->regions = calloc(request->frameCount, sizeof(*result->regions));
  result->regionCount = request->frameCount;
  for (size_t index = 0; index < request->frameCount; index += 1) {
    result->regions[index] = request->frames[index]->regions[0];
  }
  return result;
}

int main(void) {
  @autoreleasepool {
    FakeCaptureBackend fake = {0};
    MetaCaptureRouterBackend backend = {
        .context = &fake,
        .start = fake_start,
        .cancel = fake_cancel,
        .status = fake_status,
        .release_task = fake_release_task,
        .release_result = fake_release_result,
        .compose_layout = fake_compose_layout,
    };
    MetaCaptureRouter *router = meta_capture_router_create("native-1", backend);
    assert(router != NULL);
    MetaDisplayRecord displays[] = {{
        .display_ref = "display-1",
        .display_id = 10,
        .bounds = {.x = -2, .y = 0, .width = 2, .height = 2},
        .scale = 1,
    }, {
        .display_ref = "display-2",
        .display_id = 20,
        .bounds = {.x = 0, .y = 0, .width = 2, .height = 2},
        .scale = 2,
    }};
    MetaWindowRecord windows[] = {{
        .window_ref = "window-1",
        .application_ref = "application-1",
        .cg_window_id = 77,
        .pid = 42,
        .frame = {.x = -1.5, .y = 0.5, .width = 300, .height = 200},
        .mapping = META_MAPPING_CORROBORATED,
    }};
    MetaInventorySnapshot snapshot = {
        .inventory_id = "inventory-1",
        .layout_ref = "native-1:layout:3",
        .native_generation = "native-1",
        .revision = 4,
        .display_layout_revision = 3,
        .captured_at_micros = 1789466399000000ULL,
        .complete = true,
        .windows = windows,
        .window_count = 1,
        .displays = displays,
        .display_count = 2,
    };
    __block BOOL topologyCurrent = YES;
    MetaCaptureCommandBinder *binder = [[MetaCaptureCommandBinder alloc]
        initWithRouter:router
        inventoryProvider:^const MetaInventorySnapshot *{
          return &snapshot;
        }
        topologyValidator:^BOOL(const MetaInventorySnapshot *value) {
          return topologyCurrent && value != NULL;
        }
        nativeGeneration:@"native-1"
        nativeBuildId:@"native-build-1"];
    assert(binder != nil);

    NSError *error = nil;
    NSDictionary *stale = [binder startRequest:
        start_request(@"inventory-stale", 4, @"display",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(stale == nil);
    assert(error.code == 2);
    error = nil;
    NSDictionary *expired = [binder startRequest:
        start_request(@"inventory-1", 4, @"display",
                      @"2020-09-15T10:02:00.000Z") error:&error];
    assert(expired == nil);
    assert(error.code == 2);
    assert(fake.start_count == 0);

    [binder setValue:@1024 forKey:@"pendingStarts"];
    error = nil;
    NSDictionary *over_capacity = [binder startRequest:
        start_request(@"inventory-1", 4, @"display",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(over_capacity == nil);
    assert(error.code == 4);
    assert(fake.start_count == 0);
    [binder setValue:@0 forKey:@"pendingStarts"];

    error = nil;
    NSDictionary *started = [binder startRequest:
        start_request(@"inventory-1", 4, @"display",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(started != nil && error == nil);
    NSString *task_ref = started[@"captureTaskRef"];
    assert([started[@"status"][@"startPending"] boolValue]);
    assert(![started[@"status"][@"completionDelivered"] boolValue]);
    assert(fake.start_count == 1);
    assert(last_child(&fake)->accepted_request.source ==
           MetaCaptureSourceDisplayComposite);
    assert(last_child(&fake)->accepted_request.displayID == 10);

    NSString *start_status_ref = started[@"statusEvidenceRef"];
    __block NSDictionary *binary_header = nil;
    __block NSData *binary_bytes = nil;
    NSDictionary *pending = [binder cleanupRequest:
        cleanup_request(@"result", task_ref, 1, start_status_ref, @"cleanup-result-1")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          binary_header = header;
          binary_bytes = bytes;
          return YES;
        }
        error:&error];
    assert([pending[@"poll"][@"state"] isEqual:@"pending"]);
    assert(strcmp([pending[@"ack"][@"quarantined"] objCType],
                  @encode(BOOL)) == 0);
    assert([pending[@"ack"][@"quarantined"] boolValue]);
    assert(binary_header == nil && binary_bytes == nil);

    last_child(&fake)->status = (MetaCaptureTaskStatus){
        .revision = 2,
        .completionDelivered = true,
        .streamStarted = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    last_child(&fake)->completion(successful_result(1));
    error = nil;
    NSDictionary *not_emitted = [binder cleanupRequest:
        cleanup_request(@"result", task_ref, 1, start_status_ref,
                        @"cleanup-result-retry")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return NO;
        }
        error:&error];
    assert(not_emitted == nil);
    assert(error.code == 5);
    assert([binder lookupFrameGeometry:@"frame-1"] == nil);
    error = nil;
    NSDictionary *completed = [binder cleanupRequest:
        cleanup_request(@"result", task_ref, 1, start_status_ref, @"cleanup-result-2")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          binary_header = header;
          binary_bytes = bytes;
          return YES;
        }
        error:&error];
    assert([completed[@"poll"][@"state"] isEqual:@"completed"]);
    NSDictionary *execution = completed[@"poll"][@"result"];
    assert(![execution[@"observedAt"] isEqual:started[@"observedAt"]]);
    assert([execution[@"observedAt"]
        isEqual:execution[@"frame"][@"capturedAt"]]);
    assert([execution[@"backend"][@"buildId"] isEqual:@"native-build-1"]);
    assert([execution[@"frame"][@"frameRef"] isEqual:@"frame-1"]);
    assert([execution[@"frame"][@"encodedBytes"] unsignedLongLongValue] == 4);
    assert([binary_header[@"payload"][@"byteLength"] unsignedLongLongValue] == 4);
    assert(binary_bytes.length == 4);
    assert(![started[@"sourceResponseRef"]
        isEqual:execution[@"sourceResponseRef"]]);
    NSDictionary *geometry = [binder lookupFrameGeometry:@"frame-1"];
    assert([geometry[@"observationId"] isEqual:@"observation-1"]);
    assert([geometry[@"regions"] count] == 1);
    assert([geometry[@"regions"][0][@"macosDisplayRef"] isEqual:display_ref()]);

    NSString *terminal_drained = execution[@"drainedEvidenceRef"];
    __block NSUInteger repeated_emissions = 0;
    NSDictionary *repeated = [binder cleanupRequest:
        cleanup_request(@"result", task_ref, 2, terminal_drained,
                        @"cleanup-result-repeat")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          repeated_emissions += 1;
          return YES;
        }
        error:&error];
    assert(repeated != nil);
    assert(repeated_emissions == 0);
    assert([repeated[@"poll"][@"result"][@"frame"][@"binaryToken"]
        isEqual:execution[@"frame"][@"binaryToken"]]);
    assert(![repeated[@"poll"][@"result"][@"sourceResponseRef"]
        isEqual:execution[@"sourceResponseRef"]]);

    error = nil;
    NSDictionary *wrong_revision_release = [binder cleanupRequest:
        cleanup_request(@"release", task_ref, 1, terminal_drained,
                        @"cleanup-release-wrong-revision")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(wrong_revision_release == nil);
    assert(error.code == 2);
    error = nil;
    NSDictionary *wrong_release = [binder cleanupRequest:
        cleanup_request(@"release", task_ref, 2, @"drained-wrong",
                        @"cleanup-release-wrong")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(wrong_release == nil);
    assert(error.code == 2);
    error = nil;
    NSDictionary *released = [binder cleanupRequest:
        cleanup_request(@"release", task_ref, 2, terminal_drained,
                        @"cleanup-release-1")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(released != nil);
    assert(![released[@"alreadyReleased"] boolValue]);
    assert(strcmp([released[@"ack"][@"quarantined"] objCType],
                  @encode(BOOL)) == 0);
    NSDictionary *released_again = [binder cleanupRequest:
        cleanup_request(@"release", task_ref, 2, terminal_drained,
                        @"cleanup-release-1")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert([released_again[@"alreadyReleased"] boolValue]);
    assert(fake.release_task_count == 1);
    assert(fake.release_result_count == 1);
    assert([binder lookupFrameGeometry:@"frame-1"] != nil);

    snapshot.complete = false;
    topologyCurrent = NO;
    error = nil;
    BOOL display_without_topology = [binder validateStartRequest:
        start_request(@"inventory-1", 4, @"display",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(!display_without_topology);
    assert(error.code == MetaCaptureCommandStaleAuthority);
    assert(fake.start_count == 1);
    windows[0].mapping = META_MAPPING_AMBIGUOUS;
    error = nil;
    BOOL unproven_window = [binder validateStartRequest:
        start_request(@"inventory-1", 4, @"window",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(!unproven_window);
    assert(error.code == MetaCaptureCommandStaleAuthority);
    assert(fake.start_count == 1);
    windows[0].mapping = META_MAPPING_CORROBORATED;
    error = nil;
    NSDictionary *window_started = [binder startRequest:
        start_request(@"inventory-1", 4, @"window",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(window_started != nil && error == nil);
    assert(last_child(&fake)->accepted_request.source ==
           MetaCaptureSourceWindowIsolated);
    assert(last_child(&fake)->accepted_request.windowID == 77);
    assert(last_child(&fake)->accepted_request.ownerPID == 42);
    last_child(&fake)->status = (MetaCaptureTaskStatus){
        .revision = 3,
        .completionDelivered = true,
        .stopRequested = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    MetaCaptureResult *window_cleanup = calloc(1, sizeof(*window_cleanup));
    window_cleanup->outcome = MetaCaptureOutcomeFailed;
    window_cleanup->cleanup = MetaCaptureCleanupComplete;
    last_child(&fake)->completion(window_cleanup);
    assert(meta_capture_router_release_drained_operation(
               router, "operation-1", false) == 1);
    NSString *window_task_ref = window_started[@"captureTaskRef"];
    NSString *window_start_status_ref = window_started[@"statusEvidenceRef"];
    error = nil;
    NSDictionary *released_status = [binder cleanupRequest:
        cleanup_request(@"status", window_task_ref, 1,
                        window_start_status_ref, @"cleanup-owner-status")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(released_status != nil && error == nil);
    assert([released_status[@"status"][@"drained"] boolValue]);
    NSString *owner_drained = released_status[@"terminal"][@"drainedEvidenceRef"];
    NSDictionary *owner_released = [binder cleanupRequest:
        cleanup_request(@"release", window_task_ref, 3, owner_drained,
                        @"cleanup-owner-release")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(owner_released != nil && error == nil);
    assert([owner_released[@"alreadyReleased"] boolValue]);
    assert(fake.release_task_count == 2);
    assert(fake.release_result_count == 2);

    error = nil;
    NSDictionary *region_started = [binder startRequest:
        start_request(@"inventory-1", 4, @"window",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(region_started != nil && error == nil);
    last_child(&fake)->status = (MetaCaptureTaskStatus){
        .revision = 4,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    last_child(&fake)->completion(successful_window_result());
    __block NSUInteger invalid_region_emissions = 0;
    NSDictionary *invalid_regions = [binder cleanupRequest:
        cleanup_request(@"result", region_started[@"captureTaskRef"], 1,
                        region_started[@"statusEvidenceRef"],
                        @"cleanup-missing-region")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          invalid_region_emissions += 1;
          return YES;
        }
        error:&error];
    assert(invalid_regions == nil);
    assert(error.code == 4);
    assert(invalid_region_emissions == 0);
    assert(meta_capture_router_release_drained_operation(
               router, "operation-1", false) == 1);
    assert(fake.release_task_count == 3);
    assert(fake.release_result_count == 3);

    topologyCurrent = YES;
    error = nil;
    NSDictionary *layout_started = [binder startRequest:
        start_request(@"inventory-1", 4, @"desktop-layout",
                      @"2099-09-15T10:02:00.000Z") error:&error];
    assert(layout_started != nil && error == nil);
    assert([layout_started[@"status"][@"startPending"] boolValue]);
    assert(fake.start_count == 5);
    FakeCaptureChild *first_layout = &fake.children[3];
    FakeCaptureChild *second_layout = &fake.children[4];
    assert(first_layout->accepted_request.displayID == 10);
    assert(second_layout->accepted_request.displayID == 20);
    assert(first_layout->accepted_request.maxEncodedBytes == 500000);
    assert(second_layout->accepted_request.maxEncodedBytes == 500000);
    first_layout->status = (MetaCaptureTaskStatus){
        .revision = 2,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    first_layout->completion(successful_layout_child(
        10, CGRectMake(-2, 0, 2, 2), 1));
    NSDictionary *partial_layout = [binder cleanupRequest:
        cleanup_request(@"result", layout_started[@"captureTaskRef"], 1,
                        layout_started[@"statusEvidenceRef"],
                        @"cleanup-layout-partial")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(partial_layout != nil);
    assert([partial_layout[@"poll"][@"state"] isEqual:@"pending"]);
    assert(fake.compose_count == 0);
    second_layout->status = (MetaCaptureTaskStatus){
        .revision = 2,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupUnknown,
    };
    MetaCaptureResult *unknown_child = successful_layout_child(
        20, CGRectMake(0, 0, 2, 2), 2);
    unknown_child->cleanup = MetaCaptureCleanupUnknown;
    second_layout->completion(unknown_child);
    NSDictionary *partial_status = partial_layout[@"poll"][@"status"];
    NSDictionary *partial_evidence = partial_layout[@"statusEvidence"];
    NSDictionary *unknown_layout = [binder cleanupRequest:
        cleanup_request(@"result", layout_started[@"captureTaskRef"],
                        [partial_status[@"revision"] unsignedLongLongValue],
                        partial_evidence[@"statusEvidenceRef"],
                        @"cleanup-layout-unknown")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(unknown_layout != nil);
    assert([unknown_layout[@"poll"][@"state"] isEqual:@"pending"]);
    assert([unknown_layout[@"poll"][@"status"][@"cleanup"]
        isEqual:@"unknown"]);
    assert(fake.compose_count == 0);
    second_layout->status = (MetaCaptureTaskStatus){
        .revision = 3,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    NSDictionary *unknown_status = unknown_layout[@"poll"][@"status"];
    NSDictionary *unknown_evidence = unknown_layout[@"statusEvidence"];
    __block NSUInteger layout_emissions = 0;
    NSDictionary *layout_completed = [binder cleanupRequest:
        cleanup_request(@"result", layout_started[@"captureTaskRef"],
                        [unknown_status[@"revision"] unsignedLongLongValue],
                        unknown_evidence[@"statusEvidenceRef"],
                        @"cleanup-layout-complete")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          layout_emissions += 1;
          return YES;
        }
        error:&error];
    assert(layout_completed != nil && error == nil);
    assert([layout_completed[@"poll"][@"state"] isEqual:@"completed"]);
    assert(layout_emissions == 1);
    assert(fake.compose_count == 1);
    NSDictionary *layout_result = layout_completed[@"poll"][@"result"];
    assert([layout_result[@"nativeMapping"][@"kind"]
        isEqual:@"desktop-layout"]);
    assert([layout_result[@"frame"][@"regions"] count] == 2);
    assert([layout_result[@"frame"][@"regions"][0]
        [@"destinationRect"][@"x"] doubleValue] == -2);
    NSString *layout_drained = layout_result[@"drainedEvidenceRef"];
    NSDictionary *layout_release = [binder cleanupRequest:
        cleanup_request(@"release", layout_started[@"captureTaskRef"],
                        [layout_completed[@"poll"][@"status"][@"revision"]
                            unsignedLongLongValue],
                        layout_drained, @"cleanup-layout-release")
        emitBinary:^BOOL(NSDictionary *header, NSData *bytes) {
          (void)header;
          (void)bytes;
          return YES;
        }
        error:&error];
    assert(layout_release != nil && error == nil);
    assert(fake.release_task_count == 5);
    assert(fake.release_result_count == 6);
    meta_capture_router_destroy(router);
  }
  puts("meta_capture_command_test: ok");
  return 0;
}
