#include "meta_window_result.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  MetaApplicationRecord application;
  MetaWindowRecord windows[3];
  MetaDisplayRecord display;
  MetaInventorySnapshot snapshot;
  MetaWindowRecord original;
} Fixture;

static void prepare_fixture(Fixture *result) {
  memset(result, 0, sizeof(*result));
  result->application.pid = 42;
  result->application.launch_time_micros = 100;
  result->application.ax_status = META_AX_READY;
  result->application.hidden = META_FALSE;
  snprintf(result->application.application_ref,
           sizeof(result->application.application_ref), "%s",
           "native-1:application:1");
  snprintf(result->application.registration_nonce,
           sizeof(result->application.registration_nonce), "%s", "nonce-1");
  snprintf(result->application.name, sizeof(result->application.name), "%s",
           "Fixture");

  MetaWindowRecord window = {
      .pid = 42,
      .surface_kind = META_SURFACE_WINDOW,
      .frame = {.x = 10, .y = 20, .width = 640, .height = 480},
      .application_hidden = META_FALSE,
      .minimized = META_FALSE,
      .on_screen = META_TRUE,
      .space_visibility = META_SPACE_CURRENT,
      .fullscreen = META_FALSE,
      .focused = META_FALSE,
      .main = META_FALSE,
      .mapping = META_MAPPING_UNAVAILABLE,
      .actionability = META_ACTIONABILITY_AX,
      .can_raise = true,
      .can_close = true,
  };
  snprintf(window.window_ref, sizeof(window.window_ref), "%s",
           "native-1:window:1");
  snprintf(window.target_ref, sizeof(window.target_ref), "%s",
           window.window_ref);
  snprintf(window.application_ref, sizeof(window.application_ref), "%s",
           result->application.application_ref);
  snprintf(window.title, sizeof(window.title), "%s", "Document");
  snprintf(window.role, sizeof(window.role), "%s", "AXWindow");
  result->windows[0] = window;
  result->original = window;

  MetaWindowRecord owned_sheet = {
      .pid = 42,
      .surface_kind = META_SURFACE_SHEET,
      .frame = {.x = 30, .y = 40, .width = 300, .height = 180},
      .focused = META_TRUE,
      .actionability = META_ACTIONABILITY_AX,
      .can_close = true,
  };
  snprintf(owned_sheet.surface_ref, sizeof(owned_sheet.surface_ref), "%s",
           "native-1:surface:2");
  snprintf(owned_sheet.target_ref, sizeof(owned_sheet.target_ref), "%s",
           owned_sheet.surface_ref);
  snprintf(owned_sheet.owner_window_ref,
           sizeof(owned_sheet.owner_window_ref), "%s", window.window_ref);
  snprintf(owned_sheet.application_ref, sizeof(owned_sheet.application_ref),
           "%s", result->application.application_ref);
  snprintf(owned_sheet.title, sizeof(owned_sheet.title), "%s", "Save?");
  snprintf(owned_sheet.role, sizeof(owned_sheet.role), "%s", "AXSheet");
  result->windows[1] = owned_sheet;

  result->display = (MetaDisplayRecord){
      .display_id = 1,
      .bounds = {.x = 0, .y = 0, .width = 1920, .height = 1080},
      .usable_bounds = {.x = 0, .y = 23, .width = 1920, .height = 1057},
      .scale = 1,
      .main = true,
  };
  snprintf(result->display.display_ref, sizeof(result->display.display_ref),
           "%s", "native-1:display:1");
  result->snapshot = (MetaInventorySnapshot){
      .revision = 4,
      .display_layout_revision = 2,
      .captured_at_micros = 1700000000000000ULL,
      .complete = true,
      .applications = &result->application,
      .application_count = 1,
      .windows = result->windows,
      .window_count = 1,
      .displays = &result->display,
      .display_count = 1,
  };
  snprintf(result->snapshot.inventory_id,
           sizeof(result->snapshot.inventory_id), "%s", "inventory:4");
  snprintf(result->snapshot.layout_ref, sizeof(result->snapshot.layout_ref),
           "%s", "layout:2");
  snprintf(result->snapshot.native_generation,
           sizeof(result->snapshot.native_generation), "%s", "native-1");
}

