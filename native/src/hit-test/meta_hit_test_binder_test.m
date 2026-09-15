#include "meta_hit_test_binder.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  MetaApplicationRecord application;
  MetaWindowRecord window;
  MetaDisplayRecord display;
  MetaInventorySnapshot snapshot;
  CFTypeRef geometry;
  bool fence_valid;
  bool topology_valid;
  MetaHitTestWindowRelation window_relation;
  bool revoke_fence_in_window_probe;
  bool enable_secure_input_in_topology_probe;
  bool secure_input_on;
  size_t snapshot_calls;
  size_t geometry_calls;
  size_t fence_calls;
  size_t window_calls;
  size_t topology_calls;
  size_t session_calls;
} Fixture;

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *display_ref(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"displayRef" : @"display-1",
    @"displayLayoutRevision" : @1,
  };
}

static NSDictionary *window_target(void) {
  return @{
    @"kind" : @"window",
    @"ref" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"applicationRef" : @"application-1",
      @"windowRef" : @"window-1",
    },
  };
}

static NSDictionary *display_target(void) {
  return @{@"kind" : @"display", @"ref" : display_ref()};
}

static NSDictionary *layout_target(void) {
  return @{
    @"kind" : @"desktop-layout",
    @"ref" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"layoutRef" : @"layout-1",
      @"displayLayoutRevision" : @1,
    },
  };
}

static NSDictionary *geometry(NSDictionary *capture_target,
                              bool include_window,
                              NSString *expiry) {
  NSMutableDictionary *value = [@{
    @"frameRef" : @"frame-1",
    @"observationId" : @"observation-1",
    @"source" : include_window ? @"window-isolated" : @"display-composite",
    @"captureTarget" : capture_target,
    @"capturedAt" : @"2020-09-15T09:00:00.000Z",
    @"expiresAt" : expiry,
    @"inventoryId" : @"inventory-capture-1",
    @"inventoryRevision" : @1,
    @"displayLayoutRevision" : @1,
    @"imageSize" : @{@"widthPx" : @100, @"heightPx" : @100},
    @"clip" : @{@"kind" : @"full-target"},
    @"regions" : @[
      @{
        @"regionIndex" : @0,
        @"imageRect" : @{@"x" : @0, @"y" : @0, @"width" : @100, @"height" : @100},
        @"destinationRect" : @{@"x" : @0, @"y" : @0, @"width" : @100, @"height" : @100},
        @"imageToDestination" : @{
          @"a" : @1, @"b" : @0, @"c" : @0,
          @"d" : @1, @"tx" : @0, @"ty" : @0,
        },
        @"frameTimestamp" : @"2020-09-15T09:00:00.000Z",
        @"macosDisplayRef" : display_ref(),
        @"nativeDisplayId" : @1,
      },
    ],
  } mutableCopy];
  if (include_window) {
    value[@"capturedWindow"] = @{
      @"windowRef" : window_target()[@"ref"],
      @"cgWindowId" : @77,
      @"ownerPid" : @42,
      @"logicalFrame" : @{
        @"x" : @0, @"y" : @0, @"width" : @100, @"height" : @100,
      },
    };
  }
  return value;
}

static NSDictionary *request(NSDictionary *target) {
  NSDictionary *observation = @{
    @"observationId" : @"observation-1",
    @"inventoryRevision" : @1,
    @"displayLayoutRevision" : @1,
    @"proofRef" : @"proof-1",
  };
  NSDictionary *operation = @{
    @"kind" : @"native",
    @"operationId" : @"operation-1",
    @"clientRequestId" : @"client-request-1",
    @"clientSessionId" : @"client-1",
    @"principalId" : @"principal-1",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"deadlineAt" : @"2099-09-15T10:00:00.000Z",
    @"inventoryId" : @"inventory-current-2",
    @"inventoryRevision" : @2,
    @"observationRef" : observation,
    @"fence" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"counter" : @1,
    },
    @"target" : target,
  };
  return @{
    @"kind" : @"request",
    @"protocolVersion" : @"1",
    @"requestId" : @"hit-request-1",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"deadlineAt" : @"2099-09-15T10:00:00.000Z",
    @"intent" : @"read",
    @"method" : @"input.hit-test",
    @"operation" : operation,
    @"payload" : @{
      @"observationRef" : observation,
      @"frameRef" : @"frame-1",
      @"imagePoint" : @{@"x" : @10, @"y" : @20},
      @"interactionTarget" : target,
      @"expectedRegionIndex" : @0,
      @"expectedDestinationPoint" : @{@"x" : @10, @"y" : @20},
    },
  };
}

