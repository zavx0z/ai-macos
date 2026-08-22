#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define ACCESSIBILITY_EXIT 77
#define TARGET_NOT_FOUND_EXIT 78
#define VERIFICATION_EXIT 79

typedef AXError (*AXGetWindowIdFn)(AXUIElementRef, CGWindowID *);
static int number_from_dict(CFDictionaryRef dict, CFStringRef key, int fallback);

static AXGetWindowIdFn get_window_id_fn(void) {
  return (AXGetWindowIdFn)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
}

static AXError get_ax_window_id(AXUIElementRef window, CGWindowID *window_id) {
  AXGetWindowIdFn private_get_id = get_window_id_fn();
  if (private_get_id && private_get_id(window, window_id) == kAXErrorSuccess && *window_id != 0) {
    return kAXErrorSuccess;
  }
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(window, CFSTR("AXWindowNumber"), &value);
  if (error == kAXErrorSuccess && value && CFGetTypeID(value) == CFNumberGetTypeID()) {
    int numeric_id = 0;
    CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &numeric_id);
    *window_id = (CGWindowID)numeric_id;
  }
  if (value) CFRelease(value);
  return *window_id != 0 ? kAXErrorSuccess : error;
}

static bool ax_bounds(AXUIElementRef window, CGRect *bounds) {
  CFTypeRef position = NULL;
  CFTypeRef size = NULL;
  CGPoint point = CGPointZero;
  CGSize dimensions = CGSizeZero;
  bool ok = AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position) == kAXErrorSuccess &&
    position && CFGetTypeID(position) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point) &&
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size) == kAXErrorSuccess &&
    size && CFGetTypeID(size) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions);
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  if (ok) *bounds = (CGRect){ point, dimensions };
  return ok;
}

static bool close_enough(CGFloat a, CGFloat b) {
  return a - b < 2.0 && b - a < 2.0;
}

static AXError resolve_ax_window_id(pid_t pid, AXUIElementRef window, CGWindowID *window_id) {
  if (get_ax_window_id(window, window_id) == kAXErrorSuccess && *window_id != 0) return kAXErrorSuccess;
  CGRect ax_rect = CGRectZero;
  if (!ax_bounds(window, &ax_rect)) return kAXErrorNoValue;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (!windows) return kAXErrorFailure;
  CGWindowID matched = 0;
  int matches = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
    CFDictionaryRef item = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
    if (number_from_dict(item, kCGWindowOwnerPID, 0) != pid || number_from_dict(item, kCGWindowLayer, -1) != 0) continue;
    CFDictionaryRef bounds_dict = (CFDictionaryRef)CFDictionaryGetValue(item, kCGWindowBounds);
    CGRect cg_rect = CGRectZero;
    if (!bounds_dict || !CGRectMakeWithDictionaryRepresentation(bounds_dict, &cg_rect)) continue;
    if (close_enough(ax_rect.origin.x, cg_rect.origin.x) && close_enough(ax_rect.origin.y, cg_rect.origin.y) &&
        close_enough(ax_rect.size.width, cg_rect.size.width) && close_enough(ax_rect.size.height, cg_rect.size.height)) {
      matched = (CGWindowID)number_from_dict(item, kCGWindowNumber, 0);
      matches++;
    }
  }
  CFRelease(windows);
  if (matches != 1 || matched == 0) return matches > 1 ? kAXErrorCannotComplete : kAXErrorNoValue;
  *window_id = matched;
  return kAXErrorSuccess;
}

static void json_string(CFStringRef value) {
  if (!value) {
    fputs("\"\"", stdout);
    return;
  }
  char buffer[4096];
  if (!CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    fputs("\"\"", stdout);
    return;
  }
  fputc('"', stdout);
  for (const unsigned char *p = (const unsigned char *)buffer; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) fprintf(stdout, "\\u%04x", *p);
        else fputc(*p, stdout);
    }
  }
  fputc('"', stdout);
}

static int number_from_dict(CFDictionaryRef dict, CFStringRef key, int fallback) {
  CFNumberRef value = (CFNumberRef)CFDictionaryGetValue(dict, key);
  int result = fallback;
  if (value && CFGetTypeID(value) == CFNumberGetTypeID()) {
    CFNumberGetValue(value, kCFNumberIntType, &result);
  }
  return result;
}

static bool focused_identity(pid_t *pid, CGWindowID *window_id) {
  AXUIElementRef system = AXUIElementCreateSystemWide();
  AXUIElementRef app = NULL;
  AXUIElementRef window = NULL;
  bool ok = false;
  if (AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, (CFTypeRef *)&app) == kAXErrorSuccess && app) {
    AXUIElementGetPid(app, pid);
    AXError window_error = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, (CFTypeRef *)&window);
    if ((window_error != kAXErrorSuccess || !window) && window) { CFRelease(window); window = NULL; }
    if (window_error != kAXErrorSuccess || !window) {
      window_error = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, (CFTypeRef *)&window);
    }
    if (window_error == kAXErrorSuccess && window) {
      ok = resolve_ax_window_id(*pid, window, window_id) == kAXErrorSuccess && *window_id != 0;
    }
  }
  if (window) CFRelease(window);
  if (app) CFRelease(app);
  CFRelease(system);
  if (!ok) {
    CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID
    );
    if (windows) {
      for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
        CFDictionaryRef item = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
        if (number_from_dict(item, kCGWindowLayer, -1) != 0) continue;
        int candidate_pid = number_from_dict(item, kCGWindowOwnerPID, 0);
        int candidate_id = number_from_dict(item, kCGWindowNumber, 0);
        if (candidate_pid > 0 && candidate_id > 0) {
          *pid = (pid_t)candidate_pid;
          *window_id = (CGWindowID)candidate_id;
          ok = true;
          break;
        }
      }
      CFRelease(windows);
    }
  }
  return ok;
}

