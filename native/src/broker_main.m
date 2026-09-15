#include "meta_command_loop.h"
#include "meta_broker_core.h"
#include "meta_macos.h"
#include "meta_ledger.h"
#include "meta_serialization.h"
#include "meta_input_executor.h"
#include "meta_macos_input.h"
#include "meta_session_identity.h"
#include "clipboard/meta_clipboard.h"
#include "accessibility/meta_ax_inspector.h"
#include "meta_ax_request.h"
#include "code-identity/meta_code_identity.h"
#include "window-actions/meta_window_actions.h"
#include "window-actions/meta_window_readback.h"
#include "window-actions/meta_window_result.h"
#include "input-target/meta_point_target.h"
#include "input-target/meta_geometry_probe.h"
#include "application-command/meta_application_command.h"
#include "session-state/meta_session_state.h"
#include "capture-command/meta_capture_command.h"
#include "hit-test/meta_hit_test_binder.h"
#include "observer-command/meta_observer_command.h"
#include "observer-index/meta_observer_index_builder.h"
#include "recovery-probe/meta_recovery_probe.h"
#include "readiness-command/meta_readiness_system.h"
#include "input-observer/meta_input_observer_binding.h"
#include "cursor-display/meta_cursor_display.h"
#include "ax-actions/meta_ax_retained_snapshot.h"
#include "ax-actions/meta_ax_press.h"
#include "recovery-domain/meta_recovery_domain.h"
#include "domain-recovery/meta_domain_recovery.h"
#include "view-admission/meta_view_admission.h"
#include "permissions-request/meta_permissions_request.h"
#include <time.h>
#include <math.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

#ifndef META_NATIVE_BUILD_ID
#error META_NATIVE_BUILD_ID must identify the compiled artifact
#endif
#ifndef META_NATIVE_INSTALL_ROOT
#error META_NATIVE_INSTALL_ROOT must identify the canonical installation
#endif

@interface MetaSystemCommandBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithGeneration:(NSString *)generation;
- (NSDictionary *)applicationRecord:(NSDictionary *)reference;
- (BOOL)ensureApplications:(NSDictionary *)request;
- (NSDictionary *)recoveryInfo;
- (BOOL)inputRiskAllowed:(MetaInputPrimitiveRisk)risk code:(uint32_t)code;
@end

@interface MetaInspectionBorrowContext : NSObject
@property(nonatomic, strong) NSDictionary *request;
@property(nonatomic, strong) NSDictionary *result;
@property(nonatomic, strong) NSString *snapshotId;
@property(nonatomic, strong) MetaAXRetainedSnapshotRegistry *registry;
@end
@implementation MetaInspectionBorrowContext
@end

@interface MetaObserverBorrowContext : NSObject
@property(nonatomic, strong) NSDictionary *generation;
@property(nonatomic, strong) MetaObserverTargetRecord *record;
@end
@implementation MetaObserverBorrowContext
@end

@interface MetaObserverIndexBuildContext : NSObject
@property(nonatomic) MetaMacOSBackend *windows;
@property(nonatomic, strong) NSDictionary *generation;
@property(nonatomic, strong) NSString *failureReason;
@property(nonatomic, strong) NSString *failureStage;
@property(nonatomic) BOOL failureTransient;
@end
@implementation MetaObserverIndexBuildContext
@end

static bool observer_borrowed(void *context, const MetaAXTargetBorrow *borrow) {
  MetaObserverBorrowContext *binding = (__bridge MetaObserverBorrowContext *)context;
  binding.record = meta_observer_target_record_create(borrow, binding.generation[@"runtimeEpoch"],
      binding.generation[@"loginSessionId"], binding.generation[@"nativeGeneration"]);
  return binding.record != nil;
}

static uint64_t observer_index_now(void *context) {
  (void)context;
  return (uint64_t)(NSProcessInfo.processInfo.systemUptime * 1000.0);
}

static NSDictionary *capture_native_error(NSError *error) {
  NSString *code = @"internal-error";
  NSString *recovery = @"inspect-health";
  if ([error.domain isEqual:MetaCaptureCommandErrorDomain]) {
    if (error.code == MetaCaptureCommandInvalidRequest) {
      code = @"invalid-request";
      recovery = @"none";
    } else if (error.code == MetaCaptureCommandStaleAuthority) {
      code = @"target-stale";
      recovery = @"refresh-inventory";
    } else if (error.code == MetaCaptureCommandUnsupportedTarget) {
      code = @"unsupported-capability";
      recovery = @"none";
    } else if (error.code == MetaCaptureCommandBinaryFailure) {
      code = @"binary-frame-mismatch";
    }
  }
  return @{
    @"code" : code,
    @"message" : error.localizedDescription ?: @"Native capture command failed",
    @"stage" : @"capture-start",
    @"retryable" : @NO,
    @"replayAllowed" : @NO,
    @"recoveryAction" : recovery,
  };
}

static NSDictionary *capture_start_error(NSString *code, NSString *message,
                                         NSString *recovery) {
  return @{
    @"code" : code,
    @"message" : message,
    @"stage" : @"capture-start",
    @"retryable" : @NO,
    @"replayAllowed" : @NO,
    @"recoveryAction" : recovery,
  };
}

static bool observer_index_refresh(void *context, uint64_t budget) {
  MetaObserverIndexBuildContext *binding =
      (__bridge MetaObserverIndexBuildContext *)context;
  return meta_macos_refresh_inventory(binding.windows, budget);
}

static const MetaInventorySnapshot *observer_index_snapshot(void *context) {
  MetaObserverIndexBuildContext *binding =
      (__bridge MetaObserverIndexBuildContext *)context;
  return meta_macos_backend_snapshot(binding.windows);
}

static bool observer_index_snapshot_ready(
    void *context, const MetaInventorySnapshot *snapshot) {
  MetaObserverIndexBuildContext *binding =
      (__bridge MetaObserverIndexBuildContext *)context;
  return meta_macos_observer_snapshot_ready(binding.windows, snapshot);
}

static bool observer_index_snapshot_diagnostics(
    void *context, const MetaInventorySnapshot *snapshot,
    MetaObserverSnapshotDiagnostics *diagnostics) {
  MetaObserverIndexBuildContext *binding =
      (__bridge MetaObserverIndexBuildContext *)context;
  return meta_macos_observer_snapshot_diagnostics(
      binding.windows, snapshot, diagnostics);
}

static MetaObserverTargetRecord *observer_index_record(
    void *context, const MetaWindowRecord *window,
    const MetaInventorySnapshot *snapshot, NSDictionary *generation) {
  MetaObserverIndexBuildContext *builder =
      (__bridge MetaObserverIndexBuildContext *)context;
  MetaObserverBorrowContext *binding = [[MetaObserverBorrowContext alloc] init];
  binding.generation = generation;
  MetaAXBorrowStatus status = meta_macos_with_ax_target(
      builder.windows, window->target_ref, snapshot->inventory_id,
      snapshot->revision, snapshot->native_generation, observer_borrowed,
      (__bridge void *)binding);
  return status == META_AX_BORROW_OK ? binding.record : nil;
}

static bool inspect_borrowed(void *context, const MetaAXTargetBorrow *borrow) {
  MetaInspectionBorrowContext *binding = (__bridge MetaInspectionBorrowContext *)context;
  MetaAXInspectionContext request = {0};
  if (!meta_ax_build_request(borrow, binding.request, binding.snapshotId, &request)) return false;
  NSMutableDictionary *elements = [NSMutableDictionary dictionary];
  binding.result = meta_ax_inspect_borrowed_element_and_observer(borrow->element, request,
    ^BOOL(NSString *elementRef, id element, NSArray<NSString *> *actions) {
      (void)actions;
      if (elements.count >= 1500 || elements[elementRef] != nil || element == nil) return NO;
      elements[elementRef] = element;
      return YES;
    });
  if (binding.result != nil && ![binding.registry publishTarget:binding.request[@"payload"][@"target"]
      inventoryId:@(borrow->inventory_id) inventoryRevision:borrow->inventory_revision
      snapshotId:binding.snapshotId nodes:binding.result[@"nodes"] borrowedElements:elements]) {
    binding.result = nil;
  }
  return binding.result != nil;
}

static bool consume_borrow_block(void *context, const MetaAXTargetBorrow *borrow) {
  return ((__bridge BOOL (^)(const MetaAXTargetBorrow *))context)(borrow);
}

static uint64_t native_millis(void) {
  struct timespec now = {0};
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static BOOL unsigned_json_number(id value) {
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
      isfinite([value doubleValue]) && [value doubleValue] >= 0 && [value doubleValue] <= 9007199254740991.0 &&
      [value doubleValue] == [value unsignedLongLongValue];
}

static BOOL exact_application_priority(
    const MetaInventorySnapshot *snapshot,
    NSString *applicationRef,
    int32_t expectedPid,
    MetaInventoryPriority *priority) {
  if (snapshot == NULL || ![applicationRef isKindOfClass:NSString.class] ||
      priority == NULL) return NO;
  const MetaApplicationRecord *match = NULL;
  for (size_t index = 0; index < snapshot->application_count; index += 1) {
    const MetaApplicationRecord *candidate = &snapshot->applications[index];
    if ([applicationRef isEqual:@(candidate->application_ref)] &&
        (expectedPid <= 0 || candidate->pid == expectedPid)) {
      if (match != NULL) return NO;
      match = candidate;
    }
  }
  if (match == NULL || match->pid <= 0 || match->launch_time_micros == 0) {
    return NO;
  }
  *priority = (MetaInventoryPriority){
      .has_pid = true,
      .pid = match->pid,
      .has_launch_time = true,
      .launch_time_micros = match->launch_time_micros,
  };
  return YES;
}

static bool verify_window_borrow(void *context, const MetaAXTargetBorrow *borrow) {
  const MetaWindowRecord *original = context;
  return borrow->target.surface_kind == META_SURFACE_WINDOW && original->pid == borrow->target.pid &&
      strcmp(original->application_ref, borrow->target.application_ref) == 0 &&
      strcmp(original->window_ref, borrow->target.window_ref) == 0;
}

typedef struct { double x; double y; const MetaInventorySnapshot *snapshot; MetaMacOSBackend *backend; const char *application; const char *owner; bool surface; MetaPointTargetRelation relation; bool geometryMismatch; } MetaPointCheck;
static bool verify_point_borrow(void *context, const MetaAXTargetBorrow *borrow) {
  MetaPointCheck *point = context;
  if (point->application == NULL || strcmp(point->application, borrow->target.application_ref) != 0 ||
      (point->surface ? borrow->target.surface_kind == META_SURFACE_WINDOW : borrow->target.surface_kind != META_SURFACE_WINDOW) ||
      (point->surface && (point->owner == NULL || strcmp(point->owner, borrow->target.owner_window_ref) != 0))) return false;
  MetaBorrowedGeometryProbe geometry = {0};
  if (!meta_macos_probe_borrowed_geometry(point->backend, borrow, point->snapshot, &geometry)) return false;
  if (!geometry.frame_unchanged || !geometry.topology_unchanged) { point->geometryMismatch = true; return false; }
  point->relation = meta_point_relation_to_borrow(borrow, point->x, point->y);
  return point->relation != META_POINT_TARGET_RELATION_NONE;
}

static NSDictionary *application_value(const MetaApplicationRecord *record) {
  if (record == NULL) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return @{@"applicationRef": @(record->application_ref), @"registrationNonce": @(record->registration_nonce),
    @"pid": @(record->pid), @"bundleId": @(record->bundle_id), @"launchTimeMicros": @(record->launch_time_micros),
    @"launchedAt": [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:(double)record->launch_time_micros / 1000000.0]]};
}

