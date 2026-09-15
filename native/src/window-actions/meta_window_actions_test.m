#include "meta_window_actions.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  size_t show_calls;
  size_t focus_calls;
  size_t bounds_calls;
  size_t minimize_calls;
  size_t close_calls;
  char last_target[META_NATIVE_REF_CAPACITY];
  MetaRect requested_bounds;
  bool requested_minimized;
  MetaWindowTransition next;
  bool next_success;
  const char *returned_target;
} Fixture;

static void copy_transition(Fixture *fixture, const char *window_ref,
                            MetaWindowTransition *result) {
  snprintf(fixture->last_target, sizeof(fixture->last_target), "%s",
           window_ref);
  *result = fixture->next;
  snprintf(result->window_ref, sizeof(result->window_ref), "%s",
           fixture->returned_target == NULL ? window_ref
                                            : fixture->returned_target);
}

static bool show_window(void *context, const char *window_ref,
                        MetaWindowTransition *result) {
  Fixture *fixture = context;
  fixture->show_calls += 1;
  copy_transition(fixture, window_ref, result);
  return fixture->next_success;
}

static bool focus_window(void *context, const char *window_ref,
                         MetaWindowTransition *result) {
  Fixture *fixture = context;
  fixture->focus_calls += 1;
  copy_transition(fixture, window_ref, result);
  return fixture->next_success;
}

static bool set_window_bounds(void *context, const char *window_ref,
                              MetaRect requested_frame,
                              MetaWindowTransition *result) {
  Fixture *fixture = context;
  fixture->bounds_calls += 1;
  fixture->requested_bounds = requested_frame;
  copy_transition(fixture, window_ref, result);
  result->requested_frame = requested_frame;
  return fixture->next_success;
}

static bool set_window_minimized(void *context, const char *window_ref,
                                 bool minimized,
                                 MetaWindowTransition *result) {
  Fixture *fixture = context;
  fixture->minimize_calls += 1;
  fixture->requested_minimized = minimized;
  copy_transition(fixture, window_ref, result);
  return fixture->next_success;
}

static bool close_window(void *context, const char *window_ref,
                         MetaWindowTransition *result) {
  Fixture *fixture = context;
  fixture->close_calls += 1;
  copy_transition(fixture, window_ref, result);
  return fixture->next_success;
}

static MetaWindowActionBackend backend(Fixture *fixture) {
  return (MetaWindowActionBackend){
      .context = fixture,
      .show_window = show_window,
      .focus_window = focus_window,
      .set_window_bounds = set_window_bounds,
      .set_window_minimized = set_window_minimized,
      .close_window = close_window,
  };
}

static void assert_only_show_called(Fixture fixture) {
  assert(fixture.show_calls == 1);
  assert(fixture.focus_calls == 0);
  assert(fixture.bounds_calls == 0);
  assert(fixture.minimize_calls == 0);
  assert(fixture.close_calls == 0);
}

static void test_hidden_minimized_show(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_SUCCEEDED,
          .application_hidden = META_FALSE,
          .minimized = META_FALSE,
          .focused = META_TRUE,
          .application_unhide_attempted = true,
          .application_unhide_succeeded = true,
          .unminimize_attempted = true,
          .unminimize_succeeded = true,
          .raise_attempted = true,
          .raise_succeeded = true,
          .focus_attempted = true,
          .focus_succeeded = true,
      },
      .next_success = true,
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = "native-7:window:42",
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert_only_show_called(fixture);
  assert(strcmp(fixture.last_target, request.window_ref) == 0);
  assert(result.status == META_TRANSITION_SUCCEEDED);
  assert(result.application_unhide_attempted);
  assert(result.application_unhide_succeeded);
  assert(result.unminimize_attempted);
  assert(result.unminimize_succeeded);
  assert(result.application_hidden == META_FALSE);
  assert(result.minimized == META_FALSE);
  assert(result.focused == META_TRUE);
}

static void test_partial_move_resize(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_PARTIAL,
          .actual_frame = {.x = -120, .y = 30, .width = 640, .height = 480},
          .application_hidden = META_FALSE,
          .minimized = META_FALSE,
          .focused = META_FALSE,
          .move_attempted = true,
          .move_succeeded = true,
          .resize_attempted = true,
          .resize_succeeded = false,
          .ax_error = -25205,
      },
      .next_success = false,
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaRect requested = {.x = -120, .y = 30, .width = 900, .height = 700};
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_SET_BOUNDS,
      .window_ref = "native-7:window:43",
      .value.bounds = requested,
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert(fixture.bounds_calls == 1);
  assert(fixture.requested_bounds.x == requested.x);
  assert(fixture.requested_bounds.y == requested.y);
  assert(fixture.requested_bounds.width == requested.width);
  assert(fixture.requested_bounds.height == requested.height);
  assert(result.status == META_TRANSITION_PARTIAL);
  assert(result.move_succeeded);
  assert(!result.resize_succeeded);
  assert(result.requested_frame.width == 900);
  assert(result.actual_frame.width == 640);
  assert(result.actual_frame.height == 480);
}

static void test_unsaved_close_sheet(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_PARTIAL,
          .application_hidden = META_FALSE,
          .minimized = META_FALSE,
          .focused = META_TRUE,
          .close_attempted = true,
          .close_succeeded = false,
          .modal_or_sheet_observed = true,
      },
      .next_success = false,
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_CLOSE,
      .window_ref = "native-7:window:44",
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert(fixture.close_calls == 1);
  assert(fixture.show_calls == 0);
  assert(fixture.focus_calls == 0);
  assert(result.status == META_TRANSITION_PARTIAL);
  assert(result.close_attempted);
  assert(!result.close_succeeded);
  assert(result.modal_or_sheet_observed);
}

