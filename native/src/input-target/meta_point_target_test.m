#include "meta_point_target.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct Node Node;
struct Node {
  int identity;
  pid_t pid;
  Node *parent;
};

typedef struct {
  uint64_t now;
  uint64_t hit_duration;
  uint64_t parent_duration;
  uint64_t pid_duration;
  uint64_t equal_duration;
  AXError hit_error;
  AXError parent_error;
  Node system_wide;
  Node *hit;
  size_t create_calls;
  size_t hit_calls;
  size_t parent_calls;
  size_t pid_calls;
  size_t equal_calls;
  size_t release_calls;
  size_t timeout_calls;
  double largest_timeout;
  double smallest_timeout;
} Fixture;

static AXUIElementRef element(Node *node) {
  return (AXUIElementRef)node;
}

static Node *node(AXUIElementRef element_ref) {
  return (Node *)element_ref;
}

static uint64_t monotonic_millis(void *context) {
  return ((Fixture *)context)->now;
}

static AXUIElementRef create_system_wide(void *context) {
  Fixture *fixture = context;
  fixture->create_calls += 1;
  return element(&fixture->system_wide);
}

static void set_messaging_timeout(void *context, AXUIElementRef element_ref,
                                  double seconds) {
  Fixture *fixture = context;
  assert(element_ref != NULL);
  assert(seconds > 0 && seconds <= 0.1);
  fixture->timeout_calls += 1;
  if (seconds > fixture->largest_timeout) fixture->largest_timeout = seconds;
  if (fixture->smallest_timeout == 0 || seconds < fixture->smallest_timeout) {
    fixture->smallest_timeout = seconds;
  }
}

static AXError copy_element_at_position(void *context,
                                        AXUIElementRef system_wide,
                                        double x, double y,
                                        AXUIElementRef *hit) {
  Fixture *fixture = context;
  fixture->hit_calls += 1;
  fixture->now += fixture->hit_duration;
  assert(system_wide == element(&fixture->system_wide));
  assert(isfinite(x) && isfinite(y));
  if (fixture->hit_error != kAXErrorSuccess) return fixture->hit_error;
  *hit = element(fixture->hit);
  return kAXErrorSuccess;
}

static AXError copy_parent(void *context, AXUIElementRef element_ref,
                           AXUIElementRef *parent) {
  Fixture *fixture = context;
  fixture->parent_calls += 1;
  fixture->now += fixture->parent_duration;
  if (fixture->parent_error != kAXErrorSuccess) {
    return fixture->parent_error;
  }
  Node *current = node(element_ref);
  if (current->parent == NULL) return kAXErrorNoValue;
  *parent = element(current->parent);
  return kAXErrorSuccess;
}

static AXError get_pid(void *context, AXUIElementRef element_ref, pid_t *pid) {
  Fixture *fixture = context;
  fixture->pid_calls += 1;
  fixture->now += fixture->pid_duration;
  *pid = node(element_ref)->pid;
  return kAXErrorSuccess;
}

static bool equal(void *context, AXUIElementRef left, AXUIElementRef right) {
  Fixture *fixture = context;
  fixture->equal_calls += 1;
  fixture->now += fixture->equal_duration;
  return node(left)->identity == node(right)->identity;
}

static void release(void *context, AXUIElementRef element_ref) {
  Fixture *fixture = context;
  assert(element_ref != NULL);
  fixture->release_calls += 1;
}

static MetaPointTargetBackend backend(Fixture *fixture) {
  return (MetaPointTargetBackend){
      .context = fixture,
      .monotonic_millis = monotonic_millis,
      .create_system_wide = create_system_wide,
      .set_messaging_timeout = set_messaging_timeout,
      .copy_element_at_position = copy_element_at_position,
      .copy_parent = copy_parent,
      .get_pid = get_pid,
      .equal = equal,
      .release = release,
  };
}

static MetaAXTargetBorrow borrow(Node *target, MetaSurfaceKind kind,
                                 const char *owner_window_ref) {
  MetaAXTargetBorrow result = {
      .element = element(target),
      .target = {
          .pid = target->pid,
          .surface_kind = kind,
      },
  };
  if (owner_window_ref != NULL) {
    snprintf(result.target.owner_window_ref,
             sizeof(result.target.owner_window_ref), "%s",
             owner_window_ref);
  }
  return result;
}

static void test_exact_target(void) {
  Node target = {.identity = 1, .pid = 42};
  Fixture fixture = {.hit = &target};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(meta_point_matches_borrow_with_backend(
      &target_borrow, 100, 200, backend(&fixture)));
  assert(fixture.hit_calls == 1);
  assert(fixture.parent_calls == 0);
  assert(fixture.pid_calls == 1);
  assert(fixture.release_calls == 2);
  assert(fixture.largest_timeout <= 0.1);
}

