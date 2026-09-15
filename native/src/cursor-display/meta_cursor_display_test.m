#include "meta_cursor_display.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  MetaDisplayRecord displays[3];
  MetaInventorySnapshot snapshot;
  double cursorX;
  double cursorY;
  uint64_t topologyEpoch;
  uint64_t observedAt;
  size_t snapshotCalls;
  size_t topologyCalls;
  size_t epochCalls;
  size_t cursorCalls;
  BOOL topologyAvailable;
  BOOL topologyUnchanged;
  BOOL epochAvailable;
  BOOL cursorAvailable;
  BOOL changeEpochOnCursor;
  BOOL changeRevisionOnFinalSnapshot;
} MetaCursorDisplayFixture;

// Продакшен-обёртки линкуются, но тестовые фикстуры никогда их не вызывают.
const MetaInventorySnapshot *meta_macos_backend_snapshot(
    const MetaMacOSBackend *backend) {
  (void)backend;
  abort();
}

bool meta_macos_display_topology_epoch(const MetaMacOSBackend *backend,
                                       uint64_t *epoch) {
  (void)backend;
  (void)epoch;
  abort();
}

bool meta_macos_probe_topology(MetaMacOSBackend *owner,
                               const MetaInventorySnapshot *boundSnapshot,
                               MetaTopologyProbe *output) {
  (void)owner;
  (void)boundSnapshot;
  (void)output;
  abort();
}

static MetaDisplayRecord fixture_display(uint32_t displayId,
                                         NSString *displayRef,
                                         double x,
                                         double y,
                                         double width,
                                         double height,
                                         double scale,
                                         BOOL main) {
  MetaDisplayRecord display = {
      .display_id = displayId,
      .bounds = {.x = x, .y = y, .width = width, .height = height},
      .usable_bounds = {.x = x, .y = y, .width = width, .height = height},
      .scale = scale,
      .rotation_degrees = 0,
      .main = main,
  };
  snprintf(display.display_ref, sizeof(display.display_ref), "%s",
           displayRef.UTF8String);
  return display;
}

static void fixture_prepare(MetaCursorDisplayFixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  fixture->displays[0] =
      fixture_display(1, @"display-left", -1280, 0, 1280, 1024, 2, NO);
  fixture->displays[1] =
      fixture_display(2, @"display-main", 0, 0, 1920, 1080, 1, YES);
  fixture->snapshot = (MetaInventorySnapshot){
      .revision = 7,
      .display_layout_revision = 3,
      .display_topology_epoch = 5,
      .captured_at_micros = 1700000000000000ULL,
      .complete = true,
      .displays = fixture->displays,
      .display_count = 2,
  };
  snprintf(fixture->snapshot.inventory_id,
           sizeof(fixture->snapshot.inventory_id), "%s", "inventory-7");
  snprintf(fixture->snapshot.layout_ref,
           sizeof(fixture->snapshot.layout_ref), "%s", "layout-3");
  snprintf(fixture->snapshot.native_generation,
           sizeof(fixture->snapshot.native_generation), "%s", "native-1");
  fixture->topologyEpoch = 5;
  fixture->observedAt = 1700000001000000ULL;
  fixture->topologyAvailable = YES;
  fixture->topologyUnchanged = YES;
  fixture->epochAvailable = YES;
  fixture->cursorAvailable = YES;
  fixture->cursorX = 100;
  fixture->cursorY = 100;
}

static const MetaInventorySnapshot *fixture_snapshot(void *context) {
  MetaCursorDisplayFixture *fixture = context;
  fixture->snapshotCalls += 1;
  if (fixture->changeRevisionOnFinalSnapshot &&
      fixture->snapshotCalls >= 2) {
    fixture->snapshot.revision += 1;
  }
  return &fixture->snapshot;
}

