#include "meta_native.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  size_t calls;
  size_t fail_on_call;
} FailingAllocator;

static bool should_fail(FailingAllocator *allocator) {
  allocator->calls += 1;
  return allocator->fail_on_call != 0 &&
         allocator->calls == allocator->fail_on_call;
}

static void *failing_allocate_zeroed(void *context, size_t count, size_t size) {
  FailingAllocator *allocator = context;
  if (should_fail(allocator)) return NULL;
  return calloc(count, size);
}

static void *failing_resize(void *context, void *pointer, size_t size) {
  FailingAllocator *allocator = context;
  if (should_fail(allocator)) return NULL;
  return realloc(pointer, size);
}

static void failing_release(void *context, void *pointer) {
  (void)context;
  free(pointer);
}

static void test_stable_refs_and_reincarnation(void) {
  MetaRegistry *registry = meta_registry_create("native-a");
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = 42,
      .launch_time_micros = 100,
      .name = "Редактор",
      .bundle_id = "dev.meta.editor",
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput ax_window = {
      .pid = 42,
      .launch_time_micros = 100,
      .ax_token = 7,
      .title = "Документ",
      .role = "AXWindow",
      .frame = {.x = 10, .y = 20, .width = 800, .height = 600},
      .surface_kind = META_SURFACE_WINDOW,
      .minimized = META_FALSE,
      .fullscreen = META_FALSE,
      .focused = META_TRUE,
      .main = META_TRUE,
      .can_raise = true,
  };
  MetaCGWindowInput cg_window = {
      .window_id = 900,
      .pid = 42,
      .title = "Документ",
      .frame = {.x = 10, .y = 20, .width = 800, .height = 600},
      .on_screen = META_TRUE,
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = &ax_window,
      .ax_window_count = 1,
      .cg_windows = &cg_window,
      .cg_window_count = 1,
      .source_complete = true,
      .captured_at_micros = 1,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(snapshot->complete);
  assert(snapshot->window_count == 1);
  assert(snapshot->windows[0].mapping == META_MAPPING_CORROBORATED);
  assert(snapshot->windows[0].cg_window_id == 900);
  char first_window_ref[META_NATIVE_REF_CAPACITY];
  char first_application_ref[META_NATIVE_REF_CAPACITY];
  snprintf(first_window_ref, sizeof(first_window_ref), "%s",
           snapshot->windows[0].window_ref);
  snprintf(first_application_ref, sizeof(first_application_ref), "%s",
           snapshot->applications[0].application_ref);

  input.captured_at_micros = 2;
  assert(meta_registry_refresh(registry, &input));
  snapshot = meta_registry_snapshot(registry);
  assert(strcmp(first_window_ref, snapshot->windows[0].window_ref) == 0);
  assert(strcmp(first_application_ref,
                snapshot->applications[0].application_ref) == 0);

  input.ax_windows = NULL;
  input.ax_window_count = 0;
  input.cg_windows = NULL;
  input.cg_window_count = 0;
  application.ax_status = META_AX_NO_WINDOWS;
  assert(meta_registry_refresh(registry, &input));
  assert(meta_registry_resolve_window(registry, first_window_ref) == NULL);

  input.ax_windows = &ax_window;
  input.ax_window_count = 1;
  input.cg_windows = &cg_window;
  input.cg_window_count = 1;
  application.ax_status = META_AX_READY;
  assert(meta_registry_refresh(registry, &input));
  snapshot = meta_registry_snapshot(registry);
  assert(strcmp(first_window_ref, snapshot->windows[0].window_ref) != 0);

  application.launch_time_micros = 200;
  ax_window.launch_time_micros = 200;
  assert(meta_registry_refresh(registry, &input));
  snapshot = meta_registry_snapshot(registry);
  assert(strcmp(first_application_ref,
                snapshot->applications[0].application_ref) != 0);
  meta_registry_destroy(registry);
}

static void test_ambiguous_mapping_and_incomplete_apps(void) {
  MetaRegistry *registry = meta_registry_create("native-b");
  assert(registry != NULL);
  MetaApplicationInput applications[] = {
      {.pid = 50,
       .launch_time_micros = 1,
       .name = "Одинаковые окна",
       .hidden = META_FALSE,
       .ax_status = META_AX_READY},
      {.pid = 51,
       .launch_time_micros = 1,
       .name = "Без окон",
       .hidden = META_FALSE,
       .ax_status = META_AX_NO_WINDOWS},
      {.pid = 52,
       .launch_time_micros = 1,
       .name = "Медленное приложение",
       .hidden = META_UNKNOWN,
       .ax_status = META_AX_TIMED_OUT},
      {.pid = 53,
       .launch_time_micros = 1,
       .name = "Недоступное приложение",
       .hidden = META_UNKNOWN,
       .ax_status = META_AX_DENIED},
  };
  MetaAXWindowInput ax_windows[] = {
      {.pid = 50,
       .launch_time_micros = 1,
       .ax_token = 100,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 400, .height = 300},
       .surface_kind = META_SURFACE_WINDOW},
      {.pid = 50,
       .launch_time_micros = 1,
       .ax_token = 101,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 400, .height = 300},
       .surface_kind = META_SURFACE_WINDOW},
  };
  MetaCGWindowInput cg_windows[] = {
      {.window_id = 1,
       .pid = 50,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 400, .height = 300},
       .on_screen = META_TRUE},
      {.window_id = 2,
       .pid = 50,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 400, .height = 300},
       .on_screen = META_TRUE},
  };
  MetaInventoryInput input = {
      .applications = applications,
      .application_count = 4,
      .ax_windows = ax_windows,
      .ax_window_count = 2,
      .cg_windows = cg_windows,
      .cg_window_count = 2,
      .source_complete = true,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(!snapshot->complete);
  assert(snapshot->application_count == 4);
  assert(snapshot->applications[1].ax_status == META_AX_NO_WINDOWS);
  assert(snapshot->applications[2].ax_status == META_AX_TIMED_OUT);
  assert(snapshot->applications[3].ax_status == META_AX_DENIED);
  assert(snapshot->window_count == 4);
  assert(snapshot->windows[0].mapping == META_MAPPING_AMBIGUOUS);
  assert(snapshot->windows[1].mapping == META_MAPPING_AMBIGUOUS);
  assert(snapshot->windows[0].cg_window_id == 0);
  assert(snapshot->windows[1].cg_window_id == 0);
  assert(snapshot->windows[2].actionability == META_ACTIONABILITY_UNAVAILABLE);
  assert(snapshot->windows[3].actionability == META_ACTIONABILITY_UNAVAILABLE);
  meta_registry_destroy(registry);
}