static BOOL session_allows_input(NSString *loginSessionId) {
  NSDictionary *session = meta_current_session_readiness(loginSessionId);
  return [session[@"state"] isEqual:@"active-console"] && [session[@"secureInput"] isEqual:@"off"] &&
      ![session[@"lockState"] isEqual:@"locked"];
}

static bool contains_point(MetaRect bounds, double x, double y) {
  return isfinite(x) && isfinite(y) && x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
}

static bool dispatch_block(void *context) { return ((__bridge BOOL (^)(void))context)(); }

static NSDictionary *unknown_launch_value(NSString *reason, NSDictionary *candidate) {
  NSMutableDictionary *value = [@{@"state": @"unknown", @"reason": reason, @"errors": @[@{
    @"code": @"operation-outcome-unknown", @"message": reason, @"stage": @"application-launch", @"retryable": @NO,
    @"replayAllowed": @NO, @"recoveryAction": @"get-operation"}]} mutableCopy];
  if (candidate != nil) value[@"candidate"] = candidate;
  return value;
}

static bool recovery_readiness(void *context, MetaRecoveryReadiness *output) {
  NSDictionary *facts = [(__bridge MetaSystemCommandBackend *)context recoveryInfo];
  if (facts == nil) return false;
  output->input_monitoring = [facts[@"inputMonitoring"] boolValue];
  output->observer_ready = [facts[@"observerReady"] boolValue];
  output->session_state = [facts[@"sessionState"] isEqual:@"active-console"] ? MetaRecoverySessionStateActiveConsole :
      [facts[@"sessionState"] isEqual:@"inactive"] ? MetaRecoverySessionStateInactive : MetaRecoverySessionStateUnknown;
  output->lock_state = [facts[@"lockState"] isEqual:@"locked"] ? MetaRecoveryLockStateLocked : MetaRecoveryLockStateUnknown;
  output->secure_input = [facts[@"secureInput"] isEqual:@"off"] ? MetaRecoverySecureInputStateOff :
      [facts[@"secureInput"] isEqual:@"on"] ? MetaRecoverySecureInputStateOn : MetaRecoverySecureInputStateUnknown;
  return true;
}

static bool input_risk(void *context, MetaInputPrimitiveRisk risk, uint32_t code) {
  return [(__bridge MetaSystemCommandBackend *)context inputRiskAllowed:risk code:code];
}

@implementation MetaSystemCommandBackend {
  MetaMacOSBackend *_windows;
  MetaCaptureRouter *_captures;
  MetaBrokerCore *_core;
  MetaCaptureCommandBinder *_captureCommands;
  MetaObserverCommandBinder *_observerCommands;
  MetaViewAdmissionController *_viewAdmissions;
  MetaPermissionsRequestController *_permissionRequests;
  NSDictionary *_observerRequest;
  NSString *_observerInstance;
  NSDate *_observerMainDeadline;
  NSDictionary *_recoveryRequest;
  NSLock *_asyncLock;
  NSMutableSet<NSString *> *_captureOperationIds;
  NSMutableDictionary<NSString *, NSString *> *_applicationTaskRefs;
  MetaMacOSInput *_input;
  MetaInputExecutor *_inputExecutor;
  MetaAXRetainedSnapshotRegistry *_axSnapshots;
  NSDictionary *_activeInputRecoveryDescriptor;
  MetaApplicationBundles *_bundles;
  MetaApplicationCommandBinder *_applications;
  MetaApplicationBackend _applicationBackend;
  NSString *_inputLoginSession;
  BOOL _sealed;
}

- (instancetype)initWithGeneration:(NSString *)generation {
  self = [super init];
  if (self) {
    _windows = meta_macos_backend_create(generation.UTF8String);
    _asyncLock = [[NSLock alloc] init];
    _captureOperationIds = [NSMutableSet set];
    _applicationTaskRefs = [NSMutableDictionary dictionary];
    _captures = meta_capture_router_create(generation.UTF8String, meta_capture_router_default_backend());
    _input = meta_macos_input_create();
    _permissionRequests = [[MetaPermissionsRequestController alloc] initWithBackend:meta_permissions_system_backend()];
    if (!meta_macos_input_set_risk_validator(_input, (__bridge void *)self, input_risk)) return nil;
    _axSnapshots = [[MetaAXRetainedSnapshotRegistry alloc] initWithClock:^uint64_t { return native_millis(); }
      ttlMillis:120000 maxSnapshots:64 maxNodes:1500];
    _applicationBackend = meta_application_system_backend();
    MetaExecutorBackend sink = {.context = _input, .post_held_event = meta_macos_input_post_held,
      .post_text_cluster = meta_macos_input_post_text, .set_event_flags = meta_macos_input_set_flags,
      .post_pointer_event = meta_macos_input_post_pointer, .post_scroll_event = meta_macos_input_post_scroll,
      .post_cleanup_up = meta_macos_input_post_cleanup_up};
    MetaMacOSBackend *windows = _windows;
    __weak MetaSystemCommandBackend *weakSelf = self;
    _inputExecutor = [[MetaInputExecutor alloc] initWithGeneration:generation sink:sink verify:^BOOL(NSString *target) {
      MetaSystemCommandBackend *owner = weakSelf;
      return owner != nil && session_allows_input(owner->_inputLoginSession) && meta_macos_input_preflight() && meta_macos_target_is_focused(windows, target.UTF8String);
    }];
    [_inputExecutor setScopedPointVerifier:^BOOL(NSDictionary *target, double x, double y) {
      const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(windows);
      NSDictionary *ref = target[@"ref"];
      if (snapshot == NULL || ![ref isKindOfClass:NSDictionary.class] || ![ref[@"nativeGeneration"] isEqual:@(snapshot->native_generation)] ||
          !session_allows_input(ref[@"loginSessionId"]) || !meta_macos_input_preflight()) return NO;
      BOOL display = [target[@"kind"] isEqual:@"display"];
      BOOL layout = [target[@"kind"] isEqual:@"desktop-layout"];
      if (display || layout) {
        if ([ref[@"displayLayoutRevision"] unsignedLongLongValue] != snapshot->display_layout_revision ||
            (layout && ![ref[@"layoutRef"] isEqual:@(snapshot->layout_ref)])) return NO;
        BOOL contained = NO;
        for (size_t index = 0; index < snapshot->display_count; index += 1) {
          const MetaDisplayRecord *candidate = &snapshot->displays[index];
          if ((layout || [ref[@"displayRef"] isEqual:@(candidate->display_ref)]) && contains_point(candidate->bounds, x, y)) contained = YES;
        }
        MetaTopologyProbe topology = {0};
        return contained && meta_macos_probe_topology(windows, snapshot, &topology) && topology.topology_unchanged;
      }
      if (![@[@"window", @"surface"] containsObject:target[@"kind"]]) return NO;
      NSString *targetRef = [target[@"kind"] isEqual:@"window"] ? ref[@"windowRef"] : ref[@"surfaceRef"];
      if (![targetRef isKindOfClass:NSString.class]) return NO;
      if (![ref[@"applicationRef"] isKindOfClass:NSString.class]) return NO;
      BOOL surface = [target[@"kind"] isEqual:@"surface"];
      if (surface && ![ref[@"ownerWindowRef"] isKindOfClass:NSString.class]) return NO;
      MetaPointCheck point = {.x = x, .y = y, .snapshot = snapshot, .backend = windows, .application = [ref[@"applicationRef"] UTF8String],
        .owner = surface ? [ref[@"ownerWindowRef"] UTF8String] : NULL, .surface = surface};
      return meta_macos_with_ax_target(windows, targetRef.UTF8String, snapshot->inventory_id, snapshot->revision,
          snapshot->native_generation, verify_point_borrow, &point) == META_AX_BORROW_OK;
    }];
    _core = meta_broker_core_create([_inputExecutor executorOnActionWorker], _captures);
    _captureCommands = [[MetaCaptureCommandBinder alloc] initWithRouter:_captures inventoryProvider:^const MetaInventorySnapshot * {
      return meta_macos_backend_snapshot(windows);
    } topologyValidator:^BOOL(const MetaInventorySnapshot *snapshot) {
      MetaTopologyProbe topology = {0};
      return meta_macos_probe_topology(windows, snapshot, &topology) && topology.topology_unchanged;
    } nativeGeneration:generation nativeBuildId:@META_NATIVE_BUILD_ID];
    if (_windows == NULL || _captures == NULL || _input == NULL || _inputExecutor == nil || _core == NULL || _captureCommands == nil || _axSnapshots == nil || _permissionRequests == nil) return nil;
  }
  return self;
}

- (void)dealloc {
  _captureCommands = nil;
  meta_broker_core_destroy(_core);
  _inputExecutor = nil;
  meta_macos_input_destroy(_input);
  meta_macos_backend_destroy(_windows);
  meta_capture_router_destroy(_captures);
}

- (NSDictionary *)permissions {
  NSMutableDictionary *result = [@{@"accessibility": AXIsProcessTrusted() ? @YES : @NO, @"postEvents": CGPreflightPostEventAccess() ? @YES : @NO,
           @"screenRecording": meta_capture_preflight_screen_recording() ? @YES : @NO,
           @"inputMonitoring": CGPreflightListenEventAccess() ? @YES : @NO} mutableCopy];
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  NSDictionary *identity = meta_code_identity_read(&failure);
  if (identity != nil) result[@"codeIdentity"] = identity;
  return result;
}

- (NSDictionary *)permissionsRequest:(NSDictionary *)request {
  return [_permissionRequests handleCommand:request[@"command"]];
}
- (BOOL)sealPermissionRequests { return [_permissionRequests seal]; }