static void test_descendant_reaches_exact_target(void) {
  Node target = {.identity = 1, .pid = 42};
  Node group = {.identity = 2, .pid = 42, .parent = &target};
  Node button = {.identity = 3, .pid = 42, .parent = &group};
  Fixture fixture = {.hit = &button};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(meta_point_matches_borrow_with_backend(
      &target_borrow, -20, 30, backend(&fixture)));
  assert(fixture.parent_calls == 2);
  assert(fixture.release_calls == 4);
}

static void test_wrong_sheet_owner_does_not_match_window_or_pid(void) {
  Node borrowed_sheet = {.identity = 10, .pid = 42};
  Node owner_window = {.identity = 1, .pid = 42};
  Node foreign_sheet = {
      .identity = 11,
      .pid = 42,
      .parent = &owner_window,
  };
  Node field = {.identity = 12, .pid = 42, .parent = &foreign_sheet};
  Fixture fixture = {.hit = &field};
  MetaAXTargetBorrow target_borrow = borrow(
      &borrowed_sheet, META_SURFACE_SHEET, "native-1:window:1");
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.parent_calls == 3);
}

static void test_foreign_hit_pid_is_rejected_before_parent(void) {
  Node target = {.identity = 1, .pid = 42};
  Node foreign = {.identity = 2, .pid = 99, .parent = &target};
  Fixture fixture = {.hit = &foreign};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.pid_calls == 1);
  assert(fixture.parent_calls == 0);
}

static void test_ax_failures_are_not_fallbacks(void) {
  Node target = {.identity = 1, .pid = 42};
  Fixture hit_failure = {
      .hit = &target,
      .hit_error = kAXErrorCannotComplete,
  };
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&hit_failure)));
  assert(hit_failure.parent_calls == 0);

  Node child = {.identity = 2, .pid = 42};
  Fixture parent_failure = {
      .hit = &child,
      .parent_error = kAXErrorCannotComplete,
  };
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&parent_failure)));
  assert(parent_failure.parent_calls == 1);
}

static void test_cycle_is_rejected(void) {
  Node target = {.identity = 1, .pid = 42};
  Node first = {.identity = 2, .pid = 42};
  Node second = {.identity = 3, .pid = 42, .parent = &first};
  first.parent = &second;
  Fixture fixture = {.hit = &first};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.parent_calls == 2);
  assert(fixture.release_calls == 4);
}

static void test_deadline_stops_parent_walk(void) {
  Node target = {.identity = 1, .pid = 42};
  Node third = {.identity = 2, .pid = 42, .parent = &target};
  Node second = {.identity = 3, .pid = 42, .parent = &third};
  Node first = {.identity = 4, .pid = 42, .parent = &second};
  Fixture fixture = {
      .hit = &first,
      .parent_duration = 250,
  };
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.parent_calls == 2);
  assert(fixture.now == 500);
  assert(fixture.smallest_timeout <= 0.1);
}

static void test_walk_is_bounded_to_32_nodes(void) {
  Node target = {.identity = 100, .pid = 42};
  Node chain[32];
  for (size_t index = 0; index < 32; index += 1) {
    chain[index] = (Node){
        .identity = (int)index + 1,
        .pid = 42,
        .parent = index + 1 < 32 ? &chain[index + 1] : &target,
    };
  }
  Fixture fixture = {.hit = &chain[0]};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.parent_calls == 31);
  assert(fixture.equal_calls >= 32);
}

static void test_invalid_point_and_target_do_not_touch_ax(void) {
  Node target = {.identity = 1, .pid = 42};
  Fixture fixture = {.hit = &target};
  MetaAXTargetBorrow target_borrow = borrow(
      &target, META_SURFACE_WINDOW, NULL);
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, NAN, 10, backend(&fixture)));
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, INFINITY, backend(&fixture)));
  target_borrow.target.surface_kind = META_SURFACE_POPUP;
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  target_borrow.target.surface_kind = META_SURFACE_WINDOW;
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 1e300, 10, backend(&fixture)));
  target_borrow.target.surface_kind = META_SURFACE_SHEET;
  assert(!meta_point_matches_borrow_with_backend(
      &target_borrow, 10, 10, backend(&fixture)));
  assert(fixture.create_calls == 0);
}

int main(void) {
  test_exact_target();
  test_descendant_reaches_exact_target();
  test_wrong_sheet_owner_does_not_match_window_or_pid();
  test_foreign_hit_pid_is_rejected_before_parent();
  test_ax_failures_are_not_fallbacks();
  test_cycle_is_rejected();
  test_deadline_stops_parent_walk();
  test_walk_is_bounded_to_32_nodes();
  test_invalid_point_and_target_do_not_touch_ax();
  puts("point target fixture: ok");
  return 0;
}
