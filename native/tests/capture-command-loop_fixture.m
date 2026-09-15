#import <Foundation/Foundation.h>

#include <unistd.h>

#include "meta_broker_core.h"
#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "capture-command/meta_capture_command.h"
#include "observer-command/meta_observer_command.h"

typedef struct {
  MetaCaptureCompletion completion;
  dispatch_queue_t callback_queue;
  MetaCaptureTaskStatus status;
  MetaCaptureRequest accepted_request;
  bool completion_scheduled;
  size_t status_count;
  int task_storage;
} FakeCaptureChild;

typedef struct {
  FakeCaptureChild children[8];
  size_t start_count;
  size_t cancel_count;
  size_t release_task_count;
  size_t release_result_count;
} FakeCaptureBackend;

static MetaCaptureResult *successful_result(
    const MetaCaptureRequest *request) {
  static const uint8_t png[] = {
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
      0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
      0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  };
  MetaCaptureResult *result = calloc(1, sizeof(*result));
  if (result == NULL) return NULL;
  result->outcome = MetaCaptureOutcomeSucceeded;
  result->cleanup = MetaCaptureCleanupComplete;
  result->errorCode = MetaCaptureErrorNone;
  result->source = MetaCaptureSourceDisplayComposite;
  result->caption = CFRetain(request->caption);
  result->pngData = CFDataCreate(NULL, png, sizeof(png));
  result->imageWidthPixels = 1;
  result->imageHeightPixels = 1;
  result->encodedBytes = sizeof(png);
  result->capturedAtUnixNanoseconds = 1789466400000000000ULL;
  result->requestedDisplayID = request->displayID;
  result->shareableTargetMatched = true;
  result->beforeTargetMatched = true;
  result->afterTargetMatched = true;
  result->boundsUnchanged = true;
  result->regions = calloc(1, sizeof(*result->regions));
  if (result->caption == NULL || result->pngData == NULL ||
      result->regions == NULL) {
    if (result->caption != NULL) CFRelease(result->caption);
    if (result->pngData != NULL) CFRelease(result->pngData);
    free(result->regions);
    free(result);
    return NULL;
  }
  result->regionCount = 1;
  CGRect bounds = request->displayID == 10
      ? CGRectMake(-1, 0, 1, 1) : CGRectMake(0, 0, 1, 1);
  double backing_scale = request->displayID == 10 ? 1 : 2;
  result->regions[0] = (MetaCaptureDisplayRegion){
      .displayID = request->displayID,
      .displayBoundsPoints = bounds,
      .imageRectPixels = CGRectMake(0, 0, 1, 1),
      .destinationRectPoints = bounds,
      .imageToDestination = {.a = 1, .d = 1, .tx = bounds.origin.x},
      .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
      .backingScaleX = backing_scale,
      .backingScaleY = backing_scale,
      .frameTimestampUnixNanoseconds = 1789466400000000000ULL,
  };
  return result;
}

static MetaCaptureTaskRef fake_start(void *context,
                                     const MetaCaptureRequest *request,
                                     dispatch_queue_t callback_queue,
                                     MetaCaptureCompletion completion) {
  FakeCaptureBackend *fake = context;
  if (fake->start_count >= 8) return NULL;
  FakeCaptureChild *child = &fake->children[fake->start_count++];
  child->accepted_request = *request;
  child->callback_queue = callback_queue;
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

static void fake_cancel(void *context, MetaCaptureTaskRef task) {
  FakeCaptureBackend *fake = context;
  FakeCaptureChild *child = fake_child(fake, task);
  if (child == NULL) return;
  fake->cancel_count += 1;
  child->status.revision += 1;
  child->status.stopRequested = true;
}

static bool fake_status(void *context, MetaCaptureTaskRef task,
                        MetaCaptureTaskStatus *status) {
  FakeCaptureBackend *fake = context;
  FakeCaptureChild *child = fake_child(fake, task);
  if (child == NULL) return false;
  child->status_count += 1;
  *status = child->status;
  if (child->status_count >= 2 && !child->completion_scheduled &&
      child->completion != nil) {
    child->completion_scheduled = true;
    dispatch_queue_t queue = child->callback_queue == NULL
                                 ? dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0)
                                 : child->callback_queue;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC), queue, ^{
      MetaCaptureResult *result = successful_result(&child->accepted_request);
      if (result == NULL) return;
      child->status = (MetaCaptureTaskStatus){
          .revision = 2,
          .completionDelivered = true,
          .streamStarted = true,
          .streamStopped = true,
          .cleanup = MetaCaptureCleanupComplete,
          .drained = true,
      };
      child->completion(result);
    });
  }
  return true;
}

