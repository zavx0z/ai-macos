#include "meta_observer_target_index.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

@interface FixtureElement : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, weak) FixtureElement *parent;
@property(nonatomic, weak) FixtureElement *focusedWindow;
@property(nonatomic, weak) FixtureElement *focusedElement;
@end

@implementation FixtureElement
@end

typedef struct {
  uint64_t now;
  uint64_t process_start;
  uint64_t focused_duration;
  uint64_t parent_duration;
  AXError focused_window_error;
  AXError focused_element_error;
  AXError parent_error;
  AXError pid_error;
  size_t focused_window_calls;
  size_t focused_element_calls;
  size_t parent_calls;
  size_t pid_calls;
  size_t release_calls;
  size_t process_calls;
  __unsafe_unretained MetaObserverTargetIndex *swap_index;
  CFTypeRef swap_records;
  bool swapped;
} BackendFixture;

static AXUIElementRef ax(FixtureElement *element) {
  return (__bridge AXUIElementRef)element;
}

static FixtureElement *fixture_element(AXUIElementRef element) {
  return (__bridge FixtureElement *)element;
}

static uint64_t monotonic_millis(void *context) {
  return ((BackendFixture *)context)->now;
}

static uint64_t process_start_micros(void *context, pid_t pid) {
  BackendFixture *fixture = context;
  assert(pid > 0);
  fixture->process_calls += 1;
  if (!fixture->swapped && fixture->swap_index != nil) {
    fixture->swapped = true;
    assert([fixture->swap_index
        replaceRecords:(__bridge NSArray *)fixture->swap_records]);
  }
  return fixture->process_start;
}

static AXError copy_owned(FixtureElement *value, AXError error,
                          AXUIElementRef *output) {
  if (error != kAXErrorSuccess) return error;
  if (value == nil) return kAXErrorNoValue;
  CFRetain((__bridge CFTypeRef)value);
  *output = ax(value);
  return kAXErrorSuccess;
}

static AXError copy_focused_window(void *context, AXUIElementRef element,
                                   uint64_t timeout_millis,
                                   AXUIElementRef *focused) {
  BackendFixture *fixture = context;
  assert(timeout_millis > 0 && timeout_millis <= 100);
  fixture->focused_window_calls += 1;
  fixture->now += fixture->focused_duration;
  return copy_owned(fixture_element(element).focusedWindow,
                    fixture->focused_window_error, focused);
}

static AXError copy_focused_element(void *context, AXUIElementRef element,
                                    uint64_t timeout_millis,
                                    AXUIElementRef *focused) {
  BackendFixture *fixture = context;
  assert(timeout_millis > 0 && timeout_millis <= 100);
  fixture->focused_element_calls += 1;
  fixture->now += fixture->focused_duration;
  return copy_owned(fixture_element(element).focusedElement,
                    fixture->focused_element_error, focused);
}

static AXError copy_parent(void *context, AXUIElementRef element,
                           uint64_t timeout_millis,
                           AXUIElementRef *parent) {
  BackendFixture *fixture = context;
  assert(timeout_millis > 0 && timeout_millis <= 100);
  fixture->parent_calls += 1;
  fixture->now += fixture->parent_duration;
  return copy_owned(fixture_element(element).parent,
                    fixture->parent_error, parent);
}

static AXError get_pid(void *context, AXUIElementRef element, pid_t *pid) {
  BackendFixture *fixture = context;
  fixture->pid_calls += 1;
  if (fixture->pid_error != kAXErrorSuccess) return fixture->pid_error;
  *pid = fixture_element(element).pid;
  return kAXErrorSuccess;
}

static bool equal(void *context, AXUIElementRef left, AXUIElementRef right) {
  (void)context;
  return left == right;
}

static void release(void *context, AXUIElementRef element) {
  BackendFixture *fixture = context;
  fixture->release_calls += 1;
  CFRelease(element);
}

static MetaObserverTargetBackend backend(BackendFixture *fixture) {
  return (MetaObserverTargetBackend){
      .context = fixture,
      .monotonic_millis = monotonic_millis,
      .process_start_micros = process_start_micros,
      .copy_focused_window = copy_focused_window,
      .copy_focused_element = copy_focused_element,
      .copy_parent = copy_parent,
      .get_pid = get_pid,
      .equal = equal,
      .release = release,
  };
}

static FixtureElement *element(pid_t pid) {
  FixtureElement *result = [FixtureElement new];
  result.pid = pid;
  return result;
}

