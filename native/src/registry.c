#include "meta_native.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define META_AX_OWNER_AMBIGUOUS_TOKEN UINT64_MAX

MetaAXOwnerBindStatus meta_ax_window_bind_owner(
    MetaAXWindowInput *window,
    uint64_t owner_ax_token) {
  if (window == NULL || window->ax_token == 0) {
    return META_AX_OWNER_CONFLICT;
  }
  if (window->owner_ax_token == META_AX_OWNER_AMBIGUOUS_TOKEN) {
    window->surface_kind = META_SURFACE_SHEET;
    return META_AX_OWNER_CONFLICT;
  }
  if (owner_ax_token == 0) return META_AX_OWNER_UNCHANGED;
  if (owner_ax_token == window->ax_token) {
    window->owner_ax_token = META_AX_OWNER_AMBIGUOUS_TOKEN;
    window->surface_kind = META_SURFACE_SHEET;
    return META_AX_OWNER_CONFLICT;
  }
  if (window->owner_ax_token == 0) {
    window->owner_ax_token = owner_ax_token;
    window->surface_kind = META_SURFACE_SHEET;
    return META_AX_OWNER_BOUND;
  }
  if (window->owner_ax_token == owner_ax_token) {
    window->surface_kind = META_SURFACE_SHEET;
    return META_AX_OWNER_UNCHANGED;
  }
  window->owner_ax_token = META_AX_OWNER_AMBIGUOUS_TOKEN;
  return META_AX_OWNER_CONFLICT;
}

typedef struct {
  int32_t pid;
  uint64_t launch_time_micros;
  uint64_t serial;
} ApplicationIdentity;

typedef struct {
  uint64_t application_serial;
  uint64_t ax_token;
  uint64_t serial;
  uint64_t last_seen_revision;
} WindowIdentity;

struct MetaRegistry {
  MetaRegistryAllocator allocator;
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t revision;
  uint64_t next_application_serial;
  uint64_t next_window_serial;
  ApplicationIdentity *application_identities;
  size_t application_identity_count;
  WindowIdentity *window_identities;
  size_t window_identity_count;
  MetaApplicationRecord *applications;
  size_t application_count;
  MetaWindowRecord *windows;
  size_t window_count;
  MetaDisplayRecord *displays;
  size_t display_count;
  MetaInventorySnapshot snapshot;
};

static void *default_allocate_zeroed(void *context, size_t count,
                                     size_t size) {
  (void)context;
  return calloc(count, size);
}

static void *default_resize(void *context, void *pointer, size_t size) {
  (void)context;
  return realloc(pointer, size);
}

static void default_release(void *context, void *pointer) {
  (void)context;
  free(pointer);
}

static void *allocate_zeroed(MetaRegistry *registry, size_t count,
                             size_t size) {
  return registry->allocator.allocate_zeroed(registry->allocator.context,
                                              count, size);
}

static void *resize_allocation(MetaRegistry *registry, void *pointer,
                               size_t size) {
  return registry->allocator.resize(registry->allocator.context, pointer, size);
}

static void release_allocation(MetaRegistry *registry, void *pointer) {
  if (pointer == NULL) return;
  registry->allocator.release(registry->allocator.context, pointer);
}

static void copy_text(char *target, size_t capacity, const char *source) {
  if (capacity == 0) return;
  if (source == NULL) source = "";
  size_t length = strnlen(source, capacity);
  if (length == capacity) {
    length = capacity - 1;
    // Do not retain a partial UTF-8 character at the byte limit.
    while (length > 0 && ((unsigned char)source[length] & 0xc0) == 0x80)
      length -= 1;
  }
  memmove(target, source, length);
  target[length] = 0;
}

static bool valid_generation_id(const char *value) {
  if (value == NULL || value[0] == '\0') return false;
  const size_t length = strnlen(value, 65);
  return length >= 1 && length <= 64;
}

static bool same_rect(MetaRect left, MetaRect right) {
  const double tolerance = 2.0;
  return fabs(left.x - right.x) <= tolerance &&
         fabs(left.y - right.y) <= tolerance &&
         fabs(left.width - right.width) <= tolerance &&
         fabs(left.height - right.height) <= tolerance;
}

