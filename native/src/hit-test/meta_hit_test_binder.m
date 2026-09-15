#include "meta_hit_test_binder.h"

#include <math.h>
#include <string.h>

static NSDictionary *failure(NSString *status, NSString *reason) {
  return @{@"status" : status, @"reason" : reason};
}

static BOOL dictionary(id value) {
  return [value isKindOfClass:NSDictionary.class];
}

static BOOL trusted_session_ready(NSDictionary *session) {
  return dictionary(session) &&
         [session[@"state"] isEqual:@"active-console"] &&
         ![session[@"lockState"] isEqual:@"locked"] &&
         [session[@"secureInput"] isEqual:@"off"];
}

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) {
    return NO;
  }
  NSString *text = value;
  unichar first = [text characterAtIndex:0];
  BOOL valid_first =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return valid_first &&
         [text rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static BOOL integer(id value, uint64_t maximum, uint64_t *result) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  double number = [value doubleValue];
  if (!isfinite(number) || number < 0 || number > (double)maximum ||
      floor(number) != number) {
    return NO;
  }
  *result = [value unsignedLongLongValue];
  return YES;
}

static NSDate *date_from_iso(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:value];
}

static NSString *iso_now(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

static BOOL point(id value, double *x, double *y) {
  if (!dictionary(value) || [value count] != 2 ||
      ![value[@"x"] isKindOfClass:NSNumber.class] ||
      ![value[@"y"] isKindOfClass:NSNumber.class]) {
    return NO;
  }
  *x = [value[@"x"] doubleValue];
  *y = [value[@"y"] doubleValue];
  return isfinite(*x) && isfinite(*y);
}

static BOOL rect(id value, double output[4]) {
  if (!dictionary(value) || [value count] != 4) return NO;
  NSString *keys[] = {@"x", @"y", @"width", @"height"};
  for (size_t index = 0; index < 4; index += 1) {
    if (![value[keys[index]] isKindOfClass:NSNumber.class]) return NO;
    output[index] = [value[keys[index]] doubleValue];
    if (!isfinite(output[index])) return NO;
  }
  return output[2] > 0 && output[3] > 0;
}

static BOOL contains(const double bounds[4], double x, double y) {
  return x >= bounds[0] && y >= bounds[1] &&
         x < bounds[0] + bounds[2] && y < bounds[1] + bounds[3];
}

static BOOL same_point(double left_x, double left_y,
                       double right_x, double right_y) {
  return fabs(left_x - right_x) <= 1e-9 &&
         fabs(left_y - right_y) <= 1e-9;
}

static const MetaDisplayRecord *snapshot_display(
    const MetaInventorySnapshot *snapshot,
    NSDictionary *display_ref,
    NSNumber *native_display_id,
    NSDictionary *generation) {
  uint64_t display_id = 0;
  uint64_t revision = 0;
  if (!dictionary(display_ref) ||
      ![display_ref[@"runtimeEpoch"] isEqual:generation[@"runtimeEpoch"]] ||
      ![display_ref[@"loginSessionId"]
          isEqual:generation[@"loginSessionId"]] ||
      ![display_ref[@"nativeGeneration"]
          isEqual:generation[@"nativeGeneration"]] ||
      !integer(display_ref[@"displayLayoutRevision"],
               9007199254740991ULL, &revision) ||
      revision != snapshot->display_layout_revision ||
      !identifier(display_ref[@"displayRef"], 127) ||
      !integer(native_display_id, UINT32_MAX, &display_id) ||
      display_id == 0) {
    return NULL;
  }
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    const MetaDisplayRecord *display = &snapshot->displays[index];
    if (display->display_id == display_id &&
        [display_ref[@"displayRef"] isEqual:@(display->display_ref)]) {
      return display;
    }
  }
  return NULL;
}

