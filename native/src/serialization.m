#import <Foundation/Foundation.h>

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "meta_serialization.h"

static NSString *tri_state(MetaTriState value) {
  if (value == META_TRUE) return @"true";
  if (value == META_FALSE) return @"false";
  return @"unknown";
}

static NSString *ax_status(MetaAXStatus value) {
  switch (value) {
    case META_AX_READY:
      return @"ready";
    case META_AX_NO_WINDOWS:
      return @"no-windows";
    case META_AX_TIMED_OUT:
      return @"timed-out";
    case META_AX_DENIED:
      return @"denied";
    case META_AX_UNAVAILABLE:
      return @"unavailable";
    case META_AX_FAILED:
      return @"failed";
  }
  return @"failed";
}

static NSString *mapping_status(MetaMappingStatus value) {
  switch (value) {
    case META_MAPPING_CORROBORATED:
      return @"corroborated";
    case META_MAPPING_AMBIGUOUS:
      return @"ambiguous";
    case META_MAPPING_UNAVAILABLE:
      return @"unavailable";
  }
  return @"unavailable";
}

static NSString *space_visibility(MetaSpaceVisibility value) {
  switch (value) {
    case META_SPACE_CURRENT:
      return @"current";
    case META_SPACE_NOT_CURRENT:
      return @"not-current";
    case META_SPACE_UNKNOWN:
      return @"unknown";
  }
  return @"unknown";
}

static NSDictionary *rect_value(MetaRect value) {
  return @{
    @"x" : @(value.x),
    @"y" : @(value.y),
    @"width" : @(value.width),
    @"height" : @(value.height),
  };
}

static NSString *iso_from_micros(uint64_t micros) {
  NSDate *date = [NSDate dateWithTimeIntervalSince1970:
                            (NSTimeInterval)micros / 1000000.0];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:date];
}

static NSArray *actions(const MetaWindowRecord *window) {
  NSMutableArray *result = [NSMutableArray array];
  if (window->can_raise) [result addObject:@"raise"];
  if (window->can_close) [result addObject:@"close"];
  if (window->can_minimize) [result addObject:@"minimize"];
  if (window->can_move) [result addObject:@"move"];
  if (window->can_resize) [result addObject:@"resize"];
  return result;
}

static NSDictionary *surface_value(const MetaWindowRecord *surface) {
  NSString *kind = @"unknown";
  if (surface->surface_kind == META_SURFACE_SHEET) kind = @"sheet";
  if (surface->surface_kind == META_SURFACE_POPUP) kind = @"popup";
  if (surface->surface_kind == META_SURFACE_MENU) kind = @"menu";
  return @{
    @"kind" : kind,
    @"surfaceRef" : @(surface->surface_ref),
    @"applicationRef" : @(surface->application_ref),
    @"ownerWindowRef" : @(surface->owner_window_ref),
    @"ownerPid" : @(surface->pid),
    @"title" : @(surface->title),
    @"role" : @(surface->role),
    @"subrole" : @(surface->subrole),
    @"frame" : rect_value(surface->frame),
    @"focused" : tri_state(surface->focused),
    @"advertisedActions" : actions(surface),
  };
}

static NSDictionary *ax_window_value(const MetaInventorySnapshot *snapshot,
                                     const MetaWindowRecord *window) {
  NSMutableArray *surfaces = [NSMutableArray array];
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->surface_ref[0] != '\0' &&
        strcmp(candidate->owner_window_ref, window->window_ref) == 0) {
      [surfaces addObject:surface_value(candidate)];
    }
  }
  NSMutableDictionary *result = [@{
    @"kind" : @"ax-window",
    @"windowRef" : @(window->window_ref),
    @"applicationRef" : @(window->application_ref),
    @"ownerPid" : @(window->pid),
    @"title" : @(window->title),
    @"role" : @(window->role),
    @"subrole" : @(window->subrole),
    @"frame" : rect_value(window->frame),
    @"applicationHidden" : tri_state(window->application_hidden),
    @"minimized" : tri_state(window->minimized),
    @"onScreen" : tri_state(window->on_screen),
    @"spaceVisibility" : space_visibility(window->space_visibility),
    @"fullscreen" : tri_state(window->fullscreen),
    @"focused" : tri_state(window->focused),
    @"main" : tri_state(window->main),
    @"mapping" : mapping_status(window->mapping),
    @"actionability" : window->actionability == META_ACTIONABILITY_AX
                            ? @"ax"
                            : @"unavailable",
    @"advertisedActions" : actions(window),
    @"surfaces" : surfaces,
  } mutableCopy];
  if (window->cg_window_id != 0) result[@"cgWindowId"] = @(window->cg_window_id);
  if (window->mapping == META_MAPPING_CORROBORATED) {
    result[@"axSnapshotRef"] = [NSString
        stringWithFormat:@"%@:ax", @(snapshot->inventory_id)];
    result[@"cgInventoryRef"] = [NSString
        stringWithFormat:@"%@:cg", @(snapshot->inventory_id)];
  }
  if (window->mapping != META_MAPPING_CORROBORATED) {
    result[@"mappingReason"] =
        window->mapping == META_MAPPING_AMBIGUOUS
            ? @"CG-AX correlation неоднозначна"
            : @"CG-AX correlation отсутствует";
  }
  if (window->actionability == META_ACTIONABILITY_UNAVAILABLE) {
    result[@"unavailableReason"] = @"Живой AX target отсутствует";
  }
  return result;
}

