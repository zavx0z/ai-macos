#include "meta_window_readback.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static MetaApplicationRecord application(MetaAXStatus status,
                                         uint64_t launch_time) {
  MetaApplicationRecord result = {
      .pid = 42,
      .launch_time_micros = launch_time,
      .ax_status = status,
  };
  snprintf(result.application_ref, sizeof(result.application_ref), "%s",
           "native-1:application:1");
  return result;
}

static MetaWindowRecord window_record(void) {
  MetaWindowRecord result = {
      .pid = 42,
      .surface_kind = META_SURFACE_WINDOW,
      .frame = {.x = 10, .y = 20, .width = 640, .height = 480},
      .application_hidden = META_FALSE,
      .minimized = META_FALSE,
      .focused = META_TRUE,
  };
  snprintf(result.window_ref, sizeof(result.window_ref), "%s",
           "native-1:window:1");
  snprintf(result.application_ref, sizeof(result.application_ref), "%s",
           "native-1:application:1");
  return result;
}

static MetaWindowRecord sheet(const char *surface_ref,
                              const char *owner_window_ref) {
  MetaWindowRecord result = {
      .pid = 42,
      .surface_kind = META_SURFACE_SHEET,
  };
  snprintf(result.surface_ref, sizeof(result.surface_ref), "%s", surface_ref);
  snprintf(result.owner_window_ref, sizeof(result.owner_window_ref), "%s",
           owner_window_ref);
  snprintf(result.application_ref, sizeof(result.application_ref), "%s",
           "native-1:application:1");
  return result;
}

static MetaInventorySnapshot snapshot(MetaApplicationRecord *applications,
                                      size_t application_count,
                                      MetaWindowRecord *windows,
                                      size_t window_count, bool complete) {
  return (MetaInventorySnapshot){
      .complete = complete,
      .applications = applications,
      .application_count = application_count,
      .windows = windows,
      .window_count = window_count,
  };
}

static MetaWindowTransition transition(void) {
  return (MetaWindowTransition){
      .close_attempted = true,
  };
}

static void test_focus_success_uses_actual_state_only(void) {
  assert(meta_window_focus_state_confirmed(true, META_TRUE));
  assert(!meta_window_focus_state_confirmed(false, META_TRUE));
  assert(!meta_window_focus_state_confirmed(true, META_FALSE));
  assert(!meta_window_focus_state_confirmed(true, META_UNKNOWN));
}

static void test_full_fresh_ax_absence_is_closed(void) {
  MetaApplicationRecord app = application(META_AX_NO_WINDOWS, 100);
  MetaWindowRecord original = window_record();
  MetaInventorySnapshot fresh = snapshot(&app, 1, NULL, 0, true);
  MetaWindowTransition result = transition();
  meta_window_classify_close(&fresh, &original, 100, true, true, &result);
  assert(result.inventory_refreshed);
  assert(result.presence == META_WINDOW_PRESENCE_CLOSED);
  assert(result.close_succeeded);
  assert(result.status == META_TRANSITION_SUCCEEDED);
}

