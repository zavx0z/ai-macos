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
static bool diagnostics(void *context, const MetaInventorySnapshot *value,
                        MetaObserverSnapshotDiagnostics *output) {
  Fixture *fixture = context;
  if ((value != NULL && value != &fixture->snapshot) || output == NULL)
    return false;
  *output = (MetaObserverSnapshotDiagnostics){
      .receipt_matches = fixture->foreground_ready,
      .foreground_pid = fixture->applications[0].pid,
      .foreground_launch_time_micros =
          fixture->applications[0].launch_time_micros,
      .foreground_ax_status = fixture->applications[0].ax_status,
      .snapshot_revision = value == NULL ? 0 : value->revision,
      .snapshot_complete = value != NULL && value->complete,
      .application_count = fixture->snapshot.application_count,
      .window_count = fixture->snapshot.window_count,
  };
  return true;
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
      .snapshot_diagnostics = diagnostics,
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
    MetaObserverIndexBuildDiagnostics report = {0};
    MetaObserverPreparedIndex *prepared = meta_observer_build_current_index(
        backend(&background_timeout), generation, 1, &report);
    assert(prepared != nil);
    assert(report.stage == MetaObserverIndexBuildStageReady);
    assert(background_timeout.requested_budget == 3500);
    assert(!background_timeout.snapshot.complete);
    assert(background_timeout.snapshot.applications[1].ax_status ==
           META_AX_TIMED_OUT);

    Fixture foreground_append_failure = fixture();
    foreground_append_failure.foreground_ready = false;
    foreground_append_failure.applications[0].ax_status = META_AX_FAILED;
    assert(meta_observer_build_current_index(
               backend(&foreground_append_failure), generation, 1,
               &report) == nil);
    assert(report.stage ==
           MetaObserverIndexBuildStageForegroundReceiptInvalid);
    NSString *reason = meta_observer_index_build_failure_reason(&report);
    assert([reason containsString:@"stage=foreground-receipt-invalid"]);
    assert([reason containsString:@"foregroundAxStatus=failed"]);
    assert([reason containsString:@"applications=2"]);
    assert([reason rangeOfString:@"title"].location == NSNotFound);

    Fixture exhausted = fixture();
    exhausted.elapsed_during_refresh = 4000;
    assert(meta_observer_build_current_index(backend(&exhausted), generation,
                                             1, &report) == nil);
    assert(report.stage == MetaObserverIndexBuildStageRefreshDeadline);

    Fixture failed_refresh = fixture();
    failed_refresh.refresh_succeeded = false;
    failed_refresh.applications[0].ax_status = META_AX_TIMED_OUT;
    assert(meta_observer_build_current_index(
               backend(&failed_refresh), generation, 1, &report) == nil);
    assert(report.stage == MetaObserverIndexBuildStageRefreshFailed);
    reason = meta_observer_index_build_failure_reason(&report);
    assert([reason containsString:@"foregroundAxStatus=timed-out"]);
    assert([reason containsString:@"applications=2"]);
    puts("observer index builder tests passed; partial background isolated");
  }
  return 0;
}