static bool fixture_topology(void *context,
                             const MetaInventorySnapshot *snapshot,
                             MetaTopologyProbe *output) {
  MetaCursorDisplayFixture *fixture = context;
  assert(snapshot == &fixture->snapshot);
  fixture->topologyCalls += 1;
  if (!fixture->topologyAvailable) return false;
  fixture->observedAt += 1000;
  *output = (MetaTopologyProbe){
      .topology_unchanged = fixture->topologyUnchanged,
      .observed_at_unix_micros = fixture->observedAt,
  };
  return true;
}

static bool fixture_epoch(void *context, uint64_t *epoch) {
  MetaCursorDisplayFixture *fixture = context;
  fixture->epochCalls += 1;
  if (!fixture->epochAvailable) return false;
  *epoch = fixture->topologyEpoch;
  return true;
}

static bool fixture_cursor(void *context, double *x, double *y) {
  MetaCursorDisplayFixture *fixture = context;
  fixture->cursorCalls += 1;
  if (!fixture->cursorAvailable) return false;
  *x = fixture->cursorX;
  *y = fixture->cursorY;
  if (fixture->changeEpochOnCursor) fixture->topologyEpoch += 1;
  return true;
}

static MetaCursorDisplayBackend fixture_backend(
    MetaCursorDisplayFixture *fixture) {
  return (MetaCursorDisplayBackend){
      .context = fixture,
      .snapshot = fixture_snapshot,
      .probe_topology = fixture_topology,
      .current_topology_epoch = fixture_epoch,
      .read_cursor = fixture_cursor,
  };
}

static NSDictionary *fixture_generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *fixture_read(MetaCursorDisplayFixture *fixture) {
  return meta_cursor_display_read_with_backend(
      fixture_generation(), @"inventory-7", 7, 3,
      fixture_backend(fixture));
}

static void test_negative_origin_and_mixed_scale_use_logical_bounds(void) {
  MetaCursorDisplayFixture fixture;
  fixture_prepare(&fixture);
  fixture.cursorX = -640;
  fixture.cursorY = 512;
  NSDictionary *result = fixture_read(&fixture);
  assert([result[@"status"] isEqual:@"resolved"]);
  assert([result[@"displayRef"][@"displayRef"]
      isEqual:@"display-left"]);
  assert([result[@"displayRef"][@"displayLayoutRevision"] isEqual:@3]);
  assert([result[@"cursor"][@"x"] isEqual:@(-640)]);
  assert([result[@"cursor"][@"y"] isEqual:@512]);
  assert([result[@"inventoryId"] isEqual:@"inventory-7"]);
  assert([result[@"inventoryRevision"] isEqual:@7]);
  assert([result[@"sourceResponseRef"]
      hasPrefix:@"cursor-display-response-"]);
  assert(fixture.cursorCalls == 1);
  assert(fixture.topologyCalls == 2);
  assert(fixture.snapshotCalls == 2);
}

static void test_partial_unrelated_inventory_keeps_display_proof(void) {
  MetaCursorDisplayFixture fixture;
  fixture_prepare(&fixture);
  fixture.snapshot.complete = false;
  fixture.cursorX = -640;
  fixture.cursorY = 512;
  NSDictionary *result = fixture_read(&fixture);
  assert([result[@"status"] isEqual:@"resolved"]);
  assert([result[@"displayRef"][@"displayRef"]
      isEqual:@"display-left"]);

  MetaCursorDisplayFixture missing;
  fixture_prepare(&missing);
  missing.snapshot.complete = false;
  missing.snapshot.display_count = 0;
  result = fixture_read(&missing);
  assert([result[@"status"] isEqual:@"unavailable"]);
  assert(missing.cursorCalls == 0 && missing.topologyCalls == 0);

  MetaCursorDisplayFixture duplicate;
  fixture_prepare(&duplicate);
  duplicate.snapshot.complete = false;
  duplicate.displays[1].display_id = duplicate.displays[0].display_id;
  result = fixture_read(&duplicate);
  assert([result[@"status"] isEqual:@"unavailable"]);
  assert(duplicate.cursorCalls == 0 && duplicate.topologyCalls == 0);
}

