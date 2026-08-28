#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <libproc.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum {
  EXIT_USAGE = 64,
  EXIT_PERMISSION = 77,
};

static void usage(void) {
  fprintf(stderr,
          "usage: meta-input-helper <preflight|check|request|windows|frontmost|application-focus|window-focus|window-raise|window-move|window-resize|position|move|click|drag|scroll|key|type> ...\n");
}

static bool parse_double(const char *value, double *out) {
  char *end = NULL;
  errno = 0;
  const double parsed = strtod(value, &end);
  if (errno != 0 || end == value || *end != '\0') return false;
  *out = parsed;
  return true;
}

static bool parse_long(const char *value, long *out) {
  char *end = NULL;
  errno = 0;
  const long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return false;
  *out = parsed;
  return true;
}

static bool parse_u64(const char *value, uint64_t *out) {
  char *end = NULL;
  errno = 0;
  const unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return false;
  *out = (uint64_t)parsed;
  return true;
}

static bool preflight_access_granted(void) {
  return AXIsProcessTrusted() && CGPreflightPostEventAccess();
}

static int require_accessibility(void) {
  if (preflight_access_granted()) return 0;
  fprintf(stderr, "Accessibility permission is not granted to meta-input-helper\n");
  return EXIT_PERMISSION;
}

static bool post_mouse(CGEventType type, double x, double y, CGMouseButton button) {
  CGEventRef event =
      CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), button);
  if (event == NULL) return false;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

static bool post_mouse_click(CGEventType type, double x, double y,
                             CGMouseButton button, int64_t click_state) {
  CGEventRef event =
      CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), button);
  if (event == NULL) return false;
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_state);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

static bool post_key(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  if (event == NULL) return false;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

static bool active_event_access_granted(void) {
  if (!preflight_access_granted()) return false;

  CGEventRef current = CGEventCreate(NULL);
  if (current == NULL) return false;
  const CGPoint before = CGEventGetLocation(current);
  CFRelease(current);

  CGDirectDisplayID display = 0;
  uint32_t display_count = 0;
  double delta = 1;
  if (CGGetDisplaysWithPoint(before, 1, &display, &display_count) ==
          kCGErrorSuccess &&
      display_count == 1) {
    const CGRect bounds = CGDisplayBounds(display);
    delta = before.x < CGRectGetMidX(bounds) ? 1 : -1;
  }
  const CGPoint target = CGPointMake(before.x + delta, before.y);
  if (!post_mouse(kCGEventMouseMoved, target.x, target.y, kCGMouseButtonLeft))
    return false;

  usleep(150000);
  current = CGEventCreate(NULL);
  if (current == NULL) return false;
  const CGPoint after = CGEventGetLocation(current);
  CFRelease(current);

  const bool moved = after.x == target.x && after.y == target.y;
  if (moved) {
    post_mouse(kCGEventMouseMoved, before.x, before.y, kCGMouseButtonLeft);
    usleep(50000);
  }
  return moved;
}

static void print_json_string_bytes(const char *value) {
  putchar('"');
  if (value != NULL) {
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor;
         cursor++) {
      const unsigned char byte = *cursor;
      if (byte == '"' || byte == '\\') {
        putchar('\\');
        putchar(byte);
      } else if (byte == '\b') {
        fputs("\\b", stdout);
      } else if (byte == '\f') {
        fputs("\\f", stdout);
      } else if (byte == '\n') {
        fputs("\\n", stdout);
      } else if (byte == '\r') {
        fputs("\\r", stdout);
      } else if (byte == '\t') {
        fputs("\\t", stdout);
      } else if (byte < 0x20) {
        fprintf(stdout, "\\u%04x", byte);
      } else {
        putchar(byte);
      }
    }
  }
  putchar('"');
}

static void print_json_cfstring(CFStringRef value) {
  if (value == NULL) {
    print_json_string_bytes("");
    return;
  }
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maximum =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  char *buffer = calloc((size_t)maximum, sizeof(char));
  if (buffer == NULL ||
      !CFStringGetCString(value, buffer, maximum, kCFStringEncodingUTF8)) {
    free(buffer);
    print_json_string_bytes("");
    return;
  }
  print_json_string_bytes(buffer);
  free(buffer);
}