static bool display_layout_changed(const MetaRegistry *registry,
                                   const MetaInventoryInput *input) {
  if (registry->snapshot.display_topology_epoch !=
      input->display_topology_epoch) {
    return true;
  }
  if (registry->display_count != input->display_count) return true;
  for (size_t index = 0; index < input->display_count; index += 1) {
    const MetaDisplayInput *source = &input->displays[index];
    const MetaDisplayRecord *previous = NULL;
    for (size_t old_index = 0; old_index < registry->display_count;
         old_index += 1) {
      if (registry->displays[old_index].display_id == source->display_id) {
        previous = &registry->displays[old_index];
        break;
      }
    }
    if (previous == NULL ||
        previous->bounds.x != source->bounds.x || previous->bounds.y != source->bounds.y ||
        previous->bounds.width != source->bounds.width || previous->bounds.height != source->bounds.height ||
        previous->usable_bounds.x != source->usable_bounds.x || previous->usable_bounds.y != source->usable_bounds.y ||
        previous->usable_bounds.width != source->usable_bounds.width || previous->usable_bounds.height != source->usable_bounds.height ||
        previous->scale != source->scale ||
        previous->rotation_degrees != source->rotation_degrees ||
        previous->main != source->main) {
      return true;
    }
  }
  return false;
}

static ApplicationIdentity *application_identity(
    MetaRegistry *registry, int32_t pid, uint64_t launch_time_micros) {
  for (size_t index = 0; index < registry->application_identity_count;
       index += 1) {
    ApplicationIdentity *identity = &registry->application_identities[index];
    if (identity->pid == pid &&
        identity->launch_time_micros == launch_time_micros) {
      return identity;
    }
  }

  const size_t next_count = registry->application_identity_count + 1;
  ApplicationIdentity *next = resize_allocation(
      registry, registry->application_identities, next_count * sizeof(*next));
  if (next == NULL) return NULL;
  registry->application_identities = next;
  ApplicationIdentity *identity = &next[next_count - 1];
  *identity = (ApplicationIdentity){
      .pid = pid,
      .launch_time_micros = launch_time_micros,
      .serial = registry->next_application_serial++,
  };
  registry->application_identity_count = next_count;
  return identity;
}

static WindowIdentity *window_identity(MetaRegistry *registry,
                                       uint64_t application_serial,
                                       uint64_t ax_token) {
  for (size_t index = 0; index < registry->window_identity_count; index += 1) {
    WindowIdentity *identity = &registry->window_identities[index];
    if (identity->application_serial == application_serial &&
        identity->ax_token == ax_token &&
        identity->last_seen_revision + 1 == registry->revision) {
      identity->last_seen_revision = registry->revision;
      return identity;
    }
  }

  const size_t next_count = registry->window_identity_count + 1;
  WindowIdentity *next = resize_allocation(
      registry, registry->window_identities, next_count * sizeof(*next));
  if (next == NULL) return NULL;
  registry->window_identities = next;
  WindowIdentity *identity = &next[next_count - 1];
  *identity = (WindowIdentity){
      .application_serial = application_serial,
      .ax_token = ax_token,
      .serial = registry->next_window_serial++,
      .last_seen_revision = registry->revision,
  };
  registry->window_identity_count = next_count;
  return identity;
}

static MetaApplicationRecord *find_application_record(
    MetaApplicationRecord *applications, size_t application_count, int32_t pid,
    uint64_t launch_time_micros) {
  for (size_t index = 0; index < application_count; index += 1) {
    MetaApplicationRecord *application = &applications[index];
    if (application->pid == pid &&
        application->launch_time_micros == launch_time_micros) {
      return application;
    }
  }
  return NULL;
}

static uint64_t application_serial_from_ref(const char *application_ref) {
  const char *separator = strrchr(application_ref, ':');
  if (separator == NULL || separator[1] == '\0') return 0;
  return strtoull(separator + 1, NULL, 10);
}

