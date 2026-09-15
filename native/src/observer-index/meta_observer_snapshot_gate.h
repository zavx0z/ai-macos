#ifndef META_OBSERVER_SNAPSHOT_GATE_H
#define META_OBSERVER_SNAPSHOT_GATE_H

#include "meta_native.h"

typedef struct {
  bool foreground_slice_complete;
  int32_t foreground_pid;
  uint64_t foreground_launch_time_micros;
  uint64_t snapshot_revision;
  char inventory_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
} MetaObserverSnapshotReceipt;

typedef struct {
  uint64_t ax_deadline_millis;
  uint64_t inventory_deadline_millis;
} MetaObserverRefreshBudget;

// Background AX discovery не может расходовать последние 500ms, оставленные
// topology/CG/display publication. Возвращает false при overflow/нулевом budget.
bool meta_observer_refresh_budget(
    uint64_t started_millis,
    uint64_t total_budget_millis,
    MetaObserverRefreshBudget *budget);

// Pure exact-match gate: глобальная inventory может быть partial, но receipt
// действителен только для текущего foreground PID birth и того же snapshot.
bool meta_observer_snapshot_receipt_matches(
    const MetaInventorySnapshot *snapshot,
    const MetaObserverSnapshotReceipt *receipt,
    int32_t current_foreground_pid,
    uint64_t current_foreground_launch_time_micros);

// Unseen handle сохраняется только для того же живого process incarnation,
// пока enumeration этого приложения неизвестна. READY/NO_WINDOWS разрешают
// точный prune missing handles; exit/PID reuse всегда удаляет.
bool meta_observer_retain_unseen_ax_handle(
    uint64_t handle_launch_time_micros,
    uint64_t current_process_launch_time_micros,
    bool application_present,
    MetaAXStatus application_status);

#endif