static void test_sheet_owner_ax_only_and_displays(void) {
  MetaRegistry *registry = meta_registry_create("native-c");
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = 60,
      .launch_time_micros = 1,
      .name = "Диалог",
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput windows[] = {
      {.pid = 60,
       .launch_time_micros = 1,
       .ax_token = 10,
       .title = "Документ",
       .role = "AXWindow",
       .frame = {.x = -1000, .y = 100, .width = 900, .height = 700},
       .surface_kind = META_SURFACE_WINDOW,
       .can_raise = true},
      {.pid = 60,
       .launch_time_micros = 1,
       .ax_token = 11,
       .owner_ax_token = 10,
       .title = "Сохранить",
       .role = "AXSheet",
       .frame = {.x = -800, .y = 200, .width = 500, .height = 300},
       .surface_kind = META_SURFACE_SHEET,
       .can_close = true},
  };
  MetaDisplayInput displays[] = {
      {.display_id = 100,
       .bounds = {.x = -1920, .y = 0, .width = 1920, .height = 1080},
       .usable_bounds = {.x = -1920, .y = 23, .width = 1920, .height = 1057},
       .scale = 1,
       .rotation_degrees = 0,
       .main = false},
      {.display_id = 101,
       .bounds = {.x = 0, .y = -1200, .width = 1920, .height = 1200},
       .usable_bounds = {.x = 0, .y = -1177, .width = 1920, .height = 1177},
       .scale = 2,
       .rotation_degrees = 90,
       .main = true},
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = windows,
      .ax_window_count = 2,
      .displays = displays,
      .display_count = 2,
      .source_complete = true,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(snapshot->window_count == 2);
  assert(snapshot->windows[0].mapping == META_MAPPING_UNAVAILABLE);
  assert(snapshot->windows[0].actionability == META_ACTIONABILITY_AX);
  assert(strcmp(snapshot->windows[1].owner_window_ref,
                snapshot->windows[0].window_ref) == 0);
  assert(snapshot->display_count == 2);
  assert(snapshot->display_layout_revision == 1);
  assert(snapshot->displays[0].bounds.x == -1920);
  assert(snapshot->displays[1].bounds.y == -1200);
  assert(snapshot->displays[1].scale == 2);
  assert(snapshot->displays[1].rotation_degrees == 90);
  assert(meta_registry_refresh(registry, &input));
  snapshot = meta_registry_snapshot(registry);
  assert(snapshot->display_layout_revision == 1);
  displays[1].rotation_degrees = 0;
  assert(meta_registry_refresh(registry, &input));
  snapshot = meta_registry_snapshot(registry);
  assert(snapshot->display_layout_revision == 2);
  meta_registry_destroy(registry);
}

static void test_many_ax_windows_cannot_claim_one_cg_window(void) {
  MetaRegistry *registry = meta_registry_create("native-d");
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = 70,
      .launch_time_micros = 1,
      .name = "Одинаковые окна",
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput ax_windows[] = {
      {.pid = 70,
       .launch_time_micros = 1,
       .ax_token = 1,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 100, .height = 100}},
      {.pid = 70,
       .launch_time_micros = 1,
       .ax_token = 2,
       .title = "Окно",
       .frame = {.x = 0, .y = 0, .width = 100, .height = 100}},
  };
  MetaCGWindowInput cg_window = {
      .window_id = 42,
      .pid = 70,
      .title = "Окно",
      .frame = {.x = 0, .y = 0, .width = 100, .height = 100},
      .on_screen = META_TRUE,
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = ax_windows,
      .ax_window_count = 2,
      .cg_windows = &cg_window,
      .cg_window_count = 1,
      .source_complete = true,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(snapshot->window_count == 3);
  assert(snapshot->windows[0].mapping == META_MAPPING_AMBIGUOUS);
  assert(snapshot->windows[1].mapping == META_MAPPING_AMBIGUOUS);
  assert(snapshot->windows[0].cg_window_id == 0);
  assert(snapshot->windows[1].cg_window_id == 0);
  assert(snapshot->windows[2].cg_window_id == 42);
  assert(snapshot->windows[2].mapping == META_MAPPING_AMBIGUOUS);
  meta_registry_destroy(registry);
}

static void test_failed_refresh_keeps_previous_snapshot(void) {
  FailingAllocator failing = {0};
  MetaRegistryAllocator allocator = {
      .context = &failing,
      .allocate_zeroed = failing_allocate_zeroed,
      .resize = failing_resize,
      .release = failing_release,
  };
  MetaRegistry *registry =
      meta_registry_create_with_allocator("native-e", allocator);
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = 80,
      .launch_time_micros = 1,
      .name = "Атомарный снимок",
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput ax_window = {
      .pid = 80,
      .launch_time_micros = 1,
      .ax_token = 1,
      .title = "До ошибки",
      .frame = {.x = 1, .y = 2, .width = 300, .height = 200},
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = &ax_window,
      .ax_window_count = 1,
      .source_complete = true,
      .captured_at_micros = 10,
  };
  assert(meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *before = meta_registry_snapshot(registry);
  assert(before->revision == 1);
  char window_ref[META_NATIVE_REF_CAPACITY];
  snprintf(window_ref, sizeof(window_ref), "%s", before->windows[0].window_ref);

  failing.calls = 0;
  failing.fail_on_call = 4;
  ax_window.title = "После ошибки";
  input.captured_at_micros = 20;
  assert(!meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *after = meta_registry_snapshot(registry);
  assert(after->revision == 1);
  assert(after->captured_at_micros == 10);
  assert(strcmp(after->windows[0].title, "До ошибки") == 0);
  assert(meta_registry_resolve_window(registry, window_ref) != NULL);
  meta_registry_destroy(registry);
}

int main(void) {
  char long_generation[66];
  memset(long_generation, 'g', 65);
  long_generation[65] = '\0';
  assert(meta_registry_create(long_generation) == NULL);
  test_stable_refs_and_reincarnation();
  test_ambiguous_mapping_and_incomplete_apps();
  test_sheet_owner_ax_only_and_displays();
  test_many_ax_windows_cannot_claim_one_cg_window();
  test_failed_refresh_keeps_previous_snapshot();
  puts("registry tests passed");
  return 0;
}
