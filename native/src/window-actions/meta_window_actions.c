#include "meta_window_actions.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static bool valid_identifier(const char *value) {
  if (value == NULL) return false;
  const size_t length = strnlen(value, META_NATIVE_REF_CAPACITY);
  if (length == 0 || length >= META_NATIVE_REF_CAPACITY ||
      !((value[0] >= 'A' && value[0] <= 'Z') ||
        (value[0] >= 'a' && value[0] <= 'z') ||
        (value[0] >= '0' && value[0] <= '9'))) {
    return false;
  }
  for (size_t index = 1; index < length; index += 1) {
    const char character = value[index];
    const bool alphanumeric =
        (character >= 'A' && character <= 'Z') ||
        (character >= 'a' && character <= 'z') ||
        (character >= '0' && character <= '9');
    if (!alphanumeric && character != '.' && character != '_' &&
        character != ':' && character != '-') {
      return false;
    }
  }
  return true;
}

static bool valid_bounds(MetaRect bounds) {
  return isfinite(bounds.x) && isfinite(bounds.y) &&
         isfinite(bounds.width) && isfinite(bounds.height) &&
         bounds.width > 0 && bounds.height > 0;
}

static bool known_action(MetaWindowActionKind action) {
  switch (action) {
    case META_WINDOW_ACTION_SHOW:
    case META_WINDOW_ACTION_FOCUS:
    case META_WINDOW_ACTION_SET_BOUNDS:
    case META_WINDOW_ACTION_SET_MINIMIZED:
    case META_WINDOW_ACTION_CLOSE:
      return true;
  }
  return false;
}

static bool known_transition_status(MetaTransitionStatus status) {
  switch (status) {
    case META_TRANSITION_SUCCEEDED:
    case META_TRANSITION_PARTIAL:
    case META_TRANSITION_TARGET_STALE:
    case META_TRANSITION_UNAVAILABLE:
    case META_TRANSITION_SPACE_UNAVAILABLE:
    case META_TRANSITION_TIMED_OUT:
      return true;
  }
  return false;
}

static void initialize_result(MetaWindowTransition *result,
                              const MetaWindowActionRequest *request) {
  memset(result, 0, sizeof(*result));
  result->status = META_TRANSITION_UNAVAILABLE;
  result->application_hidden = META_UNKNOWN;
  result->minimized = META_UNKNOWN;
  result->focused = META_UNKNOWN;
  if (request == NULL || request->window_ref == NULL) return;
  const size_t length = strnlen(request->window_ref, META_NATIVE_REF_CAPACITY);
  if (length >= META_NATIVE_REF_CAPACITY) return;
  snprintf(result->window_ref, sizeof(result->window_ref), "%s",
           request->window_ref);
  if (request->kind == META_WINDOW_ACTION_SET_BOUNDS) {
    result->requested_frame = request->value.bounds;
  }
}

static bool same_rect(MetaRect left, MetaRect right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

MetaWindowActionDispatchStatus meta_window_action_dispatch(
    const MetaWindowActionBackend *backend,
    const MetaWindowActionRequest *request,
    MetaWindowTransition *result) {
  if (result == NULL) return META_WINDOW_ACTION_INVALID_REQUEST;
  initialize_result(result, request);
  if (backend == NULL || request == NULL ||
      !valid_identifier(request->window_ref) || !known_action(request->kind) ||
      (request->kind == META_WINDOW_ACTION_SET_BOUNDS &&
       !valid_bounds(request->value.bounds))) {
    return META_WINDOW_ACTION_INVALID_REQUEST;
  }

  bool backend_success = false;
  switch (request->kind) {
    case META_WINDOW_ACTION_SHOW:
      if (backend->show_window == NULL) {
        return META_WINDOW_ACTION_BACKEND_UNAVAILABLE;
      }
      backend_success = backend->show_window(
          backend->context, request->window_ref, result);
      break;
    case META_WINDOW_ACTION_FOCUS:
      if (backend->focus_window == NULL) {
        return META_WINDOW_ACTION_BACKEND_UNAVAILABLE;
      }
      backend_success = backend->focus_window(
          backend->context, request->window_ref, result);
      break;
    case META_WINDOW_ACTION_SET_BOUNDS:
      if (backend->set_window_bounds == NULL) {
        return META_WINDOW_ACTION_BACKEND_UNAVAILABLE;
      }
      backend_success = backend->set_window_bounds(
          backend->context, request->window_ref, request->value.bounds, result);
      break;
    case META_WINDOW_ACTION_SET_MINIMIZED:
      if (backend->set_window_minimized == NULL) {
        return META_WINDOW_ACTION_BACKEND_UNAVAILABLE;
      }
      backend_success = backend->set_window_minimized(
          backend->context, request->window_ref, request->value.minimized,
          result);
      break;
    case META_WINDOW_ACTION_CLOSE:
      if (backend->close_window == NULL) {
        return META_WINDOW_ACTION_BACKEND_UNAVAILABLE;
      }
      backend_success = backend->close_window(
          backend->context, request->window_ref, result);
      break;
  }

  const bool success_status = result->status == META_TRANSITION_SUCCEEDED;
  const size_t requested_length =
      strnlen(request->window_ref, META_NATIVE_REF_CAPACITY);
  const size_t result_length =
      strnlen(result->window_ref, META_NATIVE_REF_CAPACITY);
  const bool exact_target = result_length == requested_length &&
                            result_length < META_NATIVE_REF_CAPACITY &&
                            memcmp(result->window_ref, request->window_ref,
                                   requested_length) == 0;
  const bool exact_requested_bounds =
      request->kind != META_WINDOW_ACTION_SET_BOUNDS ||
      same_rect(result->requested_frame, request->value.bounds);
  if (!known_transition_status(result->status) ||
      backend_success != success_status || !exact_target ||
      !exact_requested_bounds) {
    initialize_result(result, request);
    return META_WINDOW_ACTION_BACKEND_CONTRACT_VIOLATION;
  }
  return META_WINDOW_ACTION_DISPATCHED;
}
