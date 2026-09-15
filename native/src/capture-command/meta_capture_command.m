#import "meta_capture_command.h"

#import <CommonCrypto/CommonDigest.h>

#include <string.h>

#include "../../include/meta_serialization.h"

NSErrorDomain const MetaCaptureCommandErrorDomain = @"@meta/macos.capture-command";

@interface MetaCaptureCommandRecord : NSObject

@property(nonatomic, copy) NSString *taskRef;
@property(nonatomic, copy) NSString *operationId;
@property(nonatomic, copy) NSDictionary *acceptedFence;
@property(nonatomic, copy) NSString *sourceResponseRef;
@property(nonatomic, copy) NSString *statusEvidencePrefix;
@property(nonatomic, copy) NSString *terminalReceiptPrefix;
@property(nonatomic, copy) NSString *inventoryId;
@property(nonatomic) uint64_t inventoryRevision;
@property(nonatomic) uint64_t displayLayoutRevision;
@property(nonatomic, copy) NSString *observedAt;
@property(nonatomic, copy) NSString *observationId;
@property(nonatomic, copy) NSString *frameRef;
@property(nonatomic, copy) NSString *expiresAt;
@property(nonatomic, copy) NSString *source;
@property(nonatomic, copy) NSString *caption;
@property(nonatomic, copy) NSDictionary *target;
@property(nonatomic, copy) NSDictionary *nativeMapping;
@property(nonatomic, copy, nullable) NSDictionary *capturedWindow;
@property(nonatomic, copy) NSDictionary *clip;
@property(nonatomic, copy) NSString *cursor;
@property(nonatomic) double scale;
@property(nonatomic) uint32_t maxWidthPixels;
@property(nonatomic) uint32_t maxHeightPixels;
@property(nonatomic) uint64_t maxPixels;
@property(nonatomic) uint64_t maxEncodedBytes;
@property(nonatomic, copy, nullable) NSDictionary *frameMetadata;
@property(nonatomic) BOOL terminalEvidenceEmitted;
@property(nonatomic) uint64_t terminalStatusRevision;
@property(nonatomic, copy, nullable) NSString *terminalDrainedEvidenceRef;
@property(nonatomic, copy, nullable) NSString *terminalReceiptRef;

@end

@implementation MetaCaptureCommandRecord
@end

static BOOL fail(NSError **error, MetaCaptureCommandError code,
                 NSString *message) {
  if (error != NULL) {
    *error = [NSError errorWithDomain:MetaCaptureCommandErrorDomain
                                 code:code
                             userInfo:@{NSLocalizedDescriptionKey : message}];
  }
  return NO;
}

static BOOL valid_string(id value, NSUInteger maximum) {
  return [value isKindOfClass:[NSString class]] &&
         [(NSString *)value length] >= 1 &&
         [(NSString *)value length] <= maximum &&
         [(NSString *)value canBeConvertedToEncoding:NSASCIIStringEncoding];
}

static BOOL unsigned_integer(id value, uint64_t *result) {
  if (![value isKindOfClass:[NSNumber class]]) return NO;
  double number = [(NSNumber *)value doubleValue];
  uint64_t converted = [(NSNumber *)value unsignedLongLongValue];
  if (!isfinite(number) || number < 0 || number != (double)converted) return NO;
  if (result != NULL) *result = converted;
  return YES;
}

static BOOL positive_u32(id value, uint32_t *result) {
  uint64_t converted = 0;
  if (!unsigned_integer(value, &converted) || converted == 0 ||
      converted > UINT32_MAX) {
    return NO;
  }
  if (result != NULL) *result = (uint32_t)converted;
  return YES;
}

static BOOL positive_i32(id value, int32_t *result) {
  uint64_t converted = 0;
  if (!unsigned_integer(value, &converted) || converted == 0 ||
      converted > INT32_MAX) {
    return NO;
  }
  if (result != NULL) *result = (int32_t)converted;
  return YES;
}

static BOOL dimensions_fit(uint64_t width, uint64_t height,
                           uint64_t max_pixels) {
  return width > 0 && height > 0 && max_pixels > 0 &&
         width <= max_pixels / height;
}

static BOOL copy_identifier(NSString *value, char output[META_NATIVE_REF_CAPACITY]) {
  if (!valid_string(value, META_NATIVE_REF_CAPACITY - 1)) return NO;
  return [value getCString:output
                 maxLength:META_NATIVE_REF_CAPACITY
                  encoding:NSASCIIStringEncoding];
}

static NSString *iso_from_micros(uint64_t micros) {
  NSDate *date = [NSDate dateWithTimeIntervalSince1970:
                            (NSTimeInterval)micros / 1000000.0];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:date];
}

static NSString *iso_now(void) {
  return iso_from_micros((uint64_t)(NSDate.date.timeIntervalSince1970 * 1000000.0));
}

static NSDate *date_from_iso(NSString *value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:value];
}

static NSString *status_cleanup(MetaCaptureCleanup cleanup) {
  if (cleanup == MetaCaptureCleanupComplete) return @"complete";
  if (cleanup == MetaCaptureCleanupUnknown) return @"unknown";
  return @"pending";
}

static NSDictionary *status_value(NSString *task_ref,
                                  MetaCaptureTaskStatus status) {
  return @{
    @"captureTaskRef" : task_ref,
    @"revision" : @(status.revision),
    @"completionDelivered" : @(status.completionDelivered),
    @"stopRequested" : @(status.stopRequested),
    @"stopCallInFlight" : @(status.stopCallInFlight),
    @"stopAttemptCount" : @(status.stopAttemptCount),
    @"startPending" : @(status.startPending),
    @"streamStarted" : @(status.streamStarted),
    @"streamStopped" : @(status.streamStopped),
    @"encodingInFlight" : @(status.encodingInFlight),
    @"cleanup" : status_cleanup(status.cleanup),
    @"drained" : @(status.drained),
  };
}

static BOOL same_generation(NSDictionary *value, NSString *runtime_epoch,
                            NSString *login_session_id,
                            NSString *native_generation) {
  return [value isKindOfClass:[NSDictionary class]] &&
         [value[@"runtimeEpoch"] isEqual:runtime_epoch] &&
         [value[@"loginSessionId"] isEqual:login_session_id] &&
         [value[@"nativeGeneration"] isEqual:native_generation];
}

static BOOL same_ref(NSDictionary *left, NSDictionary *right) {
  return [left isKindOfClass:[NSDictionary class]] &&
         [right isKindOfClass:[NSDictionary class]] &&
         [left isEqualToDictionary:right];
}

static const MetaDisplayRecord *find_display(const MetaInventorySnapshot *snapshot,
                                             NSString *display_ref,
                                             uint32_t display_id) {
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    const MetaDisplayRecord *display = &snapshot->displays[index];
    if (display->display_id == display_id &&
        [display_ref isEqualToString:@(display->display_ref)]) {
      return display;
    }
  }
  return NULL;
}