static CFStringRef copy_process_name(pid_t pid) {
  char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_name(pid, name, sizeof(name)) <= 0) {
    snprintf(name, sizeof(name), "pid-%d", pid);
  }
  return CFStringCreateWithCString(kCFAllocatorDefault, name,
                                   kCFStringEncodingUTF8);
}

static bool copy_ax_windows(pid_t pid, AXUIElementRef *application_out,
                            CFArrayRef *windows_out) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return false;
  CFTypeRef value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      application, kAXWindowsAttribute, &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    CFRelease(application);
    return false;
  }
  *application_out = application;
  *windows_out = (CFArrayRef)value;
  return true;
}

static bool copy_ax_frame(AXUIElementRef window, CGPoint *position,
                          CGSize *size) {
  CFTypeRef position_value = NULL;
  CFTypeRef size_value = NULL;
  const AXError position_error = AXUIElementCopyAttributeValue(
      window, kAXPositionAttribute, &position_value);
  const AXError size_error = AXUIElementCopyAttributeValue(
      window, kAXSizeAttribute, &size_value);
  const bool valid =
      position_error == kAXErrorSuccess && size_error == kAXErrorSuccess &&
      position_value != NULL && size_value != NULL &&
      CFGetTypeID(position_value) == AXValueGetTypeID() &&
      CFGetTypeID(size_value) == AXValueGetTypeID() &&
      AXValueGetType((AXValueRef)position_value) == kAXValueCGPointType &&
      AXValueGetType((AXValueRef)size_value) == kAXValueCGSizeType &&
      AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType,
                      position) &&
      AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, size);
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  return valid;
}

static CFStringRef copy_ax_title(AXUIElementRef window) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &value) !=
          kAXErrorSuccess ||
      value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return NULL;
  }
  return (CFStringRef)value;
}

static bool same_frame(CGRect cg_frame, CGPoint ax_position, CGSize ax_size) {
  const double tolerance = 2.0;
  return fabs(cg_frame.origin.x - ax_position.x) <= tolerance &&
         fabs(cg_frame.origin.y - ax_position.y) <= tolerance &&
         fabs(cg_frame.size.width - ax_size.width) <= tolerance &&
         fabs(cg_frame.size.height - ax_size.height) <= tolerance;
}

static void print_window_json(CFStringRef app, pid_t pid, CFStringRef title,
                              CFIndex index, CGPoint position, CGSize size) {
  fputs("{\"app\":", stdout);
  print_json_cfstring(app);
  fprintf(stdout, ",\"pid\":%d,\"title\":", pid);
  print_json_cfstring(title);
  fprintf(stdout,
          ",\"index\":%ld,\"x\":%.0f,\"y\":%.0f,\"width\":%.0f,\"height\":%.0f}",
          (long)index, position.x, position.y, size.width, size.height);
}

typedef struct {
  pid_t pid;
  CFIndex index;
} SeenWindow;

static bool already_seen(const SeenWindow *seen, size_t count, pid_t pid,
                         CFIndex index) {
  for (size_t i = 0; i < count; i++) {
    if (seen[i].pid == pid && seen[i].index == index) return true;
  }
  return false;
}

