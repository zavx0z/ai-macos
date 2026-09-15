#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "meta_macos_input.h"

struct MetaMacOSInput {
  double x;
  double y;
  MetaPointerButton button;
  uint64_t flags;
  int64_t click_state;
};

static CGMouseButton cg_button(MetaPointerButton button) {
  if (button == META_POINTER_RIGHT) return kCGMouseButtonRight;
  if (button == META_POINTER_MIDDLE) return kCGMouseButtonCenter;
  return kCGMouseButtonLeft;
}

static void tag_event(CGEventRef event, uint64_t synthetic_tag,
                      uint64_t flags) {
  CGEventSetIntegerValueField(event, kCGEventSourceUserData,
                              (int64_t)synthetic_tag);
  CGEventSetFlags(event, (CGEventFlags)flags);
}

MetaMacOSInput *meta_macos_input_create(void) {
  return calloc(1, sizeof(MetaMacOSInput));
}

void meta_macos_input_destroy(MetaMacOSInput *input) {
  free(input);
}

bool meta_macos_input_preflight(void) {
  return AXIsProcessTrusted() && CGPreflightPostEventAccess();
}

bool meta_macos_input_set_flags(void *context, uint64_t flags) {
  MetaMacOSInput *input = context;
  if (input == NULL) return false;
  input->flags = flags;
  return true;
}

bool meta_macos_input_post_held(void *context, MetaHeldEventKind kind,
                                uint32_t code, bool down,
                                uint64_t synthetic_tag) {
  MetaMacOSInput *input = context;
  if (input == NULL || synthetic_tag == 0) return false;
  CGEventRef event = NULL;
  if (kind == META_EVENT_KEY) {
    if (code > UINT16_MAX) return false;
    event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, down);
    if (event != NULL) {
      tag_event(event, synthetic_tag, down ? input->flags : 0);
    }
  } else {
    if (code > META_POINTER_MIDDLE) return false;
    const MetaPointerButton button = (MetaPointerButton)code;
    CGEventType type = kCGEventLeftMouseDown;
    if (button == META_POINTER_RIGHT) {
      type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
    } else if (button == META_POINTER_MIDDLE) {
      type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
    } else {
      type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
    }
    if (down) input->click_state += 1;
    event = CGEventCreateMouseEvent(NULL, type,
                                    CGPointMake(input->x, input->y),
                                    cg_button(button));
    if (event != NULL) {
      tag_event(event, synthetic_tag, input->flags);
      CGEventSetIntegerValueField(event, kCGMouseEventClickState,
                                  input->click_state);
    }
  }
  if (event == NULL) return false;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

bool meta_macos_input_post_cleanup_up(void *context, MetaHeldEventKind kind,
                                      uint32_t code,
                                      uint64_t synthetic_tag) {
  MetaMacOSInput *input = context;
  if (input == NULL || synthetic_tag == 0) return false;
  CGEventRef event = NULL;
  if (kind == META_EVENT_KEY) {
    if (code > UINT16_MAX) return false;
    event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, false);
  } else {
    if (code > META_POINTER_MIDDLE) return false;
    const MetaPointerButton button = (MetaPointerButton)code;
    CGEventRef cursor = CGEventCreate(NULL);
    if (cursor == NULL) return false;
    const CGPoint current_location = CGEventGetLocation(cursor);
    CFRelease(cursor);
    const CGEventType type =
        button == META_POINTER_RIGHT
            ? kCGEventRightMouseUp
            : button == META_POINTER_MIDDLE ? kCGEventOtherMouseUp
                                            : kCGEventLeftMouseUp;
    event = CGEventCreateMouseEvent(NULL, type, current_location,
                                    cg_button(button));
    if (event != NULL) {
      CGEventSetIntegerValueField(event, kCGMouseEventClickState,
                                  input->click_state);
    }
  }
  if (event == NULL) return false;
  // Cleanup не переносит прежнюю pointer location и не сохраняет modifiers.
  tag_event(event, synthetic_tag, 0);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

bool meta_macos_input_post_text(void *context, const uint16_t *utf16_units,
                                size_t utf16_count,
                                uint64_t synthetic_tag) {
  (void)context;
  if (utf16_units == NULL || utf16_count == 0 || utf16_count > 10000 ||
      synthetic_tag == 0) {
    return false;
  }
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  if (down == NULL || up == NULL) {
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    return false;
  }
  tag_event(down, synthetic_tag, 0);
  tag_event(up, synthetic_tag, 0);
  CGEventKeyboardSetUnicodeString(down, utf16_count,
                                  (const UniChar *)utf16_units);
  CGEventKeyboardSetUnicodeString(up, utf16_count,
                                  (const UniChar *)utf16_units);
  CGEventPost(kCGHIDEventTap, down);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  return true;
}

bool meta_macos_input_post_pointer(void *context,
                                   const MetaPointerEvent *event,
                                   uint64_t synthetic_tag) {
  MetaMacOSInput *input = context;
  if (input == NULL || event == NULL || event->button > META_POINTER_MIDDLE ||
      synthetic_tag == 0) {
    return false;
  }
  input->x = event->x;
  input->y = event->y;
  input->button = event->button;
  input->flags = event->flags;
  if (event->kind == META_POINTER_MOVE) input->click_state = 0;
  CGEventType type = kCGEventMouseMoved;
  if (event->kind == META_POINTER_DRAG) {
    type = event->button == META_POINTER_RIGHT
               ? kCGEventRightMouseDragged
               : event->button == META_POINTER_MIDDLE
                     ? kCGEventOtherMouseDragged
                     : kCGEventLeftMouseDragged;
  }
  CGEventRef value = CGEventCreateMouseEvent(
      NULL, type, CGPointMake(event->x, event->y), cg_button(event->button));
  if (value == NULL) return false;
  tag_event(value, synthetic_tag, event->flags);
  CGEventPost(kCGHIDEventTap, value);
  CFRelease(value);
  return true;
}

bool meta_macos_input_post_scroll(void *context,
                                  const MetaScrollEvent *event,
                                  uint64_t synthetic_tag) {
  MetaMacOSInput *input = context;
  if (input == NULL || event == NULL || event->unit > META_SCROLL_PIXEL ||
      synthetic_tag == 0) {
    return false;
  }
  input->x = event->x;
  input->y = event->y;
  input->flags = event->flags;
  const CGScrollEventUnit unit = event->unit == META_SCROLL_PIXEL
                                     ? kCGScrollEventUnitPixel
                                     : kCGScrollEventUnitLine;
  CGEventRef value = CGEventCreateScrollWheelEvent(
      NULL, unit, 2, (int32_t)-event->dy, (int32_t)event->dx);
  if (value == NULL) return false;
  CGEventSetLocation(value, CGPointMake(event->x, event->y));
  tag_event(value, synthetic_tag, event->flags);
  CGEventPost(kCGHIDEventTap, value);
  CFRelease(value);
  return true;
}
