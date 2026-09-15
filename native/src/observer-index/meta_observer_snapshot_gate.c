#include "meta_observer_snapshot_gate.h"

#include <string.h>

#define META_OBSERVER_TOPOLOGY_RESERVE_MILLIS 500

bool meta_observer_refresh_budget(
    uint64_t started_millis,
    uint64_t total_budget_millis,
    MetaObserverRefreshBudget *budget) {
  if (budget == NULL || started_millis == 0 ||
      total_budget_millis <= META_OBSERVER_TOPOLOGY_RESERVE_MILLIS ||
      total_budget_millis > UINT64_MAX - started_millis) return false;
  budget->inventory_deadline_millis = started_millis + total_budget_millis;
  budget->ax_deadline_millis = budget->inventory_deadline_millis -
      META_OBSERVER_TOPOLOGY_RESERVE_MILLIS;
  return true;
}

bool meta_observer_snapshot_receipt_matches(
    const MetaInventorySnapshot *snapshot,
    const MetaObserverSnapshotReceipt *receipt,
    int32_t current_foreground_pid,
    uint64_t current_foreground_launch_time_micros) {
  return snapshot != NULL && receipt != NULL &&
      receipt->foreground_slice_complete &&
      current_foreground_pid > 0 && current_foreground_launch_time_micros > 0 &&
      receipt->foreground_pid == current_foreground_pid &&
      receipt->foreground_launch_time_micros == current_foreground_launch_time_micros &&
      receipt->snapshot_revision == snapshot->revision &&
      strcmp(receipt->inventory_id, snapshot->inventory_id) == 0 &&
      strcmp(receipt->native_generation, snapshot->native_generation) == 0;
}

bool meta_observer_retain_unseen_ax_handle(
    uint64_t handle_launch_time_micros,
    uint64_t current_process_launch_time_micros,
    bool application_present,
    MetaAXStatus application_status) {
  if (handle_launch_time_micros == 0) return false;
  if (current_process_launch_time_micros != 0 &&
      current_process_launch_time_micros != handle_launch_time_micros)
    return false;
  if (!application_present) return true;
  return application_status != META_AX_READY &&
      application_status != META_AX_NO_WINDOWS;
}