- (NSString *)recoveryDomainVersion { return @"1"; }
- (NSString *)viewAdmissionVersion { return @"1"; }
- (BOOL)validateRecoveryRequest:(NSDictionary *)request {
  return meta_recovery_domain_validate_request(request, @META_NATIVE_BUILD_ID, NULL, NULL);
}
- (BOOL)prepareInputRisk:(NSDictionary *)request {
  _activeInputRecoveryDescriptor = nil;
  NSDictionary *descriptor = nil;
  if (!meta_recovery_domain_validate_request(request, @META_NATIVE_BUILD_ID, &descriptor, NULL)) return NO;
  _activeInputRecoveryDescriptor = descriptor;
  return YES;
}
- (BOOL)inputRiskAllowed:(MetaInputPrimitiveRisk)risk code:(uint32_t)code {
  if (_activeInputRecoveryDescriptor == nil) return NO;
  if (risk == META_INPUT_RISK_NO_HELD_INPUT) return YES;
  NSString *kind = risk == META_INPUT_RISK_KEY ? @"key" : risk == META_INPUT_RISK_BUTTON ? @"button" : nil;
  if (kind == nil) return NO;
  for (NSDictionary *hold in _activeInputRecoveryDescriptor[@"possibleHolds"]) {
    if ([hold[@"kind"] isEqual:kind] && [hold[@"code"] unsignedIntValue] == code) return YES;
  }
  return NO;
}

- (NSArray<NSDictionary *> *)capabilityCatalog {
  // Handshake описывает подключённые handlers. TCC, session и текущая observer
  // coverage проверяются отдельно в permissions и перед действием.
  NSMutableArray *capabilities = [NSMutableArray array];
  for (NSString *identifier in @[@"runtime.identity", @"runtime.transport", @"desktop.applications",
      @"desktop.windows.all", @"desktop.window.identity", @"desktop.window.show", @"desktop.window.lifecycle",
      @"desktop.displays", @"desktop.ax", @"capture.window", @"capture.desktop", @"capture.observation", @"input.clipboard", @"input.readiness", @"desktop.application.lifecycle",
      @"input.pointer", @"input.drag", @"input.keyboard", @"runtime.user-interference"]) {
    [capabilities addObject:@{@"id": identifier, @"state": @"ready"}];
  }
  [capabilities addObject:@{@"id": @"input.interaction", @"state": @"unavailable",
    @"reason": @"Native beginFocus/endRestore и STEP association ещё не подключены"}];
  return capabilities;
}

- (NSDictionary *)sessionIdentity {
  MetaSessionIdentity session = meta_session_identity_read();
  NSMutableDictionary *value = [@{@"source": @"darwin-audit", @"uid": @(session.uid),
    @"effectiveUid": @(session.effective_uid), @"verified": session.verified ? @YES : @NO} mutableCopy];
  if (session.verified) {
    value[@"auditUserId"] = @(session.audit_user_id);
    value[@"auditSessionId"] = @(session.audit_session_id);
  } else value[@"reason"] = [NSString stringWithFormat:@"Darwin audit identity недоступна: errno=%d", session.error_number];
  return value;
}

- (NSDictionary *)inventoryRequest:(NSDictionary *)request {
  NSDictionary *payload = request[@"payload"];
  if (![payload isKindOfClass:NSDictionary.class] || payload.count > 1 ||
      (payload.count == 1 && payload[@"priority"] == nil)) return nil;
  NSDictionary *hint = payload[@"priority"];
  MetaInventoryPriority priority = {0};
  const MetaInventoryPriority *selected = NULL;
  if (hint != nil) {
    if (![hint isKindOfClass:NSDictionary.class] || hint.count == 0 ||
        hint.count > 3) return nil;
    NSSet *allowed = [NSSet setWithArray:@[@"app", @"pid", @"applicationRef"]];
    for (id key in hint) if (![key isKindOfClass:NSString.class] ||
                             ![allowed containsObject:key]) return nil;
    NSString *applicationRef = hint[@"applicationRef"];
    NSString *app = hint[@"app"];
    NSNumber *pid = hint[@"pid"];
    if ((app != nil && (![app isKindOfClass:NSString.class] || app.length == 0 || app.length > 1024)) ||
        (pid != nil && (!unsigned_json_number(pid) || pid.unsignedLongLongValue == 0 ||
                        pid.unsignedLongLongValue > INT32_MAX)) ||
        (applicationRef != nil && (![applicationRef isKindOfClass:NSString.class] ||
                                   applicationRef.length == 0 || applicationRef.length >= META_NATIVE_REF_CAPACITY))) return nil;
    if (applicationRef != nil) {
      const MetaInventorySnapshot *current = meta_macos_backend_snapshot(_windows);
      BOOL exact = exact_application_priority(current, applicationRef,
                                              pid == nil ? 0 : pid.intValue,
                                              &priority);
      if (exact && app != nil) {
        const MetaApplicationRecord *record = NULL;
        for (size_t index = 0; index < current->application_count; index += 1) {
          if (current->applications[index].pid == priority.pid &&
              current->applications[index].launch_time_micros == priority.launch_time_micros) {
            record = &current->applications[index];
            break;
          }
        }
        exact = record != NULL && [app isEqual:@(record->name)];
      }
      if (!exact) {
        priority = (MetaInventoryPriority){.has_pid = true, .pid = INT32_MIN};
      }
    } else {
      if (pid != nil) { priority.has_pid = true; priority.pid = pid.intValue; }
      if (app != nil) priority.name = app.UTF8String;
    }
    selected = &priority;
  }
  if (_sealed || !meta_macos_refresh_inventory_with_priority(
                     _windows, 5000, selected)) return nil;
  NSString *source = [@"native-response-" stringByAppendingString:NSUUID.UUID.UUIDString];
  CFDataRef data = meta_inventory_copy_json(meta_macos_backend_snapshot(_windows), source.UTF8String);
  if (data == NULL) return nil;
  NSDictionary *result = [NSJSONSerialization JSONObjectWithData:(__bridge NSData *)data options:0 error:NULL];
  CFRelease(data);
  return result;
}

- (NSDictionary *)inventory {
  return [self inventoryRequest:@{@"payload" : @{}}];
}

- (NSDictionary *)applicationRecord:(NSDictionary *)reference {
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (snapshot == NULL || ![reference isKindOfClass:NSDictionary.class]) return nil;
  for (size_t index = 0; index < snapshot->application_count; index += 1) {
    const MetaApplicationRecord *record = &snapshot->applications[index];
    if (![reference[@"applicationRef"] isEqual:@(record->application_ref)]) continue;
    NSDictionary *value = application_value(record);
    if (![value[@"pid"] isEqual:reference[@"pid"]] || ![value[@"launchedAt"] isEqual:reference[@"launchedAt"]] ||
        ![value[@"registrationNonce"] isEqual:reference[@"registrationNonce"]]) return nil;
    MetaApplicationProcess live = {0};
    if (_applicationBackend.lookup(_applicationBackend.context, record->pid, &live) != META_APPLICATION_LOOKUP_FOUND ||
        live.launch_time_micros != record->launch_time_micros || strcmp(live.bundle_id, record->bundle_id) != 0) return nil;
    return value;
  }
  return nil;
}

- (BOOL)ensureApplications:(NSDictionary *)request {
  if (_applications != nil) return YES;
  NSDictionary *generation = @{@"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"], @"nativeGeneration": request[@"nativeGeneration"]};
  _bundles = [[MetaApplicationBundles alloc] initWithGeneration:generation];
  MetaMacOSBackend *windows = _windows;
  __weak MetaSystemCommandBackend *weakSelf = self;
  _applications = [[MetaApplicationCommandBinder alloc] initWithGeneration:generation bundles:_bundles backend:_applicationBackend
    candidateResolver:^NSDictionary *(const MetaApplicationProcess *process, __unused NSDictionary *operation) {
      if (!meta_macos_refresh_inventory(windows, 5000)) return nil;
      const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(windows);
      if (snapshot == NULL) return nil;
      for (size_t index = 0; index < snapshot->application_count; index += 1) {
        const MetaApplicationRecord *record = &snapshot->applications[index];
        if (record->pid == process->pid && record->launch_time_micros == process->launch_time_micros && strcmp(record->bundle_id, process->bundle_id) == 0) return application_value(record);
      }
      return nil;
    } referenceResolver:^NSDictionary *(NSDictionary *reference) { return [weakSelf applicationRecord:reference]; }];
  return _applications != nil;
}

- (NSDictionary *)resolveApplication:(NSDictionary *)request {
  if (![self ensureApplications:request]) return nil;
  NSDictionary *inventory = [self inventory];
  if (inventory == nil) return nil;
  return [_applications resolve:request[@"payload"] evidence:@{@"sourceResponseRef": inventory[@"sourceResponseRef"],
    @"inventoryId": inventory[@"inventoryId"], @"inventoryRevision": inventory[@"revision"], @"observedAt": inventory[@"capturedAt"]}];
}

- (NSDictionary *)hitTest:(NSDictionary *)request {
  NSDictionary *generation = @{@"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"], @"nativeGeneration": request[@"nativeGeneration"]};
  MetaMacOSBackend *windows = _windows;
  MetaCaptureCommandBinder *captures = _captureCommands;
  MetaInputExecutor *input = _inputExecutor;
  __block BOOL geometryMismatch = NO;
  MetaHitTestCommandBinder *binder = [[MetaHitTestCommandBinder alloc] initWithGeneration:generation
    snapshotProvider:^const MetaInventorySnapshot * { return meta_macos_backend_snapshot(windows); }
    frameGeometryLookup:^NSDictionary *(NSString *frameRef) { return [captures lookupFrameGeometry:frameRef]; }
    pendingFenceValidator:^BOOL(NSDictionary *operation) {
      MetaExecutorStatus status = meta_executor_status([input executorOnActionWorker]);
      NSDictionary *fence = operation[@"fence"];
      if (status.quarantined || status.held_count > 0 || ![fence[@"counter"] isKindOfClass:NSNumber.class]) return NO;
      uint64_t counter = [fence[@"counter"] unsignedLongLongValue];
      if (status.has_high_water_fence) {
        if (![operation[@"runtimeEpoch"] isEqual:@(status.high_water_fence.runtime_epoch)] ||
            ![operation[@"loginSessionId"] isEqual:@(status.high_water_fence.login_session_id)] ||
            ![operation[@"nativeGeneration"] isEqual:@(status.high_water_fence.native_generation)]) return NO;
        if (counter <= status.high_water_fence.counter) return NO;
      }
      return counter > 0 && status.execution != META_EXECUTOR_DISPATCHING && status.execution != META_EXECUTOR_CANCELLING;
    }
    windowProbe:^MetaHitTestWindowRelation(NSDictionary *target, NSDictionary *destination, const MetaInventorySnapshot *snapshot) {
      NSDictionary *ref = target[@"ref"];
      BOOL surface = [target[@"kind"] isEqual:@"surface"];
      NSString *targetRef = surface ? ref[@"surfaceRef"] : ref[@"windowRef"];
      if (![targetRef isKindOfClass:NSString.class] || ![ref[@"applicationRef"] isKindOfClass:NSString.class] ||
          (surface && ![ref[@"ownerWindowRef"] isKindOfClass:NSString.class])) return MetaHitTestWindowRelationUnavailable;
      if (!meta_macos_target_is_focused(windows, targetRef.UTF8String)) return MetaHitTestWindowRelationNone;
      MetaPointCheck point = {.x = [destination[@"x"] doubleValue], .y = [destination[@"y"] doubleValue], .snapshot = snapshot, .backend = windows,
        .application = [ref[@"applicationRef"] UTF8String], .owner = surface ? [ref[@"ownerWindowRef"] UTF8String] : NULL, .surface = surface};
      MetaAXBorrowStatus borrowed = meta_macos_with_ax_target(windows, targetRef.UTF8String, snapshot->inventory_id, snapshot->revision,
          snapshot->native_generation, verify_point_borrow, &point);
      if (point.geometryMismatch) geometryMismatch = YES;
      if (borrowed != META_AX_BORROW_OK) return MetaHitTestWindowRelationUnavailable;
      if (!meta_macos_target_is_focused(windows, targetRef.UTF8String)) return MetaHitTestWindowRelationNone;
      return point.relation == META_POINT_TARGET_RELATION_EXACT ? MetaHitTestWindowRelationExact : MetaHitTestWindowRelationOwnedDescendant;
    }
    topologyProbe:^BOOL(const MetaInventorySnapshot *snapshot) {
      MetaTopologyProbe topology = {0};
      return meta_macos_probe_topology(windows, snapshot, &topology) && topology.topology_unchanged;
    }
    sessionReadinessProvider:^NSDictionary * { return meta_current_session_readiness(generation[@"loginSessionId"]); }];
  NSDictionary *result = [binder handleRequest:request];
  return geometryMismatch ? @{@"status": @"observation-stale", @"reason": @"Fresh geometry окна или topology не совпали с captured snapshot"} : result;
}

