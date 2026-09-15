#include "meta_geometry_probe.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <math.h>
#include <string.h>
#include <time.h>

#define META_GEOMETRY_PROBE_DEADLINE_MILLIS 500
#define META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS 100

static bool valid_rect(MetaRect value) {
  return isfinite(value.x) && isfinite(value.y) &&
         isfinite(value.width) && isfinite(value.height) &&
         value.width > 0 && value.height > 0;
}

static bool same_rect(MetaRect left, MetaRect right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

static bool valid_backend(MetaGeometryProbeBackend backend) {
  const bool granular_ax = backend.set_ax_timeout != NULL &&
                           backend.copy_ax_position != NULL &&
                           backend.copy_ax_size != NULL;
  return backend.clock != NULL &&
         (backend.copy_ax_frame != NULL || granular_ax) &&
         backend.current_displays != NULL &&
         backend.current_topology_epoch != NULL;
}

static bool valid_topology_backend(MetaGeometryProbeBackend backend) {
  return backend.clock != NULL && backend.current_displays != NULL &&
         backend.current_topology_epoch != NULL;
}

static bool topology_epoch_matches(MetaGeometryProbeBackend backend,
                                   uint64_t expected_epoch) {
  uint64_t actual_epoch = 0;
  return expected_epoch != 0 &&
         backend.current_topology_epoch(backend.context, &actual_epoch) &&
         actual_epoch == expected_epoch;
}

static bool clock_value(MetaGeometryProbeBackend backend,
                        uint64_t *monotonic_millis,
                        uint64_t *unix_micros) {
  return backend.clock(backend.context, monotonic_millis, unix_micros) &&
         *monotonic_millis != UINT64_MAX && *unix_micros != 0;
}

static bool deadline_open(MetaGeometryProbeBackend backend,
                          uint64_t started_at,
                          uint64_t *remaining_millis) {
  uint64_t now = 0;
  uint64_t unix_micros = 0;
  if (!clock_value(backend, &now, &unix_micros) || now < started_at ||
      now - started_at >= META_GEOMETRY_PROBE_DEADLINE_MILLIS) {
    return false;
  }
  *remaining_millis = META_GEOMETRY_PROBE_DEADLINE_MILLIS -
                      (now - started_at);
  return true;
}

static const MetaWindowRecord *bound_target(
    const MetaAXTargetBorrow *borrow,
    const MetaInventorySnapshot *snapshot) {
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    const bool same_window =
        borrow->target.surface_kind == META_SURFACE_WINDOW &&
        candidate->surface_kind == META_SURFACE_WINDOW &&
        strcmp(candidate->window_ref, borrow->target.window_ref) == 0;
    const bool same_sheet =
        borrow->target.surface_kind == META_SURFACE_SHEET &&
        candidate->surface_kind == META_SURFACE_SHEET &&
        strcmp(candidate->surface_ref, borrow->target.surface_ref) == 0 &&
        strcmp(candidate->owner_window_ref,
               borrow->target.owner_window_ref) == 0;
    if ((same_window || same_sheet) &&
        strcmp(candidate->target_ref, borrow->target.target_ref) == 0 &&
        candidate->pid == borrow->target.pid &&
        strcmp(candidate->application_ref,
               borrow->target.application_ref) == 0 &&
        same_rect(candidate->frame, borrow->target.frame)) {
      return candidate;
    }
  }
  return NULL;
}

static bool unique_displays(const MetaDisplayRecord *displays, size_t count) {
  if (count > 0 && displays == NULL) return false;
  for (size_t index = 0; index < count; index += 1) {
    if (displays[index].display_id == 0 ||
        !valid_rect(displays[index].bounds) ||
        !valid_rect(displays[index].usable_bounds) ||
        !isfinite(displays[index].scale) || displays[index].scale <= 0 ||
        !isfinite(displays[index].rotation_degrees) ||
        displays[index].rotation_degrees < 0 ||
        displays[index].rotation_degrees >= 360) {
      return false;
    }
    for (size_t other = index + 1; other < count; other += 1) {
      if (displays[index].display_id == displays[other].display_id) {
        return false;
      }
    }
  }
  return true;
}

static bool same_display(const MetaDisplayRecord *left,
                         const MetaDisplayRecord *right) {
  return left->display_id == right->display_id &&
         same_rect(left->bounds, right->bounds) &&
         same_rect(left->usable_bounds, right->usable_bounds) &&
         left->scale == right->scale &&
         left->rotation_degrees == right->rotation_degrees &&
         left->main == right->main;
}

