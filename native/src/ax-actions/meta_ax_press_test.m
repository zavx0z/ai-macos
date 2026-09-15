#include "meta_ax_press.h"

#include <assert.h>
#include <stdio.h>

@interface FixtureElement : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, strong) FixtureElement *parent;
@property(nonatomic, copy) NSArray<NSString *> *actions;
@end
@implementation FixtureElement
@end

@interface FixturePressBackend : NSObject <MetaAXPressBackend>
@property(nonatomic) uint64_t now;
@property(nonatomic) uint64_t step;
@property(nonatomic) AXError performError;
@property(nonatomic) NSUInteger performCalls;
@end

@implementation FixturePressBackend
- (void)advance { _now += _step; }
- (uint64_t)monotonicMillis { return _now; }
- (BOOL)sameElement:(id)left other:(id)right { return left == right; }
- (MetaAXPressReadStatus)ownerPidForElement:(FixtureElement *)element
                                     value:(pid_t *)value {
  [self advance];
  *value = element.pid;
  return META_AX_PRESS_READ_OK;
}
- (MetaAXPressReadStatus)parentForElement:(FixtureElement *)element
                                    value:(id *)value {
  [self advance];
  *value = element.parent;
  return element.parent == nil ? META_AX_PRESS_READ_ABSENT
                               : META_AX_PRESS_READ_OK;
}
- (MetaAXPressReadStatus)actionsForElement:(FixtureElement *)element
                                     value:(NSArray<NSString *> **)value {
  [self advance];
  *value = element.actions;
  return META_AX_PRESS_READ_OK;
}
- (AXError)performPressForElement:(__unused id)element {
  _performCalls += 1;
  [self advance];
  return _performError;
}
@end

static FixtureElement *element(FixtureElement *parent) {
  FixtureElement *value = [FixtureElement new];
  value.pid = 501;
  value.parent = parent;
  value.actions = @[@"AXPress"];
  return value;
}

static MetaAXPressContext context(uint64_t deadline, NSUInteger depth) {
  return (MetaAXPressContext){
    .owner_pid = 501,
    .max_ancestry_depth = depth,
    .deadline_millis = deadline,
    .per_call_timeout_millis = 50,
  };
}

static MetaAXPressDispatchGate accepting_gate(NSUInteger *calls) {
  return ^BOOL(BOOL (^perform)(void)) {
    *calls += 1;
    return perform();
  };
}

static void test_exact_ancestry_and_single_dispatch(void) {
  FixtureElement *root = element(nil);
  FixtureElement *group = element(root);
  FixtureElement *button = element(group);
  FixturePressBackend *backend = [FixturePressBackend new];
  backend.performError = kAXErrorSuccess;
  __block NSUInteger gateCalls = 0;
  MetaAXPressOutcome result = meta_ax_press_with_backend(
      button, root, context(1000, 8), backend,
      accepting_gate(&gateCalls));
  assert(result.status == META_AX_PRESS_SUCCEEDED);
  assert(result.dispatch_attempted);
  assert(result.ancestry_depth == 2);
  assert(result.ax_error == kAXErrorSuccess);
  assert(gateCalls == 1 && backend.performCalls == 1);
}

static void test_predispatch_rejections_do_not_enter_gate(void) {
  for (NSString *scenario in @[
         @"pid", @"reparent", @"cycle", @"depth", @"action", @"deadline"
       ]) {
    FixtureElement *root = element(nil);
    FixtureElement *foreignRoot = element(nil);
    FixtureElement *group = element(root);
    FixtureElement *button = element(group);
    FixturePressBackend *backend = [FixturePressBackend new];
    MetaAXPressContext value = context(1000, 8);
    if ([scenario isEqual:@"pid"]) button.pid = 777;
    if ([scenario isEqual:@"reparent"]) group.parent = foreignRoot;
    if ([scenario isEqual:@"cycle"]) group.parent = button;
    if ([scenario isEqual:@"depth"]) value.max_ancestry_depth = 1;
    if ([scenario isEqual:@"action"]) button.actions = @[@"AXShowMenu"];
    if ([scenario isEqual:@"deadline"]) value.deadline_millis = 0;
    __block NSUInteger gateCalls = 0;
    MetaAXPressOutcome result = meta_ax_press_with_backend(
        button, root, value, backend, accepting_gate(&gateCalls));
    assert(result.status != META_AX_PRESS_SUCCEEDED);
    assert(!result.dispatch_attempted);
    assert(gateCalls == 0 && backend.performCalls == 0);
  }
}

static void test_gate_rejection_and_actual_ax_error_are_distinct(void) {
  FixtureElement *root = element(nil);
  FixtureElement *button = element(root);
  FixturePressBackend *backend = [FixturePressBackend new];
  MetaAXPressOutcome rejected = meta_ax_press_with_backend(
      button, root, context(1000, 8), backend,
      ^BOOL(__unused BOOL (^perform)(void)) { return NO; });
  assert(rejected.status == META_AX_PRESS_GATE_REJECTED);
  assert(!rejected.dispatch_attempted && backend.performCalls == 0);

  backend.performError = kAXErrorActionUnsupported;
  __block NSUInteger gateCalls = 0;
  MetaAXPressOutcome failed = meta_ax_press_with_backend(
      button, root, context(1000, 8), backend,
      accepting_gate(&gateCalls));
  assert(failed.status == META_AX_PRESS_DISPATCH_FAILED);
  assert(failed.dispatch_attempted);
  assert(failed.ax_error == kAXErrorActionUnsupported);
  assert(gateCalls == 1 && backend.performCalls == 1);
}

static void test_deadline_after_read_is_predispatch_timeout(void) {
  FixtureElement *root = element(nil);
  FixtureElement *button = element(root);
  FixturePressBackend *backend = [FixturePressBackend new];
  backend.now = 100;
  backend.step = 10;
  __block NSUInteger gateCalls = 0;
  MetaAXPressOutcome result = meta_ax_press_with_backend(
      button, root, context(105, 8), backend,
      accepting_gate(&gateCalls));
  assert(result.status == META_AX_PRESS_TIMED_OUT);
  assert(!result.dispatch_attempted);
  assert(gateCalls == 0 && backend.performCalls == 0);
}

static void test_deadline_after_ax_call_is_unknown_attempt(void) {
  FixtureElement *root = element(nil);
  FixtureElement *button = element(root);
  FixturePressBackend *backend = [FixturePressBackend new];
  backend.now = 100;
  backend.step = 10;
  backend.performError = kAXErrorSuccess;
  __block NSUInteger gateCalls = 0;
  MetaAXPressOutcome result = meta_ax_press_with_backend(
      button, root, context(155, 8), backend,
      accepting_gate(&gateCalls));
  assert(result.status == META_AX_PRESS_DISPATCH_UNKNOWN);
  assert(result.dispatch_attempted);
  assert(gateCalls == 1 && backend.performCalls == 1);
}

int main(void) {
  @autoreleasepool {
    test_exact_ancestry_and_single_dispatch();
    test_predispatch_rejections_do_not_enter_gate();
    test_gate_rejection_and_actual_ax_error_are_distinct();
    test_deadline_after_read_is_predispatch_timeout();
    test_deadline_after_ax_call_is_unknown_attempt();
  }
  puts("AXPress fresh ancestry tests passed");
  return 0;
}
