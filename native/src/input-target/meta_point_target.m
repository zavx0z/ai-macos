#include "meta_point_target.h"

#include <float.h>
#include <math.h>
#include <time.h>

#define META_POINT_TARGET_MAX_NODES 32
#define META_POINT_TARGET_DEADLINE_MILLIS 500
#define META_POINT_TARGET_CALL_TIMEOUT_MILLIS 100

static bool valid_backend(MetaPointTargetBackend backend) {
  return backend.monotonic_millis != NULL &&
         backend.create_system_wide != NULL &&
         backend.set_messaging_timeout != NULL &&
         backend.copy_element_at_position != NULL &&
         backend.copy_parent != NULL && backend.get_pid != NULL &&
         backend.equal != NULL && backend.release != NULL;
}

static bool remaining_millis(MetaPointTargetBackend backend,
                             uint64_t started_at,
                             uint64_t *remaining) {
  const uint64_t now = backend.monotonic_millis(backend.context);
  if (now < started_at || now - started_at >=
                              META_POINT_TARGET_DEADLINE_MILLIS) {
    return META_POINT_TARGET_RELATION_NONE;
  }
  *remaining = META_POINT_TARGET_DEADLINE_MILLIS - (now - started_at);
  return true;
}

static bool prepare_call(MetaPointTargetBackend backend,
                         AXUIElementRef element,
                         uint64_t started_at) {
  uint64_t remaining = 0;
  if (element == NULL ||
      !remaining_millis(backend, started_at, &remaining)) {
    return false;
  }
  const uint64_t timeout =
      remaining < META_POINT_TARGET_CALL_TIMEOUT_MILLIS
          ? remaining
          : META_POINT_TARGET_CALL_TIMEOUT_MILLIS;
  backend.set_messaging_timeout(backend.context, element,
                                (double)timeout / 1000.0);
  return remaining_millis(backend, started_at, &remaining);
}

static bool deadline_open(MetaPointTargetBackend backend,
                          uint64_t started_at) {
  uint64_t remaining = 0;
  return remaining_millis(backend, started_at, &remaining);
}

static void release_elements(MetaPointTargetBackend backend,
                             AXUIElementRef system_wide,
                             AXUIElementRef *visited,
                             size_t visited_count) {
  if (system_wide != NULL) backend.release(backend.context, system_wide);
  for (size_t index = 0; index < visited_count; index += 1) {
    backend.release(backend.context, visited[index]);
  }
}

MetaPointTargetRelation meta_point_relation_to_borrow_with_backend(
    const MetaAXTargetBorrow *borrow,
    double x, double y,
    MetaPointTargetBackend backend) {
  if (borrow == NULL || borrow->element == NULL || borrow->target.pid <= 0 ||
      (borrow->target.surface_kind != META_SURFACE_WINDOW &&
       borrow->target.surface_kind != META_SURFACE_SHEET) ||
      (borrow->target.surface_kind == META_SURFACE_SHEET &&
       borrow->target.owner_window_ref[0] == '\0') ||
      !isfinite(x) || !isfinite(y) || x < -FLT_MAX || x > FLT_MAX ||
      y < -FLT_MAX || y > FLT_MAX || !valid_backend(backend)) {
    return META_POINT_TARGET_RELATION_NONE;
  }

  const uint64_t started_at = backend.monotonic_millis(backend.context);
  if (started_at == UINT64_MAX) return META_POINT_TARGET_RELATION_NONE;
  AXUIElementRef system_wide =
      backend.create_system_wide(backend.context);
  AXUIElementRef visited[META_POINT_TARGET_MAX_NODES] = {0};
  size_t visited_count = 0;
  MetaPointTargetRelation relation = META_POINT_TARGET_RELATION_NONE;
  if (system_wide == NULL ||
      !prepare_call(backend, system_wide, started_at)) {
    release_elements(backend, system_wide, visited, visited_count);
    return META_POINT_TARGET_RELATION_NONE;
  }

  AXUIElementRef hit = NULL;
  const AXError hit_error = backend.copy_element_at_position(
      backend.context, system_wide, x, y, &hit);
  backend.release(backend.context, system_wide);
  system_wide = NULL;
  if (hit_error != kAXErrorSuccess || hit == NULL ||
      !deadline_open(backend, started_at)) {
    if (hit != NULL) backend.release(backend.context, hit);
    return META_POINT_TARGET_RELATION_NONE;
  }
  visited[visited_count++] = hit;

  if (!prepare_call(backend, hit, started_at)) {
    release_elements(backend, NULL, visited, visited_count);
    return META_POINT_TARGET_RELATION_NONE;
  }
  pid_t hit_pid = 0;
  if (backend.get_pid(backend.context, hit, &hit_pid) != kAXErrorSuccess ||
      hit_pid != borrow->target.pid ||
      !deadline_open(backend, started_at)) {
    release_elements(backend, NULL, visited, visited_count);
    return false;
  }

  while (visited_count <= META_POINT_TARGET_MAX_NODES) {
    AXUIElementRef current = visited[visited_count - 1];
    if (!deadline_open(backend, started_at)) break;
    if (backend.equal(backend.context, current, borrow->element)) {
      if (deadline_open(backend, started_at)) {
        relation = visited_count == 1
                       ? META_POINT_TARGET_RELATION_EXACT
                       : META_POINT_TARGET_RELATION_OWNED_DESCENDANT;
      }
      break;
    }
    if (!deadline_open(backend, started_at) ||
        visited_count == META_POINT_TARGET_MAX_NODES ||
        !prepare_call(backend, current, started_at)) {
      break;
    }
    AXUIElementRef parent = NULL;
    const AXError parent_error = backend.copy_parent(
        backend.context, current, &parent);
    if (parent_error != kAXErrorSuccess || parent == NULL ||
        !deadline_open(backend, started_at)) {
      if (parent != NULL) backend.release(backend.context, parent);
      break;
    }
    bool cycle = false;
    for (size_t index = 0; index < visited_count; index += 1) {
      if (backend.equal(backend.context, parent, visited[index])) {
        cycle = true;
        break;
      }
    }
    if (cycle || !deadline_open(backend, started_at)) {
      backend.release(backend.context, parent);
      break;
    }
    visited[visited_count++] = parent;
  }

  release_elements(backend, NULL, visited, visited_count);
  return relation;
}

