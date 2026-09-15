#include "meta_geometry_probe.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t now;
  uint64_t unix_micros;
  uint64_t frame_duration;
  uint64_t display_duration;
  bool frame_available;
  bool displays_available;
  bool displays_complete;
  MetaRect actual_frame;
  MetaDisplayRecord displays[65];
  size_t display_count;
  size_t frame_calls;
  size_t display_calls;
  uint64_t frame_timeout;
  uint64_t position_duration;
  uint64_t size_duration;
  size_t timeout_calls;
  size_t timeout_failure_call;
  size_t position_calls;
  size_t size_calls;
  uint64_t timeouts[2];
  AXError position_error;
  AXError size_error;
  uint64_t topology_epoch;
  size_t epoch_calls;
  bool epoch_available;
  bool change_epoch_during_displays;
} BackendFixture;

typedef struct {
  MetaWindowRecord target;
  MetaDisplayRecord displays[2];
  MetaInventorySnapshot snapshot;
  MetaAXTargetBorrow borrow;
  BackendFixture backend;
} Fixture;

static bool clock_value(void *context, uint64_t *monotonic_millis,
                        uint64_t *unix_micros) {
  BackendFixture *fixture = context;
  *monotonic_millis = fixture->now;
  *unix_micros = fixture->unix_micros + fixture->now * 1000;
  return true;
}

static bool copy_ax_frame(void *context, AXUIElementRef element,
                          uint64_t timeout_millis, MetaRect *frame) {
  BackendFixture *fixture = context;
  assert(element == (AXUIElementRef)0x1);
  assert(timeout_millis > 0 && timeout_millis <= 100);
  fixture->frame_calls += 1;
  fixture->frame_timeout = timeout_millis;
  fixture->now += fixture->frame_duration;
  if (!fixture->frame_available) return false;
  *frame = fixture->actual_frame;
  return true;
}

static bool current_displays(void *context, MetaDisplayRecord *displays,
                             size_t capacity, size_t *count, bool *complete) {
  BackendFixture *fixture = context;
  fixture->display_calls += 1;
  fixture->now += fixture->display_duration;
  if (fixture->change_epoch_during_displays) fixture->topology_epoch += 1;
  *count = fixture->display_count;
  *complete = fixture->displays_complete;
  if (!fixture->displays_available) return false;
  if (fixture->display_count <= capacity) {
    memcpy(displays, fixture->displays,
           fixture->display_count * sizeof(*displays));
  }
  return true;
}

static bool current_topology_epoch(void *context, uint64_t *epoch) {
  BackendFixture *fixture = context;
  fixture->epoch_calls += 1;
  if (!fixture->epoch_available) return false;
  *epoch = fixture->topology_epoch;
  return true;
}

static AXError set_ax_timeout(void *context, AXUIElementRef element_ref,
                              uint64_t timeout_millis) {
  BackendFixture *fixture = context;
  assert(element_ref == (AXUIElementRef)0x1);
  assert(timeout_millis > 0 && timeout_millis <= 100);
  fixture->timeout_calls += 1;
  if (fixture->timeout_calls <= 2) {
    fixture->timeouts[fixture->timeout_calls - 1] = timeout_millis;
  }
  return fixture->timeout_calls == fixture->timeout_failure_call
             ? kAXErrorCannotComplete
             : kAXErrorSuccess;
}

static AXError copy_ax_position(void *context, AXUIElementRef element_ref,
                                double *x, double *y) {
  BackendFixture *fixture = context;
  assert(element_ref == (AXUIElementRef)0x1);
  fixture->position_calls += 1;
  fixture->now += fixture->position_duration;
  if (fixture->position_error != kAXErrorSuccess) {
    return fixture->position_error;
  }
  *x = fixture->actual_frame.x;
  *y = fixture->actual_frame.y;
  return kAXErrorSuccess;
}

static AXError copy_ax_size(void *context, AXUIElementRef element_ref,
                            double *width, double *height) {
  BackendFixture *fixture = context;
  assert(element_ref == (AXUIElementRef)0x1);
  fixture->size_calls += 1;
  fixture->now += fixture->size_duration;
  if (fixture->size_error != kAXErrorSuccess) return fixture->size_error;
  *width = fixture->actual_frame.width;
  *height = fixture->actual_frame.height;
  return kAXErrorSuccess;
}

static MetaGeometryProbeBackend backend(BackendFixture *fixture) {
  return (MetaGeometryProbeBackend){
      .context = fixture,
      .clock = clock_value,
      .copy_ax_frame = copy_ax_frame,
      .current_displays = current_displays,
      .current_topology_epoch = current_topology_epoch,
  };
}