static void fake_release_task(void *context, MetaCaptureTaskRef task) {
  FakeCaptureBackend *fake = context;
  if (fake_child(fake, task) != NULL) fake->release_task_count += 1;
}

static void fake_release_result(void *context, MetaCaptureResult *result) {
  FakeCaptureBackend *fake = context;
  if (result->caption != NULL) CFRelease(result->caption);
  if (result->pngData != NULL) CFRelease(result->pngData);
  free(result->regions);
  free(result);
  fake->release_result_count += 1;
}

static MetaCaptureResult *fake_compose_layout(
    void *context, const MetaCaptureLayoutRequest *request) {
  (void)context;
  return meta_capture_compose_layout(request);
}

static bool fake_post_held(void *context, MetaHeldEventKind kind, uint32_t code,
                           bool down, uint64_t tag) {
  (void)context;
  (void)kind;
  (void)code;
  (void)down;
  return tag != 0;
}

static bool fake_cleanup_up(void *context, MetaHeldEventKind kind,
                            uint32_t code, uint64_t tag) {
  return fake_post_held(context, kind, code, false, tag);
}

@interface CaptureCommandLoopBackend : NSObject <MetaCommandBackend>
@end

@interface FixtureObserver : MetaNativeObserver
@end
@implementation FixtureObserver
- (BOOL)start { return YES; }
- (void)stop {}
- (void)setEventSink:(MetaObserverEventSink)sink {
  [super setEventSink:sink];
  if (sink != nil) [self recordInputFromPid:1234 syntheticTag:0];
}
@end

@implementation CaptureCommandLoopBackend {
  FakeCaptureBackend _fake;
  MetaCaptureRouter *_router;
  MetaInputExecutor *_executor;
  MetaBrokerCore *_core;
  MetaCaptureCommandBinder *_binder;
  MetaObserverCommandBinder *_observerBinder;
  MetaDisplayRecord _displays[2];
  MetaInventorySnapshot _snapshot;
  NSLock *_lock;
  NSMutableSet<NSString *> *_pending;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    MetaCaptureRouterBackend capture_backend = {
        .context = &_fake,
        .start = fake_start,
        .cancel = fake_cancel,
        .status = fake_status,
        .release_task = fake_release_task,
        .release_result = fake_release_result,
        .compose_layout = fake_compose_layout,
    };
    _router = meta_capture_router_create("native-1", capture_backend);
    MetaExecutorBackend sink = {
        .post_held_event = fake_post_held,
        .post_cleanup_up = fake_cleanup_up,
    };
    _executor = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-1"
                      sink:sink
                    verify:^BOOL(__unused NSString *target) {
                      return YES;
                    }];
    _core = meta_broker_core_create([_executor executorOnActionWorker], _router);
    _displays[0] = (MetaDisplayRecord){
        .display_id = 10,
        .bounds = {.x = -1, .y = 0, .width = 1, .height = 1},
        .usable_bounds = {.x = -1, .y = 0, .width = 1, .height = 1},
        .scale = 1,
        .main = true,
    };
    snprintf(_displays[0].display_ref, sizeof(_displays[0].display_ref), "%s",
             "display-1");
    _displays[1] = (MetaDisplayRecord){
        .display_id = 20,
        .bounds = {.x = 0, .y = 0, .width = 1, .height = 1},
        .usable_bounds = {.x = 0, .y = 0, .width = 1, .height = 1},
        .scale = 2,
    };
    snprintf(_displays[1].display_ref, sizeof(_displays[1].display_ref), "%s",
             "display-2");
    _snapshot = (MetaInventorySnapshot){
        .revision = 1,
        .display_layout_revision = 1,
        .captured_at_micros = 1789466400000000ULL,
        .complete = true,
        .displays = _displays,
        .display_count = 2,
    };
    snprintf(_snapshot.inventory_id, sizeof(_snapshot.inventory_id), "%s",
             "inventory-1");
    snprintf(_snapshot.layout_ref, sizeof(_snapshot.layout_ref), "%s",
             "layout-1");
    snprintf(_snapshot.native_generation,
             sizeof(_snapshot.native_generation), "%s", "native-1");
    _binder = [[MetaCaptureCommandBinder alloc]
        initWithRouter:_router
        inventoryProvider:^const MetaInventorySnapshot * {
          return &self->_snapshot;
        }
        nativeGeneration:@"native-1"
        nativeBuildId:@"capture-loop-build"];
    _lock = [[NSLock alloc] init];
    _pending = [NSMutableSet set];
    if (_router == NULL || _executor == nil || _core == NULL ||
        _binder == nil) return nil;
  }
  return self;
}