static void set_geometry(Fixture *fixture, NSDictionary *value) {
  if (fixture->geometry != NULL) CFRelease(fixture->geometry);
  fixture->geometry = CFBridgingRetain(value);
}

static void prepare_fixture(Fixture *fixture, NSDictionary *capture_target,
                            bool include_window) {
  memset(fixture, 0, sizeof(*fixture));
  fixture->application = (MetaApplicationRecord){
      .pid = 42,
      .launch_time_micros = 100,
      .ax_status = META_AX_READY,
  };
  snprintf(fixture->application.application_ref,
           sizeof(fixture->application.application_ref), "%s",
           "application-1");
  fixture->window = (MetaWindowRecord){
      .pid = 42,
      .cg_window_id = 77,
      .surface_kind = META_SURFACE_WINDOW,
      .frame = {.x = 0, .y = 0, .width = 100, .height = 100},
  };
  snprintf(fixture->window.target_ref, sizeof(fixture->window.target_ref), "%s",
           "window-1");
  snprintf(fixture->window.window_ref, sizeof(fixture->window.window_ref), "%s",
           "window-1");
  snprintf(fixture->window.application_ref,
           sizeof(fixture->window.application_ref), "%s", "application-1");
  fixture->display = (MetaDisplayRecord){
      .display_id = 1,
      .bounds = {.x = 0, .y = 0, .width = 1920, .height = 1080},
      .usable_bounds = {.x = 0, .y = 23, .width = 1920, .height = 1057},
      .scale = 1,
      .main = true,
  };
  snprintf(fixture->display.display_ref, sizeof(fixture->display.display_ref),
           "%s", "display-1");
  fixture->snapshot = (MetaInventorySnapshot){
      .revision = 2,
      .display_layout_revision = 1,
      .captured_at_micros = 1,
      .complete = true,
      .applications = &fixture->application,
      .application_count = 1,
      .windows = &fixture->window,
      .window_count = 1,
      .displays = &fixture->display,
      .display_count = 1,
  };
  snprintf(fixture->snapshot.inventory_id,
           sizeof(fixture->snapshot.inventory_id), "%s", "inventory-current-2");
  snprintf(fixture->snapshot.native_generation,
           sizeof(fixture->snapshot.native_generation), "%s", "native-1");
  snprintf(fixture->snapshot.layout_ref, sizeof(fixture->snapshot.layout_ref),
           "%s", "layout-1");
  set_geometry(fixture, geometry(capture_target, include_window,
                                 @"2099-09-15T10:00:00.000Z"));
  fixture->fence_valid = true;
  fixture->topology_valid = true;
  fixture->window_relation = MetaHitTestWindowRelationExact;
}

static void release_fixture(Fixture *fixture) {
  if (fixture->geometry != NULL) CFRelease(fixture->geometry);
  fixture->geometry = NULL;
}

static MetaHitTestCommandBinder *binder(Fixture *fixture) {
  return [[MetaHitTestCommandBinder alloc]
      initWithGeneration:generation()
         snapshotProvider:^const MetaInventorySnapshot * {
           fixture->snapshot_calls += 1;
           return &fixture->snapshot;
         }
       frameGeometryLookup:^NSDictionary *(NSString *frameRef) {
         fixture->geometry_calls += 1;
         return [frameRef isEqual:@"frame-1"]
                    ? (__bridge NSDictionary *)fixture->geometry
                    : nil;
       }
     pendingFenceValidator:^BOOL(NSDictionary *operation) {
       fixture->fence_calls += 1;
       assert([operation[@"operationId"] isEqual:@"operation-1"]);
       return fixture->fence_valid;
     }
              windowProbe:^MetaHitTestWindowRelation(
                  NSDictionary *target, NSDictionary *point,
                  const MetaInventorySnapshot *snapshot) {
                fixture->window_calls += 1;
                assert([target isEqual:request(target)[@"operation"][@"target"]]);
                assert(([point isEqual:@{@"x" : @10, @"y" : @20}]));
                assert(snapshot == &fixture->snapshot);
                if (fixture->revoke_fence_in_window_probe) {
                  fixture->fence_valid = false;
                }
                return fixture->window_relation;
              }
            topologyProbe:^BOOL(const MetaInventorySnapshot *snapshot) {
              fixture->topology_calls += 1;
              assert(snapshot == &fixture->snapshot);
              if (fixture->enable_secure_input_in_topology_probe) {
                fixture->secure_input_on = true;
              }
              return fixture->topology_valid;
            }
  sessionReadinessProvider:^NSDictionary * {
    fixture->session_calls += 1;
    return @{
      @"state" : @"active-console",
      @"lockState" : @"unknown",
      @"secureInput" : fixture->secure_input_on ? @"on" : @"off",
    };
  }];
}