static MetaGeometryProbeBackend granular_backend(BackendFixture *fixture) {
  MetaGeometryProbeBackend result = backend(fixture);
  result.copy_ax_frame = NULL;
  result.set_ax_timeout = set_ax_timeout;
  result.copy_ax_position = copy_ax_position;
  result.copy_ax_size = copy_ax_size;
  return result;
}

static MetaDisplayRecord display(uint32_t display_id, double x,
                                 double scale, bool main) {
  MetaDisplayRecord result = {
      .display_id = display_id,
      .bounds = {.x = x, .y = 0, .width = 1920, .height = 1080},
      .usable_bounds = {.x = x, .y = 23, .width = 1920, .height = 1057},
      .scale = scale,
      .rotation_degrees = 0,
      .main = main,
  };
  snprintf(result.display_ref, sizeof(result.display_ref), "display-%u",
           display_id);
  return result;
}

static void prepare_fixture(Fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  fixture->target = (MetaWindowRecord){
      .pid = 42,
      .surface_kind = META_SURFACE_WINDOW,
      .frame = {.x = 100, .y = 50, .width = 800, .height = 600},
  };
  snprintf(fixture->target.target_ref, sizeof(fixture->target.target_ref),
           "%s", "native-1:window:1");
  snprintf(fixture->target.window_ref, sizeof(fixture->target.window_ref),
           "%s", "native-1:window:1");
  snprintf(fixture->target.application_ref,
           sizeof(fixture->target.application_ref), "%s",
           "native-1:application:1");
  fixture->displays[0] = display(1, 0, 1, true);
  fixture->displays[1] = display(2, 1920, 2, false);
  fixture->snapshot = (MetaInventorySnapshot){
      .revision = 7,
      .display_layout_revision = 3,
      .display_topology_epoch = 1,
      .complete = true,
      .windows = &fixture->target,
      .window_count = 1,
      .displays = fixture->displays,
      .display_count = 2,
  };
  snprintf(fixture->snapshot.inventory_id,
           sizeof(fixture->snapshot.inventory_id), "%s", "inventory-7");
  snprintf(fixture->snapshot.native_generation,
           sizeof(fixture->snapshot.native_generation), "%s", "native-1");
  snprintf(fixture->snapshot.layout_ref,
           sizeof(fixture->snapshot.layout_ref), "%s", "layout-3");
  fixture->borrow = (MetaAXTargetBorrow){
      .element = (AXUIElementRef)0x1,
      .target = fixture->target,
      .inventory_revision = 7,
  };
  snprintf(fixture->borrow.inventory_id,
           sizeof(fixture->borrow.inventory_id), "%s", "inventory-7");
  snprintf(fixture->borrow.native_generation,
           sizeof(fixture->borrow.native_generation), "%s", "native-1");
  fixture->backend = (BackendFixture){
      .now = 100,
      .unix_micros = 1700000000000000ULL,
      .frame_available = true,
      .displays_available = true,
      .displays_complete = true,
      .actual_frame = fixture->target.frame,
      .display_count = 2,
      .topology_epoch = 1,
      .epoch_available = true,
  };
  memcpy(fixture->backend.displays, fixture->displays,
         sizeof(fixture->displays));
}

static MetaBorrowedGeometryProbe run(Fixture *fixture, bool *ok) {
  MetaBorrowedGeometryProbe result;
  *ok = meta_macos_probe_borrowed_geometry_with_backend(
      &fixture->borrow, &fixture->snapshot, &result,
      backend(&fixture->backend));
  return result;
}

static MetaTopologyProbe run_topology(Fixture *fixture, bool *ok) {
  MetaTopologyProbe result;
  MetaGeometryProbeBackend topology_backend = backend(&fixture->backend);
  topology_backend.copy_ax_frame = NULL;
  *ok = meta_macos_probe_topology_with_backend(
      &fixture->snapshot, &result, topology_backend);
  assert(fixture->backend.frame_calls == 0);
  return result;
}

static MetaBorrowedGeometryProbe run_granular(Fixture *fixture, bool *ok) {
  MetaBorrowedGeometryProbe result;
  *ok = meta_macos_probe_borrowed_geometry_with_backend(
      &fixture->borrow, &fixture->snapshot, &result,
      granular_backend(&fixture->backend));
  return result;
}

static void test_unchanged_geometry(void) {
  Fixture fixture;
  prepare_fixture(&fixture);
  bool ok = false;
  MetaBorrowedGeometryProbe result = run(&fixture, &ok);
  assert(ok);
  assert(result.frame_unchanged);
  assert(result.topology_unchanged);
  assert(result.expected_frame.x == 100);
  assert(result.actual_frame.width == 800);
  assert(result.observed_at_unix_micros > fixture.backend.unix_micros);
  assert(fixture.backend.frame_calls == 1);
  assert(fixture.backend.display_calls == 1);
  assert(fixture.backend.frame_timeout == 100);
}