static const MetaWindowRecord *find_window(const MetaInventorySnapshot *snapshot,
                                           NSString *window_ref,
                                           uint32_t window_id,
                                           int32_t owner_pid) {
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *window = &snapshot->windows[index];
    if (window->surface_ref[0] == '\0' &&
        window->mapping == META_MAPPING_CORROBORATED &&
        window->cg_window_id == window_id && window->pid == owner_pid &&
        [window_ref isEqualToString:@(window->window_ref)]) {
      return window;
    }
  }
  return NULL;
}

static BOOL mapping_displays_match(const MetaInventorySnapshot *snapshot,
                                   NSArray *mappings,
                                   const MetaWindowRecord *window,
                                   NSString *runtime_epoch,
                                   NSString *login_session_id,
                                   NSString *native_generation,
                                   uint64_t display_layout_revision) {
  if (window == NULL || ![mappings isKindOfClass:[NSArray class]] ||
      mappings.count == 0 ||
      mappings.count > 64) {
    return NO;
  }
  NSMutableSet *native_ids = [NSMutableSet set];
  for (id candidate in mappings) {
    if (![candidate isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *mapping = candidate;
    NSDictionary *ref = mapping[@"ref"];
    uint32_t display_id = 0;
    uint64_t revision = 0;
    if (!positive_u32(mapping[@"nativeDisplayId"], &display_id) ||
        !same_generation(ref, runtime_epoch, login_session_id,
                         native_generation) ||
        !unsigned_integer(ref[@"displayLayoutRevision"], &revision) ||
        revision != display_layout_revision ||
        !valid_string(ref[@"displayRef"], 127) ||
        find_display(snapshot, ref[@"displayRef"], display_id) == NULL ||
        [native_ids containsObject:@(display_id)]) {
      return NO;
    }
    [native_ids addObject:@(display_id)];
  }
  NSMutableSet *covered_native_ids = [NSMutableSet set];
  CGRect window_rect = CGRectMake(window->frame.x, window->frame.y,
                                  window->frame.width, window->frame.height);
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    const MetaDisplayRecord *display = &snapshot->displays[index];
    CGRect display_rect = CGRectMake(display->bounds.x, display->bounds.y,
                                     display->bounds.width,
                                     display->bounds.height);
    CGRect intersection = CGRectIntersection(window_rect, display_rect);
    if (!CGRectIsNull(intersection) && !CGRectIsEmpty(intersection)) {
      [covered_native_ids addObject:@(display->display_id)];
    }
  }
  if (![covered_native_ids isEqualToSet:native_ids]) return NO;
  return YES;
}

static BOOL layout_displays_match(const MetaInventorySnapshot *snapshot,
                                  NSArray *targets,
                                  NSArray *mappings,
                                  NSString *runtime_epoch,
                                  NSString *login_session_id,
                                  NSString *native_generation,
                                  uint64_t display_layout_revision) {
  if (![targets isKindOfClass:[NSArray class]] ||
      ![mappings isKindOfClass:[NSArray class]] || targets.count == 0 ||
      targets.count > 64 || targets.count != mappings.count) {
    return NO;
  }
  NSMutableSet *matched = [NSMutableSet set];
  for (NSDictionary *target in targets) {
    if (![target isKindOfClass:[NSDictionary class]] ||
        ![target[@"kind"] isEqual:@"display"]) {
      return NO;
    }
    uint32_t display_id = 0;
    if (!positive_u32(target[@"nativeDisplayId"], &display_id)) return NO;
    NSDictionary *target_ref = target[@"target"][@"ref"];
    NSDictionary *mapping_match = nil;
    for (NSDictionary *mapping in mappings) {
      if ([mapping[@"nativeDisplayId"] isEqual:@(display_id)]) {
        mapping_match = mapping;
        break;
      }
    }
    uint64_t revision = 0;
    if (mapping_match == nil || [matched containsObject:@(display_id)] ||
        !same_ref(mapping_match[@"ref"], target_ref) ||
        !same_generation(target_ref, runtime_epoch, login_session_id,
                         native_generation) ||
        !unsigned_integer(target_ref[@"displayLayoutRevision"], &revision) ||
        revision != display_layout_revision ||
        find_display(snapshot, target_ref[@"displayRef"], display_id) == NULL) {
      return NO;
    }
    [matched addObject:@(display_id)];
  }
  return matched.count == mappings.count;
}

static BOOL copy_fence(NSDictionary *value, MetaFence *fence) {
  uint64_t counter = 0;
  if (![value isKindOfClass:[NSDictionary class]] ||
      !unsigned_integer(value[@"counter"], &counter) || counter == 0 ||
      !copy_identifier(value[@"runtimeEpoch"], fence->runtime_epoch) ||
      !copy_identifier(value[@"loginSessionId"], fence->login_session_id) ||
      !copy_identifier(value[@"nativeGeneration"], fence->native_generation)) {
    return NO;
  }
  fence->counter = counter;
  return YES;
}

static NSString *outcome_value(MetaCaptureOutcome outcome) {
  switch (outcome) {
    case MetaCaptureOutcomeSucceeded: return @"succeeded";
    case MetaCaptureOutcomeCancelled: return @"cancelled";
    case MetaCaptureOutcomeTimedOut: return @"timed-out";
    case MetaCaptureOutcomeFailed: return @"failed";
  }
  return @"failed";
}

static NSString *error_code_value(MetaCaptureErrorCode code) {
  switch (code) {
    case MetaCaptureErrorNone: return @"none";
    case MetaCaptureErrorInvalidRequest: return @"invalid-request";
    case MetaCaptureErrorPermissionDenied: return @"permission-denied";
    case MetaCaptureErrorTargetUnavailable: return @"target-unavailable";
    case MetaCaptureErrorTargetChanged: return @"target-changed";
    case MetaCaptureErrorFrameUnavailable: return @"frame-unavailable";
    case MetaCaptureErrorFrameStale: return @"frame-stale";
    case MetaCaptureErrorBudgetExceeded: return @"budget-exceeded";
    case MetaCaptureErrorEncodingFailed: return @"encoding-failed";
    case MetaCaptureErrorStreamFailed: return @"stream-failed";
    case MetaCaptureErrorCancelled: return @"cancelled";
    case MetaCaptureErrorTimedOut: return @"timed-out";
  }
  return @"stream-failed";
}

static NSString *sha256(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {0};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *value = [NSMutableString stringWithCapacity:64];
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    [value appendFormat:@"%02x", digest[index]];
  }
  return value;
}

static NSString *response_ref(NSString *task_ref, NSString *request_id,
                              NSString *purpose) {
  NSString *identity = [NSString stringWithFormat:@"%@|%@|%@", task_ref,
      request_id, purpose];
  NSString *digest = sha256([identity dataUsingEncoding:NSUTF8StringEncoding]);
  return [NSString stringWithFormat:@"capture:response:%@",
      [digest substringToIndex:32]];
}