static MetaObserverTargetRecord *record(FixtureElement *element,
                                        bool surface,
                                        const char *serial) {
  MetaAXTargetBorrow borrow = {
      .element = ax(element),
      .launch_time_micros = 100,
      .target = {
          .pid = element.pid,
          .surface_kind = surface ? META_SURFACE_SHEET : META_SURFACE_WINDOW,
      },
  };
  snprintf(borrow.native_generation, sizeof(borrow.native_generation), "%s",
           "native-1");
  snprintf(borrow.target.application_ref,
           sizeof(borrow.target.application_ref), "%s", "application-1");
  if (surface) {
    snprintf(borrow.target.surface_ref, sizeof(borrow.target.surface_ref),
             "surface-%s", serial);
    snprintf(borrow.target.target_ref, sizeof(borrow.target.target_ref), "%s",
             borrow.target.surface_ref);
    snprintf(borrow.target.owner_window_ref,
             sizeof(borrow.target.owner_window_ref), "%s", "window-1");
  } else {
    snprintf(borrow.target.window_ref, sizeof(borrow.target.window_ref),
             "window-%s", serial);
    snprintf(borrow.target.target_ref, sizeof(borrow.target.target_ref), "%s",
             borrow.target.window_ref);
  }
  MetaObserverTargetRecord *result = meta_observer_target_record_create(
      &borrow, @"runtime-1", @"login-1", @"native-1");
  assert(result != nil);
  return result;
}

static MetaObserverTargetIndex *target_index(BackendFixture *fixture,
                                             NSArray *records) {
  MetaObserverTargetIndex *result =
      [[MetaObserverTargetIndex alloc] initWithBackend:backend(fixture)];
  assert(result != nil);
  assert([result replaceRecords:records]);
  return result;
}

static void test_exact_window_and_surface(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *window = element(42);
  FixtureElement *sheet = element(42);
  MetaObserverTargetIndex *resolved_index = target_index(
      &fixture, @[record(window, false, "1"), record(sheet, true, "1")]);
  NSDictionary *window_target = [resolved_index
      resolveFocusForPid:42
                  element:ax(window)
             notification:(__bridge NSString *)kAXMovedNotification];
  assert([window_target[@"kind"] isEqual:@"window"]);
  assert([window_target[@"ref"][@"windowRef"] isEqual:@"window-1"]);
  NSDictionary *surface_target = [resolved_index
      resolveFocusForPid:42
                  element:ax(sheet)
             notification:(__bridge NSString *)kAXFocusedUIElementChangedNotification];
  assert([surface_target[@"kind"] isEqual:@"surface"]);
  assert([surface_target[@"ref"][@"surfaceRef"] isEqual:@"surface-1"]);
  assert([surface_target[@"ref"][@"ownerWindowRef"] isEqual:@"window-1"]);
}

static void test_descendant_and_application_focus(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *window = element(42);
  FixtureElement *group = element(42);
  FixtureElement *field = element(42);
  group.parent = window;
  field.parent = group;
  FixtureElement *application = element(42);
  application.focusedElement = field;
  application.focusedWindow = window;
  MetaObserverTargetIndex *resolved_index = target_index(
      &fixture, @[record(window, false, "1")]);
  NSDictionary *target = [resolved_index
      resolveFocusForPid:42
                  element:ax(application)
             notification:@"application-activated"];
  assert([target[@"ref"][@"windowRef"] isEqual:@"window-1"]);
  assert(fixture.focused_element_calls == 1);
  assert(fixture.parent_calls == 2);
}

static void test_application_focused_window_fallback(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *window = element(42);
  FixtureElement *application = element(42);
  application.focusedWindow = window;
  MetaObserverTargetIndex *resolved_index = target_index(
      &fixture, @[record(window, false, "1")]);
  NSDictionary *target = [resolved_index
      resolveFocusForPid:42
                  element:ax(application)
             notification:(__bridge NSString *)kAXFocusedWindowChangedNotification];
  assert([target[@"ref"][@"windowRef"] isEqual:@"window-1"]);
  assert(fixture.focused_element_calls == 1);
  assert(fixture.focused_window_calls == 1);
}

static void test_foreign_pid_and_pid_reuse(void) {
  BackendFixture foreign_fixture = {.process_start = 100};
  FixtureElement *window = element(42);
  FixtureElement *foreign = element(99);
  foreign.parent = window;
  MetaObserverTargetIndex *foreign_index = target_index(
      &foreign_fixture, @[record(window, false, "1")]);
  assert([foreign_index
             resolveFocusForPid:42
                         element:ax(foreign)
                    notification:(__bridge NSString *)kAXMovedNotification] ==
         nil);

  BackendFixture reused_fixture = {.process_start = 101};
  MetaObserverTargetIndex *reused_index = target_index(
      &reused_fixture, @[record(window, false, "1")]);
  assert([reused_index
             resolveFocusForPid:42
                         element:ax(window)
                    notification:(__bridge NSString *)kAXMovedNotification] ==
         nil);
  assert(reused_fixture.pid_calls == 0);
}