static int command_windows(void) {
  CFArrayRef cg_windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (cg_windows == NULL) {
    fprintf(stderr, "CGWindowListCopyWindowInfo failed\n");
    return 1;
  }

  const CFIndex count = CFArrayGetCount(cg_windows);
  SeenWindow *seen = calloc((size_t)count, sizeof(SeenWindow));
  if (seen == NULL) {
    CFRelease(cg_windows);
    return 1;
  }

  size_t seen_count = 0;
  bool first = true;
  fputs("{\"windows\":[", stdout);
  for (CFIndex cg_index = 0; cg_index < count; cg_index++) {
    CFDictionaryRef info =
        (CFDictionaryRef)CFArrayGetValueAtIndex(cg_windows, cg_index);
    if (info == NULL || CFGetTypeID(info) != CFDictionaryGetTypeID()) continue;

    int layer = 0;
    CFNumberRef layer_value =
        (CFNumberRef)CFDictionaryGetValue(info, kCGWindowLayer);
    if (layer_value == NULL ||
        !CFNumberGetValue(layer_value, kCFNumberIntType, &layer) || layer != 0)
      continue;

    pid_t pid = 0;
    CFNumberRef pid_value =
        (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
    if (pid_value == NULL ||
        !CFNumberGetValue(pid_value, kCFNumberIntType, &pid) || pid <= 0)
      continue;

    CGRect cg_frame = CGRectZero;
    CFDictionaryRef bounds =
        (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
    if (bounds == NULL ||
        !CGRectMakeWithDictionaryRepresentation(bounds, &cg_frame) ||
        cg_frame.size.width <= 0 || cg_frame.size.height <= 0)
      continue;

    AXUIElementRef application = NULL;
    CFArrayRef ax_windows = NULL;
    if (!copy_ax_windows(pid, &application, &ax_windows)) continue;

    const CFIndex ax_count = CFArrayGetCount(ax_windows);
    for (CFIndex ax_index = 0; ax_index < ax_count; ax_index++) {
      AXUIElementRef window =
          (AXUIElementRef)CFArrayGetValueAtIndex(ax_windows, ax_index);
      CGPoint position = CGPointZero;
      CGSize size = CGSizeZero;
      if (!copy_ax_frame(window, &position, &size) ||
          !same_frame(cg_frame, position, size) ||
          already_seen(seen, seen_count, pid, ax_index + 1))
        continue;

      CFStringRef app =
          (CFStringRef)CFDictionaryGetValue(info, kCGWindowOwnerName);
      CFStringRef fallback_app = NULL;
      if (app == NULL || CFGetTypeID(app) != CFStringGetTypeID()) {
        fallback_app = copy_process_name(pid);
        app = fallback_app;
      }
      CFStringRef title = copy_ax_title(window);
      if (title == NULL) {
        CFTypeRef cg_title = CFDictionaryGetValue(info, kCGWindowName);
        if (cg_title != NULL && CFGetTypeID(cg_title) == CFStringGetTypeID()) {
          title = (CFStringRef)CFRetain(cg_title);
        }
      }
      if (!first) putchar(',');
      print_window_json(app, pid, title, ax_index + 1, position, size);
      first = false;
      seen[seen_count++] = (SeenWindow){.pid = pid, .index = ax_index + 1};
      if (title != NULL) CFRelease(title);
      if (fallback_app != NULL) CFRelease(fallback_app);
      break;
    }
    CFRelease(ax_windows);
    CFRelease(application);
  }
  fputs("]}\n", stdout);
  free(seen);
  CFRelease(cg_windows);
  return 0;
}

static CFIndex index_of_ax_window(CFArrayRef windows, AXUIElementRef target,
                                  CGPoint target_position,
                                  CGSize target_size) {
  const CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index++) {
    AXUIElementRef candidate =
        (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (CFEqual(candidate, target)) return index + 1;
    CGPoint position = CGPointZero;
    CGSize size = CGSizeZero;
    if (copy_ax_frame(candidate, &position, &size) &&
        same_frame(CGRectMake(target_position.x, target_position.y,
                              target_size.width, target_size.height),
                   position, size))
      return index + 1;
  }
  return 0;
}

static int command_frontmost(void) {
  NSRunningApplication *frontmost = nil;
  @autoreleasepool {
    frontmost = [[[NSWorkspace sharedWorkspace] frontmostApplication] retain];
  }
  if (frontmost == nil || frontmost.processIdentifier <= 0) {
    fprintf(stderr, "frontmost application is unavailable\n");
    return 1;
  }
  const pid_t pid = frontmost.processIdentifier;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return 1;
  CFStringRef app = NULL;
  @autoreleasepool {
    NSString *name = frontmost.localizedName;
    if (name != nil) {
      app = CFStringCreateWithCString(kCFAllocatorDefault, name.UTF8String,
                                     kCFStringEncodingUTF8);
    }
  }
  if (app == NULL) app = copy_process_name(pid);
  [frontmost release];
  fputs("{\"app\":", stdout);
  print_json_cfstring(app);
  fprintf(stdout, ",\"pid\":%d,\"window\":", pid);

  CFTypeRef window_value = NULL;
  const AXError window_error = AXUIElementCopyAttributeValue(
      application, kAXFocusedWindowAttribute, &window_value);
  if (window_error != kAXErrorSuccess || window_value == NULL) {
    fputs("null}\n", stdout);
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(app);
    CFRelease(application);
    return 0;
  }

  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_ax_frame(window, &position, &size)) {
    fputs("null}\n", stdout);
    CFRelease(window);
    CFRelease(app);
    CFRelease(application);
    return 0;
  }

  CFIndex index = 0;
  CFTypeRef windows_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute,
                                    &windows_value) == kAXErrorSuccess &&
      windows_value != NULL &&
      CFGetTypeID(windows_value) == CFArrayGetTypeID()) {
    index = index_of_ax_window((CFArrayRef)windows_value, window, position, size);
  }
  if (windows_value != NULL) CFRelease(windows_value);
  CFStringRef title = copy_ax_title(window);
  print_window_json(app, pid, title, index, position, size);
  fputs("}\n", stdout);
  if (title != NULL) CFRelease(title);
  CFRelease(window);
  CFRelease(app);
  CFRelease(application);
  return 0;
}