@interface MetaCaptureCommandBinder ()

@property(nonatomic) MetaCaptureRouter *router;
@property(nonatomic, copy) MetaCaptureInventoryProvider inventoryProvider;
@property(nonatomic, copy) MetaCaptureTopologyValidator topologyValidator;
@property(nonatomic, copy) NSString *nativeGeneration;
@property(nonatomic, copy) NSString *nativeBuildId;
@property(nonatomic) NSLock *lock;
@property(nonatomic) NSMutableDictionary<NSString *, MetaCaptureCommandRecord *> *records;
@property(nonatomic) NSMutableDictionary<NSString *, NSDictionary *> *frameGeometries;
@property(nonatomic) NSUInteger pendingStarts;

@end

@implementation MetaCaptureCommandBinder

- (nullable instancetype)initWithRouter:(MetaCaptureRouter *)router
                       inventoryProvider:(MetaCaptureInventoryProvider)inventoryProvider
                       topologyValidator:(MetaCaptureTopologyValidator)topologyValidator
                        nativeGeneration:(NSString *)nativeGeneration
                           nativeBuildId:(NSString *)nativeBuildId {
  if (router == NULL || inventoryProvider == nil || topologyValidator == nil ||
      !valid_string(nativeGeneration, 64) || !valid_string(nativeBuildId, 127)) {
    return nil;
  }
  self = [super init];
  if (self == nil) return nil;
  _router = router;
  _inventoryProvider = [inventoryProvider copy];
  _topologyValidator = [topologyValidator copy];
  _nativeGeneration = [nativeGeneration copy];
  _nativeBuildId = [nativeBuildId copy];
  _lock = [[NSLock alloc] init];
  _records = [NSMutableDictionary dictionary];
  _frameGeometries = [NSMutableDictionary dictionary];
  return self;
}