static void test_unknown_created_window_does_not_retarget_focus(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *known = element(42);
  FixtureElement *unknown = element(42);
  unknown.focusedWindow = known;
  unknown.focusedElement = known;
  MetaObserverTargetIndex *resolved_index = target_index(
      &fixture, @[record(known, false, "1")]);
  assert([resolved_index
             resolveFocusForPid:42
                         element:ax(unknown)
                    notification:(__bridge NSString *)kAXWindowCreatedNotification] ==
         nil);
  assert(fixture.focused_window_calls == 0);
  assert(fixture.focused_element_calls == 0);
}

static void test_failed_ax_and_deadline_return_nil(void) {
  FixtureElement *window = element(42);
  FixtureElement *application = element(42);
  BackendFixture failed = {
      .process_start = 100,
      .focused_window_error = kAXErrorCannotComplete,
      .focused_element_error = kAXErrorCannotComplete,
      .parent_error = kAXErrorCannotComplete,
  };
  MetaObserverTargetIndex *failed_index = target_index(
      &failed, @[record(window, false, "1")]);
  assert([failed_index resolveFocusForPid:42
                                   element:ax(application)
                              notification:@"application-activated"] == nil);

  FixtureElement *child = element(42);
  child.parent = window;
  BackendFixture timeout = {
      .process_start = 100,
      .parent_duration = 500,
  };
  MetaObserverTargetIndex *timeout_index = target_index(
      &timeout, @[record(window, false, "1")]);
  assert([timeout_index
             resolveFocusForPid:42
                         element:ax(child)
                    notification:(__bridge NSString *)kAXMovedNotification] ==
         nil);
  assert(timeout.now == 500);
}

static void test_index_swap_retains_local_old_snapshot(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *old_window = element(42);
  FixtureElement *new_window = element(42);
  MetaObserverTargetRecord *old_record = record(old_window, false, "old");
  MetaObserverTargetRecord *new_record = record(new_window, false, "new");
  MetaObserverTargetIndex *resolved_index = target_index(&fixture, @[old_record]);
  fixture.swap_index = resolved_index;
  fixture.swap_records = CFBridgingRetain(@[new_record]);
  NSDictionary *old_target = [resolved_index
      resolveFocusForPid:42
                  element:ax(old_window)
             notification:(__bridge NSString *)kAXMovedNotification];
  assert([old_target[@"ref"][@"windowRef"] isEqual:@"window-old"]);
  assert(fixture.swapped);
  assert([resolved_index
             resolveFocusForPid:42
                         element:ax(old_window)
                    notification:(__bridge NSString *)kAXMovedNotification] ==
         nil);
  NSDictionary *new_target = [resolved_index
      resolveFocusForPid:42
                  element:ax(new_window)
             notification:(__bridge NSString *)kAXMovedNotification];
  assert([new_target[@"ref"][@"windowRef"] isEqual:@"window-new"]);
  CFRelease(fixture.swap_records);
}

static void test_overflow_rejects_without_replacing_index(void) {
  BackendFixture fixture = {.process_start = 100};
  FixtureElement *window = element(42);
  MetaObserverTargetRecord *known = record(window, false, "1");
  MetaObserverTargetIndex *resolved_index = target_index(&fixture, @[known]);
  NSMutableArray *overflow = [NSMutableArray arrayWithCapacity:4097];
  for (size_t index = 0; index < 4097; index += 1) {
    [overflow addObject:known];
  }
  assert(![resolved_index replaceRecords:overflow]);
  NSDictionary *target = [resolved_index
      resolveFocusForPid:42
                  element:ax(window)
             notification:(__bridge NSString *)kAXMovedNotification];
  assert([target[@"ref"][@"windowRef"] isEqual:@"window-1"]);
}

int main(void) {
  @autoreleasepool {
    test_exact_window_and_surface();
    test_descendant_and_application_focus();
    test_application_focused_window_fallback();
    test_foreign_pid_and_pid_reuse();
    test_unknown_created_window_does_not_retarget_focus();
    test_failed_ax_and_deadline_return_nil();
    test_index_swap_retains_local_old_snapshot();
    test_overflow_rejects_without_replacing_index();
    puts("observer target index fixture: ok");
  }
  return 0;
}