static bool same_topology(const MetaDisplayRecord *expected,
                          size_t expected_count,
                          const MetaDisplayRecord *actual,
                          size_t actual_count) {
  if (expected_count != actual_count) return false;
  for (size_t index = 0; index < expected_count; index += 1) {
    const MetaDisplayRecord *match = NULL;
    for (size_t candidate = 0; candidate < actual_count; candidate += 1) {
      if (actual[candidate].display_id == expected[index].display_id) {
        match = &actual[candidate];
        break;
      }
    }
    if (match == NULL || !same_display(&expected[index], match)) return false;
  }
  return true;
}

static bool read_current_topology(
    const MetaInventorySnapshot *bound_snapshot,
    MetaGeometryProbeBackend backend,
    uint64_t started_at,
    bool *unchanged) {
  MetaDisplayRecord actual_displays[META_GEOMETRY_PROBE_MAX_DISPLAYS] = {0};
  size_t actual_count = 0;
  bool complete = false;
  uint64_t remaining = 0;
  if (!deadline_open(backend, started_at, &remaining) ||
      !backend.current_displays(
          backend.context, actual_displays,
          META_GEOMETRY_PROBE_MAX_DISPLAYS, &actual_count, &complete) ||
      !complete || actual_count > META_GEOMETRY_PROBE_MAX_DISPLAYS ||
      !unique_displays(actual_displays, actual_count) ||
      !deadline_open(backend, started_at, &remaining)) {
    return false;
  }
  *unchanged = same_topology(
      bound_snapshot->displays, bound_snapshot->display_count,
      actual_displays, actual_count);
  return true;
}

static bool finish_observation(MetaGeometryProbeBackend backend,
                               uint64_t started_at,
                               uint64_t started_unix_micros,
                               uint64_t *observed_at_unix_micros) {
  uint64_t observed_monotonic = 0;
  uint64_t observed_unix_micros = 0;
  if (!clock_value(backend, &observed_monotonic, &observed_unix_micros) ||
      observed_monotonic < started_at ||
      observed_monotonic - started_at >=
          META_GEOMETRY_PROBE_DEADLINE_MILLIS ||
      observed_unix_micros < started_unix_micros) {
    return false;
  }
  *observed_at_unix_micros = observed_unix_micros;
  return true;
}

static bool read_current_ax_frame(MetaGeometryProbeBackend backend,
                                  AXUIElementRef element,
                                  uint64_t started_at,
                                  MetaRect *frame) {
  uint64_t remaining = 0;
  if (!deadline_open(backend, started_at, &remaining)) return false;
  uint64_t timeout = remaining < META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS
                         ? remaining
                         : META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS;
  if (backend.set_ax_timeout == NULL || backend.copy_ax_position == NULL ||
      backend.copy_ax_size == NULL) {
    return backend.copy_ax_frame != NULL &&
           backend.copy_ax_frame(backend.context, element, timeout, frame);
  }
  if (backend.set_ax_timeout(backend.context, element, timeout) !=
      kAXErrorSuccess) {
    return false;
  }
  if (backend.copy_ax_position(backend.context, element, &frame->x,
                               &frame->y) != kAXErrorSuccess) {
    return false;
  }
  if (!deadline_open(backend, started_at, &remaining)) return false;
  timeout = remaining < META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS
                ? remaining
                : META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS;
  if (backend.set_ax_timeout(backend.context, element, timeout) !=
      kAXErrorSuccess) {
    return false;
  }
  return backend.copy_ax_size(backend.context, element, &frame->width,
                              &frame->height) == kAXErrorSuccess;
}