static NSDictionary *status(void) {
  NSDictionary *fence = @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"counter" : @1,
  };
  NSDictionary *observer = @{
    @"state" : @"ready",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"coverageStartCursor" : @"observer:start:1",
    @"cursor" : @"observer:1",
    @"nextSequence" : @2,
    @"startedAt" : @"2026-09-15T10:00:00.000Z",
    @"coveredFrom" : @"2026-09-15T10:00:00.000Z",
    @"coveredThrough" : @"2026-09-15T10:00:01.000Z",
    @"heartbeatAt" : @"2026-09-15T10:00:01.000Z",
    @"coveredKinds" : @[@"window-structure"],
    @"droppedEvents" : @0,
    @"gapDetected" : @NO,
  };
  return @{
    @"requestId" : @"request:1",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"highWaterFence" : fence,
    @"acceptedFence" : fence,
    @"operationId" : @"operation:1",
    @"execution" : @"finished",
    @"dispatch" : @"finished",
    @"cleanup" : @"complete",
    @"targetVerified" : @"verified",
    @"cancellationRequested" : @NO,
    @"userInterference" : @"none-observed",
    @"restorationAllowed" : @NO,
    @"quarantined" : @NO,
    @"heldCount" : @0,
    @"lastCheckpoint" : @"window-readback",
    @"dispatchAttempts" : @1,
    @"ledgerRevision" : @0,
    @"observer" : observer,
  };
}

static MetaWindowTransition transition(const Fixture *fixture,
                                       MetaWindowPresence presence,
                                       MetaTransitionStatus state) {
  MetaWindowTransition result = {
      .status = state,
      .presence = presence,
      .application_hidden = META_UNKNOWN,
      .minimized = META_UNKNOWN,
      .focused = META_UNKNOWN,
  };
  snprintf(result.window_ref, sizeof(result.window_ref), "%s",
           fixture->original.window_ref);
  return result;
}

static void test_existing_state_uses_fresh_snapshot(void) {
  Fixture value;
  prepare_fixture(&value);
  value.windows[0].focused = META_TRUE;
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_EXISTING, META_TRANSITION_SUCCEEDED);
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:1");
  assert(result != nil);
  assert([result[@"actual"][@"kind"] isEqual:@"ax-window"]);
  assert([result[@"actual"][@"focused"] isEqual:@"true"]);
  assert([result[@"changed"] isEqual:@YES]);
  assert([result[@"partial"] isEqual:@NO]);
  assert([result[@"displays"] count] == 1);
  assert([result[@"inventoryRevision"] isEqual:@4]);
}

static void test_confirmed_close_has_no_fake_window(void) {
  Fixture value;
  prepare_fixture(&value);
  value.snapshot.window_count = 0;
  value.application.ax_status = META_AX_NO_WINDOWS;
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_CLOSED, META_TRANSITION_SUCCEEDED);
  input.close_attempted = true;
  input.close_succeeded = true;
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:2");
  assert(result != nil);
  assert([result[@"actual"][@"kind"] isEqual:@"closed"]);
  assert([result[@"actual"][@"absence"] isEqual:@"confirmed"]);
  assert([result[@"changed"] isEqual:@YES]);
  assert([result[@"partial"] isEqual:@NO]);
  assert(result[@"newSurface"] == nil);
}

static void test_partial_unrelated_inventory_keeps_owner_close_proof(void) {
  Fixture value;
  prepare_fixture(&value);
  value.snapshot.complete = false;
  value.snapshot.window_count = 0;
  value.application.ax_status = META_AX_NO_WINDOWS;
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_CLOSED, META_TRANSITION_SUCCEEDED);
  input.close_attempted = true;
  input.close_succeeded = true;
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:partial");
  assert(result != nil);
  assert([result[@"actual"][@"kind"] isEqual:@"closed"]);
  assert([result[@"partial"] isEqual:@NO]);

  value.application.ax_status = META_AX_DENIED;
  assert(meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(),
      @"response:owner-partial") == nil);
}