- (NSDictionary *)observer:(NSDictionary *)request {
  NSISO8601DateFormatter *deadlineFormatter = [[NSISO8601DateFormatter alloc] init];
  deadlineFormatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  _observerMainDeadline = [deadlineFormatter dateFromString:request[@"deadlineAt"]];
  if (_observerCommands == nil) {
    NSDictionary *generation = @{@"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"], @"nativeGeneration": request[@"nativeGeneration"]};
    MetaMacOSBackend *windows = _windows;
    __weak MetaSystemCommandBackend *weakSelf = self;
    __block uint64_t indexRevision = 0;
    MetaObserverIndexBuildContext *indexContext =
        [[MetaObserverIndexBuildContext alloc] init];
    indexContext.windows = windows;
    indexContext.generation = generation;
    MetaObserverIndexBuilderBackend indexBackend = {
        .context = (__bridge void *)indexContext,
        .monotonic_millis = observer_index_now,
        .refresh_inventory = observer_index_refresh,
        .snapshot = observer_index_snapshot,
        .snapshot_ready = observer_index_snapshot_ready,
        .snapshot_diagnostics = observer_index_snapshot_diagnostics,
        .record_for_window = observer_index_record,
    };
    MetaObserverIndexBuildContext *retainedIndexContext = indexContext;
    MetaObserverCommandBinder *binder = [[MetaObserverCommandBinder alloc] initWithGeneration:generation nativeBuildId:@META_NATIVE_BUILD_ID
      indexBuilder:^MetaObserverPreparedIndex * {
        (void)retainedIndexContext;
        MetaObserverIndexBuildDiagnostics diagnostics = {0};
        MetaObserverPreparedIndex *prepared =
            meta_observer_build_current_index(
                indexBackend, generation, ++indexRevision, &diagnostics);
        retainedIndexContext.failureReason = prepared == nil
            ? meta_observer_index_build_failure_reason(&diagnostics)
            : nil;
        switch (diagnostics.stage) {
          case MetaObserverIndexBuildStageRefreshFailed:
          case MetaObserverIndexBuildStageRefreshDeadline:
          case MetaObserverIndexBuildStageSnapshotUnavailable:
          case MetaObserverIndexBuildStageForegroundReceiptInvalid:
            retainedIndexContext.failureStage = @"inventory";
            retainedIndexContext.failureTransient = YES;
            break;
          case MetaObserverIndexBuildStageRecordFailed:
          case MetaObserverIndexBuildStageIndexDeadline:
          case MetaObserverIndexBuildStageIndexPublicationFailed:
            retainedIndexContext.failureStage = @"index";
            retainedIndexContext.failureTransient = YES;
            break;
          default:
            retainedIndexContext.failureStage = @"index";
            retainedIndexContext.failureTransient = NO;
            break;
        }
        return prepared;
      }
      mainExecutor:^BOOL(BOOL (^work)(void)) {
        if (NSThread.isMainThread) return work();
        MetaSystemCommandBackend *owner = weakSelf;
        NSTimeInterval remaining = owner == nil ? 0 : owner->_observerMainDeadline.timeIntervalSinceNow;
        if (remaining <= 0) return NO;
        __block BOOL completed = NO;
        __block BOOL cancelled = NO;
        NSLock *gate = [[NSLock alloc] init];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_main_queue(), ^{
          [gate lock]; BOOL skip = cancelled; [gate unlock];
          BOOL result = skip ? NO : work();
          [gate lock]; completed = result; [gate unlock];
          dispatch_semaphore_signal(done);
        });
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MIN(remaining, 6) * NSEC_PER_SEC))) != 0) {
          [gate lock]; cancelled = YES; [gate unlock];
          return NO;
        }
        return completed;
      }
      factory:^MetaNativeObserver *(NSDictionary *identity, MetaObserverTargetIndex *index) {
        MetaNativeObserver *observer = [[MetaNativeObserver alloc] initWithGeneration:identity];
        [observer setFocusResolver:^NSDictionary *(pid_t pid, AXUIElementRef element, NSString *notification) {
          return [index resolveFocusForPid:pid element:element notification:notification];
        }];
        return observer;
      }
      readinessProvider:^NSDictionary * { return meta_current_session_readiness(generation[@"loginSessionId"]); }
      instanceIdProvider:^NSString * { return [@"observer-" stringByAppendingString:NSUUID.UUID.UUIDString]; }];
    [binder setPreparedValidator:^BOOL(MetaObserverPreparedIndex *prepared) {
      const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(windows);
      return snapshot != NULL && snapshot->revision == prepared.inventoryRevision &&
          [prepared.inventoryId isEqual:@(snapshot->inventory_id)] &&
          meta_macos_observer_snapshot_ready(windows, snapshot);
    }];
    [binder setIndexFailureProvider:^NSDictionary * {
      if (retainedIndexContext.failureReason == nil) return nil;
      return @{@"reason" : retainedIndexContext.failureReason,
               @"stage" : retainedIndexContext.failureStage ?: @"index",
               @"transient" : retainedIndexContext.failureTransient ? @YES : @NO};
    }];
    [_asyncLock lock];
    _observerCommands = binder;
    [_asyncLock unlock];
    _viewAdmissions = [[MetaViewAdmissionController alloc] initWithObserver:binder now:^NSDate * { return NSDate.date; }
      tombstoneTtlMillis:120000 maximumRecords:4096];
  }
  NSDictionary *result = [_observerCommands handleRequest:request];
  if ([result[@"ok"] isEqual:@YES]) {
    _observerRequest = [request copy];
    _observerInstance = [result[@"command"] isEqual:@"stop"] ? nil : result[@"snapshot"][@"observerInstanceRef"];
  }
  return result;
}

- (BOOL)activateObserverPush:(NSString *)instanceRef {
  return [_observerCommands activatePushForObserverInstance:instanceRef];
}

- (NSDictionary *)takeObserverPush:(NSUInteger)maximum {
  [_asyncLock lock];
  MetaObserverCommandBinder *binder = _observerCommands;
  [_asyncLock unlock];
  return [binder takePushEnvelopes:maximum];
}

- (void)stopObserver {
  if (_observerInstance == nil || _observerRequest == nil) return;
  NSMutableDictionary *request = [_observerRequest mutableCopy];
  request[@"command"] = @"stop";
  request[@"requestId"] = [@"observer-stop-" stringByAppendingString:NSUUID.UUID.UUIDString];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  request[@"deadlineAt"] = [formatter stringFromDate:[NSDate dateWithTimeIntervalSinceNow:1]];
  _observerMainDeadline = [formatter dateFromString:request[@"deadlineAt"]];
  request[@"observerInstanceRef"] = _observerInstance;
  [request removeObjectForKey:@"previousObserverInstanceRef"];
  [request removeObjectForKey:@"afterCursor"];
  NSDictionary *result = [_observerCommands handleRequest:request];
  if ([result[@"ok"] isEqual:@YES] && [result[@"command"] isEqual:@"stop"] &&
      ![result[@"snapshot"][@"coverage"][@"state"] isEqual:@"ready"]) _observerInstance = nil;
}

- (NSDictionary *)recoveryInfo {
  NSDictionary *session = meta_current_session_readiness(_recoveryRequest[@"loginSessionId"]);
  NSDictionary *coverage = nil;
  NSDictionary *observerSession = nil;
  if (_observerCommands != nil && _observerInstance != nil) {
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDictionary *request = @{@"kind": @"observer", @"protocolVersion": @"1", @"command": @"coverage",
      @"requestId": [@"recovery-observer-" stringByAppendingString:NSUUID.UUID.UUIDString],
      @"runtimeEpoch": _recoveryRequest[@"runtimeEpoch"], @"loginSessionId": _recoveryRequest[@"loginSessionId"], @"nativeGeneration": _recoveryRequest[@"nativeGeneration"],
      @"observerInstanceRef": _observerInstance, @"deadlineAt": [formatter stringFromDate:[NSDate dateWithTimeIntervalSinceNow:1]]};
    NSDictionary *reply = [_observerCommands handleRequest:request];
    if ([reply[@"ok"] boolValue]) { coverage = reply[@"snapshot"][@"coverage"]; observerSession = reply[@"snapshot"][@"sessionReadiness"]; }
  }
  BOOL ready = [coverage[@"state"] isEqual:@"ready"] && ![coverage[@"gapDetected"] boolValue] &&
      [coverage[@"coveredKinds"] containsObject:@"input"];
  return @{@"sessionState": session[@"state"] ?: @"unknown", @"secureInput": session[@"secureInput"] ?: @"unknown",
    @"lockState": [observerSession[@"lockState"] isEqual:@"locked"] ? @"locked" : @"unknown",
    @"inputMonitoring": CGPreflightListenEventAccess() ? @YES : @NO, @"observerReady": ready ? @YES : @NO};
}