- (nullable NSDictionary *)handleStartRequest:(NSDictionary *)request
                               validationOnly:(BOOL)validationOnly
                                        error:(NSError **)error {
  if (![request isKindOfClass:[NSDictionary class]]) {
    fail(error, MetaCaptureCommandInvalidRequest,
         @"Capture start должен быть JSON object");
    return nil;
  }
  NSDictionary *operation = request[@"operation"];
  NSDictionary *payload = request[@"payload"];
  NSDictionary *capture = payload[@"request"];
  NSDictionary *publication = capture[@"publication"];
  NSDictionary *target_wrapper = capture[@"target"];
  NSDictionary *target = target_wrapper[@"target"];
  NSDictionary *native_mapping = payload[@"nativeMapping"];
  NSDictionary *fence = operation[@"fence"];
  NSString *runtime_epoch = request[@"runtimeEpoch"];
  NSString *login_session_id = request[@"loginSessionId"];
  NSString *operation_id = operation[@"operationId"];
  NSString *native_generation = request[@"nativeGeneration"];
  if (![request[@"method"] isEqual:@"capture.start"] ||
      ![request[@"intent"] isEqual:@"mutation"] ||
      !valid_string(operation_id, 127) ||
      ![native_generation isEqual:self.nativeGeneration] ||
      !same_generation(operation, runtime_epoch, login_session_id,
                       self.nativeGeneration) ||
      !same_generation(fence, runtime_epoch, login_session_id,
                       self.nativeGeneration) ||
      !same_generation(target[@"ref"], runtime_epoch, login_session_id,
                       self.nativeGeneration) ||
      !same_ref(operation[@"target"], target)) {
    fail(error, MetaCaptureCommandInvalidRequest,
         @"Capture start не совпадает с admitted operation/generation/fence");
    return nil;
  }
  const MetaInventorySnapshot *snapshot = self.inventoryProvider();
  uint64_t inventory_revision = 0;
  uint64_t layout_revision = 0;
  if (snapshot == NULL ||
      strcmp(snapshot->native_generation, self.nativeGeneration.UTF8String) != 0 ||
      ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      !unsigned_integer(operation[@"inventoryRevision"], &inventory_revision) ||
      inventory_revision != snapshot->revision ||
      ![publication[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      !unsigned_integer(publication[@"inventoryRevision"], &inventory_revision) ||
      inventory_revision != snapshot->revision ||
      !unsigned_integer(publication[@"displayLayoutRevision"], &layout_revision) ||
      layout_revision != snapshot->display_layout_revision ||
      !same_generation(publication, runtime_epoch, login_session_id,
                       self.nativeGeneration)) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture start ссылается не на текущий authoritative inventory");
    return nil;
  }
  NSString *target_kind = target_wrapper[@"kind"];
  if (([target_kind isEqual:@"display"] ||
       [target_kind isEqual:@"desktop-layout"]) &&
      !self.topologyValidator(snapshot)) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture display topology не подтверждена независимо от AX inventory");
    return nil;
  }
  NSDate *operation_deadline = date_from_iso(request[@"deadlineAt"]);
  NSTimeInterval remaining_seconds =
      [operation_deadline timeIntervalSinceDate:NSDate.date];
  if (operation_deadline == nil || remaining_seconds <= 0) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture operation deadline уже истёк");
    return nil;
  }
  uint64_t remaining_milliseconds = MAX(
      1, (uint64_t)floor(remaining_seconds * 1000.0));
  if (remaining_milliseconds < 2) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture operation deadline не оставляет cleanup budget");
    return nil;
  }
  MetaCaptureRequest native_request = meta_capture_request_default();
  native_request.stopTimeoutMilliseconds = (uint32_t)MIN(
      [payload[@"stopTimeoutMs"] unsignedLongLongValue],
      MAX(1, remaining_milliseconds / 2));
  native_request.captureTimeoutMilliseconds = (uint32_t)MIN(
      [payload[@"captureTimeoutMs"] unsignedLongLongValue],
      remaining_milliseconds - native_request.stopTimeoutMilliseconds);
  native_request.maxPixels = [capture[@"output"][@"maxPixels"] unsignedLongLongValue];
  native_request.maxEncodedBytes = [capture[@"output"][@"maxEncodedBytes"] unsignedLongLongValue];
  native_request.outputScale = [capture[@"output"][@"scale"] doubleValue];
  native_request.showsCursor = [capture[@"cursor"] isEqual:@"include"];
  native_request.caption = (__bridge CFStringRef)capture[@"caption"];
  if ([capture[@"clip"][@"kind"] isEqual:@"rect"]) {
    NSDictionary *rect = capture[@"clip"][@"rect"];
    native_request.hasRegion = true;
    native_request.regionPoints = CGRectMake([rect[@"x"] doubleValue],
                                             [rect[@"y"] doubleValue],
                                             [rect[@"width"] doubleValue],
                                             [rect[@"height"] doubleValue]);
  }
  MetaCaptureRequest *layout_children = NULL;
  size_t layout_child_count = 0;
  MetaCaptureLayoutTaskRequest layout_request = {0};
  if ([target_kind isEqual:@"desktop-layout"] &&
      [native_mapping[@"kind"] isEqual:@"desktop-layout"]) {
    NSArray *targets = target_wrapper[@"displays"];
    NSArray *mappings = native_mapping[@"displays"];
    if (![capture[@"source"] isEqual:@"display-composite"] ||
        ![capture[@"clip"][@"kind"] isEqual:@"full-target"] ||
        ![target[@"ref"][@"layoutRef"] isEqual:@(snapshot->layout_ref)] ||
        !layout_displays_match(snapshot, targets, mappings, runtime_epoch,
                               login_session_id, self.nativeGeneration,
                               layout_revision)) {
      fail(error, MetaCaptureCommandStaleAuthority,
           @"Desktop layout mapping не совпадает с текущей topology");
      return nil;
    }
    layout_child_count = mappings.count;
    layout_children = calloc(layout_child_count, sizeof(*layout_children));
    if (layout_children == NULL) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Не удалось выделить bounded layout child requests");
      return nil;
    }
    CGRect layout_bounds = CGRectNull;
    double maximum_scale = 1;
    uint64_t total_child_pixels = 0;
    uint64_t child_encoded_budget = native_request.maxEncodedBytes /
                                    layout_child_count;
    for (NSUInteger index = 0; index < mappings.count; index += 1) {
      NSDictionary *mapping = mappings[index];
      uint32_t display_id = [mapping[@"nativeDisplayId"] unsignedIntValue];
      const MetaDisplayRecord *display = find_display(
          snapshot, mapping[@"ref"][@"displayRef"], display_id);
      CGRect bounds = CGRectMake(display->bounds.x, display->bounds.y,
                                 display->bounds.width,
                                 display->bounds.height);
      layout_bounds = CGRectIsNull(layout_bounds)
          ? bounds : CGRectUnion(layout_bounds, bounds);
      maximum_scale = MAX(maximum_scale, display->scale);
      uint64_t width = (uint64_t)ceil(bounds.size.width * display->scale *
                                      native_request.outputScale);
      uint64_t height = (uint64_t)ceil(bounds.size.height * display->scale *
                                       native_request.outputScale);
      uint64_t child_pixels = width > 0 && height > 0 &&
          width <= UINT64_MAX / height ? width * height : UINT64_MAX;
      if (width == 0 || height == 0 || width > UINT32_MAX ||
          height > UINT32_MAX || child_pixels > native_request.maxPixels ||
          total_child_pixels > native_request.maxPixels - child_pixels ||
          child_encoded_budget == 0) {
        free(layout_children);
        fail(error, MetaCaptureCommandRouterFailure,
             @"Layout child captures превышают общий budget");
        return nil;
      }
      total_child_pixels += child_pixels;
      layout_children[index] = native_request;
      layout_children[index].source = MetaCaptureSourceDisplayComposite;
      layout_children[index].displayID = display_id;
      layout_children[index].hasRegion = false;
      layout_children[index].maxPixels = child_pixels;
      layout_children[index].maxEncodedBytes = child_encoded_budget;
    }
    double pixels_per_point = maximum_scale * native_request.outputScale;
    uint64_t output_width = (uint64_t)ceil(layout_bounds.size.width *
                                           pixels_per_point);
    uint64_t output_height = (uint64_t)ceil(layout_bounds.size.height *
                                            pixels_per_point);
    uint32_t max_width = [capture[@"output"][@"maxWidthPx"] unsignedIntValue];
    uint32_t max_height = [capture[@"output"][@"maxHeightPx"] unsignedIntValue];
    if (!isfinite(pixels_per_point) || pixels_per_point <= 0 ||
        output_width == 0 || output_height == 0 || output_width > max_width ||
        output_height > max_height || output_width > UINT32_MAX ||
        output_height > UINT32_MAX ||
        !dimensions_fit(output_width, output_height,
                        native_request.maxPixels)) {
      free(layout_children);
      fail(error, MetaCaptureCommandRouterFailure,
           @"Desktop layout output превышает общий budget");
      return nil;
    }
    layout_request = (MetaCaptureLayoutTaskRequest){
        .child_requests = layout_children,
        .child_count = layout_child_count,
        .caption = native_request.caption,
        .output_scale = native_request.outputScale,
        .max_width_pixels = max_width,
        .max_height_pixels = max_height,
        .max_pixels = native_request.maxPixels,
        .max_encoded_bytes = native_request.maxEncodedBytes,
    };
  } else if ([target_kind isEqual:@"display"] &&
      [native_mapping[@"kind"] isEqual:@"display"]) {
    NSDictionary *display_mapping = native_mapping[@"display"];
    NSDictionary *display_ref = display_mapping[@"ref"];
    uint32_t display_id = 0;
    if (![capture[@"source"] isEqual:@"display-composite"] ||
        !positive_u32(target_wrapper[@"nativeDisplayId"], &display_id) ||
        ![display_mapping[@"nativeDisplayId"] isEqual:@(display_id)] ||
        !same_ref(target[@"ref"], display_ref) ||
        find_display(snapshot, display_ref[@"displayRef"], display_id) == NULL) {
      fail(error, MetaCaptureCommandStaleAuthority,
           @"Display mapping не совпадает с текущим registry snapshot");
      return nil;
    }
    native_request.source = MetaCaptureSourceDisplayComposite;
    native_request.displayID = display_id;
  } else if ([target_kind isEqual:@"window"] &&
             [native_mapping[@"kind"] isEqual:@"window"]) {
    uint32_t window_id = 0;
    int32_t owner_pid = 0;
    if (!positive_u32(target_wrapper[@"cgWindowId"], &window_id) ||
        !positive_i32(target_wrapper[@"ownerPid"], &owner_pid)) {
      fail(error, MetaCaptureCommandInvalidRequest,
           @"Window capture содержит некорректный CGWindowID/PID");
      return nil;
    }
    const MetaWindowRecord *window = find_window(
        snapshot, target[@"ref"][@"windowRef"], window_id, owner_pid);
    if (![capture[@"source"] isEqual:@"window-isolated"] ||
        ![native_mapping[@"cgWindowId"] isEqual:@(window_id)] ||
        ![native_mapping[@"ownerPid"] isEqual:@(owner_pid)] ||
        window == NULL ||
        !mapping_displays_match(snapshot, native_mapping[@"displays"],
                                window,
                                runtime_epoch, login_session_id,
                                self.nativeGeneration, layout_revision)) {
      fail(error, MetaCaptureCommandStaleAuthority,
           @"Window mapping не совпадает с текущим registry snapshot");
      return nil;
    }
    native_request.source = MetaCaptureSourceWindowIsolated;
    native_request.windowID = window_id;
    native_request.ownerPID = owner_pid;
  } else {
    fail(error, MetaCaptureCommandInvalidRequest,
         @"Capture target и native mapping имеют разные kind");
    return nil;
  }
  NSDate *publication_expiry = date_from_iso(publication[@"expiresAt"]);
  NSDate *now = NSDate.date;
  if (publication_expiry == nil ||
      [publication_expiry timeIntervalSinceDate:now] <= 0) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture publication уже истекла");
    return nil;
  }
  NSDate *maximum_expiry = [now dateByAddingTimeInterval:120];
  NSDate *geometry_expiry = [publication_expiry earlierDate:maximum_expiry];
  [self.lock lock];
  BOOL has_capacity = self.records.count + self.pendingStarts < 1024;
  [self.lock unlock];
  if (!has_capacity) {
    free(layout_children);
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture command metadata достигла bounded capacity");
    return nil;
  }
  if (validationOnly) {
    free(layout_children);
    return @{};
  }
  [self.lock lock];
  if (self.records.count + self.pendingStarts >= 1024) {
    [self.lock unlock];
    free(layout_children);
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture command metadata достигла bounded capacity");
    return nil;
  }
  self.pendingStarts += 1;
  [self.lock unlock];
  char task_ref_buffer[META_NATIVE_REF_CAPACITY] = {0};
  MetaCaptureTaskStatus status = {0};
  BOOL started = layout_children == NULL
      ? meta_capture_router_start(self.router, operation_id.UTF8String,
                                  &native_request, task_ref_buffer, &status)
      : meta_capture_router_start_layout(self.router, operation_id.UTF8String,
                                         &layout_request, task_ref_buffer,
                                         &status);
  free(layout_children);
  if (!started) {
    [self.lock lock];
    self.pendingStarts -= 1;
    [self.lock unlock];
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture router не принял start request");
    return nil;
  }
  NSString *task_ref = @(task_ref_buffer);
  MetaCaptureCommandRecord *record = [[MetaCaptureCommandRecord alloc] init];
  record.taskRef = task_ref;
  record.operationId = operation_id;
  record.acceptedFence = [fence copy];
  record.sourceResponseRef = response_ref(task_ref, request[@"requestId"],
                                          @"start");
  record.statusEvidencePrefix = [NSString stringWithFormat:@"%@:status", task_ref];
  record.terminalReceiptPrefix = [NSString stringWithFormat:@"%@:terminal", task_ref];
  record.inventoryId = @(snapshot->inventory_id);
  record.inventoryRevision = snapshot->revision;
  record.displayLayoutRevision = snapshot->display_layout_revision;
  record.observedAt = iso_from_micros(snapshot->captured_at_micros);
  record.observationId = publication[@"observationId"];
  record.frameRef = publication[@"frameRef"];
  record.expiresAt = iso_from_micros(
      (uint64_t)(geometry_expiry.timeIntervalSince1970 * 1000000.0));
  record.source = capture[@"source"];
  record.caption = capture[@"caption"];
  record.target = [target copy];
  record.nativeMapping = [native_mapping copy];
  if ([target_kind isEqual:@"window"]) {
    const MetaWindowRecord *window = find_window(
        snapshot, target[@"ref"][@"windowRef"], native_request.windowID,
        native_request.ownerPID);
    if (window != NULL) {
      record.capturedWindow = @{
        @"windowRef" : target[@"ref"],
        @"cgWindowId" : @(window->cg_window_id),
        @"ownerPid" : @(window->pid),
        @"logicalFrame" : @{
          @"x" : @(window->frame.x),
          @"y" : @(window->frame.y),
          @"width" : @(window->frame.width),
          @"height" : @(window->frame.height),
        },
      };
    }
  }
  record.clip = [capture[@"clip"] copy];
  record.cursor = native_request.showsCursor ? @"included" : @"excluded";
  record.scale = native_request.outputScale;
  record.maxWidthPixels = [capture[@"output"][@"maxWidthPx"] unsignedIntValue];
  record.maxHeightPixels = [capture[@"output"][@"maxHeightPx"] unsignedIntValue];
  record.maxPixels = native_request.maxPixels;
  record.maxEncodedBytes = native_request.maxEncodedBytes;
  [self.lock lock];
  self.pendingStarts -= 1;
  if (self.records[task_ref] != nil) {
    [self.lock unlock];
    meta_capture_router_cancel(self.router, task_ref.UTF8String);
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture command metadata достигла bounded capacity");
    return nil;
  }
  self.records[task_ref] = record;
  [self.lock unlock];
  NSString *status_ref = [NSString stringWithFormat:@"%@:%llu",
      record.statusEvidencePrefix, (unsigned long long)status.revision];
  return @{
    @"captureTaskRef" : task_ref,
    @"operationId" : operation_id,
    @"acceptedFence" : record.acceptedFence,
    @"sourceResponseRef" : record.sourceResponseRef,
    @"inventoryId" : record.inventoryId,
    @"inventoryRevision" : @(record.inventoryRevision),
    @"displayLayoutRevision" : @(record.displayLayoutRevision),
    @"observedAt" : record.observedAt,
    @"statusEvidenceRef" : status_ref,
    @"acceptedAt" : iso_now(),
    @"status" : status_value(task_ref, status),
  };
}

