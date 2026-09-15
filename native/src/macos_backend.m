#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <libproc.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "meta_macos.h"

typedef struct {
  uint64_t token;
  int32_t pid;
  uint64_t launch_time_micros;
  AXUIElementRef element;
  uint64_t last_seen_refresh;
} AXHandle;

struct MetaMacOSBackend {
  MetaRegistry *registry;
  AXHandle *handles;
  size_t handle_count;
  uint64_t next_handle_token;
  uint64_t refresh_number;
};

static uint64_t monotonic_millis(void) {
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000ULL +
         (uint64_t)value.tv_nsec / 1000000ULL;
}

static uint64_t unix_micros(void) {
  return (uint64_t)(NSDate.date.timeIntervalSince1970 * 1000000.0);
}

static uint64_t process_start_micros(pid_t pid) {
  struct proc_bsdinfo info = {0};
  const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) return 0;
  return (uint64_t)info.pbi_start_tvsec * 1000000ULL +
         (uint64_t)info.pbi_start_tvusec;
}

static char *copy_ns_string(NSString *value) {
  const char *bytes = value == nil ? "" : value.UTF8String;
  return strdup(bytes == NULL ? "" : bytes);
}

static char *copy_cf_string(CFStringRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) {
    return strdup("");
  }
  return copy_ns_string((__bridge NSString *)value);
}

static MetaAXStatus status_from_ax_error(AXError error) {
  if (error == kAXErrorSuccess) return META_AX_READY;
  if (error == kAXErrorCannotComplete) return META_AX_TIMED_OUT;
  if (error == kAXErrorAPIDisabled || error == kAXErrorNotImplemented) {
    return META_AX_DENIED;
  }
  if (error == kAXErrorInvalidUIElement ||
      error == kAXErrorInvalidUIElementObserver) {
    return META_AX_UNAVAILABLE;
  }
  return META_AX_FAILED;
}

static MetaTriState copy_bool_attribute(AXUIElementRef element,
                                        CFStringRef attribute) {
  CFTypeRef value = NULL;
  const AXError error =
      AXUIElementCopyAttributeValue(element, attribute, &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != CFBooleanGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return META_UNKNOWN;
  }
  const MetaTriState result = CFBooleanGetValue((CFBooleanRef)value)
                                  ? META_TRUE
                                  : META_FALSE;
  CFRelease(value);
  return result;
}

static char *copy_string_attribute(AXUIElementRef element,
                                   CFStringRef attribute) {
  CFTypeRef value = NULL;
  const AXError error =
      AXUIElementCopyAttributeValue(element, attribute, &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != CFStringGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return strdup("");
  }
  char *result = copy_cf_string((CFStringRef)value);
  CFRelease(value);
  return result;
}

static bool copy_frame(AXUIElementRef element, MetaRect *frame) {
  CFTypeRef position_value = NULL;
  CFTypeRef size_value = NULL;
  const AXError position_error = AXUIElementCopyAttributeValue(
      element, kAXPositionAttribute, &position_value);
  const AXError size_error =
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size_value);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  const bool valid =
      position_error == kAXErrorSuccess && size_error == kAXErrorSuccess &&
      position_value != NULL && size_value != NULL &&
      CFGetTypeID(position_value) == AXValueGetTypeID() &&
      CFGetTypeID(size_value) == AXValueGetTypeID() &&
      AXValueGetType((AXValueRef)position_value) == kAXValueCGPointType &&
      AXValueGetType((AXValueRef)size_value) == kAXValueCGSizeType &&
      AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType,
                      &position) &&
      AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, &size);
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  if (!valid) return false;
  *frame = (MetaRect){
      .x = position.x,
      .y = position.y,
      .width = size.width,
      .height = size.height,
  };
  return true;
}

static bool action_available(AXUIElementRef element, CFStringRef action) {
  CFArrayRef actions = NULL;
  const AXError error = AXUIElementCopyActionNames(element, &actions);
  if (error != kAXErrorSuccess || actions == NULL) return false;
  const bool result = CFArrayContainsValue(
      actions, CFRangeMake(0, CFArrayGetCount(actions)), action);
  CFRelease(actions);
  return result;
}

static bool attribute_settable(AXUIElementRef element,
                               CFStringRef attribute) {
  Boolean settable = false;
  return AXUIElementIsAttributeSettable(element, attribute, &settable) ==
             kAXErrorSuccess &&
         settable;
}

static MetaSurfaceKind surface_kind(const char *role, const char *subrole) {
  if (strcmp(role, "AXSheet") == 0 || strcmp(subrole, "AXDialog") == 0) {
    return META_SURFACE_SHEET;
  }
  if (strcmp(role, "AXMenu") == 0 || strcmp(role, "AXMenuItem") == 0) {
    return META_SURFACE_MENU;
  }
  if (strcmp(role, "AXPopover") == 0 || strcmp(role, "AXUnknown") == 0) {
    return META_SURFACE_POPUP;
  }
  if (strcmp(role, "AXWindow") == 0) return META_SURFACE_WINDOW;
  return META_SURFACE_UNKNOWN;
}