static bool parse_window_target(int argc, char **argv, int expected_argc,
                                pid_t *pid, CFIndex *index) {
  if (argc != expected_argc) return false;
  long pid_value = 0;
  long index_value = 0;
  if (!parse_long(argv[2], &pid_value) ||
      !parse_long(argv[3], &index_value) || pid_value <= 0 ||
      index_value <= 0)
    return false;
  *pid = (pid_t)pid_value;
  *index = (CFIndex)index_value;
  return true;
}

static bool copy_target_window(pid_t pid, CFIndex index,
                               AXUIElementRef *application_out,
                               AXUIElementRef *window_out) {
  AXUIElementRef application = NULL;
  CFArrayRef windows = NULL;
  if (!copy_ax_windows(pid, &application, &windows)) return false;
  if (index < 1 || index > CFArrayGetCount(windows)) {
    CFRelease(windows);
    CFRelease(application);
    return false;
  }
  AXUIElementRef window =
      (AXUIElementRef)CFArrayGetValueAtIndex(windows, index - 1);
  CFRetain(window);
  CFRelease(windows);
  *application_out = application;
  *window_out = window;
  return true;
}

static int command_window_focus(int argc, char **argv) {
  pid_t pid = 0;
  CFIndex index = 0;
  if (!parse_window_target(argc, argv, 4, &pid, &index)) return EXIT_USAGE;
  AXUIElementRef application = NULL;
  AXUIElementRef window = NULL;
  if (!copy_target_window(pid, index, &application, &window)) {
    fprintf(stderr, "window not found: pid=%d index=%ld\n", pid, (long)index);
    return 1;
  }

  bool activated = false;
  @autoreleasepool {
    NSRunningApplication *running =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    activated = running != nil &&
                [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  }
  const AXError raise_error = AXUIElementPerformAction(window, kAXRaiseAction);
  const AXError main_error =
      AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
  const AXError focused_error = AXUIElementSetAttributeValue(
      application, kAXFocusedWindowAttribute, window);
  const AXError frontmost_error = AXUIElementSetAttributeValue(
      application, kAXFrontmostAttribute, kCFBooleanTrue);
  CFRelease(window);
  CFRelease(application);
  if (!activated || raise_error != kAXErrorSuccess ||
      frontmost_error != kAXErrorSuccess) {
    fprintf(stderr,
            "window focus failed: activated=%s raise=%d main=%d focused=%d frontmost=%d\n",
            activated ? "true" : "false", raise_error, main_error,
            focused_error, frontmost_error);
    return 1;
  }
  usleep(100000);
  return 0;
}

static int command_application_focus(int argc, char **argv) {
  if (argc != 3) return EXIT_USAGE;
  long pid_value = 0;
  if (!parse_long(argv[2], &pid_value) || pid_value <= 0) return EXIT_USAGE;
  bool activated = false;
  @autoreleasepool {
    NSRunningApplication *running =
        [NSRunningApplication runningApplicationWithProcessIdentifier:
                                  (pid_t)pid_value];
    activated = running != nil &&
                [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  }
  if (!activated) {
    fprintf(stderr, "application focus failed: pid=%ld\n", pid_value);
    return 1;
  }
  usleep(100000);
  return 0;
}

static int command_window_raise(int argc, char **argv) {
  pid_t pid = 0;
  CFIndex index = 0;
  if (!parse_window_target(argc, argv, 4, &pid, &index)) return EXIT_USAGE;
  AXUIElementRef application = NULL;
  AXUIElementRef window = NULL;
  if (!copy_target_window(pid, index, &application, &window)) {
    fprintf(stderr, "window not found: pid=%d index=%ld\n", pid, (long)index);
    return 1;
  }
  const AXError error = AXUIElementPerformAction(window, kAXRaiseAction);
  CFRelease(window);
  CFRelease(application);
  if (error != kAXErrorSuccess) {
    fprintf(stderr, "AXRaise failed: %d\n", error);
    return 1;
  }
  return 0;
}

static int command_window_move(int argc, char **argv) {
  pid_t pid = 0;
  CFIndex index = 0;
  if (!parse_window_target(argc, argv, 6, &pid, &index)) return EXIT_USAGE;
  double x = 0;
  double y = 0;
  if (!parse_double(argv[4], &x) || !parse_double(argv[5], &y))
    return EXIT_USAGE;
  AXUIElementRef application = NULL;
  AXUIElementRef window = NULL;
  if (!copy_target_window(pid, index, &application, &window)) return 1;
  const CGPoint point = CGPointMake(x, y);
  AXValueRef value = AXValueCreate(kAXValueCGPointType, &point);
  const AXError error = value == NULL
                            ? kAXErrorFailure
                            : AXUIElementSetAttributeValue(
                                  window, kAXPositionAttribute, value);
  if (value != NULL) CFRelease(value);
  CFRelease(window);
  CFRelease(application);
  if (error != kAXErrorSuccess) {
    fprintf(stderr, "window move failed: %d\n", error);
    return 1;
  }
  return 0;
}

static int command_window_resize(int argc, char **argv) {
  pid_t pid = 0;
  CFIndex index = 0;
  if (!parse_window_target(argc, argv, 6, &pid, &index)) return EXIT_USAGE;
  double width = 0;
  double height = 0;
  if (!parse_double(argv[4], &width) || !parse_double(argv[5], &height) ||
      width <= 0 || height <= 0)
    return EXIT_USAGE;
  AXUIElementRef application = NULL;
  AXUIElementRef window = NULL;
  if (!copy_target_window(pid, index, &application, &window)) return 1;
  const CGSize size = CGSizeMake(width, height);
  AXValueRef value = AXValueCreate(kAXValueCGSizeType, &size);
  const AXError error = value == NULL
                            ? kAXErrorFailure
                            : AXUIElementSetAttributeValue(
                                  window, kAXSizeAttribute, value);
  if (value != NULL) CFRelease(value);
  CFRelease(window);
  CFRelease(application);
  if (error != kAXErrorSuccess) {
    fprintf(stderr, "window resize failed: %d\n", error);
    return 1;
  }
  return 0;
}

static int command_request(void) {
  const void *keys[] = {kAXTrustedCheckOptionPrompt};
  const void *values[] = {kCFBooleanTrue};
  CFDictionaryRef options = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  const bool ax = AXIsProcessTrustedWithOptions(options);
  if (options != NULL) CFRelease(options);
  const bool post = CGRequestPostEventAccess();
  printf("{\"accessibility\":%s,\"postEvents\":%s}\n",
         ax ? "true" : "false", post ? "true" : "false");
  return ax && post ? 0 : EXIT_PERMISSION;
}

static int command_position(void) {
  CGEventRef event = CGEventCreate(NULL);
  if (event == NULL) return 1;
  const CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  printf("%.0f,%.0f\n", point.x, point.y);
  return 0;
}

static int command_move(int argc, char **argv) {
  if (argc != 4) return EXIT_USAGE;
  double x = 0, y = 0;
  if (!parse_double(argv[2], &x) || !parse_double(argv[3], &y))
    return EXIT_USAGE;
  if (!post_mouse(kCGEventMouseMoved, x, y, kCGMouseButtonLeft)) return 1;
  usleep(50000);
  return 0;
}

static int command_click(int argc, char **argv) {
  if (argc != 6) return EXIT_USAGE;
  double x = 0, y = 0;
  long button_value = 0, count = 0;
  if (!parse_double(argv[2], &x) || !parse_double(argv[3], &y) ||
      !parse_long(argv[4], &button_value) || !parse_long(argv[5], &count) ||
      button_value < 0 || button_value > 2 || count < 1 || count > 3)
    return EXIT_USAGE;

  const CGMouseButton button = (CGMouseButton)button_value;
  const CGEventType down =
      button == kCGMouseButtonRight
          ? kCGEventRightMouseDown
          : button == kCGMouseButtonCenter ? kCGEventOtherMouseDown
                                           : kCGEventLeftMouseDown;
  const CGEventType up =
      button == kCGMouseButtonRight
          ? kCGEventRightMouseUp
          : button == kCGMouseButtonCenter ? kCGEventOtherMouseUp
                                           : kCGEventLeftMouseUp;

  if (!post_mouse(kCGEventMouseMoved, x, y, button)) return 1;
  usleep(20000);
  for (long i = 0; i < count; i++) {
    if (!post_mouse_click(down, x, y, button, i + 1)) return 1;
    usleep(50000);
    if (!post_mouse_click(up, x, y, button, i + 1)) return 1;
    if (i + 1 < count) usleep(50000);
  }
  usleep(50000);
  return 0;
}

static int command_drag(int argc, char **argv) {
  if (argc != 7) return EXIT_USAGE;
  double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  long duration_ms = 0;
  if (!parse_double(argv[2], &x1) || !parse_double(argv[3], &y1) ||
      !parse_double(argv[4], &x2) || !parse_double(argv[5], &y2) ||
      !parse_long(argv[6], &duration_ms) || duration_ms < 0 ||
      duration_ms > 5000)
    return EXIT_USAGE;

  if (!post_mouse(kCGEventMouseMoved, x1, y1, kCGMouseButtonLeft)) return 1;
  usleep(20000);
  if (!post_mouse(kCGEventLeftMouseDown, x1, y1, kCGMouseButtonLeft)) return 1;
  usleep(50000);
  if (!post_mouse(kCGEventLeftMouseDragged, x2, y2, kCGMouseButtonLeft))
    return 1;
  usleep((useconds_t)duration_ms * 1000);
  if (!post_mouse(kCGEventLeftMouseUp, x2, y2, kCGMouseButtonLeft)) return 1;
  usleep(50000);
  return 0;
}

static int command_scroll(int argc, char **argv) {
  if (argc != 4 && argc != 6) return EXIT_USAGE;
  long dx = 0, dy = 0;
  if (!parse_long(argv[2], &dx) || !parse_long(argv[3], &dy))
    return EXIT_USAGE;
  double x = 0;
  double y = 0;
  const bool has_location = argc == 6;
  if (has_location &&
      (!parse_double(argv[4], &x) || !parse_double(argv[5], &y)))
    return EXIT_USAGE;
  CGEventRef event = CGEventCreateScrollWheelEvent(
      NULL, kCGScrollEventUnitLine, 2, (int32_t)-dy, (int32_t)dx);
  if (event == NULL) return 1;
  if (has_location) CGEventSetLocation(event, CGPointMake(x, y));
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(50000);
  return 0;
}

static int command_key(int argc, char **argv) {
  if (argc != 4) return EXIT_USAGE;
  long key_code = 0;
  uint64_t flags = 0;
  if (!parse_long(argv[2], &key_code) || !parse_u64(argv[3], &flags) ||
      key_code < 0 || key_code > UINT16_MAX)
    return EXIT_USAGE;
  if (!post_key((CGKeyCode)key_code, true, (CGEventFlags)flags)) return 1;
  usleep(30000);
  // A key-up event must not retain synthetic modifier flags. Keeping Command
  // on the key-up made the next independently-created Unicode events inherit
  // Command, so typing text after Cmd+L was interpreted as more shortcuts.
  if (!post_key((CGKeyCode)key_code, false, 0)) return 1;
  usleep(50000);
  return 0;
}

static int command_type(int argc, char **argv) {
  if (argc != 4) return EXIT_USAGE;
  long delay_ms = 0;
  if (!parse_long(argv[3], &delay_ms) || delay_ms < 0 || delay_ms > 5000)
    return EXIT_USAGE;

  CFStringRef text = CFStringCreateWithCString(
      kCFAllocatorDefault, argv[2], kCFStringEncodingUTF8);
  if (text == NULL) {
    fprintf(stderr, "text is not valid UTF-8\n");
    return EXIT_USAGE;
  }

  const CFIndex length = CFStringGetLength(text);
  UniChar buffer[20];
  for (CFIndex offset = 0; offset < length;) {
    CFIndex count = delay_ms > 0 ? 1 : 20;
    if (offset + count > length) count = length - offset;
    const UniChar last = CFStringGetCharacterAtIndex(text, offset + count - 1);
    if (last >= 0xD800 && last <= 0xDBFF && offset + count < length) {
      if (count == 20) count--;
      else count++;
    }
    CFStringGetCharacters(text, CFRangeMake(offset, count), buffer);
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    if (down == NULL || up == NULL) {
      if (down != NULL) CFRelease(down);
      if (up != NULL) CFRelease(up);
      CFRelease(text);
      return 1;
    }
    // Unicode input is plain text. Explicitly clear flags instead of relying
    // on the process-wide CoreGraphics event-source state left by a shortcut.
    CGEventSetFlags(down, 0);
    CGEventSetFlags(up, 0);
    CGEventKeyboardSetUnicodeString(down, count, buffer);
    CGEventKeyboardSetUnicodeString(up, count, buffer);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    offset += count;
    if (delay_ms > 0 && offset < length)
      usleep((useconds_t)delay_ms * 1000);
  }
  CFRelease(text);
  usleep(50000);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    usage();
    return EXIT_USAGE;
  }

  if (strcmp(argv[1], "check") == 0) {
    const bool effective = active_event_access_granted();
    printf("{\"accessibility\":%s,\"postEvents\":%s,\"effective\":%s}\n",
           AXIsProcessTrusted() ? "true" : "false",
           CGPreflightPostEventAccess() ? "true" : "false",
           effective ? "true" : "false");
    return effective ? 0 : EXIT_PERMISSION;
  }
  if (strcmp(argv[1], "preflight") == 0) {
    const bool accessibility = AXIsProcessTrusted();
    const bool post_events = CGPreflightPostEventAccess();
    const bool effective = accessibility && post_events;
    printf("{\"accessibility\":%s,\"postEvents\":%s,\"effective\":%s}\n",
           accessibility ? "true" : "false",
           post_events ? "true" : "false",
           effective ? "true" : "false");
    return effective ? 0 : EXIT_PERMISSION;
  }
  if (strcmp(argv[1], "request") == 0) return command_request();

  const int permission = require_accessibility();
  if (permission != 0) return permission;

  int result = EXIT_USAGE;
  if (strcmp(argv[1], "windows") == 0)
    result = command_windows();
  else if (strcmp(argv[1], "frontmost") == 0)
    result = command_frontmost();
  else if (strcmp(argv[1], "application-focus") == 0)
    result = command_application_focus(argc, argv);
  else if (strcmp(argv[1], "window-focus") == 0)
    result = command_window_focus(argc, argv);
  else if (strcmp(argv[1], "window-raise") == 0)
    result = command_window_raise(argc, argv);
  else if (strcmp(argv[1], "window-move") == 0)
    result = command_window_move(argc, argv);
  else if (strcmp(argv[1], "window-resize") == 0)
    result = command_window_resize(argc, argv);
  else if (strcmp(argv[1], "position") == 0)
    result = command_position();
  else if (strcmp(argv[1], "move") == 0)
    result = command_move(argc, argv);
  else if (strcmp(argv[1], "click") == 0)
    result = command_click(argc, argv);
  else if (strcmp(argv[1], "drag") == 0)
    result = command_drag(argc, argv);
  else if (strcmp(argv[1], "scroll") == 0)
    result = command_scroll(argc, argv);
  else if (strcmp(argv[1], "key") == 0)
    result = command_key(argc, argv);
  else if (strcmp(argv[1], "type") == 0)
    result = command_type(argc, argv);

  if (result == EXIT_USAGE) usage();
  return result;
}