- (BOOL)validateStartRequest:(NSDictionary *)request error:(NSError **)error {
  return [self handleStartRequest:request validationOnly:YES error:error] != nil;
}

- (nullable NSDictionary *)startRequest:(NSDictionary *)request
                                   error:(NSError **)error {
  return [self handleStartRequest:request validationOnly:NO error:error];
}

- (NSDictionary *)statusEvidence:(MetaCaptureCommandRecord *)record
                           status:(MetaCaptureTaskStatus)status
                sourceResponseRef:(NSString *)sourceResponseRef {
  return @{
    @"operationId" : record.operationId,
    @"acceptedFence" : record.acceptedFence,
    @"sourceResponseRef" : sourceResponseRef,
    @"inventoryId" : record.inventoryId,
    @"inventoryRevision" : @(record.inventoryRevision),
    @"displayLayoutRevision" : @(record.displayLayoutRevision),
    @"observedAt" : record.observedAt,
    @"statusEvidenceRef" : [NSString stringWithFormat:@"%@:%llu",
        record.statusEvidencePrefix, (unsigned long long)status.revision],
  };
}

- (NSDictionary *)terminalEvidence:(MetaCaptureCommandRecord *)record
                              status:(MetaCaptureTaskStatus)status
                   sourceResponseRef:(NSString *)sourceResponseRef {
  NSString *drained = [NSString stringWithFormat:@"%@:%llu",
      record.statusEvidencePrefix, (unsigned long long)status.revision];
  NSString *terminal = [NSString stringWithFormat:@"%@:%llu",
      record.terminalReceiptPrefix, (unsigned long long)status.revision];
  return @{
    @"operationId" : record.operationId,
    @"acceptedFence" : record.acceptedFence,
    @"sourceResponseRef" : sourceResponseRef,
    @"inventoryId" : record.inventoryId,
    @"inventoryRevision" : @(record.inventoryRevision),
    @"displayLayoutRevision" : @(record.displayLayoutRevision),
    @"observedAt" : record.observedAt,
    @"drainedEvidenceRef" : drained,
    @"terminalReceiptRef" : terminal,
  };
}

