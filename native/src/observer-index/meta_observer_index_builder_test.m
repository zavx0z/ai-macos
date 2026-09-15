#include "meta_observer_index_builder.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint64_t now;
  uint64_t elapsed_during_refresh;
  uint64_t requested_budget;
  bool refresh_succeeded;
  bool foreground_ready;
  MetaApplicationRecord applications[2];
  MetaInventorySnapshot snapshot;
} Fixture;

static uint64_t now(void *context) { return ((Fixture *)context)->now; }
static bool refresh(void *context, uint64_t budget) {
  Fixture *fixture = context;
  fixture->requested_budget = budget;
  fixture->now += fixture->elapsed_during_refresh;
  return fixture->refresh_succeeded;
}
static const MetaInventorySnapshot *snapshot(void *context) {
  return &((Fixture *)context)->snapshot;
}
static bool ready(void *context, const MetaInventorySnapshot *value) {
  Fixture *fixture = context;
  return value == &fixture->snapshot && fixture->foreground_ready;
}
static MetaObserverTargetRecord *record(void *context,
                                        const MetaWindowRecord *window,
                                        const MetaInventorySnapshot *value,
                                        NSDictionary *generation) {
  (void)context;
  (void)window;
  (void)value;
  (void)generation;
  return nil;
}

static Fixture fixture(void) {
  Fixture value = {
      .now = 100,
      .elapsed_during_refresh = 3000,
      .refresh_succeeded = true,
      .foreground_ready = true,
      .applications = {
          {.pid = 42, .launch_time_micros = 900,
           .ax_status = META_AX_NO_WINDOWS},
          {.pid = 43, .launch_time_micros = 901,
           .ax_status = META_AX_TIMED_OUT},
      },
  };
  value.snapshot = (MetaInventorySnapshot){
      .revision = 7,
      .complete = false,
      .application_count = 2,
  };
  snprintf(value.snapshot.inventory_id, sizeof(value.snapshot.inventory_id),
           "%s", "inventory-7");
  snprintf(value.snapshot.native_generation,
           sizeof(value.snapshot.native_generation), "%s", "native-1");
  return value;
}

static MetaObserverIndexBuilderBackend backend(Fixture *value) {
  value->snapshot.applications = value->applications;
  return (MetaObserverIndexBuilderBackend){
      .context = value,
      .monotonic_millis = now,
      .refresh_inventory = refresh,
      .snapshot = snapshot,
      .snapshot_ready = ready,
      .record_for_window = record,
  };
}

int main(void) {
  @autoreleasepool {
    NSDictionary *generation = @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
    };
    Fixture background_timeout = fixture();
    MetaObserverPreparedIndex *prepared = meta_observer_build_current_index(
        backend(&background_timeout), generation, 1);
    assert(prepared != nil);
    assert(background_timeout.requested_budget == 3500);
    assert(!background_timeout.snapshot.complete);
    assert(background_timeout.snapshot.applications[1].ax_status ==
           META_AX_TIMED_OUT);

    Fixture foreground_append_failure = fixture();
    foreground_append_failure.foreground_ready = false;
    foreground_append_failure.applications[0].ax_status = META_AX_FAILED;
    assert(meta_observer_build_current_index(
               backend(&foreground_append_failure), generation, 1) == nil);

    Fixture exhausted = fixture();
    exhausted.elapsed_during_refresh = 4000;
    assert(meta_observer_build_current_index(backend(&exhausted), generation,
                                             1) == nil);
    puts("observer index builder tests passed; partial background isolated");
  }
  return 0;
}