- (NSDictionary *)executeReadiness:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *expected = request[@"payload"][@"expectedDisplayRef"];
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (snapshot == NULL || ![expected isKindOfClass:NSDictionary.class] ||
      ![job.operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      [job.operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision ||
      ![job.operation[@"target"][@"kind"] isEqual:@"display"] ||
      ![job.operation[@"target"][@"ref"] isEqual:expected]) return nil;
  if (![self prepareInputRisk:request]) return nil;
  NSDictionary *generation = @{@"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"],
    @"nativeGeneration": request[@"nativeGeneration"]};
  MetaObserverCommandBinder *observer = _observerCommands;
  NSString *instance = [_observerInstance copy];
  MetaReadinessSystemContext *context = [[MetaReadinessSystemContext alloc] initWithWindows:_windows expectedDisplay:expected
    observer:observer observerInstance:instance sessionProvider:^NSDictionary * {
      NSMutableDictionary *session = [meta_current_session_readiness(generation[@"loginSessionId"]) mutableCopy];
      if (observer != nil && instance != nil) {
        NSMutableDictionary *query = [generation mutableCopy];
        NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
        formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
        [query addEntriesFromDictionary:@{@"kind": @"observer", @"protocolVersion": @"1", @"command": @"coverage",
          @"requestId": [@"readiness-session-" stringByAppendingString:NSUUID.UUID.UUIDString], @"observerInstanceRef": instance,
          @"deadlineAt": [formatter stringFromDate:[NSDate dateWithTimeIntervalSinceNow:1]]}];
        NSDictionary *reply = [observer handleRequest:query];
        if ([reply[@"snapshot"][@"sessionReadiness"][@"lockState"] isEqual:@"locked"]) session[@"lockState"] = @"locked";
      }
      return session;
    }];
  [job setObserverCoverageProvider:^NSDictionary * { return [context coverage]; }];
  MetaExecutor *executor = [_inputExecutor executorOnActionWorker];
  MetaInputReadinessBackend backend = [context backend];
  MetaReadinessObserverSnapshot observed = {0};
  BOOL observerReady = backend.read_observer(backend.context, &observed) && observed.ready && observed.continuous && !observed.gap_detected;
  meta_executor_set_observer_state(executor, observerReady ? META_OBSERVER_READY : META_OBSERVER_UNAVAILABLE);
  MetaReadinessCommandBinder *binder = [[MetaReadinessCommandBinder alloc] initWithGeneration:generation backend:backend now:^NSDate * { return NSDate.date; }];
  NSDictionary *execution = [_inputExecutor executePrimitive:request job:job targetRef:expected[@"displayRef"]
    verify:^BOOL(NSString *target) { return [target isEqual:expected[@"displayRef"]] && [context targetAvailable]; }
    action:^NSDictionary * {
      uint64_t tag = meta_executor_synthetic_tag(executor);
      BOOL registered = [observer registerSyntheticTag:tag operationId:job.operation[@"operationId"] interactionId:nil
        target:job.operation[@"target"] observerInstanceRef:instance];
      if (!registered) meta_executor_set_observer_state(executor, META_OBSERVER_UNAVAILABLE);
      NSError *error = nil;
      MetaReadinessCommandOutcome *outcome = [binder handleRequest:request currentRequestId:job.requestId
        currentOperation:job.operation executor:executor error:&error];
      if (registered) [observer unregisterSyntheticTag:tag observerInstanceRef:instance];
      if (outcome == nil || ![outcome.result[@"inputReady"] boolValue]) meta_executor_fail(executor, "readiness-not-ready");
      return outcome.result;
    }];
  meta_executor_set_observer_state(executor, META_OBSERVER_UNAVAILABLE);
  _activeInputRecoveryDescriptor = nil;
  if (execution[@"value"] == nil || execution[@"status"] == nil) return nil;
  NSMutableDictionary *value = [execution[@"value"] mutableCopy];
  if (![execution[@"finished"] boolValue] && [value[@"inputReady"] boolValue]) {
    value[@"inputReady"] = @NO;
    value[@"reason"] = @"Probe завершён, но parent native operation не подтвердила finish";
    value[@"dispatch"] = execution[@"status"][@"dispatch"];
    value[@"cleanup"] = execution[@"status"][@"cleanup"];
    value[@"quarantined"] = execution[@"status"][@"quarantined"];
    value[@"interference"] = execution[@"status"][@"userInterference"];
  }
  return @{@"value": value, @"status": execution[@"status"]};
}

- (NSDictionary *)domainRecovery:(NSDictionary *)request owner:(NSDictionary *)owner {
  _recoveryRequest = request;
  MetaRecoveryProbeBackend backend = meta_recovery_probe_system_backend();
  backend.context = (__bridge void *)self;
  backend.readiness = recovery_readiness;
  NSDictionary *result = meta_domain_recovery_receive(owner, request, backend);
  _recoveryRequest = nil;
  return result;
}

- (NSDictionary *)heldRecovery:(NSDictionary *)request owner:(NSDictionary *)owner {
  _recoveryRequest = request;
  MetaRecoveryProbeBackend backend = meta_recovery_probe_system_backend();
  backend.context = (__bridge void *)self;
  backend.readiness = recovery_readiness;
  NSDictionary *result = meta_recovery_probe_receive(owner, request, backend);
  _recoveryRequest = nil;
  return result;
}

- (NSDictionary *)inspect:(NSDictionary *)request {
  NSDictionary *payload = request[@"payload"];
  NSDictionary *target = payload[@"target"];
  NSDictionary *ref = target[@"ref"];
  if (![ref isKindOfClass:NSDictionary.class] || payload[@"cursor"] != nil ||
      [payload[@"depth"] integerValue] < 0 || [payload[@"depth"] integerValue] > 12 ||
      [payload[@"maxNodes"] integerValue] < 1 || [payload[@"maxNodes"] integerValue] > 1500 ||
      [payload[@"maxBytes"] integerValue] < 1 || [payload[@"maxBytes"] integerValue] > 1024 * 1024) return nil;
  NSString *targetRef = [target[@"kind"] isEqual:@"surface"] ? ref[@"surfaceRef"] : ref[@"windowRef"];
  if (![targetRef isKindOfClass:NSString.class]) return nil;
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (snapshot == NULL) return nil;
  MetaInspectionBorrowContext *binding = [[MetaInspectionBorrowContext alloc] init];
  binding.request = request;
  binding.registry = _axSnapshots;
  binding.snapshotId = [@"ax-" stringByAppendingString:NSUUID.UUID.UUIDString];
  MetaAXBorrowStatus status = meta_macos_with_ax_target(_windows, targetRef.UTF8String,
      snapshot->inventory_id, snapshot->revision, [request[@"nativeGeneration"] UTF8String],
      inspect_borrowed, (__bridge void *)binding);
  if (status != META_AX_BORROW_OK) {
    [_axSnapshots invalidateTarget:target];
    NSString *code = status == META_AX_BORROW_PERMISSION_DENIED ? @"permission-denied" :
                     status == META_AX_BORROW_TARGET_STALE ? @"target-stale" : @"inventory-incomplete";
    return @{@"nativeError": @{@"code": code, @"message": @"AX inspector не получил подтверждённую live target reference",
      @"stage": @"ax-inspect-borrow", @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"refresh-inventory"}};
  }
  return binding.result;
}

- (NSDictionary *)cursorDisplay:(NSDictionary *)request {
  NSDictionary *payload = request[@"payload"];
  if (![payload isKindOfClass:NSDictionary.class] || ![payload[@"inventoryId"] isKindOfClass:NSString.class] ||
      !unsigned_json_number(payload[@"inventoryRevision"]) || !unsigned_json_number(payload[@"displayLayoutRevision"])) return nil;
  NSDictionary *generation = @{@"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"], @"nativeGeneration": request[@"nativeGeneration"]};
  return meta_cursor_display_read(_windows, generation, payload[@"inventoryId"],
    [payload[@"inventoryRevision"] unsignedLongLongValue], [payload[@"displayLayoutRevision"] unsignedLongLongValue]);
}

- (NSDictionary *)executeAxPress:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation, *target = operation[@"target"], *ref = target[@"ref"];
  NSDictionary *element = request[@"payload"][@"element"];
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  BOOL surface = [target[@"kind"] isEqual:@"surface"];
  NSString *targetRef = surface ? ref[@"surfaceRef"] : ref[@"windowRef"];
  if (snapshot == NULL || ![@[@"window", @"surface"] containsObject:target[@"kind"]] ||
      ![targetRef isKindOfClass:NSString.class] || ![element isKindOfClass:NSDictionary.class] ||
      ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] || !unsigned_json_number(operation[@"inventoryRevision"]) ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision ||
      ![element[@"applicationRef"] isEqual:ref[@"applicationRef"]]) return nil;
  for (NSString *key in @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (![operation[key] isEqual:element[key]] || ![operation[key] isEqual:ref[key]]) return nil;
  }
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *deadlineDate = [formatter dateFromString:request[@"deadlineAt"]];
  NSTimeInterval remaining = deadlineDate.timeIntervalSinceNow * 1000;
  if (deadlineDate == nil || remaining <= 0) return nil;
  uint64_t deadline = native_millis() + (uint64_t)MIN(remaining, 5000);
  MetaMacOSBackend *windows = _windows;
  MetaExecutor *executor = [_inputExecutor executorOnActionWorker];
  NSString *viewError = nil;
  NSDictionary *viewHead = [_viewAdmissions admitRequest:request proof:request[@"viewAdmission"] error:&viewError];
  __block BOOL admissionRejected = viewHead == nil;
  [_inputExecutor setFirstDispatchGuard:^BOOL {
    BOOL allowed = viewHead != nil && [self->_viewAdmissions recheckOperationId:operation[@"operationId"]];
    if (!allowed) admissionRejected = YES;
    return allowed;
  }];
  __block BOOL accepted = NO;
  __block NSString *code = @"target-stale";
  __block NSString *message = @"Retained AX snapshot или exact parent недоступны";
  BOOL (^identity)(const MetaAXTargetBorrow *) = ^BOOL(const MetaAXTargetBorrow *borrow) {
    return [ref[@"applicationRef"] isEqual:@(borrow->target.application_ref)] &&
      (surface ? borrow->target.surface_kind == META_SURFACE_SHEET && [ref[@"ownerWindowRef"] isEqual:@(borrow->target.owner_window_ref)] : borrow->target.surface_kind == META_SURFACE_WINDOW);
  };
  NSDictionary *execution = [_inputExecutor executePrimitive:request job:job targetRef:targetRef
    verify:^BOOL(NSString *value) {
      return [value isEqual:targetRef] && session_allows_input(operation[@"loginSessionId"]) &&
        meta_macos_with_ax_target(windows, targetRef.UTF8String, [operation[@"inventoryId"] UTF8String],
          [operation[@"inventoryRevision"] unsignedLongLongValue], [operation[@"nativeGeneration"] UTF8String],
          consume_borrow_block, (__bridge void *)identity) == META_AX_BORROW_OK;
    } action:^NSDictionary * {
      if (viewHead == nil) { meta_executor_fail(executor, "view-admission-rejected"); return @{}; }
      __block BOOL visited = NO;
      MetaAXRetainedBorrowStatus retained = [self->_axSnapshots withPressElement:element target:target
        inventoryId:operation[@"inventoryId"] inventoryRevision:[operation[@"inventoryRevision"] unsignedLongLongValue]
        consume:^BOOL(id retainedElement) {
          visited = YES;
          __block MetaAXPressOutcome outcome = {.status = META_AX_PRESS_INVALID_REQUEST};
          BOOL (^press)(const MetaAXTargetBorrow *) = ^BOOL(const MetaAXTargetBorrow *borrow) {
            if (!identity(borrow)) return NO;
            outcome = meta_ax_press_borrowed_elements((__bridge AXUIElementRef)retainedElement, borrow->element,
              (MetaAXPressContext){.owner_pid = borrow->target.pid, .max_ancestry_depth = 32,
                .deadline_millis = deadline, .per_call_timeout_millis = 500},
              ^BOOL(BOOL (^perform)(void)) {
                return meta_executor_dispatch_action(executor, dispatch_block, (__bridge void *)perform, "ax-press");
              });
            return YES;
          };
          MetaAXBorrowStatus borrowed = meta_macos_with_ax_target(windows, targetRef.UTF8String,
            [operation[@"inventoryId"] UTF8String], [operation[@"inventoryRevision"] unsignedLongLongValue],
            [operation[@"nativeGeneration"] UTF8String], consume_borrow_block, (__bridge void *)press);
          accepted = borrowed == META_AX_BORROW_OK && outcome.status == META_AX_PRESS_SUCCEEDED && outcome.dispatch_attempted;
          if (!accepted) {
            code = outcome.dispatch_attempted ? @"operation-outcome-unknown" :
              outcome.status == META_AX_PRESS_ACTION_UNAVAILABLE ? @"unsupported-capability" : @"target-stale";
            message = [NSString stringWithFormat:@"AXPress не подтверждён: borrow=%ld, status=%ld, AXError=%d",
              (long)borrowed, (long)outcome.status, outcome.ax_error];
          }
          return accepted;
        }];
      if (!visited && retained == META_AX_RETAINED_BORROW_ACTION_UNAVAILABLE) code = @"unsupported-capability";
      if (!accepted) meta_executor_fail(executor, "ax-press-not-confirmed");
      return accepted ? @{@"element": element, @"action": @"AXPress", @"performed": @YES} : @{};
    }];
  [_inputExecutor setFirstDispatchGuard:nil];
  [_viewAdmissions finishOperationId:operation[@"operationId"]];
  if (admissionRejected) { code = @"observation-stale"; message = viewError ?: @"View admission изменилась перед AXPress dispatch"; }
  if (accepted && [execution[@"finished"] boolValue]) return @{@"value": execution[@"value"], @"status": execution[@"status"]};
  if (accepted) { code = @"operation-outcome-unknown"; message = @"AXPress вызван, но parent operation не подтвердила finish"; }
  NSMutableDictionary *failure = [@{@"nativeError": @{@"code": code, @"message": message, @"stage": @"ax-press",
    @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"refresh-inventory"}} mutableCopy];
  if (execution[@"status"] != nil) failure[@"nativeStatus"] = execution[@"status"];
  return failure;
}