bool meta_macos_probe_borrowed_geometry_with_backend(
    const MetaAXTargetBorrow *borrow,
    const MetaInventorySnapshot *bound_snapshot,
    MetaBorrowedGeometryProbe *output,
    MetaGeometryProbeBackend backend) {
  if (output == NULL) return false;
  *output = (MetaBorrowedGeometryProbe){0};
  if (borrow == NULL || borrow->element == NULL || bound_snapshot == NULL ||
      !bound_snapshot->complete || !valid_backend(backend) ||
      bound_snapshot->display_count > META_GEOMETRY_PROBE_MAX_DISPLAYS ||
      (bound_snapshot->display_count > 0 &&
       bound_snapshot->displays == NULL) ||
      (bound_snapshot->window_count > 0 && bound_snapshot->windows == NULL) ||
      strcmp(borrow->inventory_id, bound_snapshot->inventory_id) != 0 ||
      borrow->inventory_revision != bound_snapshot->revision ||
      strcmp(borrow->native_generation,
             bound_snapshot->native_generation) != 0 ||
      !topology_epoch_matches(backend,
                              bound_snapshot->display_topology_epoch) ||
      (borrow->target.surface_kind != META_SURFACE_WINDOW &&
       borrow->target.surface_kind != META_SURFACE_SHEET)) {
    return false;
  }
  const MetaWindowRecord *expected = bound_target(borrow, bound_snapshot);
  if (expected == NULL || !valid_rect(expected->frame) ||
      !unique_displays(bound_snapshot->displays,
                       bound_snapshot->display_count)) {
    return false;
  }
  output->expected_frame = expected->frame;

  uint64_t started_at = 0;
  uint64_t started_unix_micros = 0;
  if (!clock_value(backend, &started_at, &started_unix_micros)) return false;
  uint64_t remaining = 0;
  if (!deadline_open(backend, started_at, &remaining)) return false;
  if (!read_current_ax_frame(backend, borrow->element, started_at,
                             &output->actual_frame) ||
      !valid_rect(output->actual_frame) ||
      !deadline_open(backend, started_at, &remaining)) {
    return false;
  }
  output->frame_unchanged =
      same_rect(output->expected_frame, output->actual_frame);

  if (!read_current_topology(bound_snapshot, backend, started_at,
                             &output->topology_unchanged)) {
    return false;
  }
  if (!topology_epoch_matches(backend,
                              bound_snapshot->display_topology_epoch)) {
    return false;
  }
  return finish_observation(backend, started_at, started_unix_micros,
                            &output->observed_at_unix_micros);
}

bool meta_macos_probe_topology_with_backend(
    const MetaInventorySnapshot *bound_snapshot,
    MetaTopologyProbe *output,
    MetaGeometryProbeBackend backend) {
  if (output == NULL) return false;
  *output = (MetaTopologyProbe){0};
  if (bound_snapshot == NULL || !bound_snapshot->complete ||
      !valid_topology_backend(backend) ||
      bound_snapshot->display_count > META_GEOMETRY_PROBE_MAX_DISPLAYS ||
      (bound_snapshot->display_count > 0 &&
       bound_snapshot->displays == NULL) ||
      !unique_displays(bound_snapshot->displays,
                       bound_snapshot->display_count) ||
      !topology_epoch_matches(backend,
                              bound_snapshot->display_topology_epoch)) {
    return false;
  }
  uint64_t started_at = 0;
  uint64_t started_unix_micros = 0;
  if (!clock_value(backend, &started_at, &started_unix_micros) ||
      !read_current_topology(bound_snapshot, backend, started_at,
                             &output->topology_unchanged)) {
    return false;
  }
  if (!topology_epoch_matches(backend,
                              bound_snapshot->display_topology_epoch)) {
    return false;
  }
  return finish_observation(backend, started_at, started_unix_micros,
                            &output->observed_at_unix_micros);
}

static bool system_clock(void *context, uint64_t *monotonic_millis,
                         uint64_t *unix_micros) {
  (void)context;
  struct timespec monotonic = {0};
  struct timespec realtime = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &monotonic) != 0 ||
      clock_gettime(CLOCK_REALTIME, &realtime) != 0) {
    return false;
  }
  *monotonic_millis = (uint64_t)monotonic.tv_sec * 1000 +
                      (uint64_t)monotonic.tv_nsec / 1000000;
  *unix_micros = (uint64_t)realtime.tv_sec * 1000000 +
                 (uint64_t)realtime.tv_nsec / 1000;
  return true;
}

static bool current_topology_epoch(void *context, uint64_t *epoch) {
  return meta_macos_display_topology_epoch(
      (MetaMacOSBackend *)context, epoch);
}

static AXError set_ax_timeout(void *context, AXUIElementRef element,
                              uint64_t timeout_millis) {
  (void)context;
  if (element == NULL || timeout_millis == 0 ||
      timeout_millis > META_GEOMETRY_PROBE_AX_TIMEOUT_MILLIS) {
    return kAXErrorIllegalArgument;
  }
  return AXUIElementSetMessagingTimeout(element,
                                        (float)timeout_millis / 1000.0f);
}

static AXError copy_ax_position(void *context, AXUIElementRef element,
                                double *x, double *y) {
  (void)context;
  CFTypeRef position_value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      element, kAXPositionAttribute, &position_value);
  CGPoint position = CGPointZero;
  const bool valid = error == kAXErrorSuccess && position_value != NULL &&
      CFGetTypeID(position_value) == AXValueGetTypeID() &&
      AXValueGetType((AXValueRef)position_value) == kAXValueCGPointType &&
      AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType,
                      &position);
  if (position_value != NULL) CFRelease(position_value);
  if (!valid) return error == kAXErrorSuccess ? kAXErrorIllegalArgument : error;
  *x = position.x;
  *y = position.y;
  return kAXErrorSuccess;
}