- (void)dealloc {
  meta_broker_core_destroy(_core);
  meta_capture_router_destroy(_router);
}

- (NSDictionary *)sessionIdentity {
  return @{
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"verified" : @NO,
    @"reason" : @"Fake command-loop session",
  };
}

- (NSDictionary *)permissions {
  return @{
    @"accessibility" : @NO,
    @"postEvents" : @NO,
    @"screenRecording" : @NO,
  };
}

- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }

- (NSDictionary *)observer:(NSDictionary *)request {
  if (_observerBinder == nil) {
    NSDictionary *generation = @{@"runtimeEpoch": @"runtime-1", @"loginSessionId": @"login-1", @"nativeGeneration": @"native-1"};
    _observerBinder = [[MetaObserverCommandBinder alloc] initWithGeneration:generation nativeBuildId:@"capture-loop-build"
      indexBuilder:^MetaObserverPreparedIndex * {
        return meta_observer_prepared_index_create([[MetaObserverTargetIndex alloc] init], @"inventory-fixture", 1, 1);
      }
      mainExecutor:^BOOL(BOOL (^work)(void)) { return work(); }
      factory:^MetaNativeObserver *(NSDictionary *identity, __unused MetaObserverTargetIndex *index) {
        return [[FixtureObserver alloc] initWithGeneration:identity];
      }
      readinessProvider:^NSDictionary * {
        return @{@"state": @"unknown", @"lockState": @"unknown", @"secureInput": @"unknown",
          @"evidence": @"Изолированная fixture", @"observedAt": @"2026-09-15T10:00:00.000Z"};
      }
      instanceIdProvider:^NSString * { return @"observer-fixture-1"; }];
  }
  return [_observerBinder handleRequest:request];
}
- (BOOL)activateObserverPush:(NSString *)instanceRef { return [_observerBinder activatePushForObserverInstance:instanceRef]; }
- (NSDictionary *)takeObserverPush:(NSUInteger)maximum { return [_observerBinder takePushEnvelopes:maximum]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }

- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  NSDictionary *target = operation[@"target"];
  BOOL layout = [target[@"kind"] isEqual:@"desktop-layout"];
  NSString *target_ref = layout ? target[@"ref"][@"layoutRef"]
                                : target[@"ref"][@"displayRef"];
  BOOL exact_target = layout ? [target_ref isEqual:@"layout-1"]
                             : [target[@"kind"] isEqual:@"display"] &&
                               [target_ref isEqual:@"display-1"];
  if (!exact_target ||
      ![operation[@"inventoryId"] isEqual:@"inventory-1"] ||
      ![operation[@"inventoryRevision"] isEqual:@1]) {
    return @{
      @"nativeError" : @{
        @"code" : @"invalid-request",
        @"message" : [NSString stringWithFormat:
            @"Fixture target mismatch kind=%@ ref=%@ inventory=%@ revision=%@",
            target[@"kind"], target_ref, operation[@"inventoryId"],
            operation[@"inventoryRevision"]],
        @"retryable" : @NO,
        @"stage" : @"native-execute",
        @"replayAllowed" : @NO,
        @"recoveryAction" : @"inspect-health",
      },
    };
  }
  __block NSError *capture_error = nil;
  NSDictionary *execution = [_executor
      executeExternal:request
                 job:job
           targetRef:target_ref
              verify:^BOOL(NSString *value) {
                return [value isEqual:target_ref];
              }
              action:^NSDictionary * {
                return [self->_binder startRequest:request error:&capture_error];
              }];
  if (execution == nil) {
    MetaExecutorStatus status = meta_executor_status(
        [_executor executorOnActionWorker]);
    return @{
      @"nativeError" : @{
        @"code" : @"internal-error",
        @"message" : [NSString stringWithFormat:
            @"Fixture external gate rejected layout=%d fence=%llu state=%d quarantined=%d",
            layout, (unsigned long long)[operation[@"fence"][@"counter"]
                unsignedLongLongValue], status.execution, status.quarantined],
        @"retryable" : @NO,
        @"stage" : @"native-execute",
        @"replayAllowed" : @NO,
        @"recoveryAction" : @"inspect-health",
      },
    };
  }
  NSDictionary *value = execution[@"value"];
  if (value == nil && capture_error != nil) {
    return @{
      @"nativeError" : @{
        @"code" : @"invalid-request",
        @"message" : capture_error.localizedDescription,
        @"retryable" : @NO,
        @"stage" : @"native-execute",
        @"replayAllowed" : @NO,
        @"recoveryAction" : @"inspect-health",
      },
    };
  }
  if (value != nil) {
    [_lock lock];
    [_pending addObject:operation[@"operationId"]];
    [_lock unlock];
  }
  return value;
}

