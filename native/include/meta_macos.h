#ifndef META_MACOS_H
#define META_MACOS_H

#include "meta_native.h"

typedef enum {
  META_TRANSITION_SUCCEEDED,
  META_TRANSITION_PARTIAL,
  META_TRANSITION_TARGET_STALE,
  META_TRANSITION_UNAVAILABLE,
  META_TRANSITION_SPACE_UNAVAILABLE,
  META_TRANSITION_TIMED_OUT,
} MetaTransitionStatus;

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
  int32_t ax_error;
} MetaWindowTransition;

typedef struct MetaMacOSBackend MetaMacOSBackend;

MetaMacOSBackend *meta_macos_backend_create(const char *native_generation);
bool meta_macos_target_is_focused(MetaMacOSBackend *backend, const char *target_ref);
void meta_macos_backend_destroy(MetaMacOSBackend *backend);
const MetaInventorySnapshot *meta_macos_backend_snapshot(
    const MetaMacOSBackend *backend);
bool meta_macos_refresh_inventory(MetaMacOSBackend *backend,
                                  uint64_t total_budget_millis);
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
