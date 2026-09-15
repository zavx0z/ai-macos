#include "meta_observer_snapshot_gate.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void copy_text(char *target, size_t capacity, const char *value) {
  snprintf(target, capacity, "%s", value);
}

int main(void) {
  MetaApplicationRecord applications[] = {
      {.pid = 42, .launch_time_micros = 900, .ax_status = META_AX_READY},
      {.pid = 43, .launch_time_micros = 901, .ax_status = META_AX_TIMED_OUT},
  };
  MetaInventorySnapshot snapshot = {
      .revision = 7,
      .complete = false,
      .applications = applications,
      .application_count = 2,
  };
  copy_text(snapshot.inventory_id, sizeof(snapshot.inventory_id), "inventory-7");
  copy_text(snapshot.native_generation, sizeof(snapshot.native_generation), "native-1");
  MetaObserverSnapshotReceipt receipt = {
      .foreground_slice_complete = true,
      .foreground_pid = 42,
      .foreground_launch_time_micros = 900,
      .snapshot_revision = 7,
  };
  copy_text(receipt.inventory_id, sizeof(receipt.inventory_id), "inventory-7");
  copy_text(receipt.native_generation, sizeof(receipt.native_generation), "native-1");
  assert(meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 42, 900));
  receipt.foreground_slice_complete = false;
  assert(!meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 42, 900));
  receipt.foreground_slice_complete = true;
  assert(!meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 43, 900));
  assert(!meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 42, 901));
  snapshot.revision = 8;
  assert(!meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 42, 900));
  snapshot.revision = 7;
  copy_text(snapshot.inventory_id, sizeof(snapshot.inventory_id), "inventory-foreign");
  assert(!meta_observer_snapshot_receipt_matches(&snapshot, &receipt, 42, 900));
  MetaObserverRefreshBudget budget = {0};
  assert(meta_observer_refresh_budget(1000, 3500, &budget));
  assert(budget.ax_deadline_millis == 4000);
  assert(budget.inventory_deadline_millis == 4500);
  // Background AX timeout исчерпал только AX slice; topology reserve остался.
  const uint64_t background_timeout_at = budget.ax_deadline_millis;
  assert(background_timeout_at >= budget.ax_deadline_millis);
  assert(budget.inventory_deadline_millis - background_timeout_at == 500);
  assert(!meta_observer_refresh_budget(1000, 500, &budget));
  assert(!meta_observer_refresh_budget(UINT64_MAX - 10, 3500, &budget));
  assert(meta_observer_retain_unseen_ax_handle(
      900, 900, true, META_AX_TIMED_OUT));
  assert(meta_observer_retain_unseen_ax_handle(
      900, 900, true, META_AX_FAILED));
  assert(meta_observer_retain_unseen_ax_handle(
      900, 900, false, META_AX_UNAVAILABLE));
  assert(meta_observer_retain_unseen_ax_handle(
      900, 0, false, META_AX_UNAVAILABLE));
  assert(meta_observer_retain_unseen_ax_handle(
      900, 0, true, META_AX_TIMED_OUT));
  assert(!meta_observer_retain_unseen_ax_handle(
      900, 901, true, META_AX_TIMED_OUT));
  assert(!meta_observer_retain_unseen_ax_handle(
      900, 900, true, META_AX_READY));
  assert(!meta_observer_retain_unseen_ax_handle(
      900, 900, true, META_AX_NO_WINDOWS));
  puts("observer snapshot receipt tests passed");
  return 0;
}
