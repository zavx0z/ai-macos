#ifndef META_MACOS_H
#define META_MACOS_H

#include "meta_native.h"
#include <ApplicationServices/ApplicationServices.h>

typedef enum {
  META_TRANSITION_SUCCEEDED,
  META_TRANSITION_PARTIAL,
  META_TRANSITION_TARGET_STALE,
  META_TRANSITION_UNAVAILABLE,
  META_TRANSITION_SPACE_UNAVAILABLE,
  META_TRANSITION_TIMED_OUT,
} MetaTransitionStatus;

typedef enum {
  META_WINDOW_PRESENCE_UNKNOWN,
  META_WINDOW_PRESENCE_EXISTING,
  META_WINDOW_PRESENCE_CLOSED,
} MetaWindowPresence;

typedef struct {
  MetaTransitionStatus status;
  char window_ref[META_NATIVE_REF_CAPACITY];
  MetaRect requested_frame;
  MetaRect actual_frame;
  MetaTriState application_hidden;
  MetaTriState minimized;
  MetaTriState focused;
  bool application_unhide_attempted;
  bool application_unhide_succeeded;
  bool unminimize_attempted;
  bool unminimize_succeeded;
  bool raise_attempted;
  bool raise_succeeded;
  bool focus_attempted;
  bool focus_succeeded;
  bool move_attempted;
  bool move_succeeded;
  bool resize_attempted;
  bool resize_succeeded;
  bool close_attempted;
  bool close_succeeded;
  bool modal_or_sheet_observed;
  MetaWindowPresence presence;
  bool inventory_refreshed;
  char new_surface_ref[META_NATIVE_REF_CAPACITY];
  int32_t ax_error;
} MetaWindowTransition;

typedef struct MetaMacOSBackend MetaMacOSBackend;

typedef struct {
  bool receipt_matches;
  int32_t foreground_pid;
  uint64_t foreground_launch_time_micros;
  MetaAXStatus foreground_ax_status;
  uint64_t snapshot_revision;
  bool snapshot_complete;
  size_t application_count;
  size_t window_count;
} MetaObserverSnapshotDiagnostics;

typedef void (*MetaDisplayTopologyChanged)(
    CGDirectDisplayID display,
    CGDisplayChangeSummaryFlags flags,
    void *callback_context);
typedef struct {
  void *context;
  bool (*start)(void *context, MetaDisplayTopologyChanged changed,
                void *callback_context);
  bool (*stop)(void *context, MetaDisplayTopologyChanged changed,
               void *callback_context);
} MetaDisplayTopologyObserverBackend;

typedef enum {
  META_AX_BORROW_OK,
  META_AX_BORROW_INVALID_REQUEST,
  META_AX_BORROW_TARGET_STALE,
  META_AX_BORROW_PERMISSION_DENIED,
  META_AX_BORROW_CONSUMER_FAILED,
} MetaAXBorrowStatus;

typedef struct {
  AXUIElementRef element;
  MetaWindowRecord target;
  uint64_t launch_time_micros;
  uint64_t inventory_revision;
  char inventory_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
} MetaAXTargetBorrow;

// Вызывается только на action worker владельца backend. element и borrow
// действительны до возврата callback; callback не освобождает element и не
// сохраняет ссылку для асинхронной работы. Registry остаётся у native-owner.
typedef bool (*MetaAXTargetConsumer)(void *context, const MetaAXTargetBorrow *borrow);
MetaAXBorrowStatus meta_macos_with_ax_target(MetaMacOSBackend *backend,
                                            const char *target_ref,
                                            const char *inventory_id,
                                            uint64_t inventory_revision,
                                            const char *native_generation,
                                            MetaAXTargetConsumer consume,
                                            void *context);

MetaMacOSBackend *meta_macos_backend_create(const char *native_generation);
MetaMacOSBackend *meta_macos_backend_create_with_topology_observer(
    const char *native_generation,
    MetaDisplayTopologyObserverBackend topology_observer);
bool meta_macos_display_topology_epoch(const MetaMacOSBackend *backend,
                                       uint64_t *epoch);
bool meta_macos_target_is_focused(MetaMacOSBackend *backend, const char *target_ref);
bool meta_macos_backend_destroy(MetaMacOSBackend *backend);
const MetaInventorySnapshot *meta_macos_backend_snapshot(
    const MetaMacOSBackend *backend);
bool meta_macos_refresh_inventory(MetaMacOSBackend *backend,
                                  uint64_t total_budget_millis);
// Проверяет backend-owned receipt exact foreground AX slice для текущего
// snapshot. Global snapshot.complete остаётся независимым строгим контрактом.
bool meta_macos_observer_snapshot_ready(
    MetaMacOSBackend *backend,
    const MetaInventorySnapshot *snapshot);
bool meta_macos_observer_snapshot_diagnostics(
    MetaMacOSBackend *backend,
    const MetaInventorySnapshot *snapshot,
    MetaObserverSnapshotDiagnostics *diagnostics);
bool meta_macos_show_window(MetaMacOSBackend *backend, const char *window_ref,
                            MetaWindowTransition *result);
bool meta_macos_focus_window(MetaMacOSBackend *backend, const char *window_ref,
                             MetaWindowTransition *result);
bool meta_macos_set_window_bounds(MetaMacOSBackend *backend,
                                  const char *window_ref,
                                  MetaRect requested_frame,
                                  MetaWindowTransition *result);
bool meta_macos_set_window_minimized(MetaMacOSBackend *backend,
                                     const char *window_ref, bool minimized,
                                     MetaWindowTransition *result);
bool meta_macos_close_window(MetaMacOSBackend *backend,
                             const char *window_ref,
                             MetaWindowTransition *result);

#endif