- (NSDictionary *)cleanupAck:(NSDictionary *)control
                       status:(MetaCaptureTaskStatus)status
                     terminal:(nullable NSDictionary *)terminal {
  BOOL complete = status.cleanup == MetaCaptureCleanupComplete && status.drained;
  NSMutableDictionary *ack = [@{
    @"kind" : @"cleanup-ack",
    @"requestId" : control[@"requestId"],
    @"cleanupRequestId" : control[@"cleanupRequestId"],
    @"operationId" : control[@"operationId"],
    @"runtimeEpoch" : control[@"runtimeEpoch"],
    @"loginSessionId" : control[@"loginSessionId"],
    @"nativeGeneration" : control[@"nativeGeneration"],
    @"acceptedFence" : control[@"acceptedFence"],
    @"currentHighWaterFence" : control[@"currentHighWaterFence"],
    @"statusRevision" : @(status.revision),
    @"drainedEvidenceRef" : control[@"expectedDrainedEvidenceRef"],
    @"cleanup" : complete ? @"complete" :
        (status.cleanup == MetaCaptureCleanupUnknown ? @"unknown" : @"incomplete"),
    @"drained" : @(complete),
    @"quarantined" : complete ? @NO : @YES,
  } mutableCopy];
  if (complete && terminal != nil) {
    ack[@"terminalReceiptRef"] = terminal[@"terminalReceiptRef"];
  }
  return ack;
}

- (void)rememberTerminal:(NSDictionary *)terminal
                   status:(MetaCaptureTaskStatus)status
                   record:(MetaCaptureCommandRecord *)record {
  if (terminal == nil) return;
  [self.lock lock];
  record.terminalEvidenceEmitted = YES;
  record.terminalStatusRevision = status.revision;
  record.terminalDrainedEvidenceRef = terminal[@"drainedEvidenceRef"];
  record.terminalReceiptRef = terminal[@"terminalReceiptRef"];
  [self.lock unlock];
}

