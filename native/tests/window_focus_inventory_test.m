#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>

// Изолированная регрессия сборщика inventory. Настоящие окна, AX и Runtime
// не используются: подмены действуют только в этой единице компиляции.
static pid_t fixture_frontmost = 900001;
static size_t fixture_frontmost_reads = 0;
static bool fixture_switch_frontmost = false;
static bool fixture_no_foreground = false;
static CFStringRef fixture_focused_window;
static AXError fixture_focus_error = kAXErrorSuccess;
static bool fixture_literal_focused = false;
static bool fixture_application_timeout = false;

@interface CUFocusApplication : NSObject
@property(nonatomic) pid_t processIdentifier;
@end
@implementation CUFocusApplication
@end

@interface CUFocusWorkspace : NSObject
+ (instancetype)sharedWorkspace;
@property(readonly) NSRunningApplication *frontmostApplication;
@property(readonly) NSArray<NSRunningApplication *> *runningApplications;
@end
@implementation CUFocusWorkspace
+ (instancetype)sharedWorkspace {
  static CUFocusWorkspace *workspace;
  if (workspace == nil) workspace = [CUFocusWorkspace new];
  return workspace;
}
- (NSRunningApplication *)frontmostApplication {
  fixture_frontmost_reads += 1;
  if (fixture_no_foreground) return nil;
  CUFocusApplication *application = [CUFocusApplication new];
  application.processIdentifier = fixture_switch_frontmost &&
      fixture_frontmost_reads > 1 ? 900002 : fixture_frontmost;
  return (NSRunningApplication *)(id)application;
}
- (NSArray<NSRunningApplication *> *)runningApplications { return @[]; }
@end

static AXUIElementRef fixture_create_application(pid_t pid) {
  (void)pid;
  return (AXUIElementRef)CFRetain(CFSTR("fixture-application"));
}
static CFTypeID fixture_element_type(void) { return CFStringGetTypeID(); }
static AXError fixture_timeout(AXUIElementRef element, Float32 timeout) {
  (void)timeout;
  if (fixture_application_timeout && CFEqual(element, CFSTR("fixture-application")))
    return kAXErrorCannotComplete;
  return kAXErrorSuccess;
}
static AXError fixture_copy_attribute(AXUIElementRef element,
                                      CFStringRef attribute, CFTypeRef *value) {
  (void)element;
  *value = NULL;
  if (CFEqual(attribute, kAXFocusedWindowAttribute)) {
    if (fixture_focus_error != kAXErrorSuccess) return fixture_focus_error;
    *value = CFRetain(fixture_focused_window);
  } else if (CFEqual(attribute, kAXRoleAttribute)) {
    *value = CFRetain(CFSTR("AXWindow"));
  } else if (CFEqual(attribute, kAXSubroleAttribute)) {
    *value = CFRetain(CFSTR("AXStandardWindow"));
  } else if (CFEqual(attribute, kAXTitleAttribute)) {
    *value = CFRetain(CFSTR("Isolated focus fixture"));
  } else if (CFEqual(attribute, kAXFocusedAttribute)) {
    *value = CFRetain(fixture_literal_focused ? kCFBooleanTrue : kCFBooleanFalse);
  } else if (CFEqual(attribute, kAXMinimizedAttribute) ||
             CFEqual(attribute, CFSTR("AXFullScreen")) ||
             CFEqual(attribute, kAXMainAttribute)) {
    *value = CFRetain(kCFBooleanFalse);
  } else if (CFEqual(attribute, kAXPositionAttribute)) {
    CGPoint point = CGPointMake(10, 20);
    *value = AXValueCreate(kAXValueCGPointType, &point);
  } else if (CFEqual(attribute, kAXSizeAttribute)) {
    CGSize size = CGSizeMake(800, 600);
    *value = AXValueCreate(kAXValueCGSizeType, &size);
  } else {
    return kAXErrorAttributeUnsupported;
  }
  return kAXErrorSuccess;
}
static AXError fixture_actions(AXUIElementRef element, CFArrayRef *actions) {
  (void)element;
  *actions = CFArrayCreate(NULL, NULL, 0, &kCFTypeArrayCallBacks);
  return kAXErrorSuccess;
}
static AXError fixture_settable(AXUIElementRef element, CFStringRef attribute,
                                Boolean *settable) {
  (void)element;
  (void)attribute;
  *settable = false;
  return kAXErrorSuccess;
}

#define NSWorkspace CUFocusWorkspace
#define AXUIElementCreateApplication fixture_create_application
#define AXUIElementGetTypeID fixture_element_type
#define AXUIElementSetMessagingTimeout fixture_timeout
#define AXUIElementCopyAttributeValue fixture_copy_attribute
#define AXUIElementCopyActionNames fixture_actions
#define AXUIElementIsAttributeSettable fixture_settable
#include "../src/macos_backend.m"

static void reset_fixture(void) {
  fixture_frontmost = 900001;
  fixture_frontmost_reads = 0;
  fixture_switch_frontmost = false;
  fixture_no_foreground = false;
  fixture_focused_window = CFSTR("window-a");
  fixture_focus_error = kAXErrorSuccess;
  fixture_literal_focused = false;
  fixture_application_timeout = false;
}

static bool verify_focus(const char *name, MetaTriState expected) {
  MetaMacOSBackend backend = { .next_handle_token = 1, .refresh_number = 1 };
  MetaAXWindowInput *windows = NULL;
  size_t count = 0;
  bool timed_out = false;
  const bool collected = append_ax_window(&backend, &windows, &count,
      900001, 1, (AXUIElementRef)CFSTR("window-a"), 0,
      monotonic_millis() + 1000, &timed_out);
  const MetaTriState actual = count == 1 ? windows[0].focused : META_UNKNOWN;
  const bool passed = collected && !timed_out && count == 1 && actual == expected;
  printf("%s %s expected=%d actual=%d\n", passed ? "PASS" : "FAIL",
         name, expected, actual);
  free_ax_window_inputs(windows, count);
  for (size_t index = 0; index < backend.handle_count; index += 1)
    CFRelease(backend.handles[index].element);
  free(backend.handles);
  return passed;
}

int main(void) {
  @autoreleasepool {
    size_t failed = 0;
    reset_fixture();
    failed += !verify_focus("focused-window-identity-not-element-boolean", META_TRUE);
    reset_fixture();
    fixture_literal_focused = true;
    fixture_focused_window = CFSTR("window-b");
    failed += !verify_focus("sibling-window-is-not-focused", META_FALSE);
    reset_fixture();
    fixture_literal_focused = true;
    fixture_frontmost = 900002;
    failed += !verify_focus("background-application-is-not-focused", META_FALSE);
    reset_fixture();
    fixture_focus_error = kAXErrorCannotComplete;
    failed += !verify_focus("unavailable-ax-stays-unknown", META_UNKNOWN);
    reset_fixture();
    fixture_no_foreground = true;
    failed += !verify_focus("missing-foreground-stays-unknown", META_UNKNOWN);
    reset_fixture();
    fixture_switch_frontmost = true;
    failed += !verify_focus("foreground-change-stays-unknown", META_UNKNOWN);
    reset_fixture();
    fixture_focused_window = CFSTR("owned-sheet");
    failed += !verify_focus("sheet-does-not-authorize-parent-window", META_FALSE);
    reset_fixture();
    fixture_application_timeout = true;
    failed += !verify_focus("ax-timeout-setup-stays-unknown", META_UNKNOWN);
    printf("WINDOW_FOCUS_CASES=8 FAILURES=%zu\n", failed);
    return failed == 0 ? 0 : 1;
  }
}