static const MetaWindowRecord *snapshot_target(
    const MetaInventorySnapshot *snapshot,
    NSDictionary *target) {
  NSDictionary *reference = target[@"ref"];
  NSString *kind = target[@"kind"];
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->pid <= 0 ||
        ![reference[@"applicationRef"]
            isEqual:@(candidate->application_ref)]) {
      continue;
    }
    if ([kind isEqual:@"window"] &&
        candidate->surface_kind == META_SURFACE_WINDOW &&
        [reference[@"windowRef"] isEqual:@(candidate->window_ref)]) {
      return candidate;
    }
    if ([kind isEqual:@"surface"] &&
        candidate->surface_kind != META_SURFACE_WINDOW &&
        [reference[@"surfaceRef"] isEqual:@(candidate->surface_ref)] &&
        [reference[@"ownerWindowRef"]
            isEqual:@(candidate->owner_window_ref)]) {
      return candidate;
    }
  }
  return NULL;
}

static const MetaWindowRecord *snapshot_owner_window(
    const MetaInventorySnapshot *snapshot,
    NSDictionary *target,
    const MetaWindowRecord *resolved) {
  if ([target[@"kind"] isEqual:@"window"]) return resolved;
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->surface_kind == META_SURFACE_WINDOW &&
        candidate->pid == resolved->pid &&
        strcmp(candidate->application_ref, resolved->application_ref) == 0 &&
        strcmp(candidate->window_ref, resolved->owner_window_ref) == 0) {
      return candidate;
    }
  }
  return NULL;
}

static BOOL same_logical_frame(NSDictionary *value,
                               const MetaWindowRecord *window) {
  double bounds[4] = {0};
  return rect(value, bounds) && bounds[0] == window->frame.x &&
         bounds[1] == window->frame.y && bounds[2] == window->frame.width &&
         bounds[3] == window->frame.height;
}

@interface MetaHitTestCommandBinder ()
@property(nonatomic, strong) NSDictionary *generation;
@property(nonatomic, copy) MetaHitTestSnapshotProvider snapshotProvider;
@property(nonatomic, copy) MetaHitTestFrameGeometryLookup frameGeometryLookup;
@property(nonatomic, copy) MetaHitTestPendingFenceValidator pendingFenceValidator;
@property(nonatomic, copy) MetaHitTestWindowProbe windowProbe;
@property(nonatomic, copy) MetaHitTestTopologyProbe topologyProbe;
@property(nonatomic, copy) MetaHitTestSessionReadinessProvider sessionReadinessProvider;
@end

@implementation MetaHitTestCommandBinder

- (instancetype)initWithGeneration:(NSDictionary *)generation
                   snapshotProvider:(MetaHitTestSnapshotProvider)snapshotProvider
                 frameGeometryLookup:(MetaHitTestFrameGeometryLookup)frameGeometryLookup
               pendingFenceValidator:(MetaHitTestPendingFenceValidator)pendingFenceValidator
                        windowProbe:(MetaHitTestWindowProbe)windowProbe
                      topologyProbe:(MetaHitTestTopologyProbe)topologyProbe
            sessionReadinessProvider:(MetaHitTestSessionReadinessProvider)sessionReadinessProvider {
  if (!dictionary(generation) ||
      !identifier(generation[@"runtimeEpoch"], 64) ||
      !identifier(generation[@"loginSessionId"], 64) ||
      !identifier(generation[@"nativeGeneration"], 64) ||
      snapshotProvider == nil || frameGeometryLookup == nil ||
      pendingFenceValidator == nil || windowProbe == nil ||
      topologyProbe == nil || sessionReadinessProvider == nil) {
    return nil;
  }
  self = [super init];
  if (self) {
    _generation = @{
      @"runtimeEpoch" : generation[@"runtimeEpoch"],
      @"loginSessionId" : generation[@"loginSessionId"],
      @"nativeGeneration" : generation[@"nativeGeneration"],
    };
    _snapshotProvider = [snapshotProvider copy];
    _frameGeometryLookup = [frameGeometryLookup copy];
    _pendingFenceValidator = [pendingFenceValidator copy];
    _windowProbe = [windowProbe copy];
    _topologyProbe = [topologyProbe copy];
    _sessionReadinessProvider = [sessionReadinessProvider copy];
  }
  return self;
}