static AXError copy_ax_size(void *context, AXUIElementRef element,
                            double *width, double *height) {
  (void)context;
  CFTypeRef size_value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      element, kAXSizeAttribute, &size_value);
  CGSize size = CGSizeZero;
  const bool valid = error == kAXErrorSuccess && size_value != NULL &&
      CFGetTypeID(size_value) == AXValueGetTypeID() &&
      AXValueGetType((AXValueRef)size_value) == kAXValueCGSizeType &&
      AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, &size);
  if (size_value != NULL) CFRelease(size_value);
  if (!valid) return error == kAXErrorSuccess ? kAXErrorIllegalArgument : error;
  *width = size.width;
  *height = size.height;
  return kAXErrorSuccess;
}

static NSScreen *screen_for_display(CGDirectDisplayID display_id) {
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    if (number != nil && number.unsignedIntValue == display_id) return screen;
  }
  return nil;
}

static bool current_displays(void *context, MetaDisplayRecord *displays,
                             size_t capacity, size_t *count, bool *complete) {
  (void)context;
  if (displays == NULL || count == NULL || complete == NULL ||
      capacity > META_GEOMETRY_PROBE_MAX_DISPLAYS) {
    return false;
  }
  *count = 0;
  *complete = false;
  @autoreleasepool {
    uint32_t display_count = 0;
    if (CGGetActiveDisplayList(0, NULL, &display_count) != kCGErrorSuccess ||
        display_count > capacity) {
      return false;
    }
    CGDirectDisplayID ids[META_GEOMETRY_PROBE_MAX_DISPLAYS] = {0};
    if (CGGetActiveDisplayList(display_count, ids, &display_count) !=
            kCGErrorSuccess ||
        display_count > capacity) {
      return false;
    }
    for (uint32_t index = 0; index < display_count; index += 1) {
      const CGDirectDisplayID display_id = ids[index];
      const CGRect bounds = CGDisplayBounds(display_id);
      CGRect usable = bounds;
      NSScreen *screen = screen_for_display(display_id);
      if (screen != nil) {
        const NSRect frame = screen.frame;
        const NSRect visible = screen.visibleFrame;
        const double left = NSMinX(visible) - NSMinX(frame);
        const double right = NSMaxX(frame) - NSMaxX(visible);
        const double bottom = NSMinY(visible) - NSMinY(frame);
        const double top = NSMaxY(frame) - NSMaxY(visible);
        usable.origin.x += left;
        usable.origin.y += top;
        usable.size.width -= left + right;
        usable.size.height -= top + bottom;
      }
      displays[index] = (MetaDisplayRecord){
          .display_id = display_id,
          .bounds = {.x = bounds.origin.x,
                     .y = bounds.origin.y,
                     .width = bounds.size.width,
                     .height = bounds.size.height},
          .usable_bounds = {.x = usable.origin.x,
                            .y = usable.origin.y,
                            .width = usable.size.width,
                            .height = usable.size.height},
          .scale = bounds.size.width > 0
                       ? (double)CGDisplayPixelsWide(display_id) /
                             bounds.size.width
                       : 0,
          .rotation_degrees = CGDisplayRotation(display_id),
          .main = CGDisplayIsMain(display_id),
      };
    }
    *count = display_count;
    *complete = true;
    return true;
  }
}

bool meta_macos_probe_borrowed_geometry(
    MetaMacOSBackend *owner,
    const MetaAXTargetBorrow *borrow,
    const MetaInventorySnapshot *bound_snapshot,
    MetaBorrowedGeometryProbe *output) {
  return meta_macos_probe_borrowed_geometry_with_backend(
      borrow, bound_snapshot, output,
      (MetaGeometryProbeBackend){
          .context = owner,
          .clock = system_clock,
          .set_ax_timeout = set_ax_timeout,
          .copy_ax_position = copy_ax_position,
          .copy_ax_size = copy_ax_size,
          .current_displays = current_displays,
          .current_topology_epoch = current_topology_epoch,
      });
}

bool meta_macos_probe_topology(
    MetaMacOSBackend *owner,
    const MetaInventorySnapshot *bound_snapshot,
    MetaTopologyProbe *output) {
  return meta_macos_probe_topology_with_backend(
      bound_snapshot, output,
      (MetaGeometryProbeBackend){
          .context = owner,
          .clock = system_clock,
          .current_displays = current_displays,
          .current_topology_epoch = current_topology_epoch,
      });
}