static NSDictionary *cg_window_value(const MetaWindowRecord *window) {
  return @{
    @"kind" : @"cg-only",
    @"ownerPid" : @(window->pid),
    @"cgWindowId" : @(window->cg_window_id),
    @"title" : @(window->title),
    @"frame" : rect_value(window->frame),
    @"onScreen" : tri_state(window->on_screen),
    @"spaceVisibility" : space_visibility(window->space_visibility),
    @"unavailableReason" : @"AX correlation отсутствует или неоднозначна",
  };
}

CFDataRef meta_inventory_copy_json(const MetaInventorySnapshot *snapshot,
                                   const char *source_response_ref) {
  if (snapshot == NULL || source_response_ref == NULL ||
      source_response_ref[0] == '\0' ||
      strnlen(source_response_ref, META_NATIVE_REF_CAPACITY) >=
          META_NATIVE_REF_CAPACITY) {
    return NULL;
  }
  @autoreleasepool {
    // Reject malformed titles through the existing serialization failure path.
    // Never fabricate an empty title or pass nil to a dictionary literal.
    for (size_t index = 0; index < snapshot->window_count; index += 1) {
      const MetaWindowRecord *window = &snapshot->windows[index];
      const size_t length = strnlen(window->title, sizeof(window->title));
      if (length == sizeof(window->title) ||
          [[NSString alloc] initWithBytes:window->title length:length
                                encoding:NSUTF8StringEncoding] == nil) return NULL;
    }
    NSMutableArray *applications = [NSMutableArray array];
    NSMutableArray *windows = [NSMutableArray array];
    NSMutableArray *displays = [NSMutableArray array];
    NSMutableArray *errors = [NSMutableArray array];
    for (size_t index = 0; index < snapshot->application_count; index += 1) {
      const MetaApplicationRecord *application =
          &snapshot->applications[index];
      NSMutableDictionary *value = [@{
        @"applicationRef" : @(application->application_ref),
        @"registrationNonce" : @(application->registration_nonce),
        @"pid" : @(application->pid),
        @"launchedAt" : iso_from_micros(application->launch_time_micros),
        @"name" : @(application->name),
        @"hidden" : tri_state(application->hidden),
        @"axStatus" : ax_status(application->ax_status),
        @"windowCount" : @(application->window_count),
      } mutableCopy];
      if (application->bundle_id[0] != '\0') {
        value[@"bundleId"] = @(application->bundle_id);
      }
      if (application->ax_status != META_AX_READY &&
          application->ax_status != META_AX_NO_WINDOWS) {
        NSString *reason = [NSString
            stringWithFormat:@"AX inventory приложения %@: %@",
                             @(application->name),
                             ax_status(application->ax_status)];
        value[@"axReason"] = reason;
        [errors addObject:reason];
      }
      [applications addObject:value];
    }
    for (size_t index = 0; index < snapshot->window_count; index += 1) {
      const MetaWindowRecord *window = &snapshot->windows[index];
      if (window->window_ref[0] != '\0') {
        [windows addObject:ax_window_value(snapshot, window)];
      } else if (window->surface_ref[0] == '\0' &&
                 window->cg_window_id != 0) {
        NSMutableDictionary *value = [cg_window_value(window) mutableCopy];
        if (window->application_ref[0] != '\0') {
          value[@"applicationRef"] = @(window->application_ref);
        }
        [windows addObject:value];
      }
    }
    for (size_t index = 0; index < snapshot->display_count; index += 1) {
      const MetaDisplayRecord *display = &snapshot->displays[index];
      [displays addObject:@{
        @"displayRef" : @(display->display_ref),
        @"nativeDisplayId" : @(display->display_id),
        @"bounds" : rect_value(display->bounds),
        @"usableBounds" : rect_value(display->usable_bounds),
        @"scale" : @(display->scale),
        @"rotationDegrees" : @(display->rotation_degrees),
        @"main" : @(display->main),
      }];
    }
    if (!snapshot->complete && errors.count == 0) {
      [errors addObject:@"Native inventory source incomplete"];
    }
    NSDictionary *result = @{
      @"sourceResponseRef" : @(source_response_ref),
      @"inventoryId" : @(snapshot->inventory_id),
      @"revision" : @(snapshot->revision),
      @"displayLayoutRevision" : @(snapshot->display_layout_revision),
      @"layoutRef" : @(snapshot->layout_ref),
      @"capturedAt" : iso_from_micros(snapshot->captured_at_micros),
      @"complete" : @(snapshot->complete),
      @"errors" : errors,
      @"applications" : applications,
      @"windows" : windows,
      @"displays" : displays,
    };
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0
                                                      error:&error];
    if (data == nil || error != nil || data.length > 1024 * 1024) return NULL;
    return CFBridgingRetain(data);
  }
}