static void test_stale_target_has_no_fallback(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_TARGET_STALE,
          .application_hidden = META_UNKNOWN,
          .minimized = META_UNKNOWN,
          .focused = META_UNKNOWN,
      },
      .next_success = false,
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = "native-old:window:9",
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert_only_show_called(fixture);
  assert(result.status == META_TRANSITION_TARGET_STALE);
}

static void test_invalid_requests_never_reach_backend(void) {
  Fixture fixture = {0};
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowTransition result;
  MetaWindowActionRequest empty_target = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = "",
  };
  assert(meta_window_action_dispatch(&actions, &empty_target, &result) ==
         META_WINDOW_ACTION_INVALID_REQUEST);
  MetaWindowActionRequest unsafe_target = {
      .kind = META_WINDOW_ACTION_FOCUS,
      .window_ref = "native/window/1",
  };
  assert(meta_window_action_dispatch(&actions, &unsafe_target, &result) ==
         META_WINDOW_ACTION_INVALID_REQUEST);
  char oversized_target[META_NATIVE_REF_CAPACITY];
  memset(oversized_target, 'a', sizeof(oversized_target));
  MetaWindowActionRequest unterminated_target = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = oversized_target,
  };
  assert(meta_window_action_dispatch(&actions, &unterminated_target, &result) ==
         META_WINDOW_ACTION_INVALID_REQUEST);
  MetaWindowActionRequest invalid_action = {
      .kind = (MetaWindowActionKind)99,
      .window_ref = "native-7:window:45",
  };
  assert(meta_window_action_dispatch(&actions, &invalid_action, &result) ==
         META_WINDOW_ACTION_INVALID_REQUEST);
  MetaWindowActionRequest invalid_bounds = {
      .kind = META_WINDOW_ACTION_SET_BOUNDS,
      .window_ref = "native-7:window:45",
      .value.bounds = {.x = NAN, .y = 0, .width = 0, .height = INFINITY},
  };
  assert(meta_window_action_dispatch(&actions, &invalid_bounds, &result) ==
         META_WINDOW_ACTION_INVALID_REQUEST);
  assert(fixture.show_calls == 0);
  assert(fixture.focus_calls == 0);
  assert(fixture.bounds_calls == 0);
  assert(fixture.minimize_calls == 0);
  assert(fixture.close_calls == 0);
}

static void test_missing_operation_has_no_fallback(void) {
  Fixture fixture = {0};
  MetaWindowActionBackend actions = backend(&fixture);
  actions.show_window = NULL;
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = "native-7:window:46",
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_BACKEND_UNAVAILABLE);
  assert(fixture.focus_calls == 0);
  assert(fixture.bounds_calls == 0);
  assert(fixture.minimize_calls == 0);
  assert(fixture.close_calls == 0);
}

static void test_focus_and_minimize_use_their_exact_operations(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_SUCCEEDED,
          .application_hidden = META_FALSE,
          .minimized = META_FALSE,
          .focused = META_TRUE,
      },
      .next_success = true,
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowTransition result;
  MetaWindowActionRequest focus = {
      .kind = META_WINDOW_ACTION_FOCUS,
      .window_ref = "native-7:window:48",
  };
  assert(meta_window_action_dispatch(&actions, &focus, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert(fixture.focus_calls == 1);
  assert(fixture.show_calls == 0);
  fixture.next.minimized = META_TRUE;
  MetaWindowActionRequest minimize = {
      .kind = META_WINDOW_ACTION_SET_MINIMIZED,
      .window_ref = "native-7:window:48",
      .value.minimized = true,
  };
  assert(meta_window_action_dispatch(&actions, &minimize, &result) ==
         META_WINDOW_ACTION_DISPATCHED);
  assert(fixture.minimize_calls == 1);
  assert(fixture.requested_minimized);
  assert(fixture.show_calls == 0);
  assert(fixture.close_calls == 0);
}

static void test_backend_cannot_retarget_result(void) {
  Fixture fixture = {
      .next = {
          .status = META_TRANSITION_SUCCEEDED,
          .application_hidden = META_FALSE,
          .minimized = META_FALSE,
          .focused = META_TRUE,
      },
      .next_success = true,
      .returned_target = "native-7:window:999",
  };
  MetaWindowActionBackend actions = backend(&fixture);
  MetaWindowActionRequest request = {
      .kind = META_WINDOW_ACTION_SHOW,
      .window_ref = "native-7:window:47",
  };
  MetaWindowTransition result;
  assert(meta_window_action_dispatch(&actions, &request, &result) ==
         META_WINDOW_ACTION_BACKEND_CONTRACT_VIOLATION);
  assert_only_show_called(fixture);
  assert(strcmp(result.window_ref, request.window_ref) == 0);
  assert(result.status == META_TRANSITION_UNAVAILABLE);
}

int main(void) {
  test_hidden_minimized_show();
  test_partial_move_resize();
  test_unsaved_close_sheet();
  test_stale_target_has_no_fallback();
  test_invalid_requests_never_reach_backend();
  test_missing_operation_has_no_fallback();
  test_focus_and_minimize_use_their_exact_operations();
  test_backend_cannot_retarget_result();
  puts("window actions fixture: ok");
  return 0;
}