static void test_window_move_and_resize_are_changes(void) {
  Fixture moved;
  prepare_fixture(&moved);
  moved.backend.actual_frame.x += 1;
  bool ok = false;
  MetaBorrowedGeometryProbe result = run(&moved, &ok);
  assert(ok);
  assert(!result.frame_unchanged);
  assert(result.topology_unchanged);

  Fixture resized;
  prepare_fixture(&resized);
  resized.backend.actual_frame.width += 1;
  result = run(&resized, &ok);
  assert(ok);
  assert(!result.frame_unchanged);
}

static void test_topology_geometry_and_scale_changes(void) {
  Fixture pixel;
  prepare_fixture(&pixel);
  pixel.backend.displays[1].bounds.x += 1;
  bool ok = false;
  MetaBorrowedGeometryProbe result = run(&pixel, &ok);
  assert(ok);
  assert(!result.topology_unchanged);

  Fixture scale;
  prepare_fixture(&scale);
  scale.backend.displays[1].scale = 1;
  result = run(&scale, &ok);
  assert(ok);
  assert(!result.topology_unchanged);
}

static void test_missing_and_different_display_count_are_changes(void) {
  Fixture missing;
  prepare_fixture(&missing);
  missing.backend.display_count = 1;
  bool ok = false;
  MetaBorrowedGeometryProbe result = run(&missing, &ok);
  assert(ok);
  assert(!result.topology_unchanged);

  Fixture extra;
  prepare_fixture(&extra);
  extra.backend.displays[2] = display(3, -1920, 1, false);
  extra.backend.display_count = 3;
  result = run(&extra, &ok);
  assert(ok);
  assert(!result.topology_unchanged);
}

static void test_duplicate_and_over_limit_displays_fail_closed(void) {
  Fixture duplicate;
  prepare_fixture(&duplicate);
  duplicate.backend.displays[1].display_id = 1;
  bool ok = true;
  run(&duplicate, &ok);
  assert(!ok);

  Fixture over_limit;
  prepare_fixture(&over_limit);
  over_limit.backend.display_count = 65;
  run(&over_limit, &ok);
  assert(!ok);
}

static void test_incomplete_and_failed_reads_fail_closed(void) {
  Fixture failed_frame;
  prepare_fixture(&failed_frame);
  failed_frame.backend.frame_available = false;
  bool ok = true;
  run(&failed_frame, &ok);
  assert(!ok);
  assert(failed_frame.backend.display_calls == 0);

  Fixture incomplete;
  prepare_fixture(&incomplete);
  incomplete.backend.displays_complete = false;
  run(&incomplete, &ok);
  assert(!ok);
}

static void test_mismatched_borrow_never_reads_sources(void) {
  Fixture fixture;
  prepare_fixture(&fixture);
  snprintf(fixture.borrow.inventory_id, sizeof(fixture.borrow.inventory_id),
           "%s", "inventory-foreign");
  bool ok = true;
  run(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.frame_calls == 0);
  assert(fixture.backend.display_calls == 0);

  prepare_fixture(&fixture);
  fixture.borrow.target.pid = 99;
  run(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.frame_calls == 0);

  prepare_fixture(&fixture);
  snprintf(fixture.borrow.target.target_ref,
           sizeof(fixture.borrow.target.target_ref), "%s",
           "native-1:window:foreign");
  run(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.frame_calls == 0);

  prepare_fixture(&fixture);
  snprintf(fixture.borrow.target.application_ref,
           sizeof(fixture.borrow.target.application_ref), "%s",
           "native-1:application:foreign");
  run(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.frame_calls == 0);

  prepare_fixture(&fixture);
  snprintf(fixture.borrow.native_generation,
           sizeof(fixture.borrow.native_generation), "%s", "native-foreign");
  run(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.frame_calls == 0);
}

static void test_whole_deadline_is_bounded(void) {
  Fixture frame_timeout;
  prepare_fixture(&frame_timeout);
  frame_timeout.backend.frame_duration = 500;
  bool ok = true;
  run(&frame_timeout, &ok);
  assert(!ok);
  assert(frame_timeout.backend.display_calls == 0);

  Fixture display_timeout;
  prepare_fixture(&display_timeout);
  display_timeout.backend.frame_duration = 100;
  display_timeout.backend.display_duration = 400;
  run(&display_timeout, &ok);
  assert(!ok);
}