- (NSDictionary *)cleanupCapture:(NSDictionary *)request
                       emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary {
  NSError *error = nil;
  NSDictionary *result = [_binder cleanupRequest:request
                                      emitBinary:emitBinary
                                           error:&error];
  if ([request[@"control"][@"purpose"] isEqual:@"release"] &&
      [result[@"ack"][@"cleanup"] isEqual:@"complete"]) {
    [_lock lock];
    [_pending removeObject:request[@"control"][@"operationId"]];
    [_lock unlock];
  }
  return result;
}

- (NSDictionary *)supplementStatus:(NSDictionary *)status {
  NSString *operation_id = status[@"operationId"];
  if (![operation_id isKindOfClass:NSString.class]) return status;
  MetaCaptureOperationTaskRecord records[8] = {0};
  size_t count = meta_capture_router_operation_tasks(
      _router, operation_id.UTF8String, records, 8);
  bool pending = count > 8;
  for (size_t index = 0; index < MIN(count, 8); index += 1) {
    if (!records[index].released &&
        (!records[index].status.drained ||
         records[index].status.cleanup != MetaCaptureCleanupComplete)) {
      pending = true;
    }
  }
  if (!pending) return status;
  NSMutableDictionary *value = [status mutableCopy];
  value[@"cleanup"] = @"unknown";
  value[@"quarantined"] = @YES;
  value[@"restorationAllowed"] = @NO;
  return value;
}

- (NSDictionary *)reconcileStatus:(NSDictionary *)status {
  return [self supplementStatus:status];
}

- (NSArray<NSString *> *)pendingOperationIds {
  [_lock lock];
  NSArray *result = _pending.allObjects;
  [_lock unlock];
  return result;
}

- (NSDictionary *)cancel:(NSDictionary *)request {
  NSDictionary *source = request[@"fence"];
  MetaFence fence = {.counter = [source[@"counter"] unsignedLongLongValue]};
  snprintf(fence.runtime_epoch, sizeof(fence.runtime_epoch), "%s",
           [source[@"runtimeEpoch"] UTF8String]);
  snprintf(fence.login_session_id, sizeof(fence.login_session_id), "%s",
           [source[@"loginSessionId"] UTF8String]);
  snprintf(fence.native_generation, sizeof(fence.native_generation), "%s",
           [source[@"nativeGeneration"] UTF8String]);
  meta_broker_core_cancel_operation(_core,
                                    [request[@"operationId"] UTF8String],
                                    fence);
  return nil;
}

- (BOOL)beginRotation {
  return meta_broker_core_begin_rotation(_core) == META_BROKER_ROTATION_READY;
}

@end

int main(void) {
  @autoreleasepool {
    CaptureCommandLoopBackend *backend = [[CaptureCommandLoopBackend alloc] init];
    if (backend == nil) return 70;
    return meta_command_loop_run(backend, @"capture-loop-build", @"/tmp/capture-loop-fixture",
                                 @"native-1", STDIN_FILENO, STDOUT_FILENO);
  }
}