- (NSDictionary *)handleRequest:(NSDictionary *)request {
  NSDictionary *operation = request[@"operation"];
  NSDictionary *payload = request[@"payload"];
  NSDictionary *target = payload[@"interactionTarget"];
  NSDictionary *observation_ref = payload[@"observationRef"];
  if (!dictionary(request) || !dictionary(operation) || !dictionary(payload) ||
      !dictionary(target) || !dictionary(target[@"ref"]) ||
      !dictionary(observation_ref) ||
      ![request[@"protocolVersion"] isEqual:@"1"] ||
      ![request[@"kind"] isEqual:@"request"] ||
      ![request[@"intent"] isEqual:@"read"] ||
      ![request[@"method"] isEqual:@"input.hit-test"] ||
      ![request[@"runtimeEpoch"] isEqual:self.generation[@"runtimeEpoch"]] ||
      ![request[@"loginSessionId"]
          isEqual:self.generation[@"loginSessionId"]] ||
      ![request[@"nativeGeneration"]
          isEqual:self.generation[@"nativeGeneration"]] ||
      ![operation[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![operation[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![operation[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] ||
      ![operation[@"deadlineAt"] isEqual:request[@"deadlineAt"]] ||
      ![operation[@"observationRef"] isEqual:observation_ref] ||
      ![operation[@"target"] isEqual:target]) {
    return failure(@"target-mismatch",
                   @"Hit-test request не совпадает с trusted generation или operation");
  }
  NSDate *deadline = date_from_iso(request[@"deadlineAt"]);
  if (deadline == nil || [NSDate.date compare:deadline] != NSOrderedAscending ||
      !self.pendingFenceValidator(operation)) {
    return failure(@"cancelled",
                   @"Operation fence или deadline больше не допускает hit-test");
  }
  NSDictionary *session = self.sessionReadinessProvider();
  if (!trusted_session_ready(session)) {
    return failure(@"cancelled",
                   @"Trusted session readiness не допускает input hit-test");
  }

  const MetaInventorySnapshot *snapshot = self.snapshotProvider();
  uint64_t operation_revision = 0;
  uint64_t observation_revision = 0;
  if (snapshot == NULL || !snapshot->complete ||
      !integer(operation[@"inventoryRevision"], 9007199254740991ULL,
               &operation_revision) ||
      !integer(observation_ref[@"inventoryRevision"],
               9007199254740991ULL, &observation_revision) ||
      operation_revision != snapshot->revision ||
      ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      ![request[@"nativeGeneration"]
          isEqual:@(snapshot->native_generation)]) {
    return failure(@"inventory-stale",
                   @"Bound inventory больше не совпадает с operation");
  }

  NSString *frame_ref = payload[@"frameRef"];
  NSDictionary *geometry = identifier(frame_ref, 127)
                               ? self.frameGeometryLookup(frame_ref)
                               : nil;
  uint64_t geometry_revision = 0;
  uint64_t geometry_layout_revision = 0;
  uint64_t observation_layout_revision = 0;
  if (!dictionary(geometry) ||
      ![geometry[@"frameRef"] isEqual:frame_ref] ||
      ![geometry[@"observationId"]
          isEqual:observation_ref[@"observationId"]] ||
      !integer(geometry[@"inventoryRevision"], 9007199254740991ULL,
               &geometry_revision) ||
      !integer(geometry[@"displayLayoutRevision"], 9007199254740991ULL,
               &geometry_layout_revision) ||
      !integer(observation_ref[@"displayLayoutRevision"],
               9007199254740991ULL, &observation_layout_revision) ||
      geometry_revision != observation_revision ||
      geometry_layout_revision != snapshot->display_layout_revision ||
      observation_layout_revision != snapshot->display_layout_revision ||
      ![observation_ref[@"proofRef"] isKindOfClass:NSString.class] ||
      date_from_iso(geometry[@"capturedAt"]) == nil ||
      date_from_iso(geometry[@"expiresAt"]) == nil ||
      [NSDate.date compare:date_from_iso(geometry[@"expiresAt"])] !=
          NSOrderedAscending) {
    return failure(@"observation-stale",
                   @"Frame geometry отсутствует, истекла или имеет другую revision");
  }

  double image_x = 0;
  double image_y = 0;
  double expected_x = 0;
  double expected_y = 0;
  uint64_t expected_region = 0;
  if (!point(payload[@"imagePoint"], &image_x, &image_y) ||
      !point(payload[@"expectedDestinationPoint"],
             &expected_x, &expected_y) ||
      !integer(payload[@"expectedRegionIndex"], 63, &expected_region) ||
      !identifier(observation_ref[@"observationId"], 127) ||
      !identifier(observation_ref[@"proofRef"], 127)) {
    return failure(@"observation-stale",
                   @"Observation point metadata имеет неверную форму");
  }
  NSDictionary *image_size = geometry[@"imageSize"];
  uint64_t image_width = 0;
  uint64_t image_height = 0;
  if (!dictionary(image_size) ||
      !integer(image_size[@"widthPx"], 32768, &image_width) ||
      !integer(image_size[@"heightPx"], 32768, &image_height) ||
      image_width == 0 || image_height == 0 || image_x < 0 || image_y < 0 ||
      image_x >= image_width || image_y >= image_height ||
      ![geometry[@"regions"] isKindOfClass:NSArray.class] ||
      [geometry[@"regions"] count] == 0 ||
      [geometry[@"regions"] count] > 64) {
    return failure(@"observation-stale",
                   @"Image point не принадлежит bounded frame geometry");
  }

  NSDictionary *selected = nil;
  size_t matches = 0;
  for (NSDictionary *region in geometry[@"regions"]) {
    double image_rect[4] = {0};
    if (!dictionary(region) || !rect(region[@"imageRect"], image_rect)) {
      return failure(@"observation-stale",
                     @"Frame содержит malformed region geometry");
    }
    if (contains(image_rect, image_x, image_y)) {
      selected = region;
      matches += 1;
    }
  }
  uint64_t region_index = 0;
  NSDictionary *transform = selected[@"imageToDestination"];
  double destination_rect[4] = {0};
  if (matches != 1 || !dictionary(selected) ||
      !integer(selected[@"regionIndex"], 63, &region_index) ||
      region_index != expected_region || !dictionary(transform) ||
      [transform count] != 6 || !rect(selected[@"destinationRect"],
                                      destination_rect)) {
    return failure(@"observation-stale",
                   @"Image point не принадлежит exact expected region");
  }
  NSString *transform_keys[] = {@"a", @"b", @"c", @"d", @"tx", @"ty"};
  double affine[6] = {0};
  for (size_t index = 0; index < 6; index += 1) {
    if (![transform[transform_keys[index]] isKindOfClass:NSNumber.class]) {
      return failure(@"observation-stale", @"Affine transform неполон");
    }
    affine[index] = [transform[transform_keys[index]] doubleValue];
    if (!isfinite(affine[index])) {
      return failure(@"observation-stale", @"Affine transform не конечен");
    }
  }
  double destination_x = affine[0] * image_x + affine[2] * image_y + affine[4];
  double destination_y = affine[1] * image_x + affine[3] * image_y + affine[5];
  const double determinant = affine[0] * affine[3] - affine[1] * affine[2];
  NSDictionary *clip = geometry[@"clip"];
  BOOL clip_valid = dictionary(clip) && [clip count] >= 1;
  if ([clip[@"kind"] isEqual:@"full-target"]) {
    clip_valid = clip_valid && [clip count] == 1;
  } else if ([clip[@"kind"] isEqual:@"rect"]) {
    double clip_rect[4] = {0};
    clip_valid = clip_valid && [clip count] == 2 &&
                 rect(clip[@"rect"], clip_rect) &&
                 contains(clip_rect, destination_x, destination_y);
  } else {
    clip_valid = NO;
  }
  if (!clip_valid || fabs(determinant) < 1e-12 ||
      !same_point(destination_x, destination_y, expected_x, expected_y) ||
      !contains(destination_rect, destination_x, destination_y)) {
    return failure(@"observation-stale",
                   @"Expected destination point не совпадает с cached transform");
  }
  NSDate *frame_timestamp = date_from_iso(selected[@"frameTimestamp"]);
  if (frame_timestamp == nil ||
      [frame_timestamp compare:NSDate.date] == NSOrderedDescending) {
    return failure(@"observation-stale",
                   @"Frame timestamp отсутствует или находится в будущем");
  }

  NSDictionary *display_ref = selected[@"macosDisplayRef"];
  const MetaDisplayRecord *display = snapshot_display(
      snapshot, display_ref, selected[@"nativeDisplayId"], self.generation);
  if (display == NULL || !contains((double[4]){
                                      display->bounds.x,
                                      display->bounds.y,
                                      display->bounds.width,
                                      display->bounds.height,
                                  }, destination_x, destination_y)) {
    return failure(@"inventory-stale",
                   @"Frame region display не совпадает с bound topology");
  }

  NSString *target_kind = target[@"kind"];
  BOOL window_scope = [target_kind isEqual:@"window"] ||
                      [target_kind isEqual:@"surface"];
  BOOL display_scope = [target_kind isEqual:@"display"] ||
                       [target_kind isEqual:@"desktop-layout"];
  if (!window_scope && !display_scope) {
    return failure(@"target-mismatch", @"Hit-test target kind не поддерживается");
  }
  if (display_scope && ![geometry[@"source"] isEqual:@"display-composite"]) {
    return failure(@"target-mismatch",
                   @"Broad display scope требует cached display-composite frame");
  }
  NSDictionary *target_ref = target[@"ref"];
  if (![target_ref[@"runtimeEpoch"] isEqual:self.generation[@"runtimeEpoch"]] ||
      ![target_ref[@"loginSessionId"]
          isEqual:self.generation[@"loginSessionId"]] ||
      ![target_ref[@"nativeGeneration"]
          isEqual:self.generation[@"nativeGeneration"]]) {
    return failure(@"target-mismatch",
                   @"Interaction target принадлежит другой generation");
  }

  NSString *observed_at = iso_now();
  NSMutableDictionary *confirmed = [@{
    @"status" : @"confirmed",
    @"sourceResponseRef" : [@"hit-test-"
        stringByAppendingString:NSUUID.UUID.UUIDString],
    @"operationId" : operation[@"operationId"],
    @"inventoryId" : operation[@"inventoryId"],
    @"inventoryRevision" : @(snapshot->revision),
    @"displayLayoutRevision" : @(snapshot->display_layout_revision),
    @"observedAt" : observed_at,
    @"observationId" : observation_ref[@"observationId"],
    @"frameRef" : frame_ref,
    @"regionIndex" : @(region_index),
    @"imagePoint" : payload[@"imagePoint"],
    @"destinationPoint" : payload[@"expectedDestinationPoint"],
    @"space" : @{@"kind" : @"macos-screen", @"display" : display_ref},
    @"frameTimestamp" : selected[@"frameTimestamp"],
    @"topologyUnchanged" : @YES,
    @"interactionTarget" : target,
    @"hitOwnerTarget" : target,
  } mutableCopy];

  if (window_scope) {
    const MetaWindowRecord *resolved = snapshot_target(snapshot, target);
    if (resolved == NULL) {
      return failure(@"target-mismatch",
                     @"Window или surface отсутствует в bound snapshot");
    }
    NSDictionary *captured_window = geometry[@"capturedWindow"];
    if (captured_window != nil) {
      const MetaWindowRecord *owner = snapshot_owner_window(
          snapshot, target, resolved);
      uint64_t owner_pid = 0;
      uint64_t cg_window_id = 0;
      if (owner == NULL || !dictionary(captured_window) ||
          ![captured_window[@"windowRef"]
              isEqual:geometry[@"captureTarget"][@"ref"]] ||
          !integer(captured_window[@"ownerPid"], INT32_MAX, &owner_pid) ||
          !integer(captured_window[@"cgWindowId"], UINT32_MAX,
                   &cg_window_id) ||
          owner_pid != (uint64_t)owner->pid ||
          cg_window_id != owner->cg_window_id ||
          !same_logical_frame(captured_window[@"logicalFrame"], owner)) {
        return failure(@"target-mismatch",
                       @"Captured window не совпадает с bound AX/CG owner");
      }
    } else if ([geometry[@"source"] isEqual:@"window-isolated"]) {
      return failure(@"observation-stale",
                     @"Window capture потерял cached capturedWindow geometry");
    }
    MetaHitTestWindowRelation relation = self.windowProbe(
        target, payload[@"expectedDestinationPoint"], snapshot);
    if (relation == MetaHitTestWindowRelationUnavailable) {
      return failure(@"ax-unavailable",
                     @"Fresh AX geometry, focus или hit-test недоступны");
    }
    if (relation == MetaHitTestWindowRelationNone) {
      return failure(@"focus-mismatch",
                     @"Fresh focused AX owner не совпадает с interaction target");
    }
    if (relation != MetaHitTestWindowRelationExact &&
        relation != MetaHitTestWindowRelationOwnedDescendant) {
      return failure(@"ax-unavailable",
                     @"Window probe вернул неизвестную relation");
    }
    const BOOL fence_still_valid = self.pendingFenceValidator(operation);
    const BOOL session_still_ready =
        trusted_session_ready(self.sessionReadinessProvider());
    if (!fence_still_valid || !session_still_ready) {
      return failure(@"cancelled",
                     @"Fence или trusted session readiness отозваны во время window probe");
    }
    if ([NSDate.date compare:deadline] != NSOrderedAscending) {
      return failure(@"cancelled",
                     @"Operation deadline истёк во время window hit-test");
    }
    confirmed[@"observedAt"] = iso_now();
    confirmed[@"scope"] = @"window";
    confirmed[@"focusedTarget"] = target;
    confirmed[@"hitRelation"] =
        relation == MetaHitTestWindowRelationExact
            ? @"exact"
            : @"owned-descendant";
    confirmed[@"focusRelation"] = @"target";
    confirmed[@"frameUnchanged"] = @YES;
    return confirmed;
  }

  if ([target_kind isEqual:@"display"]) {
    if (![target_ref isEqual:display_ref]) {
      return failure(@"target-mismatch",
                     @"Explicit display target не совпадает с point region");
    }
  } else {
    uint64_t layout_revision = 0;
    if (![target_ref[@"layoutRef"] isEqual:@(snapshot->layout_ref)] ||
        !integer(target_ref[@"displayLayoutRevision"],
                 9007199254740991ULL, &layout_revision) ||
        layout_revision != snapshot->display_layout_revision) {
      return failure(@"target-mismatch",
                     @"Desktop layout target не совпадает с bound topology");
    }
  }
  if (!self.topologyProbe(snapshot)) {
    return failure(@"inventory-stale",
                   @"Fresh display topology не совпадает с bound snapshot");
  }
  const BOOL fence_still_valid = self.pendingFenceValidator(operation);
  const BOOL session_still_ready =
      trusted_session_ready(self.sessionReadinessProvider());
  if (!fence_still_valid || !session_still_ready) {
    return failure(@"cancelled",
                   @"Fence или trusted session readiness отозваны во время topology probe");
  }
  if ([NSDate.date compare:deadline] != NSOrderedAscending) {
    return failure(@"cancelled",
                   @"Operation deadline истёк во время topology hit-test");
  }
  confirmed[@"observedAt"] = iso_now();
  confirmed[@"scope"] = @"display";
  confirmed[@"hitRelation"] = @"display-contained";
  confirmed[@"focusRelation"] = @"not-required-display-focus";
  return confirmed;
}

@end