bool meta_point_matches_borrow_with_backend(
    const MetaAXTargetBorrow *borrow,
    double x, double y,
    MetaPointTargetBackend backend) {
  return meta_point_relation_to_borrow_with_backend(
             borrow, x, y, backend) != META_POINT_TARGET_RELATION_NONE;
}

static uint64_t monotonic_millis(void *context) {
  (void)context;
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000 +
         (uint64_t)value.tv_nsec / 1000000;
}

static AXUIElementRef create_system_wide(void *context) {
  (void)context;
  return AXUIElementCreateSystemWide();
}

static void set_messaging_timeout(void *context, AXUIElementRef element,
                                  double seconds) {
  (void)context;
  AXUIElementSetMessagingTimeout(element, (float)seconds);
}

static AXError copy_element_at_position(void *context,
                                        AXUIElementRef system_wide,
                                        double x, double y,
                                        AXUIElementRef *element) {
  (void)context;
  return AXUIElementCopyElementAtPosition(system_wide, (float)x, (float)y,
                                          element);
}

static AXError copy_parent(void *context, AXUIElementRef element,
                           AXUIElementRef *parent) {
  (void)context;
  CFTypeRef value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      element, kAXParentAttribute, &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != AXUIElementGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return error == kAXErrorSuccess ? kAXErrorIllegalArgument : error;
  }
  *parent = (AXUIElementRef)value;
  return kAXErrorSuccess;
}

static AXError get_pid(void *context, AXUIElementRef element, pid_t *pid) {
  (void)context;
  return AXUIElementGetPid(element, pid);
}

static bool equal(void *context, AXUIElementRef left, AXUIElementRef right) {
  (void)context;
  return CFEqual(left, right);
}

static void release(void *context, AXUIElementRef element) {
  (void)context;
  CFRelease(element);
}

MetaPointTargetRelation meta_point_relation_to_borrow(
    const MetaAXTargetBorrow *borrow,
    double x, double y) {
  return meta_point_relation_to_borrow_with_backend(
      borrow, x, y, (MetaPointTargetBackend){
                        .monotonic_millis = monotonic_millis,
                        .create_system_wide = create_system_wide,
                        .set_messaging_timeout = set_messaging_timeout,
                        .copy_element_at_position = copy_element_at_position,
                        .copy_parent = copy_parent,
                        .get_pid = get_pid,
                        .equal = equal,
                        .release = release,
                    });
}

bool meta_point_matches_borrow(const MetaAXTargetBorrow *borrow,
                               double x, double y) {
  return meta_point_relation_to_borrow(borrow, x, y) !=
         META_POINT_TARGET_RELATION_NONE;
}