static void test_overlap_is_ambiguous(void) {
  MetaCursorDisplayFixture fixture;
  fixture_prepare(&fixture);
  fixture.displays[0] =
      fixture_display(1, @"display-left", -100, 0, 300, 300, 2, NO);
  fixture.displays[1] =
      fixture_display(2, @"display-main", 0, 0, 300, 300, 1, YES);
  fixture.cursorX = 50;
  fixture.cursorY = 50;
  NSDictionary *result = fixture_read(&fixture);
  assert([result[@"status"] isEqual:@"ambiguous"]);
  assert([result[@"reason"] length] > 0);
  assert(fixture.topologyCalls == 2);
}

static void test_display_gap_is_unavailable(void) {
  MetaCursorDisplayFixture fixture;
  fixture_prepare(&fixture);
  fixture.cursorX = -1400;
  fixture.cursorY = 500;
  NSDictionary *result = fixture_read(&fixture);
  assert([result[@"status"] isEqual:@"unavailable"]);
  assert(fixture.topologyCalls == 2);
}

static void test_stale_revision_and_epoch_fail_as_stale(void) {
  MetaCursorDisplayFixture revision;
  fixture_prepare(&revision);
  NSDictionary *staleRevision = meta_cursor_display_read_with_backend(
      fixture_generation(), @"inventory-7", 8, 3,
      fixture_backend(&revision));
  assert([staleRevision[@"status"] isEqual:@"stale-inventory"]);
  assert(revision.cursorCalls == 0 && revision.topologyCalls == 0);

  MetaCursorDisplayFixture epoch;
  fixture_prepare(&epoch);
  epoch.topologyEpoch = 6;
  NSDictionary *staleEpoch = fixture_read(&epoch);
  assert([staleEpoch[@"status"] isEqual:@"stale-inventory"]);
  assert(epoch.cursorCalls == 0 && epoch.topologyCalls == 0);

  MetaCursorDisplayFixture changing;
  fixture_prepare(&changing);
  changing.changeEpochOnCursor = YES;
  NSDictionary *changed = fixture_read(&changing);
  assert([changed[@"status"] isEqual:@"stale-inventory"]);
  assert(changing.cursorCalls == 1 && changing.topologyCalls == 1);
}

static void test_unavailable_sources_and_final_snapshot_fail_closed(void) {
  MetaCursorDisplayFixture unavailable;
  fixture_prepare(&unavailable);
  unavailable.topologyAvailable = NO;
  NSDictionary *topology = fixture_read(&unavailable);
  assert([topology[@"status"] isEqual:@"unavailable"]);
  assert(unavailable.cursorCalls == 0);

  MetaCursorDisplayFixture invalidCursor;
  fixture_prepare(&invalidCursor);
  invalidCursor.cursorX = NAN;
  NSDictionary *cursor = fixture_read(&invalidCursor);
  assert([cursor[@"status"] isEqual:@"unavailable"]);
  assert(invalidCursor.topologyCalls == 1);

  MetaCursorDisplayFixture changedSnapshot;
  fixture_prepare(&changedSnapshot);
  changedSnapshot.changeRevisionOnFinalSnapshot = YES;
  NSDictionary *snapshot = fixture_read(&changedSnapshot);
  assert([snapshot[@"status"] isEqual:@"stale-inventory"]);
  assert(changedSnapshot.topologyCalls == 2);
}

int main(void) {
  @autoreleasepool {
    test_negative_origin_and_mixed_scale_use_logical_bounds();
    test_partial_unrelated_inventory_keeps_display_proof();
    test_overlap_is_ambiguous();
    test_display_gap_is_unavailable();
    test_stale_revision_and_epoch_fail_as_stale();
    test_unavailable_sources_and_final_snapshot_fail_closed();
  }
  puts("cursor display tests passed");
}