static void test_partial_existing_requires_exact_live_target_proof(void) {
  MetaApplicationRecord app = application(META_AX_READY, 100);
  MetaWindowRecord original = window_record();
  MetaWindowRecord current = original;
  current.focused = META_TRUE;
  MetaInventorySnapshot partial = snapshot(&app, 1, &current, 1, false);
  MetaWindowTransition result = transition();
  meta_window_classify_existing(&partial, &original, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_EXISTING);
  assert(result.focused == META_TRUE);

  result = transition();
  meta_window_classify_existing(&partial, &original, false, &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);

  MetaWindowRecord duplicate[] = {current, current};
  partial.windows = duplicate;
  partial.window_count = 2;
  result = transition();
  meta_window_classify_existing(&partial, &original, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);

  partial.windows = &current;
  partial.window_count = 1;
  snprintf(current.application_ref, sizeof(current.application_ref), "%s",
           "native-1:application:other");
  result = transition();
  meta_window_classify_existing(&partial, &original, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);

  current = original;
  snprintf(current.target_ref, sizeof(current.target_ref), "%s",
           "native-1:window:foreign-target");
  result = transition();
  meta_window_classify_existing(&partial, &original, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
}

static void test_partial_unrelated_is_closed_but_owner_gaps_are_unknown(void) {
  MetaWindowRecord original = window_record();
  MetaApplicationRecord applications[] = {
      application(META_AX_NO_WINDOWS, 100),
      application(META_AX_DENIED, 200),
  };
  applications[1].pid = 99;
  snprintf(applications[1].application_ref,
           sizeof(applications[1].application_ref), "%s",
           "native-1:application:unrelated");
  MetaInventorySnapshot incomplete = snapshot(applications, 2, NULL, 0, false);
  MetaWindowTransition result = transition();
  meta_window_classify_close(&incomplete, &original, 100, true, true, &result);
  assert(result.inventory_refreshed);
  assert(result.presence == META_WINDOW_PRESENCE_CLOSED);
  assert(result.close_succeeded);

  MetaApplicationRecord denied = application(META_AX_DENIED, 100);
  MetaInventorySnapshot denied_snapshot = snapshot(&denied, 1, NULL, 0, true);
  meta_window_classify_close(&denied_snapshot, &original, 100, true, true,
                             &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
  assert(!result.close_succeeded);

  MetaApplicationRecord reused = application(META_AX_NO_WINDOWS, 101);
  MetaInventorySnapshot reused_snapshot = snapshot(&reused, 1, NULL, 0, true);
  meta_window_classify_close(&reused_snapshot, &original, 100, true, true,
                             &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
  meta_window_classify_close(&denied_snapshot, &original, 100, false, true,
                             &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
  meta_window_classify_close(NULL, &original, 100, true, true, &result);
  assert(!result.inventory_refreshed);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);

  MetaApplicationRecord duplicate_apps[] = {
      application(META_AX_NO_WINDOWS, 100),
      application(META_AX_NO_WINDOWS, 100),
  };
  MetaInventorySnapshot ambiguous_app =
      snapshot(duplicate_apps, 2, NULL, 0, false);
  meta_window_classify_close(&ambiguous_app, &original, 100, true, true,
                             &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);

  MetaApplicationRecord ready = application(META_AX_READY, 100);
  MetaWindowRecord duplicate_windows[] = {original, original};
  MetaInventorySnapshot ambiguous_window =
      snapshot(&ready, 1, duplicate_windows, 2, false);
  meta_window_classify_close(&ambiguous_window, &original, 100, true, true,
                             &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
}

static void test_only_exact_owner_sheet_is_reported(void) {
  MetaApplicationRecord app = application(META_AX_READY, 100);
  MetaWindowRecord original = window_record();
  MetaWindowRecord windows[] = {
      original,
      sheet("native-1:surface:foreign", "native-1:window:99"),
      sheet("native-1:surface:owned", original.window_ref),
  };
  MetaInventorySnapshot fresh = snapshot(&app, 1, windows, 3, true);
  MetaWindowTransition result = transition();
  meta_window_classify_close(&fresh, &original, 100, true, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_EXISTING);
  assert(!result.close_succeeded);
  assert(result.modal_or_sheet_observed);
  assert(strcmp(result.new_surface_ref, "native-1:surface:owned") == 0);
  assert(result.actual_frame.width == original.frame.width);
}

static void test_foreign_sheet_is_not_reported(void) {
  MetaApplicationRecord app = application(META_AX_READY, 100);
  MetaWindowRecord original = window_record();
  MetaWindowRecord windows[] = {
      original,
      sheet("native-1:surface:foreign", "native-1:window:99"),
  };
  MetaInventorySnapshot fresh = snapshot(&app, 1, windows, 2, true);
  MetaWindowTransition result = transition();
  meta_window_classify_close(&fresh, &original, 100, true, true, &result);
  assert(result.presence == META_WINDOW_PRESENCE_EXISTING);
  assert(!result.modal_or_sheet_observed);
  assert(result.new_surface_ref[0] == '\0');
}

static void test_absence_without_dispatch_is_not_closed(void) {
  MetaApplicationRecord app = application(META_AX_NO_WINDOWS, 100);
  MetaWindowRecord original = window_record();
  MetaInventorySnapshot fresh = snapshot(&app, 1, NULL, 0, true);
  MetaWindowTransition result = transition();
  meta_window_classify_close(&fresh, &original, 100, true, false, &result);
  assert(result.presence == META_WINDOW_PRESENCE_UNKNOWN);
  assert(!result.close_succeeded);
  assert(result.status == META_TRANSITION_PARTIAL);
}

int main(void) {
  test_focus_success_uses_actual_state_only();
  test_full_fresh_ax_absence_is_closed();
  test_partial_existing_requires_exact_live_target_proof();
  test_partial_unrelated_is_closed_but_owner_gaps_are_unknown();
  test_only_exact_owner_sheet_is_reported();
  test_foreign_sheet_is_not_reported();
  test_absence_without_dispatch_is_not_closed();
  puts("window readback fixture: ok");
  return 0;
}