static void test_topology_only_same_and_changed(void) {
  Fixture same;
  prepare_fixture(&same);
  bool ok = false;
  MetaTopologyProbe result = run_topology(&same, &ok);
  assert(ok);
  assert(result.topology_unchanged);
  assert(result.observed_at_unix_micros > same.backend.unix_micros);

  Fixture pixel;
  prepare_fixture(&pixel);
  pixel.backend.displays[0].usable_bounds.y += 1;
  result = run_topology(&pixel, &ok);
  assert(ok);
  assert(!result.topology_unchanged);

  Fixture missing;
  prepare_fixture(&missing);
  missing.backend.display_count = 1;
  result = run_topology(&missing, &ok);
  assert(ok);
  assert(!result.topology_unchanged);
}

static void test_topology_only_duplicate_and_timeout_fail_closed(void) {
  Fixture duplicate;
  prepare_fixture(&duplicate);
  duplicate.backend.displays[1].display_id = 1;
  bool ok = true;
  run_topology(&duplicate, &ok);
  assert(!ok);
  assert(duplicate.backend.frame_calls == 0);

  Fixture timeout;
  prepare_fixture(&timeout);
  timeout.backend.display_duration = 500;
  run_topology(&timeout, &ok);
  assert(!ok);
  assert(timeout.backend.frame_calls == 0);
}

static void test_granular_ax_timeout_and_first_failure_stop_size(void) {
  Fixture timeout_failure;
  prepare_fixture(&timeout_failure);
  timeout_failure.backend.timeout_failure_call = 1;
  bool ok = true;
  run_granular(&timeout_failure, &ok);
  assert(!ok);
  assert(timeout_failure.backend.timeout_calls == 1);
  assert(timeout_failure.backend.position_calls == 0);
  assert(timeout_failure.backend.size_calls == 0);
  assert(timeout_failure.backend.display_calls == 0);

  Fixture position_failure;
  prepare_fixture(&position_failure);
  position_failure.backend.position_error = kAXErrorCannotComplete;
  run_granular(&position_failure, &ok);
  assert(!ok);
  assert(position_failure.backend.timeout_calls == 1);
  assert(position_failure.backend.position_calls == 1);
  assert(position_failure.backend.size_calls == 0);
  assert(position_failure.backend.display_calls == 0);
}

static void test_granular_ax_recomputes_size_budget_and_whole_deadline(void) {
  Fixture fixture;
  prepare_fixture(&fixture);
  fixture.backend.position_duration = 450;
  fixture.backend.size_duration = 50;
  bool ok = true;
  run_granular(&fixture, &ok);
  assert(!ok);
  assert(fixture.backend.timeout_calls == 2);
  assert(fixture.backend.timeouts[0] == 100);
  assert(fixture.backend.timeouts[1] == 50);
  assert(fixture.backend.position_calls == 1);
  assert(fixture.backend.size_calls == 1);
  assert(fixture.backend.now == 600);
  assert(fixture.backend.display_calls == 0);
}

static void test_topology_epoch_change_rejects_same_display_metadata(void) {
  Fixture reconnected;
  prepare_fixture(&reconnected);
  reconnected.backend.topology_epoch = 2;
  bool ok = true;
  run(&reconnected, &ok);
  assert(!ok);
  assert(reconnected.backend.frame_calls == 0);
  assert(reconnected.backend.display_calls == 0);

  Fixture during_window_probe;
  prepare_fixture(&during_window_probe);
  during_window_probe.backend.change_epoch_during_displays = true;
  run(&during_window_probe, &ok);
  assert(!ok);
  assert(during_window_probe.backend.display_calls == 1);
  assert(during_window_probe.backend.epoch_calls >= 2);

  Fixture during_topology_probe;
  prepare_fixture(&during_topology_probe);
  during_topology_probe.backend.change_epoch_during_displays = true;
  run_topology(&during_topology_probe, &ok);
  assert(!ok);
  assert(during_topology_probe.backend.frame_calls == 0);
  assert(during_topology_probe.backend.display_calls == 1);
}

int main(void) {
  test_unchanged_geometry();
  test_window_move_and_resize_are_changes();
  test_topology_geometry_and_scale_changes();
  test_missing_and_different_display_count_are_changes();
  test_duplicate_and_over_limit_displays_fail_closed();
  test_incomplete_and_failed_reads_fail_closed();
  test_mismatched_borrow_never_reads_sources();
  test_whole_deadline_is_bounded();
  test_topology_only_same_and_changed();
  test_topology_only_duplicate_and_timeout_fail_closed();
  test_granular_ax_timeout_and_first_failure_stop_size();
  test_granular_ax_recomputes_size_budget_and_whole_deadline();
  test_topology_epoch_change_rejects_same_display_metadata();
  puts("geometry probe fixture: ok");
  return 0;
}