static uint64_t token_for_element(MetaMacOSBackend *backend, int32_t pid,
                                  uint64_t launch_time_micros,
                                  AXUIElementRef element) {
  for (size_t index = 0; index < backend->handle_count; index += 1) {
    AXHandle *handle = &backend->handles[index];
    if (handle->pid == pid &&
        handle->launch_time_micros == launch_time_micros &&
        CFEqual(handle->element, element)) {
      handle->last_seen_refresh = backend->refresh_number;
      return handle->token;
    }
  }
  const size_t next_count = backend->handle_count + 1;
  AXHandle *next = realloc(backend->handles, next_count * sizeof(*next));
  if (next == NULL) return 0;
  backend->handles = next;
  AXHandle *handle = &next[next_count - 1];
  *handle = (AXHandle){
      .token = backend->next_handle_token++,
      .pid = pid,
      .launch_time_micros = launch_time_micros,
      .element = (AXUIElementRef)CFRetain(element),
      .last_seen_refresh = backend->refresh_number,
  };
  backend->handle_count = next_count;
  return handle->token;
}

static AXHandle *find_handle(MetaMacOSBackend *backend, uint64_t token) {
  for (size_t index = 0; index < backend->handle_count; index += 1) {
    if (backend->handles[index].token == token) return &backend->handles[index];
  }
  return NULL;
}

static void prune_handles(MetaMacOSBackend *backend) {
  size_t output = 0;
  for (size_t index = 0; index < backend->handle_count; index += 1) {
    AXHandle handle = backend->handles[index];
    if (handle.last_seen_refresh != backend->refresh_number) {
      CFRelease(handle.element);
      continue;
    }
    backend->handles[output++] = handle;
  }
  backend->handle_count = output;
}

static bool window_input_exists(const MetaAXWindowInput *windows, size_t count,
                                int32_t pid, uint64_t ax_token) {
  for (size_t index = 0; index < count; index += 1) {
    if (windows[index].pid == pid && windows[index].ax_token == ax_token) {
      return true;
    }
  }
  return false;
}

