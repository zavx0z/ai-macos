#include "meta_window_readback.h"
#include <stdio.h>
#include <string.h>

bool meta_window_focus_state_confirmed(bool frontmost,
                                       MetaTriState focused) {
  return frontmost && focused == META_TRUE;
}

static const MetaWindowRecord *exact_current_window(
    const MetaInventorySnapshot *snapshot,
    const MetaWindowRecord *original,
    bool *ambiguous) {
  const MetaWindowRecord *actual = NULL;
  *ambiguous = false;
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->surface_kind == META_SURFACE_WINDOW &&
        strcmp(candidate->window_ref, original->window_ref) == 0 &&
        strcmp(candidate->application_ref, original->application_ref) == 0 &&
        candidate->pid == original->pid) {
      if (actual != NULL) {
        *ambiguous = true;
        return NULL;
      }
      actual = candidate;
    }
  }
  if (actual != NULL &&
      strcmp(actual->target_ref, original->target_ref) != 0) {
    *ambiguous = true;
    return NULL;
  }
  return actual;
}

static void record_owned_surface(const MetaInventorySnapshot *snapshot,
                                 const MetaWindowRecord *original,
                                 MetaWindowTransition *result) {
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *surface = &snapshot->windows[index];
    if (surface->surface_kind != META_SURFACE_WINDOW &&
        strcmp(surface->owner_window_ref, original->window_ref) == 0 &&
        strcmp(surface->application_ref, original->application_ref) == 0 &&
        surface->pid == original->pid) {
      result->modal_or_sheet_observed = true;
      snprintf(result->new_surface_ref, sizeof(result->new_surface_ref), "%s",
               surface->surface_ref);
      return;
    }
  }
}

void meta_window_classify_existing(const MetaInventorySnapshot *snapshot,
                                    const MetaWindowRecord *original,
                                    bool target_matches,
                                    MetaWindowTransition *result) {
  if (result == NULL) return;
  result->presence = META_WINDOW_PRESENCE_UNKNOWN;
  result->modal_or_sheet_observed = false;
  result->new_surface_ref[0] = '\0';
  if (snapshot == NULL || original == NULL || !target_matches ||
      snapshot->window_count == 0 || snapshot->windows == NULL) return;
  bool ambiguous = false;
  const MetaWindowRecord *actual =
      exact_current_window(snapshot, original, &ambiguous);
  if (actual == NULL || ambiguous) return;
  result->presence = META_WINDOW_PRESENCE_EXISTING;
  result->actual_frame = actual->frame;
  result->application_hidden = actual->application_hidden;
  result->minimized = actual->minimized;
  result->focused = actual->focused;
  record_owned_surface(snapshot, original, result);
}

void meta_window_classify_close(const MetaInventorySnapshot *snapshot,
                                 const MetaWindowRecord *original,
                                 uint64_t launch_time_micros,
                                 bool process_matches,
                                 bool close_dispatched,
                                 MetaWindowTransition *result) {
  if (result == NULL) return;
  result->presence = META_WINDOW_PRESENCE_UNKNOWN;
  result->inventory_refreshed = snapshot != NULL;
  result->close_succeeded = false;
  result->modal_or_sheet_observed = false;
  result->new_surface_ref[0] = '\0';
  result->status = META_TRANSITION_PARTIAL;
  if (snapshot == NULL || original == NULL || !process_matches ||
      snapshot->application_count == 0 || snapshot->applications == NULL ||
      (snapshot->window_count > 0 && snapshot->windows == NULL)) return;
  const MetaApplicationRecord *application = NULL;
  size_t application_matches = 0;
  for (size_t index = 0; index < snapshot->application_count; index += 1) {
    const MetaApplicationRecord *candidate = &snapshot->applications[index];
    if (strcmp(candidate->application_ref, original->application_ref) == 0 &&
        candidate->pid == original->pid) {
      application = candidate;
      application_matches += 1;
    }
  }
  if (application_matches != 1 ||
      application->launch_time_micros != launch_time_micros ||
      (application->ax_status != META_AX_READY &&
       application->ax_status != META_AX_NO_WINDOWS)) return;
  bool ambiguous = false;
  const MetaWindowRecord *actual =
      exact_current_window(snapshot, original, &ambiguous);
  if (ambiguous) return;
  if (actual == NULL) {
    if (!close_dispatched) return;
    result->presence = META_WINDOW_PRESENCE_CLOSED;
    result->close_succeeded = true;
    result->status = META_TRANSITION_SUCCEEDED;
    return;
  }
  result->presence = META_WINDOW_PRESENCE_EXISTING;
  result->actual_frame = actual->frame;
  result->application_hidden = actual->application_hidden;
  result->minimized = actual->minimized;
  result->focused = actual->focused;
  record_owned_surface(snapshot, original, result);
}