static int list_windows(void) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (!windows) return 1;
  fputc('[', stdout);
  bool first = true;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex i = 0; i < count; i++) {
    CFDictionaryRef item = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
    int layer = number_from_dict(item, kCGWindowLayer, -1);
    if (layer != 0) continue;
    int window_id = number_from_dict(item, kCGWindowNumber, 0);
    int pid = number_from_dict(item, kCGWindowOwnerPID, 0);
    CFDictionaryRef bounds_dict = (CFDictionaryRef)CFDictionaryGetValue(item, kCGWindowBounds);
    CGRect bounds = CGRectZero;
    if (!bounds_dict || !CGRectMakeWithDictionaryRepresentation(bounds_dict, &bounds)) continue;
    if (window_id <= 0 || pid <= 0 || bounds.size.width <= 1 || bounds.size.height <= 1) continue;
    CFStringRef app = (CFStringRef)CFDictionaryGetValue(item, kCGWindowOwnerName);
    CFStringRef title = (CFStringRef)CFDictionaryGetValue(item, kCGWindowName);
    if (!first) fputc(',', stdout);
    first = false;
    fprintf(stdout, "{\"windowId\":%d,\"pid\":%d,\"app\":", window_id, pid);
    json_string(app);
    fputs(",\"title\":", stdout);
    json_string(title);
    fprintf(stdout, ",\"x\":%.0f,\"y\":%.0f,\"width\":%.0f,\"height\":%.0f}",
      bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
  }
  fputs("]\n", stdout);
  CFRelease(windows);
  return 0;
}

static int print_focused(void) {
  if (!AXIsProcessTrusted()) return ACCESSIBILITY_EXIT;
  pid_t pid = 0;
  CGWindowID window_id = 0;
  if (!focused_identity(&pid, &window_id)) {
    fputs("{\"focused\":null}\n", stdout);
    return 0;
  }
  fprintf(stdout, "{\"focused\":{\"pid\":%d,\"windowId\":%u}}\n", pid, window_id);
  return 0;
}

static int focus_window(pid_t pid, CGWindowID requested_id) {
  if (!AXIsProcessTrusted()) return ACCESSIBILITY_EXIT;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef raw_windows = NULL;
  AXError copied = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &raw_windows);
  if (copied != kAXErrorSuccess || !raw_windows || CFGetTypeID(raw_windows) != CFArrayGetTypeID()) {
    if (raw_windows) CFRelease(raw_windows);
    CFRelease(app);
    return TARGET_NOT_FOUND_EXIT;
  }
  CFArrayRef windows = (CFArrayRef)raw_windows;
  AXUIElementRef target = NULL;
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
    AXUIElementRef candidate = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
    CGWindowID candidate_id = 0;
    if (resolve_ax_window_id(pid, candidate, &candidate_id) == kAXErrorSuccess && candidate_id == requested_id) {
      target = candidate;
      CFRetain(target);
      break;
    }
  }
  CFRelease(windows);
  if (!target) {
    CFRelease(app);
    return TARGET_NOT_FOUND_EXIT;
  }
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
  AXUIElementPerformAction(target, kAXRaiseAction);
  AXUIElementSetAttributeValue(target, kAXMainAttribute, kCFBooleanTrue);
  AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue);
  usleep(50000);
  pid_t focused_pid = 0;
  CGWindowID focused_window_id = 0;
  bool verified = focused_identity(&focused_pid, &focused_window_id) &&
    focused_pid == pid && focused_window_id == requested_id;
  CFRelease(target);
  CFRelease(app);
  if (!verified) return VERIFICATION_EXIT;
  fprintf(stdout, "{\"focused\":{\"pid\":%d,\"windowId\":%u},\"verified\":true}\n", pid, requested_id);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (strcmp(argv[1], "list") == 0) return list_windows();
  if (strcmp(argv[1], "focused") == 0) return print_focused();
  if (strcmp(argv[1], "check") == 0) return AXIsProcessTrusted() ? 0 : ACCESSIBILITY_EXIT;
  if (strcmp(argv[1], "request") == 0) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    printf("{\"granted\":%s}\n", trusted ? "true" : "false");
    return trusted ? 0 : ACCESSIBILITY_EXIT;
  }
  if (strcmp(argv[1], "focus") == 0 && argc == 4) {
    return focus_window((pid_t)strtol(argv[2], NULL, 10), (CGWindowID)strtoul(argv[3], NULL, 10));
  }
  return 64;
}