static void test_exact_window_owner(void) {
  Fixture fixture;
  prepare_fixture(&fixture, window_target(), true);
  NSDictionary *input = request(window_target());
  assert([input[@"operation"][@"inventoryRevision"] isEqual:@2]);
  assert([input[@"payload"][@"observationRef"][@"inventoryRevision"]
      isEqual:@1]);
  NSDictionary *result = [binder(&fixture) handleRequest:input];
  assert([result[@"status"] isEqual:@"confirmed"]);
  assert([result[@"scope"] isEqual:@"window"]);
  assert([result[@"hitRelation"] isEqual:@"exact"]);
  assert([result[@"focusRelation"] isEqual:@"target"]);
  assert([result[@"frameUnchanged"] isEqual:@YES]);
  assert([result[@"topologyUnchanged"] isEqual:@YES]);
  assert([result[@"hitOwnerTarget"] isEqual:window_target()]);
  assert([result[@"focusedTarget"] isEqual:window_target()]);
  assert(fixture.window_calls == 1);
  assert(fixture.topology_calls == 0);
  release_fixture(&fixture);
}

static void test_explicit_display_and_layout_never_call_window_probe(void) {
  Fixture display_fixture;
  prepare_fixture(&display_fixture, display_target(), false);
  NSDictionary *display_result =
      [binder(&display_fixture) handleRequest:request(display_target())];
  assert([display_result[@"status"] isEqual:@"confirmed"]);
  assert([display_result[@"scope"] isEqual:@"display"]);
  assert([display_result[@"hitRelation"] isEqual:@"display-contained"]);
  assert([display_result[@"focusRelation"]
      isEqual:@"not-required-display-focus"]);
  assert(display_result[@"focusedTarget"] == nil);
  assert(display_result[@"frameUnchanged"] == nil);
  assert(display_fixture.window_calls == 0);
  assert(display_fixture.topology_calls == 1);
  release_fixture(&display_fixture);

  Fixture layout_fixture;
  prepare_fixture(&layout_fixture, display_target(), false);
  NSDictionary *layout_result =
      [binder(&layout_fixture) handleRequest:request(layout_target())];
  assert([layout_result[@"status"] isEqual:@"confirmed"]);
  assert([layout_result[@"scope"] isEqual:@"display"]);
  assert(layout_fixture.window_calls == 0);
  assert(layout_fixture.topology_calls == 1);
  release_fixture(&layout_fixture);
}

static void test_stale_frame_and_pending_fence_stop_early(void) {
  Fixture stale;
  prepare_fixture(&stale, window_target(), true);
  set_geometry(&stale, geometry(window_target(), true,
                                @"2020-01-01T00:00:00.000Z"));
  NSDictionary *result = [binder(&stale) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"observation-stale"]);
  assert(stale.window_calls == 0);
  release_fixture(&stale);

  Fixture cancelled;
  prepare_fixture(&cancelled, window_target(), true);
  cancelled.fence_valid = false;
  result = [binder(&cancelled) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"cancelled"]);
  assert(cancelled.snapshot_calls == 0);
  assert(cancelled.geometry_calls == 0);
  assert(cancelled.window_calls == 0);
  release_fixture(&cancelled);
}

static void test_moved_window_and_topology_change_fail(void) {
  Fixture moved;
  prepare_fixture(&moved, window_target(), true);
  NSMutableDictionary *changed =
      [(__bridge NSDictionary *)moved.geometry mutableCopy];
  NSMutableDictionary *captured = [changed[@"capturedWindow"] mutableCopy];
  captured[@"logicalFrame"] = @{
    @"x" : @1, @"y" : @0, @"width" : @100, @"height" : @100,
  };
  changed[@"capturedWindow"] = captured;
  set_geometry(&moved, changed);
  NSDictionary *result = [binder(&moved) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"target-mismatch"]);
  assert(moved.window_calls == 0);
  release_fixture(&moved);

  Fixture topology;
  prepare_fixture(&topology, display_target(), false);
  topology.topology_valid = false;
  result = [binder(&topology) handleRequest:request(display_target())];
  assert([result[@"status"] isEqual:@"inventory-stale"]);
  assert(topology.window_calls == 0);
  assert(topology.topology_calls == 1);
  release_fixture(&topology);

  Fixture reconnected;
  prepare_fixture(&reconnected, display_target(), false);
  reconnected.snapshot.display_layout_revision = 2;
  result = [binder(&reconnected) handleRequest:request(display_target())];
  assert([result[@"status"] isEqual:@"observation-stale"]);
  assert(reconnected.window_calls == 0);
  assert(reconnected.topology_calls == 0);
  release_fixture(&reconnected);
}