- (nullable NSDictionary *)executionResult:(const MetaCaptureResult *)result
                                      record:(MetaCaptureCommandRecord *)record
                                      status:(MetaCaptureTaskStatus)status
                            sourceResponseRef:(NSString *)sourceResponseRef
                                    terminal:(nullable NSDictionary *)terminal
                                  emitBinary:(MetaCaptureBinaryEmitter)emitBinary
                                       error:(NSError **)error {
  MetaCaptureSource expected_source = [record.source isEqual:@"display-composite"]
      ? MetaCaptureSourceDisplayComposite : MetaCaptureSourceWindowIsolated;
  NSString *actual_caption = result->caption == NULL
      ? nil : (__bridge NSString *)result->caption;
  BOOL expected_target = result->source == expected_source &&
      [actual_caption isEqual:record.caption];
  if ([record.nativeMapping[@"kind"] isEqual:@"display"]) {
    expected_target = expected_target &&
        result->requestedDisplayID ==
            [record.nativeMapping[@"display"][@"nativeDisplayId"] unsignedIntValue] &&
        result->requestedWindowID == 0 && result->requestedOwnerPID == 0;
  } else if ([record.nativeMapping[@"kind"] isEqual:@"window"]) {
    expected_target = expected_target && result->requestedDisplayID == 0 &&
        result->requestedWindowID ==
            [record.nativeMapping[@"cgWindowId"] unsignedIntValue] &&
        result->requestedOwnerPID ==
            [record.nativeMapping[@"ownerPid"] intValue];
  }
  if (!expected_target) {
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture result не совпадает с accepted source/target/caption");
    return nil;
  }
  BOOL complete = status.cleanup == MetaCaptureCleanupComplete && status.drained;
  BOOL success_shape = result->outcome == MetaCaptureOutcomeSucceeded &&
      result->errorCode == MetaCaptureErrorNone && result->errorMessage == NULL;
  BOOL failure_shape = result->outcome != MetaCaptureOutcomeSucceeded &&
      result->errorCode != MetaCaptureErrorNone && result->errorMessage != NULL &&
      [(__bridge NSString *)result->errorMessage length] >= 1 &&
      [(__bridge NSString *)result->errorMessage length] <= 2048;
  if (!status.completionDelivered || (!success_shape && !failure_shape)) {
    fail(error, MetaCaptureCommandRouterFailure,
         @"Capture completion имеет противоречивый outcome/status/error");
    return nil;
  }
  NSString *completion_observed_at = result->outcome == MetaCaptureOutcomeSucceeded
      ? iso_from_micros(result->capturedAtUnixNanoseconds / 1000ULL)
      : record.observedAt;
  NSMutableDictionary *value = [@{
    @"captureTaskRef" : record.taskRef,
    @"operationId" : record.operationId,
    @"acceptedFence" : record.acceptedFence,
    @"sourceResponseRef" : sourceResponseRef,
    @"observationId" : record.observationId,
    @"inventoryId" : record.inventoryId,
    @"inventoryRevision" : @(record.inventoryRevision),
    @"displayLayoutRevision" : @(record.displayLayoutRevision),
    @"observedAt" : completion_observed_at,
    @"outcome" : outcome_value(result->outcome),
    @"cleanup" : complete ? @"complete" : @"unknown",
    @"errorCode" : error_code_value(result->errorCode),
    @"source" : record.source,
    @"caption" : record.caption,
    @"target" : record.target,
    @"nativeMapping" : record.nativeMapping,
    @"clip" : record.clip,
    @"cursor" : record.cursor,
    @"scale" : @(record.scale),
    @"backend" : @{ @"name" : @"ScreenCaptureKit", @"buildId" : self.nativeBuildId },
    @"targetEvidence" : @{
      @"shareableTargetMatched" : @(result->shareableTargetMatched),
      @"beforeTargetMatched" : @(result->beforeTargetMatched),
      @"afterTargetMatched" : @(result->afterTargetMatched),
      @"boundsUnchanged" : @(result->boundsUnchanged),
      @"auxiliarySurfacesExcluded" : @(result->auxiliarySurfacesExcluded),
    },
    @"readinessFacts" : @[],
    @"statusRevision" : @(status.revision),
  } mutableCopy];
  if (result->errorMessage != NULL) {
    value[@"errorMessage"] = (__bridge NSString *)result->errorMessage;
  }
  if (complete) {
    value[@"drainedEvidenceRef"] = terminal[@"drainedEvidenceRef"];
    value[@"terminalReceiptRef"] = terminal[@"terminalReceiptRef"];
  }
  if (result->outcome == MetaCaptureOutcomeSucceeded) {
    @synchronized(record) {
    if (record.frameMetadata != nil) {
      value[@"frame"] = record.frameMetadata;
      return value;
    }
    uint64_t pixels = (uint64_t)result->imageWidthPixels *
                      (uint64_t)result->imageHeightPixels;
    if (result->pngData == NULL || result->encodedBytes == 0 ||
        result->encodedBytes != (uint64_t)CFDataGetLength(result->pngData) ||
        result->imageWidthPixels == 0 || result->imageHeightPixels == 0 ||
        result->imageWidthPixels > record.maxWidthPixels ||
        result->imageHeightPixels > record.maxHeightPixels ||
        pixels > record.maxPixels ||
        result->encodedBytes > record.maxEncodedBytes) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Успешный capture result не содержит целый PNG");
      return nil;
    }
    NSData *png = (__bridge NSData *)result->pngData;
    NSData *binary_identity = [[NSString stringWithFormat:@"%@|%@",
        record.taskRef, record.frameRef] dataUsingEncoding:NSUTF8StringEncoding];
    NSString *binary_digest = sha256(binary_identity);
    NSString *binary_token = [NSString stringWithFormat:@"capture:binary:%@",
        [binary_digest substringToIndex:32]];
    MetaCaptureFrameSerializationContext frame_context = {0};
    if (!copy_identifier(binary_token, frame_context.binary_token) ||
        !copy_identifier(record.frameRef, frame_context.frame_ref) ||
        ![sha256(png) getCString:frame_context.sha256
                      maxLength:sizeof(frame_context.sha256)
                       encoding:NSASCIIStringEncoding]) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Capture frame identity не помещается в native ABI");
      return nil;
    }
    CFDataRef frame_json = meta_capture_frame_copy_json(result, &frame_context);
    if (frame_json == NULL) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Capture frame metadata не сериализуется");
      return nil;
    }
    NSDictionary *frame = [NSJSONSerialization JSONObjectWithData:
        CFBridgingRelease(frame_json) options:0 error:error];
    if (![frame isKindOfClass:[NSDictionary class]]) return nil;
    NSMutableArray *geometry_regions = [NSMutableArray array];
    NSArray *mapping_displays = [record.nativeMapping[@"kind"] isEqual:@"display"]
        ? @[record.nativeMapping[@"display"]]
        : record.nativeMapping[@"displays"];
    NSMutableSet *accepted_display_ids = [NSMutableSet set];
    for (NSDictionary *mapping in mapping_displays) {
      NSNumber *display_id = mapping[@"nativeDisplayId"];
      if (display_id == nil || [accepted_display_ids containsObject:display_id]) {
        fail(error, MetaCaptureCommandRouterFailure,
             @"Accepted display mapping содержит повтор");
        return nil;
      }
      [accepted_display_ids addObject:display_id];
    }
    NSMutableSet *actual_display_ids = [NSMutableSet set];
    for (NSUInteger index = 0; index < [frame[@"regions"] count]; index += 1) {
      NSDictionary *region = frame[@"regions"][index];
      NSNumber *region_display_id = region[@"nativeDisplayId"];
      if (region_display_id == nil ||
          [actual_display_ids containsObject:region_display_id]) {
        fail(error, MetaCaptureCommandRouterFailure,
             @"Frame regions содержат повтор native display");
        return nil;
      }
      [actual_display_ids addObject:region_display_id];
      NSDictionary *matching = nil;
      for (NSDictionary *mapping in mapping_displays) {
        if ([mapping[@"nativeDisplayId"] isEqual:region[@"nativeDisplayId"]]) {
          matching = mapping;
          break;
        }
      }
      if (matching == nil) {
        fail(error, MetaCaptureCommandRouterFailure,
             @"Frame region не связана с accepted display mapping");
        return nil;
      }
      [geometry_regions addObject:@{
        @"regionIndex" : @(index),
        @"imageRect" : region[@"imageRect"],
        @"destinationRect" : region[@"destinationRect"],
        @"imageToDestination" : region[@"imageToDestination"],
        @"frameTimestamp" : region[@"frameTimestamp"],
        @"macosDisplayRef" : matching[@"ref"],
        @"nativeDisplayId" : region[@"nativeDisplayId"],
      }];
    }
    if (![actual_display_ids isEqualToSet:accepted_display_ids]) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Frame region set не совпадает с accepted display mapping");
      return nil;
    }
    NSMutableDictionary *geometry = [@{
      @"frameRef" : record.frameRef,
      @"observationId" : record.observationId,
      @"source" : record.source,
      @"captureTarget" : record.target,
      @"capturedAt" : frame[@"capturedAt"],
      @"expiresAt" : record.expiresAt,
      @"inventoryId" : record.inventoryId,
      @"inventoryRevision" : @(record.inventoryRevision),
      @"displayLayoutRevision" : @(record.displayLayoutRevision),
      @"imageSize" : @{
        @"widthPx" : frame[@"widthPx"],
        @"heightPx" : frame[@"heightPx"],
      },
      @"clip" : record.clip,
      @"regions" : geometry_regions,
    } mutableCopy];
    if (record.capturedWindow != nil) {
      geometry[@"capturedWindow"] = record.capturedWindow;
    }
    NSDictionary *header = @{
      @"channel" : @"binary",
      @"payload" : @{
        @"binaryToken" : binary_token,
        @"byteLength" : @(png.length),
      },
    };
    if (!emitBinary(header, png)) {
      fail(error, MetaCaptureCommandBinaryFailure,
           @"Transport не принял атомарный binary frame");
      return nil;
    }
    value[@"frame"] = frame;
    record.frameMetadata = [frame copy];
    [self.lock lock];
    self.frameGeometries[record.frameRef] = [geometry copy];
    [self.lock unlock];
    }
  }
  return value;
}