static NSString *clipboard_error(MetaClipboardStatus status) {
  switch (status) {
    case META_CLIPBOARD_PAYLOAD_TOO_LARGE: return @"payload-too-large";
    case META_CLIPBOARD_INVALID_UTF8: return @"invalid-utf8";
    case META_CLIPBOARD_INVALID_ARGUMENT: return @"invalid-argument";
    default: return @"backend-unavailable";
  }
}

- (NSDictionary *)clipboard:(NSDictionary *)command {
  if (_sealed) return nil;
  NSString *method = command[@"method"];
  NSDictionary *payload = command[@"payload"];
  if (![method isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) return nil;
  MetaClipboardBackend backend = meta_clipboard_system_backend();
  NSDictionary *value = nil;
  if ([method isEqual:@"clipboard.version"]) {
    MetaClipboardVersionResult result = meta_clipboard_read_version(backend);
    value = result.status == META_CLIPBOARD_OK
        ? @{@"status": @"ok", @"changeCount": @(result.change_count)}
        : @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
  } else if ([method isEqual:@"clipboard.read"]) {
    NSNumber *maximum = payload[@"maxBytes"];
    if (![maximum isKindOfClass:NSNumber.class] || maximum.doubleValue != maximum.longLongValue || maximum.longLongValue < 1 || maximum.longLongValue > META_CLIPBOARD_MAX_UTF8_BYTES) return nil;
    size_t capacity = (size_t)maximum.longLongValue;
    uint8_t *output = calloc(capacity, 1);
    if (output == NULL) return nil;
    MetaClipboardReadResult result = meta_clipboard_read_text(backend, output, capacity);
    if (result.status == META_CLIPBOARD_OK) {
      NSString *text = [[NSString alloc] initWithBytes:output length:result.utf8_bytes encoding:NSUTF8StringEncoding];
      value = @{@"status": @"ok", @"text": text ?: @"", @"utf8Bytes": @(result.utf8_bytes),
                @"beforeChangeCount": @(result.before_change_count), @"afterChangeCount": @(result.after_change_count)};
    } else if (result.status == META_CLIPBOARD_CHANGED_DURING_READ || result.status == META_CLIPBOARD_TEXT_UNAVAILABLE) {
      value = @{@"status": result.status == META_CLIPBOARD_CHANGED_DURING_READ ? @"changed-during-read" : @"text-unavailable",
                @"beforeChangeCount": @(result.before_change_count), @"afterChangeCount": @(result.after_change_count)};
    } else value = @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
    memset(output, 0, capacity);
    free(output);
  } else if ([method isEqual:@"clipboard.write"]) {
    NSString *text = payload[@"text"];
    if (![text isKindOfClass:NSString.class]) return nil;
    if ([text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > META_CLIPBOARD_MAX_UTF8_BYTES) {
      value = @{@"status": @"payload-too-large", @"mutationAttempted": @NO};
    } else {
      NSNumber *expected = payload[@"expectedChangeCount"];
      if (expected != nil && (![expected isKindOfClass:NSNumber.class] || expected.doubleValue != expected.longLongValue || expected.longLongValue < 0)) return nil;
      NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
      if (data == nil) return nil;
      MetaClipboardWriteRequest request = {.bytes = data.bytes, .length = data.length,
        .has_expected_change_count = expected != nil, .expected_change_count = expected.longLongValue};
      MetaClipboardWriteResult result = meta_clipboard_write_text(backend, request);
      if (result.status == META_CLIPBOARD_OK) {
        value = @{@"status": @"written", @"beforeChangeCount": @(result.before_change_count),
          @"declaredChangeCount": @(result.declared_change_count), @"afterChangeCount": @(result.after_change_count),
          @"mutationAttempted": @YES, @"setStringSucceeded": @(result.set_string_succeeded),
          @"ownershipStableAfterWrite": @(result.ownership_stable_after_write), @"atomicPrecondition": @NO,
          @"utf8Bytes": @(result.utf8_bytes)};
      } else if (result.status == META_CLIPBOARD_PRECONDITION_MISMATCH) {
        value = @{@"status": @"precondition-mismatch-no-dispatch", @"beforeChangeCount": @(result.before_change_count),
                  @"mutationAttempted": @NO, @"atomicPrecondition": @NO};
      } else if (result.mutation_attempted) {
        value = @{@"status": @"partial-or-unknown", @"beforeChangeCount": @(result.before_change_count),
          @"mutationAttempted": @YES, @"setStringSucceeded": @(result.set_string_succeeded),
          @"ownershipStableAfterWrite": @(result.ownership_stable_after_write), @"atomicPrecondition": @NO,
          @"utf8Bytes": @(result.utf8_bytes)};
      } else value = @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
    }
  }
  return value == nil ? nil : @{@"method": method, @"value": value};
}

- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId {
  (void)operationId;
  (void)requestId;
  return nil;
}

- (NSDictionary *)cancel:(NSDictionary *)request {
  NSDictionary *source = request[@"fence"];
  MetaFence fence = {.counter = [source[@"counter"] unsignedLongLongValue]};
  snprintf(fence.runtime_epoch, sizeof(fence.runtime_epoch), "%s", [source[@"runtimeEpoch"] UTF8String]);
  snprintf(fence.login_session_id, sizeof(fence.login_session_id), "%s", [source[@"loginSessionId"] UTF8String]);
  snprintf(fence.native_generation, sizeof(fence.native_generation), "%s", [source[@"nativeGeneration"] UTF8String]);
  meta_broker_core_cancel_operation(_core, [request[@"operationId"] UTF8String], fence);
  [_asyncLock lock]; NSString *task = _applicationTaskRefs[request[@"operationId"]]; [_asyncLock unlock];
  if (task != nil) {
    NSDictionary *current = [_applications launchStatus:task requestId:request[@"requestId"] ?: @"cancel-status"];
    if ([current[@"fence"] isEqual:source]) [_applications cancelLaunch:task requestId:request[@"requestId"] ?: @"cancel-status"];
  }
  return nil;
}

- (NSDictionary *)supplementStatus:(NSDictionary *)status {
  if (![status[@"operationId"] isKindOfClass:NSString.class]) return status;
  MetaCaptureOperationTaskRecord records[128] = {0};
  size_t count = meta_capture_router_operation_tasks(_captures, [status[@"operationId"] UTF8String], records, 128);
  BOOL pending = count > 128;
  for (size_t index = 0; index < MIN(count, 128); index += 1) {
    if (!records[index].released && (!records[index].status.drained || records[index].status.cleanup != MetaCaptureCleanupComplete)) pending = YES;
  }
  [_asyncLock lock]; NSString *applicationTask = _applicationTaskRefs[status[@"operationId"]]; [_asyncLock unlock];
  if (applicationTask != nil) {
    NSDictionary *application = [_applications launchStatus:applicationTask requestId:status[@"requestId"]];
    if (![application[@"effectiveTerminal"] boolValue]) pending = YES;
  }
  if (!pending) return status;
  NSMutableDictionary *value = [status mutableCopy];
  value[@"cleanup"] = @"unknown";
  value[@"quarantined"] = @YES;
  value[@"restorationAllowed"] = @NO;
  return value;
}

- (NSDictionary *)reconcileStatus:(NSDictionary *)status {
  if ([status[@"cancellationRequested"] boolValue]) {
    [self cancel:@{@"operationId": status[@"operationId"], @"fence": status[@"acceptedFence"]}];
    meta_broker_core_release_drained_operation(_core, [status[@"operationId"] UTF8String], false);
    MetaCaptureOperationTaskRecord records[128] = {0};
    size_t count = meta_capture_router_operation_tasks(_captures, [status[@"operationId"] UTF8String], records, 128);
    BOOL released = count <= 128;
    for (size_t index = 0; index < MIN(count, 128); index += 1) if (!records[index].released) released = NO;
    if (released) { [_asyncLock lock]; [_captureOperationIds removeObject:status[@"operationId"]]; [_asyncLock unlock]; }
  }
  [_asyncLock lock]; NSString *task = _applicationTaskRefs[status[@"operationId"]]; [_asyncLock unlock];
  if (task != nil) {
    NSDictionary *application = [_applications finalizeLaunch:task requestId:status[@"requestId"]];
    if ([application[@"effectiveTerminal"] boolValue] && [_applications releaseLaunch:task]) {
      [_asyncLock lock]; [_applicationTaskRefs removeObjectForKey:status[@"operationId"]]; [_asyncLock unlock];
    }
  }
  return [self supplementStatus:status];
}

- (NSArray<NSString *> *)pendingOperationIds {
  [_asyncLock lock];
  NSMutableSet *all = [_captureOperationIds mutableCopy];
  NSDictionary *applications = [_applicationTaskRefs copy];
  BOOL sealed = _sealed;
  [_asyncLock unlock];
  for (NSString *operation in applications) {
    NSDictionary *status = [_applications launchStatus:applications[operation] requestId:@"pending-operations"];
    if (!sealed || ![status[@"drained"] boolValue] || [status[@"parentActivationInFlight"] boolValue]) [all addObject:operation];
  }
  NSArray *operations = all.allObjects;
  return operations;
}

- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job {
  if (_sealed || ![self ensureApplications:request]) return nil;
  NSDictionary *operation = job.operation, *payload = request[@"payload"];
  [_asyncLock lock];
  BOOL occupied = _applicationTaskRefs[operation[@"operationId"]] != nil;
  [_asyncLock unlock];
  if (occupied) return nil;
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (snapshot == NULL || ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision) return nil;
  BOOL launch = [request[@"method"] isEqual:@"application.launch"];
  NSDictionary *reference = launch ? payload[@"bundle"] : payload[@"application"];
  if (![reference isKindOfClass:NSDictionary.class] || ![reference isEqual:operation[@"target"][@"ref"]] ||
      ![operation[@"target"][@"kind"] isEqual:launch ? @"application-bundle" : @"application"]) return nil;
  NSString *targetRef = launch ? reference[@"bundleRef"] : reference[@"applicationRef"];
  if (![targetRef isKindOfClass:NSString.class]) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *deadlineDate = [formatter dateFromString:operation[@"deadlineAt"]];
  double remaining = deadlineDate.timeIntervalSinceNow * 1000;
  if (deadlineDate == nil || remaining <= 0) return nil;
  uint64_t deadline = _applicationBackend.monotonic_millis(_applicationBackend.context) + (uint64_t)MIN(remaining, 30000);
  __block BOOL quitConfirmed = NO;
  __block NSString *launchTask = nil;
  NSDictionary *execution = [_inputExecutor executeExternal:request job:job targetRef:targetRef verify:^BOOL(NSString *value) {
    if (![value isEqual:targetRef]) return NO;
    return launch ? [self->_bundles validateReference:reference] : quitConfirmed || [self applicationRecord:reference] != nil;
  } action:^NSDictionary * {
    if (!launch) {
      NSDictionary *quit = [self->_applications quit:payload operation:operation deadlineMillis:deadline];
      quitConfirmed = [quit[@"value"][@"state"] isEqual:@"terminated"];
      return quit;
    }
    NSDictionary *state = [self->_applications startLaunch:payload operation:operation requestId:job.requestId deadlineMillis:deadline];
    launchTask = state[@"launchTaskRef"];
    if (launchTask == nil) return nil;
    [self->_asyncLock lock]; self->_applicationTaskRefs[operation[@"operationId"]] = launchTask; [self->_asyncLock unlock];
    uint64_t waitUntil = deadline > 100 ? deadline - 100 : deadline;
    while (![state[@"drained"] boolValue] && ![job cancelRequested] && self->_applicationBackend.monotonic_millis(self->_applicationBackend.context) < waitUntil) {
      usleep(1000);
      state = [self->_applications launchStatus:launchTask requestId:job.requestId];
    }
    if (![state[@"drained"] boolValue] || [job cancelRequested]) {
      [job requestCancel];
      [self->_applications cancelLaunch:launchTask requestId:job.requestId];
    }
    state = [self->_applications finalizeLaunch:launchTask requestId:job.requestId];
    if ([payload[@"activate"] boolValue] && [state[@"value"][@"state"] isEqual:@"running"] && ![job cancelRequested]) {
      if (!session_allows_input(operation[@"loginSessionId"])) {
        [job requestCancel];
        [self->_applications cancelLaunch:launchTask requestId:job.requestId];
      } else {
        BOOL (^activate)(void) = ^BOOL { return [self->_applications activateLaunch:launchTask deadlineMillis:deadline] != nil; };
        meta_executor_dispatch_action([self->_inputExecutor executorOnActionWorker], dispatch_block, (__bridge void *)activate, "application-activate");
      }
      state = [self->_applications finalizeLaunch:launchTask requestId:job.requestId];
    }
    return state;
  }];
  if (execution == nil) return nil;
  NSDictionary *state = execution[@"value"];
  NSDictionary *value = state[@"value"];
  if (launch) {
    if (value == nil) value = unknown_launch_value(@"Launch callback или его reconciliation ещё не завершены", nil);
    if ([value[@"state"] isEqual:@"running"] && ![execution[@"finished"] boolValue]) value = unknown_launch_value(@"Launch dispatch завершён, но операция отменена или её budget истёк", value[@"application"]);
    if ([state[@"effectiveTerminal"] boolValue] && [_applications releaseLaunch:launchTask]) {
      [_asyncLock lock]; [_applicationTaskRefs removeObjectForKey:operation[@"operationId"]]; [_asyncLock unlock];
    }
  } else if (value != nil && ![value[@"state"] isEqual:@"unknown"] && ![execution[@"finished"] boolValue]) {
    NSString *reason = @"Quit callback вернулся, но parent native operation не подтвердила finish";
    value = @{@"state": @"unknown", @"application": reference,
      @"reason": reason, @"errors": @[@{@"code": @"operation-outcome-unknown", @"message": reason,
        @"stage": @"application-quit", @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"get-operation"}]};
  }
  if (value == nil) return nil;
  return @{@"value": value, @"status": [self supplementStatus:execution[@"status"]]};
}

- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  NSDictionary *target = operation[@"target"], *ref = target[@"ref"];
  NSString *targetRef = ref[@"windowRef"] ?: ref[@"displayRef"] ?: ref[@"layoutRef"];
  if (![targetRef isKindOfClass:NSString.class]) return nil;
  if ([self pendingOperationIds].count >= 128) {
    return @{
      @"nativeError" : capture_start_error(
          @"capability-unavailable", @"Capture operation capacity исчерпана",
          @"inspect-health"),
      @"startDisposition" : @"rejected-before-start",
    };
  }
  if (!meta_capture_preflight_screen_recording()) {
    return @{
      @"nativeError" : capture_start_error(
          @"permission-denied", @"Screen Recording не выдан native capture",
          @"request-user-action"),
      @"startDisposition" : @"rejected-before-start",
    };
  }
  NSError *validationError = nil;
  if (![_captureCommands validateStartRequest:request error:&validationError]) {
    return @{
      @"nativeError" : capture_native_error(validationError),
      @"startDisposition" : @"rejected-before-start",
    };
  }
  MetaMacOSBackend *windows = _windows;
  __block NSError *captureError = nil;
  NSDictionary *execution = [_inputExecutor executeExternal:request job:job targetRef:targetRef verify:^BOOL(NSString *value) {
    const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(windows);
    if (snapshot == NULL || ![value isEqual:targetRef] || ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
        [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision || !meta_capture_preflight_screen_recording()) return NO;
    if (![target[@"kind"] isEqual:@"window"]) return [@[@"display", @"desktop-layout"] containsObject:target[@"kind"]];
    for (size_t index = 0; index < snapshot->window_count; index += 1) {
      MetaWindowRecord record = snapshot->windows[index];
      if ([targetRef isEqual:@(record.window_ref)] && [ref[@"applicationRef"] isEqual:@(record.application_ref)]) {
        return meta_macos_with_ax_target(windows, targetRef.UTF8String, snapshot->inventory_id, snapshot->revision,
            snapshot->native_generation, verify_window_borrow, &record) == META_AX_BORROW_OK;
      }
    }
    return NO;
  } action:^NSDictionary * {
    return [self->_captureCommands startRequest:request error:&captureError];
  }];
  if (execution != nil && execution[@"value"] == nil && captureError != nil) {
    NSMutableDictionary *failure = [@{
      @"nativeError" : capture_native_error(captureError),
    } mutableCopy];
    if ([execution[@"status"] isKindOfClass:NSDictionary.class]) {
      failure[@"nativeStatus"] = execution[@"status"];
    }
    return failure;
  }
  if (execution != nil && execution[@"value"] == nil &&
      [execution[@"status"] isKindOfClass:NSDictionary.class]) {
    return @{
      @"nativeError" : capture_start_error(
          @"target-stale", @"Capture target verification failed before start",
          @"refresh-inventory"),
      @"nativeStatus" : execution[@"status"],
    };
  }
  if (execution[@"value"] != nil) {
    [_asyncLock lock]; [_captureOperationIds addObject:operation[@"operationId"]]; [_asyncLock unlock];
  }
  if (execution[@"value"] != nil && ![execution[@"finished"] boolValue]) {
    [self cancel:@{@"operationId": operation[@"operationId"], @"fence": operation[@"fence"]}];
  }
  return execution[@"value"];
}

- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary {
  NSError *error = nil;
  NSDictionary *result = [_captureCommands cleanupRequest:request emitBinary:emitBinary error:&error];
  if ([request[@"control"][@"purpose"] isEqual:@"release"] && [result[@"ack"][@"cleanup"] isEqual:@"complete"]) {
    [_asyncLock lock]; [_captureOperationIds removeObject:request[@"control"][@"operationId"]]; [_asyncLock unlock];
  }
  return result;
}

- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job {
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  NSDictionary *operation = job.operation;
  if (snapshot == NULL || ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision) return nil;
  if (operation[@"observationRef"] != nil && [operation[@"observationRef"][@"displayLayoutRevision"] unsignedLongLongValue] != snapshot->display_layout_revision) return nil;
  NSDictionary *scope = operation[@"target"], *ref = scope[@"ref"];
  if ([@[@"window", @"surface"] containsObject:scope[@"kind"]]) {
    BOOL surface = [scope[@"kind"] isEqual:@"surface"], matches = NO;
    NSString *targetRef = surface ? ref[@"surfaceRef"] : ref[@"windowRef"];
    for (size_t index = 0; index < snapshot->window_count; index += 1) {
      const MetaWindowRecord *record = &snapshot->windows[index];
      if ([targetRef isEqual:@(record->target_ref)] && [ref[@"applicationRef"] isEqual:@(record->application_ref)] &&
          (surface ? record->surface_kind != META_SURFACE_WINDOW : record->surface_kind == META_SURFACE_WINDOW) &&
          (!surface || [ref[@"ownerWindowRef"] isEqual:@(record->owner_window_ref)])) matches = YES;
    }
    if (!matches) return nil;
  }
  _inputLoginSession = operation[@"loginSessionId"];
  if (![self prepareInputRisk:request]) return nil;
  NSString *viewError = nil;
  NSDictionary *viewHead = [_viewAdmissions admitRequest:request proof:request[@"viewAdmission"] error:&viewError];
  __block BOOL admissionRejected = viewHead == nil;
  MetaInputObserverBinding *binding = [[MetaInputObserverBinding alloc] initWithObserver:_observerCommands
    observerInstanceRef:_observerInstance operationId:operation[@"operationId"] target:scope interactionId:nil];
  BOOL headInstalled = viewHead != nil && [binding useAdmissionHead:viewHead];
  if (!headInstalled) admissionRejected = YES;
  [job setObserverCoverageProvider:^NSDictionary * { return [binding currentCoverage]; }];
  MetaExecutor *executor = [_inputExecutor executorOnActionWorker];
  meta_executor_set_observer_state(executor, [binding currentCoverage] != nil ? META_OBSERVER_READY : META_OBSERVER_UNAVAILABLE);
  [_inputExecutor setInputObserverAfterBegin:^BOOL(MetaExecutor *accepted, MetaInputJob *current) {
    return headInstalled && current == job && accepted == executor && [binding registerTag:meta_executor_synthetic_tag(accepted)];
  } poll:^MetaInputObserverDecision {
    MetaInputObserverPollResult decision = [binding poll];
    return decision == MetaInputObserverPollContinue ? MetaInputObserverContinue :
        decision == MetaInputObserverPollForeignEvent ? MetaInputObserverForeignEvent : MetaInputObserverUnavailable;
  }];
  [_inputExecutor setFirstDispatchGuard:^BOOL {
    BOOL allowed = headInstalled && [self->_viewAdmissions recheckOperationId:operation[@"operationId"]];
    if (!allowed) admissionRejected = YES;
    return allowed;
  }];
  NSDictionary *result = [_inputExecutor execute:request job:job];
  [binding stop];
  [_inputExecutor setInputObserverAfterBegin:nil poll:nil];
  [_inputExecutor setFirstDispatchGuard:nil];
  [_viewAdmissions finishOperationId:operation[@"operationId"]];
  meta_executor_set_observer_state(executor, META_OBSERVER_UNAVAILABLE);
  _activeInputRecoveryDescriptor = nil;
  if (admissionRejected) {
    NSMutableDictionary *failure = [@{@"nativeError": @{@"code": @"observation-stale", @"message": viewError ?: @"View admission изменилась перед input dispatch",
      @"stage": @"view-admission", @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"capture-new-observation"}} mutableCopy];
    if (result[@"status"] != nil) failure[@"nativeStatus"] = result[@"status"];
    return failure;
  }
  return result;
}

- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  NSDictionary *payload = request[@"payload"];
  NSDictionary *ref = payload[@"target"];
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (_sealed || ![payload isKindOfClass:NSDictionary.class] || ![ref isKindOfClass:NSDictionary.class] ||
      ![operation[@"target"][@"kind"] isEqual:@"window"] || ![ref isEqual:operation[@"target"][@"ref"]] ||
      snapshot == NULL || ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision ||
      ![ref[@"nativeGeneration"] isEqual:@(snapshot->native_generation)] ||
      ![ref[@"runtimeEpoch"] isEqual:operation[@"runtimeEpoch"]] || ![ref[@"loginSessionId"] isEqual:operation[@"loginSessionId"]]) return nil;
  NSString *windowRef = ref[@"windowRef"];
  if (![windowRef isKindOfClass:NSString.class]) return nil;
  MetaWindowRecord original = {0};
  BOOL found = NO;
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->surface_kind == META_SURFACE_WINDOW && [windowRef isEqual:@(candidate->window_ref)] &&
        [ref[@"applicationRef"] isEqual:@(candidate->application_ref)]) { original = *candidate; found = YES; break; }
  }
  if (!found) return nil;
  MetaInventoryPriority actionPriority = {0};
  if (!exact_application_priority(snapshot, ref[@"applicationRef"],
                                  original.pid, &actionPriority)) return nil;
  MetaWindowActionRequest action = {.window_ref = windowRef.UTF8String};
  NSString *kind = payload[@"kind"];
  if ([kind isEqual:@"show"]) action.kind = META_WINDOW_ACTION_SHOW;
  else if ([kind isEqual:@"focus"]) action.kind = META_WINDOW_ACTION_FOCUS;
  else if ([kind isEqual:@"close"]) action.kind = META_WINDOW_ACTION_CLOSE;
  else if ([kind isEqual:@"minimize"] && [payload[@"minimized"] isKindOfClass:NSNumber.class]) {
    action.kind = META_WINDOW_ACTION_SET_MINIMIZED;
    action.value.minimized = [payload[@"minimized"] boolValue];
  } else if ([kind isEqual:@"set-bounds"] && [payload[@"bounds"] isKindOfClass:NSDictionary.class]) {
    NSDictionary *bounds = payload[@"bounds"];
    for (NSString *field in @[@"x", @"y", @"width", @"height"]) if (![bounds[field] isKindOfClass:NSNumber.class]) return nil;
    action.kind = META_WINDOW_ACTION_SET_BOUNDS;
    action.value.bounds = (MetaRect){[bounds[@"x"] doubleValue], [bounds[@"y"] doubleValue], [bounds[@"width"] doubleValue], [bounds[@"height"] doubleValue]};
    if (!isfinite(action.value.bounds.x) || !isfinite(action.value.bounds.y) || !isfinite(action.value.bounds.width) ||
        !isfinite(action.value.bounds.height) || action.value.bounds.width <= 0 || action.value.bounds.height <= 0) return nil;
  } else return nil;
  __block MetaWindowTransition transition = {0};
  __block BOOL refreshed = NO;
  MetaMacOSBackend *windows = _windows;
  NSDictionary *execution = [_inputExecutor executeExternal:request job:job targetRef:windowRef verify:^BOOL(NSString *target) {
    if (transition.close_succeeded && transition.presence == META_WINDOW_PRESENCE_CLOSED) return YES;
    const MetaInventorySnapshot *current = meta_macos_backend_snapshot(windows);
    if (current == NULL) return NO;
    MetaWindowRecord expected = original;
    return meta_macos_with_ax_target(windows, target.UTF8String, current->inventory_id, current->revision,
        current->native_generation, verify_window_borrow, &expected) == META_AX_BORROW_OK;
  } action:^NSDictionary * {
    MetaWindowActionBackend backend = meta_window_action_backend_macos(windows);
    MetaWindowActionDispatchStatus dispatched = meta_window_action_dispatch(&backend, &action, &transition);
    if (dispatched != META_WINDOW_ACTION_DISPATCHED) return nil;
    refreshed = action.kind == META_WINDOW_ACTION_CLOSE ? transition.inventory_refreshed :
        meta_macos_refresh_inventory_with_priority(windows, 5000,
                                                   &actionPriority);
    if (refreshed && action.kind != META_WINDOW_ACTION_CLOSE) {
      const MetaInventorySnapshot *after = meta_macos_backend_snapshot(windows);
      MetaWindowRecord expected = original;
      BOOL targetMatches = after != NULL &&
          meta_macos_with_ax_target(windows, windowRef.UTF8String,
              after->inventory_id, after->revision, after->native_generation,
              verify_window_borrow, &expected) == META_AX_BORROW_OK;
      meta_window_classify_existing(after, &original, targetMatches,
                                    &transition);
    }
    return @{};
  }];
  if (execution == nil) return nil;
  if (execution[@"value"] == nil || !refreshed) return @{@"nativeStatus": execution[@"status"], @"nativeError": @{@"code": @"target-stale", @"message": @"Window action не завершила native dispatch или fresh inventory",
      @"stage": @"window-transition", @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"refresh-inventory"}};
  return meta_window_transition_value(refreshed ? meta_macos_backend_snapshot(_windows) : NULL, &original,
      &transition, execution[@"status"], [@"native-response-" stringByAppendingString:NSUUID.UUID.UUIDString]);
}