static bool append_ax_window(MetaMacOSBackend *backend,
                             MetaAXWindowInput **windows, size_t *count,
                             int32_t pid, uint64_t launch_time_micros,
                             AXUIElementRef element, uint64_t owner_token,
                             uint64_t deadline_millis, bool *timed_out) {
  if (monotonic_millis() >= deadline_millis) {
    *timed_out = true;
    return false;
  }
  AXUIElementSetMessagingTimeout(element, 0.1f);
  const uint64_t token = token_for_element(backend, pid, launch_time_micros,
                                           element);
  if (token == 0) return false;
  if (window_input_exists(*windows, *count, pid, token)) return true;
  const size_t next_count = *count + 1;
  MetaAXWindowInput *next = realloc(*windows, next_count * sizeof(*next));
  if (next == NULL) return false;
  *windows = next;
  MetaAXWindowInput *window = &next[next_count - 1];
  memset(window, 0, sizeof(*window));
  char *role = copy_string_attribute(element, kAXRoleAttribute);
  char *subrole = NULL;
  if (monotonic_millis() >= deadline_millis) goto deadline_reached;
  subrole = copy_string_attribute(element, kAXSubroleAttribute);
  if (monotonic_millis() >= deadline_millis) goto deadline_reached;
  char *title = copy_string_attribute(element, kAXTitleAttribute);
  if (monotonic_millis() >= deadline_millis) {
    free(title);
    goto deadline_reached;
  }
  MetaAXWindowInput collected = {
      .pid = pid,
      .launch_time_micros = launch_time_micros,
      .ax_token = token,
      .owner_ax_token = owner_token,
      .title = title,
      .role = role,
      .subrole = subrole,
      .surface_kind = surface_kind(role, subrole),
      .minimized = META_UNKNOWN,
      .fullscreen = META_UNKNOWN,
      .focused = META_UNKNOWN,
      .main = META_UNKNOWN,
  };
  collected.minimized = copy_bool_attribute(element, kAXMinimizedAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.fullscreen = copy_bool_attribute(element, CFSTR("AXFullScreen"));
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.focused = copy_bool_attribute(element, kAXFocusedAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.main = copy_bool_attribute(element, kAXMainAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.can_raise = action_available(element, kAXRaiseAction);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  CFTypeRef close_button = NULL;
  const AXError close_button_error = AXUIElementCopyAttributeValue(
      element, kAXCloseButtonAttribute, &close_button);
  if (close_button_error == kAXErrorSuccess && close_button != NULL &&
      CFGetTypeID(close_button) == AXUIElementGetTypeID()) {
    collected.can_close = action_available((AXUIElementRef)close_button,
                                           kAXPressAction);
  }
  if (close_button != NULL) CFRelease(close_button);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.can_minimize =
      attribute_settable(element, kAXMinimizedAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.can_move = attribute_settable(element, kAXPositionAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  collected.can_resize = attribute_settable(element, kAXSizeAttribute);
  if (monotonic_millis() >= deadline_millis) goto collected_deadline_reached;
  *window = collected;
  if (!copy_frame(element, &window->frame)) {
    window->frame = (MetaRect){0};
  }
  if (monotonic_millis() >= deadline_millis) {
    free((void *)window->title);
    free((void *)window->role);
    free((void *)window->subrole);
    memset(window, 0, sizeof(*window));
    *timed_out = true;
    return false;
  }
  *count = next_count;
  return true;

collected_deadline_reached:
  free((void *)collected.title);
  free((void *)collected.role);
  free((void *)collected.subrole);
  *timed_out = true;
  return false;

deadline_reached:
  free(role);
  free(subrole);
  *timed_out = true;
  return false;
}

static void free_application_inputs(MetaApplicationInput *applications,
                                    size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    free((void *)applications[index].name);
    free((void *)applications[index].bundle_id);
  }
  free(applications);
}

static void free_ax_window_inputs(MetaAXWindowInput *windows, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    free((void *)windows[index].title);
    free((void *)windows[index].role);
    free((void *)windows[index].subrole);
  }
  free(windows);
}

static bool append_cg_window(MetaCGWindowInput **windows, size_t *count,
                             CFDictionaryRef info) {
  int layer = 0;
  int32_t pid = 0;
  uint32_t window_id = 0;
  CGRect bounds = CGRectZero;
  CFNumberRef layer_value =
      (CFNumberRef)CFDictionaryGetValue(info, kCGWindowLayer);
  CFNumberRef pid_value =
      (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
  CFNumberRef id_value =
      (CFNumberRef)CFDictionaryGetValue(info, kCGWindowNumber);
  CFDictionaryRef bounds_value =
      (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
  if (layer_value == NULL || pid_value == NULL || id_value == NULL ||
      bounds_value == NULL ||
      !CFNumberGetValue(layer_value, kCFNumberIntType, &layer) || layer != 0 ||
      !CFNumberGetValue(pid_value, kCFNumberSInt32Type, &pid) || pid <= 0 ||
      !CFNumberGetValue(id_value, kCFNumberSInt32Type, &window_id) ||
      window_id == 0 ||
      !CGRectMakeWithDictionaryRepresentation(bounds_value, &bounds) ||
      bounds.size.width <= 0 || bounds.size.height <= 0) {
    return true;
  }

  const size_t next_count = *count + 1;
  MetaCGWindowInput *next = realloc(*windows, next_count * sizeof(*next));
  if (next == NULL) return false;
  *windows = next;
  CFStringRef title =
      (CFStringRef)CFDictionaryGetValue(info, kCGWindowName);
  CFBooleanRef on_screen =
      (CFBooleanRef)CFDictionaryGetValue(info, kCGWindowIsOnscreen);
  next[next_count - 1] = (MetaCGWindowInput){
      .window_id = window_id,
      .pid = pid,
      .title = copy_cf_string(title),
      .frame = {.x = bounds.origin.x,
                .y = bounds.origin.y,
                .width = bounds.size.width,
                .height = bounds.size.height},
      .on_screen = on_screen != NULL &&
                           CFGetTypeID(on_screen) == CFBooleanGetTypeID()
                       ? (CFBooleanGetValue(on_screen) ? META_TRUE : META_FALSE)
                       : META_UNKNOWN,
  };
  *count = next_count;
  return true;
}

static void free_cg_window_inputs(MetaCGWindowInput *windows, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    free((void *)windows[index].title);
  }
  free(windows);
}

static NSScreen *screen_for_display(CGDirectDisplayID display_id) {
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    if (number != nil && number.unsignedIntValue == display_id) return screen;
  }
  return nil;
}

static bool collect_displays(MetaDisplayInput **displays, size_t *count) {
  uint32_t display_count = 0;
  if (CGGetActiveDisplayList(0, NULL, &display_count) != kCGErrorSuccess) {
    return false;
  }
  CGDirectDisplayID *ids = calloc(display_count, sizeof(*ids));
  if (ids == NULL && display_count > 0) return false;
  if (CGGetActiveDisplayList(display_count, ids, &display_count) !=
      kCGErrorSuccess) {
    free(ids);
    return false;
  }
  MetaDisplayInput *result = calloc(display_count, sizeof(*result));
  if (result == NULL && display_count > 0) {
    free(ids);
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
    result[index] = (MetaDisplayInput){
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
  free(ids);
  *displays = result;
  *count = display_count;
  return true;
}

MetaMacOSBackend *meta_macos_backend_create(const char *native_generation) {
  MetaMacOSBackend *backend = calloc(1, sizeof(*backend));
  if (backend == NULL) return NULL;
  backend->registry = meta_registry_create(native_generation);
  if (backend->registry == NULL) {
    free(backend);
    return NULL;
  }
  backend->next_handle_token = 1;
  return backend;
}

void meta_macos_backend_destroy(MetaMacOSBackend *backend) {
  if (backend == NULL) return;
  for (size_t index = 0; index < backend->handle_count; index += 1) {
    CFRelease(backend->handles[index].element);
  }
  free(backend->handles);
  meta_registry_destroy(backend->registry);
  free(backend);
}

const MetaInventorySnapshot *meta_macos_backend_snapshot(
    const MetaMacOSBackend *backend) {
  return backend == NULL ? NULL : meta_registry_snapshot(backend->registry);
}

bool meta_macos_refresh_inventory(MetaMacOSBackend *backend,
                                  uint64_t total_budget_millis) {
  if (backend == NULL || total_budget_millis == 0) return false;
  @autoreleasepool {
    backend->refresh_number += 1;
    const uint64_t started = monotonic_millis();
    const uint64_t inventory_deadline = started + total_budget_millis;
    NSArray<NSRunningApplication *> *running =
        NSWorkspace.sharedWorkspace.runningApplications;
    const size_t application_count = running.count;
    MetaApplicationInput *applications =
        calloc(application_count, sizeof(*applications));
    MetaAXWindowInput *ax_windows = NULL;
    size_t ax_window_count = 0;
    MetaCGWindowInput *cg_windows = NULL;
    size_t cg_window_count = 0;
    MetaDisplayInput *displays = NULL;
    size_t display_count = 0;
    bool complete = applications != NULL || application_count == 0;

    if (!complete) return false;
    const bool accessibility = AXIsProcessTrusted();
    for (size_t index = 0; index < application_count; index += 1) {
      NSRunningApplication *running_application = running[index];
      const pid_t pid = running_application.processIdentifier;
      const uint64_t launch_time_micros = process_start_micros(pid);
      MetaApplicationInput *application = &applications[index];
      *application = (MetaApplicationInput){
          .pid = pid,
          .launch_time_micros = launch_time_micros,
          .name = copy_ns_string(running_application.localizedName),
          .bundle_id = copy_ns_string(running_application.bundleIdentifier),
          .hidden = running_application.hidden ? META_TRUE : META_FALSE,
          .ax_status = META_AX_UNAVAILABLE,
      };
      if (pid <= 0 || launch_time_micros == 0) {
        application->ax_status = META_AX_UNAVAILABLE;
        complete = false;
        continue;
      }
      if (!accessibility) {
        application->ax_status = META_AX_DENIED;
        complete = false;
        continue;
      }
      if (monotonic_millis() - started >= total_budget_millis) {
        application->ax_status = META_AX_TIMED_OUT;
        complete = false;
        continue;
      }

      AXUIElementRef ax_application = AXUIElementCreateApplication(pid);
      if (ax_application == NULL) {
        application->ax_status = META_AX_UNAVAILABLE;
        complete = false;
        continue;
      }
      AXUIElementSetMessagingTimeout(ax_application, 0.5f);
      CFTypeRef windows_value = NULL;
      const AXError windows_error = AXUIElementCopyAttributeValue(
          ax_application, kAXWindowsAttribute, &windows_value);
      if (windows_error != kAXErrorSuccess || windows_value == NULL ||
          CFGetTypeID(windows_value) != CFArrayGetTypeID()) {
        application->ax_status = status_from_ax_error(windows_error);
        complete = false;
        if (windows_value != NULL) CFRelease(windows_value);
        CFRelease(ax_application);
        continue;
      }

      CFArrayRef top_windows = (CFArrayRef)windows_value;
      application->ax_status = CFArrayGetCount(top_windows) == 0
                                   ? META_AX_NO_WINDOWS
                                   : META_AX_READY;
      bool application_timed_out = false;
      for (CFIndex window_index = 0;
           window_index < CFArrayGetCount(top_windows); window_index += 1) {
        AXUIElementRef window =
            (AXUIElementRef)CFArrayGetValueAtIndex(top_windows, window_index);
        if (!append_ax_window(backend, &ax_windows, &ax_window_count, pid,
                              launch_time_micros, window, 0,
                              inventory_deadline, &application_timed_out)) {
          complete = false;
          if (application_timed_out) break;
          continue;
        }
        const uint64_t owner_token =
            token_for_element(backend, pid, launch_time_micros, window);
        CFTypeRef sheets_value = NULL;
        const AXError sheets_error = AXUIElementCopyAttributeValue(
            window, CFSTR("AXSheets"), &sheets_value);
        if (sheets_error == kAXErrorSuccess && sheets_value != NULL &&
            CFGetTypeID(sheets_value) == CFArrayGetTypeID()) {
          CFArrayRef sheets = (CFArrayRef)sheets_value;
          for (CFIndex sheet_index = 0; sheet_index < CFArrayGetCount(sheets);
               sheet_index += 1) {
            AXUIElementRef sheet =
                (AXUIElementRef)CFArrayGetValueAtIndex(sheets, sheet_index);
            if (!append_ax_window(backend, &ax_windows, &ax_window_count, pid,
                                  launch_time_micros, sheet, owner_token,
                                  inventory_deadline,
                                  &application_timed_out)) {
              complete = false;
              if (application_timed_out) break;
            }
          }
        }
        if (sheets_value != NULL) CFRelease(sheets_value);
        if (application_timed_out) break;
      }

      CFTypeRef focused_value = NULL;
      if (!application_timed_out &&
          AXUIElementCopyAttributeValue(ax_application,
                                        kAXFocusedWindowAttribute,
                                        &focused_value) == kAXErrorSuccess &&
          focused_value != NULL &&
          CFGetTypeID(focused_value) == AXUIElementGetTypeID()) {
        append_ax_window(backend, &ax_windows, &ax_window_count, pid,
                         launch_time_micros,
                         (AXUIElementRef)focused_value, 0,
                         inventory_deadline, &application_timed_out);
      }
      if (application_timed_out) {
        application->ax_status = META_AX_TIMED_OUT;
        complete = false;
      }
      if (focused_value != NULL) CFRelease(focused_value);
      CFRelease(top_windows);
      CFRelease(ax_application);
    }

    CFArrayRef cg_values = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    if (cg_values == NULL) {
      complete = false;
    } else {
      for (CFIndex index = 0; index < CFArrayGetCount(cg_values); index += 1) {
        CFDictionaryRef info =
            (CFDictionaryRef)CFArrayGetValueAtIndex(cg_values, index);
        if (info == NULL || CFGetTypeID(info) != CFDictionaryGetTypeID()) {
          continue;
        }
        if (!append_cg_window(&cg_windows, &cg_window_count, info)) {
          complete = false;
          break;
        }
      }
      CFRelease(cg_values);
    }
    if (!collect_displays(&displays, &display_count)) complete = false;

    MetaInventoryInput input = {
        .applications = applications,
        .application_count = application_count,
        .ax_windows = ax_windows,
        .ax_window_count = ax_window_count,
        .cg_windows = cg_windows,
        .cg_window_count = cg_window_count,
        .displays = displays,
        .display_count = display_count,
        .source_complete = complete,
        .captured_at_micros = unix_micros(),
    };
    const bool refreshed = meta_registry_refresh(backend->registry, &input);
    if (refreshed) prune_handles(backend);
    free_application_inputs(applications, application_count);
    free_ax_window_inputs(ax_windows, ax_window_count);
    free_cg_window_inputs(cg_windows, cg_window_count);
    free(displays);
    return refreshed;
  }
}

static bool process_matches(const MetaWindowRecord *record, AXHandle *handle) {
  return record != NULL && handle != NULL && record->pid == handle->pid &&
         process_start_micros(handle->pid) == handle->launch_time_micros;
}

static void initialize_transition(MetaWindowTransition *result,
                                  const char *window_ref) {
  memset(result, 0, sizeof(*result));
  result->status = META_TRANSITION_UNAVAILABLE;
  result->application_hidden = META_UNKNOWN;
  result->minimized = META_UNKNOWN;
  result->focused = META_UNKNOWN;
  snprintf(result->window_ref, sizeof(result->window_ref), "%s", window_ref);
}

static AXHandle *resolve_transition_target(MetaMacOSBackend *backend,
                                           const char *window_ref,
                                           const MetaWindowRecord **record,
                                           MetaWindowTransition *result) {
  initialize_transition(result, window_ref == NULL ? "" : window_ref);
  *record = meta_registry_resolve_target(backend->registry, window_ref);
  if (*record == NULL || (*record)->actionability != META_ACTIONABILITY_AX) {
    result->status = META_TRANSITION_TARGET_STALE;
    return NULL;
  }
  AXHandle *handle = find_handle(backend, (*record)->ax_token);
  if (!process_matches(*record, handle)) {
    result->status = META_TRANSITION_TARGET_STALE;
    return NULL;
  }
  return handle;
}

MetaAXBorrowStatus meta_macos_with_ax_target(MetaMacOSBackend *backend,
                                            const char *target_ref,
                                            const char *inventory_id,
                                            uint64_t inventory_revision,
                                            const char *native_generation,
                                            MetaAXTargetConsumer consume,
                                            void *context) {
  if (backend == NULL || target_ref == NULL || inventory_id == NULL || native_generation == NULL || consume == NULL ||
      target_ref[0] == '\0' || strnlen(target_ref, META_NATIVE_REF_CAPACITY) >= META_NATIVE_REF_CAPACITY) {
    return META_AX_BORROW_INVALID_REQUEST;
  }
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(backend->registry);
  if (snapshot == NULL || strcmp(snapshot->inventory_id, inventory_id) != 0 ||
      snapshot->revision != inventory_revision || strcmp(snapshot->native_generation, native_generation) != 0) {
    return META_AX_BORROW_TARGET_STALE;
  }
  const MetaWindowRecord *record = meta_registry_resolve_target(backend->registry, target_ref);
  if (record == NULL || record->actionability != META_ACTIONABILITY_AX) return META_AX_BORROW_TARGET_STALE;
  AXHandle *handle = find_handle(backend, record->ax_token);
  if (!process_matches(record, handle)) return META_AX_BORROW_TARGET_STALE;
  if (!AXIsProcessTrusted()) return META_AX_BORROW_PERMISSION_DENIED;
  MetaAXTargetBorrow borrow = {
    .element = (AXUIElementRef)CFRetain(handle->element),
    .target = *record,
    .launch_time_micros = handle->launch_time_micros,
    .inventory_revision = snapshot->revision,
  };
  snprintf(borrow.native_generation, sizeof(borrow.native_generation), "%s", snapshot->native_generation);
  snprintf(borrow.inventory_id, sizeof(borrow.inventory_id), "%s", snapshot->inventory_id);
  AXUIElementSetMessagingTimeout(borrow.element, 0.5f);
  bool consumed = consume(context, &borrow);
  CFRelease(borrow.element);
  if (process_start_micros(borrow.target.pid) != borrow.launch_time_micros) return META_AX_BORROW_TARGET_STALE;
  return consumed ? META_AX_BORROW_OK : META_AX_BORROW_CONSUMER_FAILED;
}

static bool element_is_owned_sheet(AXUIElementRef owner,
                                   AXUIElementRef candidate) {
  CFTypeRef sheets_value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      owner, CFSTR("AXSheets"), &sheets_value);
  if (error != kAXErrorSuccess || sheets_value == NULL ||
      CFGetTypeID(sheets_value) != CFArrayGetTypeID()) {
    if (sheets_value != NULL) CFRelease(sheets_value);
    return false;
  }
  const bool result = CFArrayContainsValue(
      (CFArrayRef)sheets_value,
      CFRangeMake(0, CFArrayGetCount((CFArrayRef)sheets_value)), candidate);
  CFRelease(sheets_value);
  return result;
}

static void read_transition_state(AXHandle *handle,
                                  MetaWindowTransition *result) {
  copy_frame(handle->element, &result->actual_frame);
  result->minimized =
      copy_bool_attribute(handle->element, kAXMinimizedAttribute);
  NSRunningApplication *running =
      [NSRunningApplication runningApplicationWithProcessIdentifier:handle->pid];
  result->application_hidden = running == nil
                                   ? META_UNKNOWN
                                   : (running.hidden ? META_TRUE : META_FALSE);
  AXUIElementRef application = AXUIElementCreateApplication(handle->pid);
  if (application == NULL) return;
  AXUIElementSetMessagingTimeout(application, 0.5f);
  CFTypeRef focused_value = NULL;
  const AXError focused_error = AXUIElementCopyAttributeValue(
      application, kAXFocusedWindowAttribute, &focused_value);
  if (focused_error == kAXErrorSuccess && focused_value != NULL &&
      CFGetTypeID(focused_value) == AXUIElementGetTypeID()) {
    AXUIElementRef focused = (AXUIElementRef)focused_value;
    const bool exact = CFEqual(focused, handle->element);
    const bool owned_sheet = element_is_owned_sheet(handle->element, focused);
    result->focused = exact || owned_sheet ? META_TRUE : META_FALSE;
    result->modal_or_sheet_observed = owned_sheet;
  }
  if (focused_value != NULL) CFRelease(focused_value);
  CFRelease(application);
}

bool meta_macos_target_is_focused(MetaMacOSBackend *backend, const char *target_ref) {
  if (backend == NULL || target_ref == NULL || !AXIsProcessTrusted()) return false;
  const MetaWindowRecord *record = meta_registry_resolve_target(backend->registry, target_ref);
  if (record == NULL) return false;
  AXHandle *handle = find_handle(backend, record->ax_token);
  if (!process_matches(record, handle)) return false;
  NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:handle->pid];
  if (running == nil || running.hidden || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != handle->pid ||
      copy_bool_attribute(handle->element, kAXMinimizedAttribute) == META_TRUE) return false;
  AXUIElementRef application = AXUIElementCreateApplication(handle->pid);
  if (application == NULL) return false;
  AXUIElementSetMessagingTimeout(application, 0.5f);
  CFTypeRef focused = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &focused);
  const bool exact = error == kAXErrorSuccess && focused != NULL &&
                     CFGetTypeID(focused) == AXUIElementGetTypeID() && CFEqual(focused, handle->element);
  if (focused != NULL) CFRelease(focused);
  CFRelease(application);
  return exact;
}

static bool perform_focus(MetaMacOSBackend *backend, const char *window_ref,
                          bool show, MetaWindowTransition *result) {
  if (backend == NULL || window_ref == NULL || result == NULL) return false;
  @autoreleasepool {
    const MetaWindowRecord *record = NULL;
    AXHandle *handle =
        resolve_transition_target(backend, window_ref, &record, result);
    if (handle == NULL) return false;
    NSRunningApplication *running =
        [NSRunningApplication runningApplicationWithProcessIdentifier:
                                  handle->pid];
    if (running == nil) {
      result->status = META_TRANSITION_TARGET_STALE;
      return false;
    }
    AXUIElementRef application = AXUIElementCreateApplication(handle->pid);
    if (application == NULL) return false;
    AXUIElementSetMessagingTimeout(application, 0.5f);

    if (show && running.hidden) {
      result->application_unhide_attempted = true;
      result->application_unhide_succeeded = [running unhide];
    }
    if (show && copy_bool_attribute(handle->element,
                                    kAXMinimizedAttribute) == META_TRUE) {
      result->unminimize_attempted = true;
      const AXError error = AXUIElementSetAttributeValue(
          handle->element, kAXMinimizedAttribute, kCFBooleanFalse);
      result->unminimize_succeeded = error == kAXErrorSuccess;
      if (error != kAXErrorSuccess) result->ax_error = error;
    }

    result->raise_attempted = true;
    const AXError raise_error =
        AXUIElementPerformAction(handle->element, kAXRaiseAction);
    result->raise_succeeded = raise_error == kAXErrorSuccess;
    result->focus_attempted = true;
    const bool activated =
        [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    const AXError main_error = AXUIElementSetAttributeValue(
        handle->element, kAXMainAttribute, kCFBooleanTrue);
    const AXError focused_error = AXUIElementSetAttributeValue(
        application, kAXFocusedWindowAttribute, handle->element);
    const AXError frontmost_error = AXUIElementSetAttributeValue(
        application, kAXFrontmostAttribute, kCFBooleanTrue);
    if (raise_error != kAXErrorSuccess) result->ax_error = raise_error;
    if (main_error != kAXErrorSuccess) result->ax_error = main_error;
    if (focused_error != kAXErrorSuccess) result->ax_error = focused_error;
    if (frontmost_error != kAXErrorSuccess) result->ax_error = frontmost_error;
    CFRelease(application);

    read_transition_state(handle, result);
    const bool frontmost =
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier ==
        handle->pid;
    result->focus_succeeded = activated && frontmost &&
                              result->focused == META_TRUE;
    const bool shown = !show ||
                       (result->application_hidden == META_FALSE &&
                        result->minimized != META_TRUE);
    if (result->focus_succeeded && result->raise_succeeded && shown) {
      result->status = META_TRANSITION_SUCCEEDED;
      return true;
    }
    if (activated && shown && result->focused == META_FALSE) {
      result->status = META_TRANSITION_SPACE_UNAVAILABLE;
      return false;
    }
    result->status = META_TRANSITION_PARTIAL;
    return false;
  }
}

bool meta_macos_show_window(MetaMacOSBackend *backend, const char *window_ref,
                            MetaWindowTransition *result) {
  return perform_focus(backend, window_ref, true, result);
}

bool meta_macos_focus_window(MetaMacOSBackend *backend, const char *window_ref,
                             MetaWindowTransition *result) {
  return perform_focus(backend, window_ref, false, result);
}

static bool same_number(double left, double right) {
  return fabs(left - right) <= 1.0;
}

bool meta_macos_set_window_bounds(MetaMacOSBackend *backend,
                                  const char *window_ref,
                                  MetaRect requested_frame,
                                  MetaWindowTransition *result) {
  if (backend == NULL || window_ref == NULL || result == NULL ||
      requested_frame.width <= 0 || requested_frame.height <= 0) {
    return false;
  }
  const MetaWindowRecord *record = NULL;
  AXHandle *handle =
      resolve_transition_target(backend, window_ref, &record, result);
  if (handle == NULL) return false;
  result->requested_frame = requested_frame;
  const CGPoint position = CGPointMake(requested_frame.x, requested_frame.y);
  const CGSize size = CGSizeMake(requested_frame.width, requested_frame.height);
  AXValueRef position_value = AXValueCreate(kAXValueCGPointType, &position);
  AXValueRef size_value = AXValueCreate(kAXValueCGSizeType, &size);
  result->move_attempted = true;
  const AXError move_error =
      position_value == NULL
          ? kAXErrorFailure
          : AXUIElementSetAttributeValue(handle->element, kAXPositionAttribute,
                                         position_value);
  result->move_succeeded = move_error == kAXErrorSuccess;
  result->resize_attempted = true;
  const AXError resize_error =
      size_value == NULL
          ? kAXErrorFailure
          : AXUIElementSetAttributeValue(handle->element, kAXSizeAttribute,
                                         size_value);
  result->resize_succeeded = resize_error == kAXErrorSuccess;
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  if (move_error != kAXErrorSuccess) result->ax_error = move_error;
  if (resize_error != kAXErrorSuccess) result->ax_error = resize_error;
  read_transition_state(handle, result);
  const bool actual_matches = same_number(result->actual_frame.x,
                                          requested_frame.x) &&
                              same_number(result->actual_frame.y,
                                          requested_frame.y) &&
                              same_number(result->actual_frame.width,
                                          requested_frame.width) &&
                              same_number(result->actual_frame.height,
                                          requested_frame.height);
  if (result->move_succeeded && result->resize_succeeded && actual_matches) {
    result->status = META_TRANSITION_SUCCEEDED;
    return true;
  }
  result->status = META_TRANSITION_PARTIAL;
  return false;
}

bool meta_macos_set_window_minimized(MetaMacOSBackend *backend,
                                     const char *window_ref, bool minimized,
                                     MetaWindowTransition *result) {
  if (backend == NULL || window_ref == NULL || result == NULL) return false;
  const MetaWindowRecord *record = NULL;
  AXHandle *handle =
      resolve_transition_target(backend, window_ref, &record, result);
  if (handle == NULL) return false;
  result->unminimize_attempted = !minimized;
  const AXError error = AXUIElementSetAttributeValue(
      handle->element, kAXMinimizedAttribute,
      minimized ? kCFBooleanTrue : kCFBooleanFalse);
  result->unminimize_succeeded = !minimized && error == kAXErrorSuccess;
  result->ax_error = error == kAXErrorSuccess ? 0 : error;
  read_transition_state(handle, result);
  if (error == kAXErrorSuccess &&
      result->minimized == (minimized ? META_TRUE : META_FALSE)) {
    result->status = META_TRANSITION_SUCCEEDED;
    return true;
  }
  result->status = META_TRANSITION_PARTIAL;
  return false;
}

static bool element_still_present(AXHandle *handle,
                                  bool *sheet_observed) {
  AXUIElementRef application = AXUIElementCreateApplication(handle->pid);
  if (application == NULL) return false;
  AXUIElementSetMessagingTimeout(application, 0.5f);
  CFTypeRef windows_value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      application, kAXWindowsAttribute, &windows_value);
  CFRelease(application);
  if (error != kAXErrorSuccess || windows_value == NULL ||
      CFGetTypeID(windows_value) != CFArrayGetTypeID()) {
    if (windows_value != NULL) CFRelease(windows_value);
    return true;
  }
  bool present = false;
  CFArrayRef windows = (CFArrayRef)windows_value;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); index += 1) {
    AXUIElementRef window =
        (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (CFEqual(window, handle->element)) present = true;
    CFTypeRef sheets_value = NULL;
    if (AXUIElementCopyAttributeValue(window, CFSTR("AXSheets"),
                                      &sheets_value) == kAXErrorSuccess &&
        sheets_value != NULL &&
        CFGetTypeID(sheets_value) == CFArrayGetTypeID() &&
        CFArrayGetCount((CFArrayRef)sheets_value) > 0) {
      *sheet_observed = true;
    }
    if (sheets_value != NULL) CFRelease(sheets_value);
  }
  CFRelease(windows);
  return present;
}

bool meta_macos_close_window(MetaMacOSBackend *backend,
                             const char *window_ref,
                             MetaWindowTransition *result) {
  if (backend == NULL || window_ref == NULL || result == NULL) return false;
  const MetaWindowRecord *record = NULL;
  AXHandle *handle =
      resolve_transition_target(backend, window_ref, &record, result);
  if (handle == NULL) return false;
  result->close_attempted = true;
  CFTypeRef button_value = NULL;
  const AXError copy_error = AXUIElementCopyAttributeValue(
      handle->element, kAXCloseButtonAttribute, &button_value);
  AXError close_error = copy_error;
  if (copy_error == kAXErrorSuccess && button_value != NULL &&
      CFGetTypeID(button_value) == AXUIElementGetTypeID()) {
    close_error = AXUIElementPerformAction((AXUIElementRef)button_value,
                                           kAXPressAction);
  }
  if (button_value != NULL) CFRelease(button_value);
  result->ax_error = close_error == kAXErrorSuccess ? 0 : close_error;
  bool sheet_observed = false;
  const bool present = element_still_present(handle, &sheet_observed);
  result->modal_or_sheet_observed = sheet_observed;
  result->close_succeeded = close_error == kAXErrorSuccess && !present;
  if (result->close_succeeded) {
    result->status = META_TRANSITION_SUCCEEDED;
    return true;
  }
  result->status = META_TRANSITION_PARTIAL;
  return false;
}
