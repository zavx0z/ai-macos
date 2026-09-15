#include "meta_inventory_priority.h"
#include "meta_native.h"

#include <assert.h>
#include <stdio.h>

static void test_foreground_then_selected_then_rest(void) {
  MetaInventoryPriorityCandidate candidates[] = {
      {.pid = 1, .launch_time_micros = 10, .name = "Other"},
      {.pid = 2, .launch_time_micros = 20, .name = "Front", .foreground = true},
      {.pid = 3, .launch_time_micros = 30, .name = "Selected"},
      {.pid = 4, .launch_time_micros = 40, .name = "Other"},
  };
  MetaInventoryPriority priority = {
      .has_pid = true,
      .pid = 3,
      .has_launch_time = true,
      .launch_time_micros = 30,
      .name = "Selected",
  };
  size_t indices[4] = {0};
  assert(meta_inventory_priority_order(candidates, 4, &priority, indices, 4));
  assert(indices[0] == 1 && indices[1] == 2 && indices[2] == 0 &&
         indices[3] == 3);
  priority.launch_time_micros = 31;
  assert(meta_inventory_priority_order(candidates, 4, &priority, indices, 4));
  assert(indices[0] == 1 && indices[1] == 0 && indices[2] == 2 &&
         indices[3] == 3);
  assert(meta_inventory_priority_order(candidates, 4, NULL, indices, 4));
  assert(indices[0] == 1 && indices[1] == 0 && indices[2] == 2 &&
         indices[3] == 3);
}

static void test_selected_background_precedes_slow_rest(void) {
  MetaInventoryPriorityCandidate candidates[96] = {0};
  candidates[0] = (MetaInventoryPriorityCandidate){
      .pid = 1, .launch_time_micros = 10, .name = "Front", .foreground = true};
  for (size_t index = 1; index < 96; index += 1) {
    candidates[index] = (MetaInventoryPriorityCandidate){
        .pid = (int32_t)(index + 1),
        .launch_time_micros = 100 + index,
        .name = "Slow"};
  }
  candidates[95].name = "Selected";
  MetaInventoryPriority priority = {.name = "Selected"};
  size_t indices[96] = {0};
  assert(meta_inventory_priority_order(candidates, 96, &priority, indices, 96));
  assert(indices[0] == 0 && indices[1] == 95);
  const size_t fake_budget = 2;
  bool selected_collected = false;
  for (size_t index = 0; index < fake_budget; index += 1) {
    selected_collected = selected_collected || indices[index] == 95;
  }
  assert(selected_collected);
  assert(fake_budget < 96);

  MetaRegistry *registry = meta_registry_create("native-priority");
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = candidates[95].pid,
      .launch_time_micros = candidates[95].launch_time_micros,
      .name = candidates[95].name,
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput window = {
      .pid = candidates[95].pid,
      .launch_time_micros = candidates[95].launch_time_micros,
      .ax_token = 1,
      .title = "Selected Window",
      .role = "AXWindow",
      .surface_kind = META_SURFACE_WINDOW,
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = &window,
      .ax_window_count = 1,
      .source_complete = false,
      .display_topology_epoch = 1,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(!snapshot->complete);
  assert(snapshot->application_count == 1);
  assert(snapshot->window_count == 1);
  assert(snapshot->applications[0].pid == candidates[95].pid);
  assert(snapshot->windows[0].pid == candidates[95].pid);
  meta_registry_destroy(registry);
}

int main(void) {
  test_foreground_then_selected_then_rest();
  test_selected_background_precedes_slow_rest();
  puts("inventory priority tests passed");
  return 0;
}