static void retain_uncertain_window_identities(
    MetaRegistry *working,
    const MetaRegistry *previous,
    const MetaInventoryInput *input,
    const MetaApplicationRecord *applications,
    size_t application_count) {
  for (size_t index = 0; index < working->window_identity_count; index += 1) {
    WindowIdentity *identity = &working->window_identities[index];
    if (identity->last_seen_revision != previous->revision) continue;
    const MetaApplicationRecord *application = NULL;
    for (size_t app_index = 0; app_index < application_count; app_index += 1) {
      const MetaApplicationRecord *candidate = &applications[app_index];
      if (application_serial_from_ref(candidate->application_ref) ==
          identity->application_serial) {
        application = candidate;
        break;
      }
    }
    const bool uncertain = application == NULL
        ? !input->source_complete
        : application->ax_status != META_AX_READY &&
          application->ax_status != META_AX_NO_WINDOWS;
    if (uncertain) identity->last_seen_revision = working->revision;
  }
}

static MetaMappingStatus correlate_window(
    const MetaAXWindowInput *window, const MetaCGWindowInput *cg_windows,
    size_t cg_window_count, size_t *matched_index) {
  size_t frame_count = 0;
  size_t title_count = 0;
  size_t frame_index = 0;
  size_t title_index = 0;
  const bool has_title = window->title != NULL && window->title[0] != '\0';

  for (size_t index = 0; index < cg_window_count; index += 1) {
    const MetaCGWindowInput *candidate = &cg_windows[index];
    if (candidate->pid != window->pid ||
        !same_rect(candidate->frame, window->frame)) {
      continue;
    }
    frame_count += 1;
    frame_index = index;
    if (has_title && candidate->title != NULL &&
        strcmp(candidate->title, window->title) == 0) {
      title_count += 1;
      title_index = index;
    }
  }

  if (frame_count == 1) {
    *matched_index = frame_index;
    return META_MAPPING_CORROBORATED;
  }
  if (title_count == 1) {
    *matched_index = title_index;
    return META_MAPPING_CORROBORATED;
  }
  if (frame_count > 1) return META_MAPPING_AMBIGUOUS;
  return META_MAPPING_UNAVAILABLE;
}

static bool exact_sheet_owner(const MetaAXWindowInput *windows,
                              size_t count,
                              const MetaAXWindowInput *sheet) {
  if (sheet->owner_ax_token == 0 ||
      sheet->owner_ax_token == META_AX_OWNER_AMBIGUOUS_TOKEN ||
      sheet->owner_ax_token == sheet->ax_token) {
    return false;
  }
  const MetaAXWindowInput *owner = NULL;
  for (size_t index = 0; index < count; index += 1) {
    const MetaAXWindowInput *candidate = &windows[index];
    if (candidate->pid == sheet->pid &&
        candidate->launch_time_micros == sheet->launch_time_micros &&
        candidate->ax_token == sheet->owner_ax_token &&
        candidate->surface_kind == META_SURFACE_WINDOW) {
      if (owner != NULL) return false;
      owner = candidate;
    }
  }
  return owner != NULL;
}

MetaRegistry *meta_registry_create(const char *native_generation) {
  MetaRegistryAllocator allocator = {
      .allocate_zeroed = default_allocate_zeroed,
      .resize = default_resize,
      .release = default_release,
  };
  return meta_registry_create_with_allocator(native_generation, allocator);
}

MetaRegistry *meta_registry_create_with_allocator(
    const char *native_generation, MetaRegistryAllocator allocator) {
  if (!valid_generation_id(native_generation)) return NULL;
  if (allocator.allocate_zeroed == NULL || allocator.resize == NULL ||
      allocator.release == NULL) {
    return NULL;
  }
  MetaRegistry *registry =
      allocator.allocate_zeroed(allocator.context, 1, sizeof(*registry));
  if (registry == NULL) return NULL;
  registry->allocator = allocator;
  copy_text(registry->native_generation, sizeof(registry->native_generation),
            native_generation);
  registry->next_application_serial = 1;
  registry->next_window_serial = 1;
  return registry;
}