- (BOOL)beginRotation {
  _sealed = YES;
  BOOL permissionsReady = [_permissionRequests seal];
  [self stopObserver];
  meta_broker_core_begin_rotation(_core);
  for (NSString *operation in [self pendingOperationIds]) {
    meta_capture_router_cancel_operation(_captures, operation.UTF8String);
    meta_broker_core_release_drained_operation(_core, operation.UTF8String, false);
    MetaCaptureOperationTaskRecord records[128] = {0};
    size_t count = meta_capture_router_operation_tasks(_captures, operation.UTF8String, records, 128);
    BOOL released = count <= 128;
    for (size_t index = 0; index < MIN(count, 128); index += 1) if (!records[index].released) released = NO;
    if (released) { [_asyncLock lock]; [_captureOperationIds removeObject:operation]; [_asyncLock unlock]; }
  }
  BOOL coreReady = meta_broker_core_begin_rotation(_core) == META_BROKER_ROTATION_READY;
  BOOL applicationsReady = _applications == nil || [[_applications drainLaunchesUntil:_applicationBackend.monotonic_millis(_applicationBackend.context)][@"cleanup"] isEqual:@"complete"];
  return coreReady && applicationsReady && permissionsReady && _observerInstance == nil;
}
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *generation = [@"native-" stringByAppendingString:NSUUID.UUID.UUIDString];
    MetaSystemCommandBackend *backend = [[MetaSystemCommandBackend alloc] initWithGeneration:generation];
    if (backend == nil) return 70;
    if (argc == 2 && (strcmp(argv[1], "--metadata") == 0 || strcmp(argv[1], "--doctor") == 0)) {
      NSMutableDictionary *metadata = [@{@"protocolVersion": @"1", @"nativeBuildId": @META_NATIVE_BUILD_ID,
        @"installRoot": @META_NATIVE_INSTALL_ROOT, @"nativeGeneration": generation,
        @"pid": @(getpid()), @"capabilitySchemaVersion": @"1"} mutableCopy];
      metadata[@"session"] = [backend sessionIdentity];
      if (strcmp(argv[1], "--doctor") == 0) metadata[@"permissions"] = [backend permissions];
      NSData *data = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:NULL];
      fwrite(data.bytes, 1, data.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc != 1) return 64;
    return meta_command_loop_run(backend, @META_NATIVE_BUILD_ID, @META_NATIVE_INSTALL_ROOT, generation,
                                  STDIN_FILENO, STDOUT_FILENO);
  }
}