CFDataRef meta_capture_frame_copy_json(
    const MetaCaptureResult *result,
    const MetaCaptureFrameSerializationContext *context) {
  if (result == NULL || context == NULL || result->pngData == NULL ||
      result->imageWidthPixels == 0 || result->imageHeightPixels == 0 ||
      result->encodedBytes == 0 || context->binary_token[0] == '\0' ||
      context->frame_ref[0] == '\0' || strlen(context->sha256) != 64) {
    return NULL;
  }
  @autoreleasepool {
    NSMutableArray *regions = [NSMutableArray array];
    for (size_t index = 0; index < result->regionCount; index += 1) {
      const MetaCaptureDisplayRegion *region = &result->regions[index];
      if (region->frameOrientation !=
          MetaCaptureFrameOrientationDisplayOriented) {
        return NULL;
      }
      [regions addObject:@{
        @"nativeDisplayId" : @(region->displayID),
        @"displayBounds" : rect_value((MetaRect){
            .x = region->displayBoundsPoints.origin.x,
            .y = region->displayBoundsPoints.origin.y,
            .width = region->displayBoundsPoints.size.width,
            .height = region->displayBoundsPoints.size.height,
        }),
        @"imageRect" : rect_value((MetaRect){
            .x = region->imageRectPixels.origin.x,
            .y = region->imageRectPixels.origin.y,
            .width = region->imageRectPixels.size.width,
            .height = region->imageRectPixels.size.height,
        }),
        @"destinationRect" : rect_value((MetaRect){
            .x = region->destinationRectPoints.origin.x,
            .y = region->destinationRectPoints.origin.y,
            .width = region->destinationRectPoints.size.width,
            .height = region->destinationRectPoints.size.height,
        }),
        @"imageToDestination" : @{
          @"a" : @(region->imageToDestination.a),
          @"b" : @(region->imageToDestination.b),
          @"c" : @(region->imageToDestination.c),
          @"d" : @(region->imageToDestination.d),
          @"tx" : @(region->imageToDestination.tx),
          @"ty" : @(region->imageToDestination.ty),
        },
        @"rotationDegrees" : @(region->displayRotationDegrees),
        @"frameOrientation" : @"display-oriented",
        @"backingScaleX" : @(region->backingScaleX),
        @"backingScaleY" : @(region->backingScaleY),
        @"frameTimestamp" : iso_from_micros(
            region->frameTimestampUnixNanoseconds / 1000ULL),
      }];
    }
    if (regions.count == 0) return NULL;
    NSMutableDictionary *frame = [@{
      @"binaryToken" : @(context->binary_token),
      @"frameRef" : @(context->frame_ref),
      @"sha256" : @(context->sha256),
      @"widthPx" : @(result->imageWidthPixels),
      @"heightPx" : @(result->imageHeightPixels),
      @"encodedBytes" : @(result->encodedBytes),
      @"capturedAt" : iso_from_micros(
          result->capturedAtUnixNanoseconds / 1000ULL),
      @"frameStatus" : @"complete",
      @"regions" : regions,
    } mutableCopy];
    if (result->hasContentRect) {
      frame[@"contentRect"] = rect_value((MetaRect){
          .x = result->contentRectPoints.origin.x,
          .y = result->contentRectPoints.origin.y,
          .width = result->contentRectPoints.size.width,
          .height = result->contentRectPoints.size.height,
      });
    }
    if (result->hasScreenRect) {
      frame[@"screenRect"] = rect_value((MetaRect){
          .x = result->screenRectPoints.origin.x,
          .y = result->screenRectPoints.origin.y,
          .width = result->screenRectPoints.size.width,
          .height = result->screenRectPoints.size.height,
      });
    }
    if (result->hasContentScale) frame[@"contentScale"] = @(result->contentScale);
    if (result->hasScaleFactor) frame[@"scaleFactor"] = @(result->scaleFactor);
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:frame options:0
                                                      error:&error];
    if (data == nil || error != nil || data.length > 1024 * 1024) return NULL;
    return CFBridgingRetain(data);
  }
}