void meta_registry_destroy(MetaRegistry *registry) {
  if (registry == NULL) return;
  MetaRegistryAllocator allocator = registry->allocator;
  release_allocation(registry, registry->application_identities);
  release_allocation(registry, registry->window_identities);
  release_allocation(registry, registry->applications);
  release_allocation(registry, registry->windows);
  release_allocation(registry, registry->displays);
  allocator.release(allocator.context, registry);
}

bool meta_registry_refresh(MetaRegistry *registry,
                           const MetaInventoryInput *input) {
  if (registry == NULL || input == NULL) return false;
  if ((input->application_count > 0 && input->applications == NULL) ||
      (input->ax_window_count > 0 && input->ax_windows == NULL) ||
      (input->cg_window_count > 0 && input->cg_windows == NULL) ||
      (input->display_count > 0 && input->displays == NULL)) {
    return false;
  }

  MetaRegistry working = *registry;
  working.revision = registry->revision + 1;
  const bool topology_changed = display_layout_changed(registry, input);
  working.application_identities = NULL;
  working.window_identities = NULL;
  working.applications = NULL;
  working.application_count = 0;
  working.windows = NULL;
  working.window_count = 0;
  working.displays = NULL;
  working.display_count = 0;
  memset(&working.snapshot, 0, sizeof(working.snapshot));

  MetaApplicationRecord *applications = NULL;
  MetaWindowRecord *windows = NULL;
  MetaDisplayRecord *displays = NULL;
  bool *matched_cg = NULL;
  MetaMappingStatus *ax_mappings = NULL;
  size_t *ax_candidate_indices = NULL;

  if (registry->application_identity_count > 0) {
    working.application_identities = allocate_zeroed(
        &working, registry->application_identity_count,
        sizeof(*working.application_identities));
    if (working.application_identities == NULL) goto allocation_failure;
    memcpy(working.application_identities, registry->application_identities,
           registry->application_identity_count *
               sizeof(*working.application_identities));
  }
  if (registry->window_identity_count > 0) {
    working.window_identities = allocate_zeroed(
        &working, registry->window_identity_count,
        sizeof(*working.window_identities));
    if (working.window_identities == NULL) goto allocation_failure;
    memcpy(working.window_identities, registry->window_identities,
           registry->window_identity_count *
               sizeof(*working.window_identities));
  }

  applications = allocate_zeroed(&working, input->application_count,
                                  sizeof(*applications));
  const size_t maximum_window_count =
      input->ax_window_count + input->cg_window_count;
  windows = allocate_zeroed(&working, maximum_window_count, sizeof(*windows));
  displays =
      allocate_zeroed(&working, input->display_count, sizeof(*displays));
  matched_cg =
      allocate_zeroed(&working, input->cg_window_count, sizeof(*matched_cg));
  ax_mappings = allocate_zeroed(&working, input->ax_window_count,
                                sizeof(*ax_mappings));
  ax_candidate_indices = allocate_zeroed(
      &working, input->ax_window_count, sizeof(*ax_candidate_indices));
  if ((input->application_count > 0 && applications == NULL) ||
      (maximum_window_count > 0 && windows == NULL) ||
      (input->display_count > 0 && displays == NULL) ||
      (input->cg_window_count > 0 && matched_cg == NULL) ||
      (input->ax_window_count > 0 && ax_mappings == NULL) ||
      (input->ax_window_count > 0 && ax_candidate_indices == NULL)) {
    goto allocation_failure;
  }

  bool complete = input->source_complete;
  for (size_t index = 0; index < input->application_count; index += 1) {
    const MetaApplicationInput *source = &input->applications[index];
    ApplicationIdentity *identity = application_identity(
        &working, source->pid, source->launch_time_micros);
    if (identity == NULL) goto allocation_failure;
    MetaApplicationRecord *target = &applications[index];
    snprintf(target->application_ref, sizeof(target->application_ref),
             "%s:app:%llu", working.native_generation,
             (unsigned long long)identity->serial);
    snprintf(target->registration_nonce, sizeof(target->registration_nonce),
             "app-%llu", (unsigned long long)identity->serial);
    target->pid = source->pid;
    target->launch_time_micros = source->launch_time_micros;
    copy_text(target->name, sizeof(target->name), source->name);
    copy_text(target->bundle_id, sizeof(target->bundle_id), source->bundle_id);
    target->hidden = source->hidden;
    target->ax_status = source->ax_status;
    if (source->ax_status == META_AX_TIMED_OUT ||
        source->ax_status == META_AX_DENIED ||
        source->ax_status == META_AX_UNAVAILABLE ||
        source->ax_status == META_AX_FAILED) {
      complete = false;
    }
  }
  working.applications = applications;
  working.application_count = input->application_count;

  for (size_t index = 0; index < input->ax_window_count; index += 1) {
    ax_mappings[index] = input->ax_windows[index].surface_kind ==
                                 META_SURFACE_WINDOW
        ? correlate_window(&input->ax_windows[index], input->cg_windows,
                           input->cg_window_count,
                           &ax_candidate_indices[index])
        : META_MAPPING_UNAVAILABLE;
  }
  for (size_t index = 0; index < input->ax_window_count; index += 1) {
    if (ax_mappings[index] != META_MAPPING_CORROBORATED) continue;
    const size_t candidate_index = ax_candidate_indices[index];
    const MetaCGWindowInput *candidate = &input->cg_windows[candidate_index];
    for (size_t other = 0; other < input->ax_window_count; other += 1) {
      if (other == index || input->ax_windows[other].pid != candidate->pid ||
          !same_rect(input->ax_windows[other].frame, candidate->frame)) {
        continue;
      }
      if ((ax_mappings[other] == META_MAPPING_CORROBORATED &&
           ax_candidate_indices[other] == candidate_index) ||
          ax_mappings[other] == META_MAPPING_AMBIGUOUS) {
        ax_mappings[index] = META_MAPPING_AMBIGUOUS;
        break;
      }
    }
  }

  size_t output_window_count = 0;
  for (size_t index = 0; index < input->ax_window_count; index += 1) {
    const MetaAXWindowInput *source = &input->ax_windows[index];
    const bool contradictory_window_owner =
        source->surface_kind == META_SURFACE_WINDOW &&
        source->owner_ax_token != 0;
    if (source->owner_ax_token == META_AX_OWNER_AMBIGUOUS_TOKEN ||
        contradictory_window_owner ||
        (source->surface_kind == META_SURFACE_SHEET &&
         !exact_sheet_owner(input->ax_windows, input->ax_window_count,
                            source))) {
      complete = false;
      continue;
    }
    MetaApplicationRecord *application = find_application_record(
        applications, input->application_count, source->pid,
        source->launch_time_micros);
    if (application == NULL || source->ax_token == 0) {
      complete = false;
      continue;
    }
    const uint64_t application_serial =
        application_serial_from_ref(application->application_ref);
    WindowIdentity *identity =
        window_identity(&working, application_serial, source->ax_token);
    if (identity == NULL) goto allocation_failure;

    MetaWindowRecord *target = &windows[output_window_count++];
    const char *reference_kind = source->surface_kind == META_SURFACE_WINDOW
                                     ? "window"
                                     : "surface";
    snprintf(target->target_ref, sizeof(target->target_ref), "%s:%s:%llu",
             working.native_generation, reference_kind,
             (unsigned long long)identity->serial);
    if (source->surface_kind == META_SURFACE_WINDOW) {
      copy_text(target->window_ref, sizeof(target->window_ref),
                target->target_ref);
    } else {
      copy_text(target->surface_ref, sizeof(target->surface_ref),
                target->target_ref);
    }
    copy_text(target->application_ref, sizeof(target->application_ref),
              application->application_ref);
    target->ax_token = source->ax_token;
    target->pid = source->pid;
    copy_text(target->title, sizeof(target->title), source->title);
    copy_text(target->role, sizeof(target->role), source->role);
    copy_text(target->subrole, sizeof(target->subrole), source->subrole);
    target->frame = source->frame;
    target->surface_kind = source->surface_kind;
    target->application_hidden = application->hidden;
    target->minimized = source->minimized;
    target->fullscreen = source->fullscreen;
    target->focused = source->focused;
    target->main = source->main;
    target->on_screen = META_UNKNOWN;
    target->space_visibility = META_SPACE_UNKNOWN;
    target->actionability = META_ACTIONABILITY_AX;
    target->can_raise = source->can_raise;
    target->can_close = source->can_close;
    target->can_minimize = source->can_minimize;
    target->can_move = source->can_move;
    target->can_resize = source->can_resize;
    target->mapping = ax_mappings[index];
    if (target->mapping == META_MAPPING_CORROBORATED) {
      const size_t matched_index = ax_candidate_indices[index];
      const MetaCGWindowInput *cg_window = &input->cg_windows[matched_index];
      target->cg_window_id = cg_window->window_id;
      target->on_screen = cg_window->on_screen;
      if (cg_window->on_screen == META_TRUE) {
        target->space_visibility = META_SPACE_CURRENT;
      }
      matched_cg[matched_index] = true;
    }
    application->window_count += 1;
  }

  for (size_t index = 0; index < output_window_count; index += 1) {
    const MetaAXWindowInput *source = NULL;
    for (size_t source_index = 0; source_index < input->ax_window_count;
         source_index += 1) {
      if (input->ax_windows[source_index].ax_token == windows[index].ax_token &&
          input->ax_windows[source_index].pid == windows[index].pid) {
        source = &input->ax_windows[source_index];
        break;
      }
    }
    if (source == NULL || source->owner_ax_token == 0) continue;
    for (size_t owner_index = 0; owner_index < output_window_count;
         owner_index += 1) {
      if (windows[owner_index].pid == source->pid &&
          windows[owner_index].ax_token == source->owner_ax_token) {
        copy_text(windows[index].owner_window_ref,
                  sizeof(windows[index].owner_window_ref),
                  windows[owner_index].window_ref);
        break;
      }
    }
  }

  // Partial enumeration не возвращает старое окно в fresh snapshot, но и не
  // превращает временно неизвестный live AX handle в новый identity после
  // восстановления. Known READY/NO_WINDOWS absence остаётся tombstone.
  retain_uncertain_window_identities(
      &working, registry, input, applications, input->application_count);

  for (size_t index = 0; index < input->cg_window_count; index += 1) {
    if (matched_cg[index]) continue;
    const MetaCGWindowInput *source = &input->cg_windows[index];
    MetaWindowRecord *target = &windows[output_window_count++];
    target->cg_window_id = source->window_id;
    target->pid = source->pid;
    copy_text(target->title, sizeof(target->title), source->title);
    target->frame = source->frame;
    target->surface_kind = META_SURFACE_UNKNOWN;
    target->minimized = META_UNKNOWN;
    target->fullscreen = META_UNKNOWN;
    target->focused = META_UNKNOWN;
    target->main = META_UNKNOWN;
    target->on_screen = source->on_screen;
    target->space_visibility = source->on_screen == META_TRUE
                                   ? META_SPACE_CURRENT
                                   : META_SPACE_UNKNOWN;
    target->mapping = META_MAPPING_UNAVAILABLE;
    for (size_t ax_index = 0; ax_index < input->ax_window_count; ax_index += 1) {
      if (ax_mappings[ax_index] == META_MAPPING_AMBIGUOUS &&
          input->ax_windows[ax_index].pid == source->pid &&
          same_rect(input->ax_windows[ax_index].frame, source->frame)) {
        target->mapping = META_MAPPING_AMBIGUOUS;
        break;
      }
    }
    target->actionability = META_ACTIONABILITY_UNAVAILABLE;
    for (size_t app_index = 0; app_index < input->application_count;
         app_index += 1) {
      MetaApplicationRecord *application = &applications[app_index];
      if (application->pid != source->pid) continue;
      copy_text(target->application_ref, sizeof(target->application_ref),
                application->application_ref);
      target->application_hidden = application->hidden;
      application->window_count += 1;
      break;
    }
  }

  for (size_t index = 0; index < input->display_count; index += 1) {
    const MetaDisplayInput *source = &input->displays[index];
    MetaDisplayRecord *target = &displays[index];
    snprintf(target->display_ref, sizeof(target->display_ref), "%s:display:%u",
             working.native_generation, source->display_id);
    target->display_id = source->display_id;
    target->bounds = source->bounds;
    target->usable_bounds = source->usable_bounds;
    target->scale = source->scale;
    target->rotation_degrees = source->rotation_degrees;
    target->main = source->main;
  }

  working.windows = windows;
  working.window_count = output_window_count;
  working.displays = displays;
  working.display_count = input->display_count;
  snprintf(working.snapshot.inventory_id,
           sizeof(working.snapshot.inventory_id), "%s:inventory:%llu",
           working.native_generation, (unsigned long long)working.revision);
  copy_text(working.snapshot.native_generation,
            sizeof(working.snapshot.native_generation),
            working.native_generation);
  working.snapshot.revision = working.revision;
  working.snapshot.display_layout_revision =
      registry->snapshot.display_layout_revision +
      (topology_changed ? 1 : 0);
  snprintf(working.snapshot.layout_ref, sizeof(working.snapshot.layout_ref),
           "%s:layout:%llu", working.native_generation,
           (unsigned long long)working.snapshot.display_layout_revision);
  working.snapshot.display_topology_epoch = input->display_topology_epoch;
  working.snapshot.captured_at_micros = input->captured_at_micros;
  working.snapshot.complete = complete;
  working.snapshot.applications = working.applications;
  working.snapshot.application_count = working.application_count;
  working.snapshot.windows = working.windows;
  working.snapshot.window_count = working.window_count;
  working.snapshot.displays = working.displays;
  working.snapshot.display_count = working.display_count;

  release_allocation(registry, registry->application_identities);
  release_allocation(registry, registry->window_identities);
  release_allocation(registry, registry->applications);
  release_allocation(registry, registry->windows);
  release_allocation(registry, registry->displays);
  *registry = working;
  release_allocation(registry, matched_cg);
  release_allocation(registry, ax_mappings);
  release_allocation(registry, ax_candidate_indices);
  return true;

allocation_failure:
  release_allocation(&working, working.application_identities);
  release_allocation(&working, working.window_identities);
  release_allocation(&working, applications);
  release_allocation(&working, windows);
  release_allocation(&working, displays);
  release_allocation(&working, matched_cg);
  release_allocation(&working, ax_mappings);
  release_allocation(&working, ax_candidate_indices);
  return false;
}