static void test_unknown_is_partial_with_reason(void) {
  Fixture value;
  prepare_fixture(&value);
  value.snapshot.complete = false;
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_UNKNOWN, META_TRANSITION_PARTIAL);
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:3");
  assert(result != nil);
  assert([result[@"actual"][@"kind"] isEqual:@"unknown"]);
  assert([result[@"partial"] isEqual:@YES]);
  assert([result[@"errors"] count] == 1);
  assert([result[@"actual"][@"reason"] isEqual:result[@"errors"][0]]);
  NSString *reason = result[@"errors"][0];
  assert([reason containsString:@"focusAttempted=false"]);
  assert([reason containsString:@"focusSucceeded=false"]);
  assert([reason containsString:@"raiseAttempted=false"]);
  assert([reason containsString:@"raiseSucceeded=false"]);
  assert([reason containsString:@"axError=0"]);
  assert([reason containsString:@"hidden=unknown"]);
  assert([reason containsString:@"minimized=unknown"]);
  assert([reason containsString:@"focused=unknown"]);
}

static void test_exact_owned_sheet_is_new_surface(void) {
  Fixture value;
  prepare_fixture(&value);
  value.snapshot.window_count = 2;
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_EXISTING, META_TRANSITION_PARTIAL);
  input.close_attempted = true;
  input.modal_or_sheet_observed = true;
  snprintf(input.new_surface_ref, sizeof(input.new_surface_ref), "%s",
           value.windows[1].surface_ref);
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:4");
  assert(result != nil);
  assert([result[@"actual"][@"kind"] isEqual:@"ax-window"]);
  assert([result[@"newSurface"][@"surfaceRef"]
      isEqual:@"native-1:surface:2"]);
  assert([result[@"newSurface"][@"ownerWindowRef"]
      isEqual:@"native-1:window:1"]);
  assert([result[@"changed"] isEqual:@YES]);
  assert([result[@"partial"] isEqual:@YES]);
}

static void test_attempt_flag_alone_does_not_claim_change(void) {
  Fixture value;
  prepare_fixture(&value);
  MetaWindowTransition input = transition(
      &value, META_WINDOW_PRESENCE_EXISTING, META_TRANSITION_PARTIAL);
  input.close_attempted = true;
  NSDictionary *result = meta_window_transition_value(
      &value.snapshot, &value.original, &input, status(), @"response:7");
  assert(result != nil);
  assert([result[@"changed"] isEqual:@NO]);
  assert([result[@"partial"] isEqual:@YES]);
  assert([result[@"errors"] count] == 1);
}

static void test_inconsistent_closed_and_foreign_surface_fail_closed(void) {
  Fixture value;
  prepare_fixture(&value);
  MetaWindowTransition closed = transition(
      &value, META_WINDOW_PRESENCE_CLOSED, META_TRANSITION_SUCCEEDED);
  closed.close_succeeded = true;
  assert(meta_window_transition_value(&value.snapshot, &value.original, &closed,
                                      status(), @"response:5") == nil);

  value.snapshot.window_count = 2;
  MetaWindowTransition foreign = transition(
      &value, META_WINDOW_PRESENCE_EXISTING, META_TRANSITION_PARTIAL);
  foreign.modal_or_sheet_observed = true;
  snprintf(foreign.new_surface_ref, sizeof(foreign.new_surface_ref), "%s",
           "native-1:surface:foreign");
  assert(meta_window_transition_value(&value.snapshot, &value.original,
                                      &foreign, status(), @"response:6") ==
         nil);
}

int main(void) {
  @autoreleasepool {
    test_existing_state_uses_fresh_snapshot();
    test_confirmed_close_has_no_fake_window();
    test_partial_unrelated_inventory_keeps_owner_close_proof();
    test_unknown_is_partial_with_reason();
    test_exact_owned_sheet_is_new_surface();
    test_attempt_flag_alone_does_not_claim_change();
    test_inconsistent_closed_and_foreign_surface_fail_closed();
    puts("window result fixture: ok");
  }
  return 0;
}