static void test_generation_cross_and_point_mismatch_fail(void) {
  Fixture generation_fixture;
  prepare_fixture(&generation_fixture, window_target(), true);
  NSMutableDictionary *foreign = [request(window_target()) mutableCopy];
  foreign[@"nativeGeneration"] = @"native-foreign";
  NSDictionary *result = [binder(&generation_fixture) handleRequest:foreign];
  assert([result[@"status"] isEqual:@"target-mismatch"]);
  assert(generation_fixture.fence_calls == 0);
  release_fixture(&generation_fixture);

  Fixture point_fixture;
  prepare_fixture(&point_fixture, window_target(), true);
  NSMutableDictionary *point_request = [request(window_target()) mutableCopy];
  NSMutableDictionary *payload = [point_request[@"payload"] mutableCopy];
  payload[@"expectedDestinationPoint"] = @{@"x" : @11, @"y" : @20};
  point_request[@"payload"] = payload;
  result = [binder(&point_fixture) handleRequest:point_request];
  assert([result[@"status"] isEqual:@"observation-stale"]);
  assert(point_fixture.window_calls == 0);
  release_fixture(&point_fixture);
}

static void test_window_failure_never_widens_to_display(void) {
  Fixture mismatch;
  prepare_fixture(&mismatch, window_target(), true);
  mismatch.window_relation = MetaHitTestWindowRelationNone;
  NSDictionary *result = [binder(&mismatch) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"focus-mismatch"]);
  assert(mismatch.window_calls == 1);
  assert(mismatch.topology_calls == 0);
  release_fixture(&mismatch);

  Fixture unavailable;
  prepare_fixture(&unavailable, window_target(), true);
  unavailable.window_relation = MetaHitTestWindowRelationUnavailable;
  result = [binder(&unavailable) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"ax-unavailable"]);
  assert(unavailable.topology_calls == 0);
  release_fixture(&unavailable);

  Fixture malformed;
  prepare_fixture(&malformed, window_target(), true);
  malformed.window_relation = (MetaHitTestWindowRelation)99;
  result = [binder(&malformed) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"ax-unavailable"]);
  assert(malformed.topology_calls == 0);
  release_fixture(&malformed);

  Fixture isolated;
  prepare_fixture(&isolated, window_target(), true);
  NSDictionary *result_isolated =
      [binder(&isolated) handleRequest:request(display_target())];
  assert([result_isolated[@"status"] isEqual:@"target-mismatch"]);
  assert(isolated.window_calls == 0);
  assert(isolated.topology_calls == 0);
  release_fixture(&isolated);
}

static void test_post_probe_fence_and_session_revocation_emit_no_source(void) {
  Fixture window;
  prepare_fixture(&window, window_target(), true);
  window.revoke_fence_in_window_probe = true;
  NSDictionary *result = [binder(&window) handleRequest:request(window_target())];
  assert([result[@"status"] isEqual:@"cancelled"]);
  assert(result[@"sourceResponseRef"] == nil);
  assert(window.window_calls == 1);
  assert(window.fence_calls == 2);
  assert(window.session_calls == 2);
  release_fixture(&window);

  Fixture display;
  prepare_fixture(&display, display_target(), false);
  display.enable_secure_input_in_topology_probe = true;
  result = [binder(&display) handleRequest:request(display_target())];
  assert([result[@"status"] isEqual:@"cancelled"]);
  assert(result[@"sourceResponseRef"] == nil);
  assert(display.window_calls == 0);
  assert(display.topology_calls == 1);
  assert(display.fence_calls == 2);
  assert(display.session_calls == 2);
  release_fixture(&display);
}

int main(void) {
  @autoreleasepool {
    test_exact_window_owner();
    test_explicit_display_and_layout_never_call_window_probe();
    test_stale_frame_and_pending_fence_stop_early();
    test_moved_window_and_topology_change_fail();
    test_generation_cross_and_point_mismatch_fail();
    test_window_failure_never_widens_to_display();
    test_post_probe_fence_and_session_revocation_emit_no_source();
    puts("hit test binder fixture: ok");
  }
  return 0;
}
