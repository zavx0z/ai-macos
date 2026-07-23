#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
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
          "usage: meta-input-helper <check|request|position|move|click|drag|scroll|key|type> ...\n");
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
  if (argc != 4) return EXIT_USAGE;
  long dx = 0, dy = 0;
  if (!parse_long(argv[2], &dx) || !parse_long(argv[3], &dy))
    return EXIT_USAGE;
  CGEventRef event = CGEventCreateScrollWheelEvent(
      NULL, kCGScrollEventUnitLine, 2, (int32_t)-dy, (int32_t)dx);
  if (event == NULL) return 1;
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
  if (!post_key((CGKeyCode)key_code, false, (CGEventFlags)flags)) return 1;
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
  if (strcmp(argv[1], "request") == 0) return command_request();

  const int permission = require_accessibility();
  if (permission != 0) return permission;

  int result = EXIT_USAGE;
  if (strcmp(argv[1], "position") == 0)
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