- (nullable NSDictionary *)cleanupRequest:(NSDictionary *)request
                                emitBinary:(MetaCaptureBinaryEmitter)emitBinary
                                     error:(NSError **)error {
  NSDictionary *control = request[@"control"];
  NSString *task_ref = request[@"payload"][@"captureTaskRef"];
  [self.lock lock];
  MetaCaptureCommandRecord *record = self.records[task_ref];
  [self.lock unlock];
  uint64_t expected_revision = 0;
  if (record == nil || !valid_string(task_ref, 127) ||
      ![control[@"kind"] isEqual:@"cleanup-only"] ||
      ![control[@"operationId"] isEqual:record.operationId] ||
      ![control[@"nativeGeneration"] isEqual:self.nativeGeneration] ||
      !same_ref(control[@"acceptedFence"], record.acceptedFence) ||
      !same_generation(control[@"currentHighWaterFence"],
                       control[@"runtimeEpoch"], control[@"loginSessionId"],
                       self.nativeGeneration) ||
      !unsigned_integer(control[@"expectedStatusRevision"], &expected_revision) ||
      !valid_string(control[@"expectedDrainedEvidenceRef"], 127)) {
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture cleanup не совпадает с accepted task/fence");
    return nil;
  }
  NSString *purpose = control[@"purpose"];
  NSString *source_response_ref = response_ref(
      task_ref, control[@"requestId"], purpose);
  if ([purpose isEqual:@"cancel"]) {
    fail(error, MetaCaptureCommandUnsupportedTarget,
         @"Cancel принадлежит общему broker lifecycle");
    return nil;
  }
  if ([purpose isEqual:@"release"]) {
    [self.lock lock];
    BOOL terminal_emitted = record.terminalEvidenceEmitted;
    uint64_t terminal_revision = record.terminalStatusRevision;
    NSString *terminal_drained = record.terminalDrainedEvidenceRef;
    NSString *terminal_receipt = record.terminalReceiptRef;
    [self.lock unlock];
    if (!terminal_emitted || expected_revision != terminal_revision ||
        ![control[@"expectedDrainedEvidenceRef"] isEqual:terminal_drained]) {
      fail(error, MetaCaptureCommandStaleAuthority,
           @"Release authority не совпадает с emitted terminal evidence");
      return nil;
    }
    MetaCaptureTaskStatus status = {
        .revision = expected_revision,
        .completionDelivered = true,
        .streamStopped = true,
        .cleanup = MetaCaptureCleanupComplete,
        .drained = true,
    };
    NSDictionary *terminal = @{ @"terminalReceiptRef" : terminal_receipt };
    MetaCaptureReleaseAuthority authority = {0};
    if (!copy_identifier(control[@"cleanupRequestId"],
                         authority.cleanup_request_id) ||
        !copy_identifier(record.operationId, authority.operation_id) ||
        !copy_identifier(control[@"runtimeEpoch"], authority.runtime_epoch) ||
        !copy_identifier(control[@"loginSessionId"], authority.login_session_id) ||
        !copy_identifier(self.nativeGeneration, authority.native_generation) ||
        !copy_identifier(task_ref, authority.task_ref) ||
        !copy_fence(control[@"acceptedFence"], &authority.accepted_fence) ||
        !copy_fence(control[@"currentHighWaterFence"],
                    &authority.current_high_water_fence) ||
        !copy_identifier(control[@"expectedDrainedEvidenceRef"],
                         authority.drained_evidence_ref) ||
        !copy_identifier(terminal[@"terminalReceiptRef"],
                         authority.terminal_receipt_ref)) {
      fail(error, MetaCaptureCommandInvalidRequest,
           @"Release authority не помещается в native ABI");
      return nil;
    }
    authority.expected_status_revision = expected_revision;
    MetaCaptureReleaseReceipt receipt = {0};
    if (!meta_capture_router_release_authorized(self.router, &authority,
                                                &receipt)) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Capture router отклонил release authority");
      return nil;
    }
    status.revision = receipt.status_revision;
    return @{
      @"purpose" : @"release",
      @"ack" : [self cleanupAck:control status:status terminal:terminal],
      @"alreadyReleased" : @(receipt.already_released),
    };
  }
  MetaCaptureTaskStatus status = {0};
  const MetaCaptureResult *result = NULL;
  BOOL result_held = NO;
  if ([purpose isEqual:@"result"]) {
    if (!meta_capture_router_result(self.router, task_ref.UTF8String, &status,
                                    &result)) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Capture result task не найден");
      return nil;
    }
    result_held = YES;
  } else if ([purpose isEqual:@"status"]) {
    if (!meta_capture_router_status(self.router, task_ref.UTF8String, &status)) {
      fail(error, MetaCaptureCommandRouterFailure,
           @"Capture status task не найден");
      return nil;
    }
  } else {
    fail(error, MetaCaptureCommandInvalidRequest,
         @"Неизвестный capture cleanup purpose");
    return nil;
  }
  if (status.revision < expected_revision) {
    if (result_held) {
      meta_capture_router_result_done(self.router, task_ref.UTF8String, result);
    }
    fail(error, MetaCaptureCommandStaleAuthority,
         @"Capture cleanup ожидает более новую status revision");
    return nil;
  }
  NSDictionary *status_evidence = [self statusEvidence:record status:status
      sourceResponseRef:source_response_ref];
  NSDictionary *terminal = status.drained && status.cleanup == MetaCaptureCleanupComplete
      ? [self terminalEvidence:record status:status
          sourceResponseRef:source_response_ref] : nil;
  NSDictionary *ack = [self cleanupAck:control status:status terminal:terminal];
  if ([purpose isEqual:@"status"]) {
    NSMutableDictionary *response = [@{
      @"purpose" : @"status",
      @"ack" : ack,
      @"statusEvidence" : status_evidence,
      @"status" : status_value(task_ref, status),
    } mutableCopy];
    if (terminal != nil) response[@"terminal"] = terminal;
    [self rememberTerminal:terminal status:status record:record];
    return response;
  }
  NSMutableDictionary *poll = [@{
    @"state" : result == NULL ? @"pending" : @"completed",
    @"captureTaskRef" : task_ref,
    @"status" : status_value(task_ref, status),
  } mutableCopy];
  if (result != NULL) {
    NSDictionary *execution = [self executionResult:result record:record
        status:status sourceResponseRef:source_response_ref terminal:terminal
        emitBinary:emitBinary error:error];
    if (execution != nil) poll[@"result"] = execution;
    meta_capture_router_result_done(self.router, task_ref.UTF8String, result);
    if (execution == nil) return nil;
  } else {
    meta_capture_router_result_done(self.router, task_ref.UTF8String, result);
  }
  [self rememberTerminal:terminal status:status record:record];
  return @{
    @"purpose" : @"result",
    @"ack" : ack,
    @"statusEvidence" : status_evidence,
    @"poll" : poll,
  };
}

- (nullable NSDictionary *)lookupFrameGeometry:(NSString *)frameRef {
  if (!valid_string(frameRef, 127)) return nil;
  [self.lock lock];
  NSDictionary *geometry = self.frameGeometries[frameRef];
  NSString *expires_at = geometry[@"expiresAt"];
  NSDate *expiry = date_from_iso(expires_at);
  if (geometry != nil &&
      (expiry == nil || [NSDate.date timeIntervalSinceDate:expiry] >= 0)) {
    [self.frameGeometries removeObjectForKey:frameRef];
    geometry = nil;
  }
  NSDictionary *result = [geometry copy];
  [self.lock unlock];
  return result;
}

@end