const MetaInventorySnapshot *meta_registry_snapshot(
    const MetaRegistry *registry) {
  return registry == NULL ? NULL : &registry->snapshot;
}

const MetaWindowRecord *meta_registry_resolve_window(
    const MetaRegistry *registry, const char *window_ref) {
  if (registry == NULL || window_ref == NULL || window_ref[0] == '\0') {
    return NULL;
  }
  for (size_t index = 0; index < registry->window_count; index += 1) {
    if (strcmp(registry->windows[index].window_ref, window_ref) == 0) {
      return &registry->windows[index];
    }
  }
  return NULL;
}

const MetaWindowRecord *meta_registry_resolve_surface(
    const MetaRegistry *registry, const char *surface_ref) {
  if (registry == NULL || surface_ref == NULL || surface_ref[0] == '\0') {
    return NULL;
  }
  for (size_t index = 0; index < registry->window_count; index += 1) {
    if (strcmp(registry->windows[index].surface_ref, surface_ref) == 0) {
      return &registry->windows[index];
    }
  }
  return NULL;
}

const MetaWindowRecord *meta_registry_resolve_target(
    const MetaRegistry *registry, const char *target_ref) {
  if (registry == NULL || target_ref == NULL || target_ref[0] == '\0') {
    return NULL;
  }
  for (size_t index = 0; index < registry->window_count; index += 1) {
    if (strcmp(registry->windows[index].target_ref, target_ref) == 0) {
      return &registry->windows[index];
    }
  }
  return NULL;
}

const MetaApplicationRecord *meta_registry_resolve_application(
    const MetaRegistry *registry, const char *application_ref) {
  if (registry == NULL || application_ref == NULL ||
      application_ref[0] == '\0') {
    return NULL;
  }
  for (size_t index = 0; index < registry->application_count; index += 1) {
    if (strcmp(registry->applications[index].application_ref,
               application_ref) == 0) {
      return &registry->applications[index];
    }
  }
  return NULL;
}
