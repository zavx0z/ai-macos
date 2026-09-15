#include "meta_input_readiness.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define META_READINESS_EVENT_TIMEOUT_MILLIS 250

static bool valid_text(const char *value, size_t capacity) {
  return value != NULL && value[0] != '\0' &&
         memchr(value, '\0', capacity) != NULL;
}

static void reason(MetaInputReadinessResult *result, const char *value) {
  snprintf(result->reason, sizeof(result->reason), "%s",
           value == NULL || value[0] == '\0' ? "Readiness probe failed" : value);
}

static bool finite_point(MetaReadinessPoint point) {
  return isfinite(point.x) && isfinite(point.y);
}

static bool same_point(MetaReadinessPoint left, MetaReadinessPoint right) {
  return fabs(left.x - right.x) <= 0.001 &&
         fabs(left.y - right.y) <= 0.001;
}

static bool contains_point(MetaRect bounds, MetaReadinessPoint point) {
  return isfinite(bounds.x) && isfinite(bounds.y) &&
         isfinite(bounds.width) && isfinite(bounds.height) &&
         bounds.width > 0 && bounds.height > 0 && point.x >= bounds.x &&
         point.y >= bounds.y && point.x < bounds.x + bounds.width &&
         point.y < bounds.y + bounds.height;
}

static bool choose_probe_point(MetaReadinessDisplay display,
                               MetaReadinessPoint original,
                               MetaReadinessPoint *probe) {
  if (!contains_point(display.bounds, original) || probe == NULL) return false;
  *probe = original;
  const double right = display.bounds.x + display.bounds.width;
  const double bottom = display.bounds.y + display.bounds.height;
  if (original.x + 1 < right) probe->x += 1;
  else if (original.x - 1 >= display.bounds.x) probe->x -= 1;
  else if (original.y + 1 < bottom) probe->y += 1;
  else if (original.y - 1 >= display.bounds.y) probe->y -= 1;
  else return false;
  return contains_point(display.bounds, *probe) &&
         fabs(probe->x - original.x) + fabs(probe->y - original.y) == 1;
}

static bool session_ready(MetaReadinessSessionFacts facts) {
  return facts.audit_identity_verified && facts.audit_session_matches &&
         facts.real_uid == facts.effective_uid &&
         facts.real_uid == facts.audit_uid &&
         facts.real_uid == facts.session_uid && facts.active_console &&
         facts.on_console && facts.login_done &&
         facts.lock_state == META_READINESS_LOCK_UNKNOWN &&
         facts.secure_input == META_READINESS_SECURE_INPUT_OFF;
}

static bool permissions_ready(MetaReadinessPermissions permissions) {
  return permissions.accessibility && permissions.post_events &&
         permissions.listen_events;
}

static bool observer_ready(MetaReadinessObserverSnapshot snapshot) {
  return snapshot.ready && snapshot.continuous && !snapshot.gap_detected &&
         valid_text(snapshot.cursor, sizeof(snapshot.cursor));
}

static void sync_status(MetaExecutor *executor,
                        MetaInputReadinessResult *result) {
  MetaExecutorStatus status = meta_executor_status(executor);
  result->dispatch = status.dispatch;
  result->cleanup = status.cleanup;
  result->interference = status.user_interference;
  result->quarantined = status.quarantined;
}

static bool reject_dispatch(void *context) {
  (void)context;
  return false;
}

static bool fail_unknown(MetaExecutor *executor,
                         MetaInputReadinessResult *result,
                         const char *message) {
  result->input_ready = false;
  result->cleanup = META_CLEANUP_UNKNOWN;
  result->interference = META_INTERFERENCE_UNKNOWN;
  result->restoration = META_READINESS_RESTORE_UNKNOWN;
  result->quarantined = true;
  reason(result, message);
  if (executor != NULL &&
      meta_executor_status(executor).execution == META_EXECUTOR_DISPATCHING) {
    meta_executor_dispatch_action(executor, reject_dispatch, NULL,
                                  "readiness-unknown");
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_UNKNOWN;
    result->interference = META_INTERFERENCE_UNKNOWN;
    result->restoration = META_READINESS_RESTORE_UNKNOWN;
    result->quarantined = true;
  }
  return false;
}

static bool read_current_preconditions(MetaInputReadinessBackend backend,
                                       MetaReadinessSessionFacts *session,
                                       MetaReadinessPermissions *permissions,
                                       MetaReadinessObserverSnapshot *observer) {
  return backend.read_session(backend.context, session) &&
         session_ready(*session) &&
         backend.read_permissions(backend.context, permissions) &&
         permissions_ready(*permissions) &&
         backend.read_observer(backend.context, observer) &&
         observer_ready(*observer);
}

bool meta_input_readiness_probe_active(MetaExecutor *executor,
                                       const char *expected_display_ref,
                                       MetaInputReadinessBackend backend,
                                       MetaInputReadinessResult *result) {
  if (result == NULL) return false;
  *result = (MetaInputReadinessResult){
      .dispatch = META_DISPATCH_NONE,
      .cleanup = META_CLEANUP_COMPLETE,
      .interference = META_INTERFERENCE_UNKNOWN,
      .restoration = META_READINESS_RESTORE_NOT_ATTEMPTED,
  };
  if (executor == NULL ||
      !valid_text(expected_display_ref, META_NATIVE_REF_CAPACITY) ||
      backend.read_session == NULL ||
      backend.read_permissions == NULL || backend.read_observer == NULL ||
      backend.read_cursor == NULL || backend.resolve_display == NULL ||
      backend.scan_events == NULL) {
    return fail_unknown(executor, result, "Readiness backend incomplete");
  }

  MetaExecutorStatus initial = meta_executor_status(executor);
  if (initial.execution != META_EXECUTOR_DISPATCHING ||
      !initial.has_accepted_fence || !initial.has_high_water_fence ||
      initial.target_verification != META_VERIFICATION_VERIFIED ||
      initial.observer_state != META_OBSERVER_READY || initial.quarantined) {
    return fail_unknown(executor, result,
                        "Readiness probe требует active parent executor");
  }

  MetaReadinessSessionFacts session = {0};
  MetaReadinessPermissions permissions = {0};
  MetaReadinessObserverSnapshot observer = {0};
  if (!read_current_preconditions(backend, &session, &permissions, &observer)) {
    reason(result,
           "Active console, Secure Input off, permissions или observer не подтверждены");
    result->interference = observer_ready(observer)
                               ? META_INTERFERENCE_NONE_OBSERVED
                               : META_INTERFERENCE_UNKNOWN;
    return true;
  }

  MetaReadinessPoint original = {0};
  MetaReadinessDisplay display = {0};
  if (!backend.read_cursor(backend.context, &original) ||
      !finite_point(original) ||
      !backend.resolve_display(backend.context, original, &display) ||
      !valid_text(display.display_ref, sizeof(display.display_ref)) ||
      strcmp(display.display_ref, expected_display_ref) != 0 ||
      !choose_probe_point(display, original, &result->probe_cursor)) {
    reason(result, "Cursor или exact resolved display не подтверждены");
    result->interference = META_INTERFERENCE_NONE_OBSERVED;
    return true;
  }
  result->original_cursor = original;
  snprintf(result->display_ref, sizeof(result->display_ref), "%s",
           display.display_ref);

  const uint64_t synthetic_tag = meta_executor_synthetic_tag(executor);
  if (synthetic_tag == 0 ||
      !meta_executor_checkpoint(executor, "readiness-before-move")) {
    return fail_unknown(executor, result,
                        "Readiness move не получил active synthetic fence");
  }
  MetaPointerEvent move = {
      .kind = META_POINTER_MOVE,
      .button = META_POINTER_LEFT,
      .x = result->probe_cursor.x,
      .y = result->probe_cursor.y,
      .flags = 0,
  };
  if (!meta_executor_post_pointer_event(executor, &move, "readiness-move")) {
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_UNKNOWN;
    result->restoration = META_READINESS_RESTORE_UNKNOWN;
    result->quarantined = true;
    reason(result, "Readiness move мог остаться незавершённым");
    return false;
  }
  result->move_posted = true;

  MetaReadinessEventScan moved = {0};
  if (!backend.scan_events(backend.context, observer.cursor, synthetic_tag,
                           true, META_READINESS_EVENT_TIMEOUT_MILLIS, &moved) ||
      !valid_text(moved.cursor, sizeof(moved.cursor))) {
    return fail_unknown(executor, result,
                        "Readiness move не получил exact own observer event");
  }
  MetaReadinessObserverSnapshot after_move = {0};
  if (!backend.read_observer(backend.context, &after_move) ||
      !observer_ready(after_move) ||
      strcmp(after_move.cursor, moved.cursor) != 0) {
    return fail_unknown(executor, result,
                        "Observer continuity после readiness move неизвестна");
  }
  if (moved.state == META_READINESS_SCAN_USER_TAKEOVER) {
    meta_executor_note_observed_event(executor, 0);
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_COMPLETE;
    result->interference = META_INTERFERENCE_OBSERVED;
    result->restoration = META_READINESS_RESTORE_SKIPPED_USER_TAKEOVER;
    result->quarantined = false;
    reason(result, "Restore пропущен: user takeover совпал с readiness move");
    return true;
  }
  if (moved.state != META_READINESS_SCAN_OWN_EVENT_ONLY ||
      moved.synthetic_tag != synthetic_tag ||
      !meta_executor_note_observed_event(executor, moved.synthetic_tag)) {
    return fail_unknown(executor, result,
                        "Readiness move не получил exact own observer event");
  }
  result->move_observed = true;
  MetaReadinessPoint moved_cursor = {0};
  if (!backend.read_cursor(backend.context, &moved_cursor) ||
      !same_point(moved_cursor, result->probe_cursor)) {
    return fail_unknown(executor, result,
                        "Cursor readback после readiness move не совпал");
  }
  result->move_readback_confirmed = true;

  MetaReadinessObserverSnapshot before_restore = {0};
  if (!read_current_preconditions(backend, &session, &permissions,
                                  &before_restore) ||
      !meta_executor_checkpoint(executor, "readiness-before-restore")) {
    return fail_unknown(executor, result,
                        "Readiness restore потерял current preconditions");
  }

  MetaReadinessEventScan quiet = {0};
  if (!backend.scan_events(backend.context, moved.cursor, synthetic_tag, false,
                           META_READINESS_EVENT_TIMEOUT_MILLIS, &quiet) ||
      !valid_text(quiet.cursor, sizeof(quiet.cursor))) {
    return fail_unknown(executor, result,
                        "User takeover перед restore не удалось проверить");
  }
  MetaReadinessObserverSnapshot after_quiet_scan = {0};
  if (!backend.read_observer(backend.context, &after_quiet_scan) ||
      !observer_ready(after_quiet_scan) ||
      strcmp(after_quiet_scan.cursor, quiet.cursor) != 0) {
    return fail_unknown(executor, result,
                        "Observer continuity перед restore неизвестна");
  }
  if (quiet.state == META_READINESS_SCAN_USER_TAKEOVER) {
    meta_executor_note_observed_event(executor, 0);
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_COMPLETE;
    result->interference = META_INTERFERENCE_OBSERVED;
    result->restoration = META_READINESS_RESTORE_SKIPPED_USER_TAKEOVER;
    reason(result, "Restore пропущен после подтверждённого user takeover");
    return true;
  }
  if (quiet.state != META_READINESS_SCAN_NO_EVENTS ||
      strcmp(quiet.cursor, moved.cursor) != 0) {
    return fail_unknown(executor, result,
                        "Перед restore появились неподтверждённые события");
  }

  MetaPointerEvent restore = {
      .kind = META_POINTER_MOVE,
      .button = META_POINTER_LEFT,
      .x = original.x,
      .y = original.y,
      .flags = 0,
  };
  result->restoration = META_READINESS_RESTORE_FAILED;
  if (!meta_executor_post_pointer_event(executor, &restore,
                                        "readiness-restore")) {
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_UNKNOWN;
    result->restoration = META_READINESS_RESTORE_UNKNOWN;
    result->quarantined = true;
    reason(result, "Readiness restore мог остаться незавершённым");
    return false;
  }
  result->restore_posted = true;

  MetaReadinessEventScan restored = {0};
  if (!backend.scan_events(backend.context, quiet.cursor, synthetic_tag, true,
                           META_READINESS_EVENT_TIMEOUT_MILLIS, &restored) ||
      !valid_text(restored.cursor, sizeof(restored.cursor))) {
    return fail_unknown(executor, result,
                        "Readiness restore не получил exact own observer event");
  }
  MetaReadinessObserverSnapshot after_restore = {0};
  if (!backend.read_observer(backend.context, &after_restore) ||
      !observer_ready(after_restore) ||
      strcmp(after_restore.cursor, restored.cursor) != 0) {
    return fail_unknown(executor, result,
                        "Observer continuity после restore неизвестна");
  }
  if (restored.state == META_READINESS_SCAN_USER_TAKEOVER) {
    meta_executor_note_observed_event(executor, 0);
    sync_status(executor, result);
    result->cleanup = META_CLEANUP_COMPLETE;
    result->interference = META_INTERFERENCE_OBSERVED;
    result->restoration = META_READINESS_RESTORE_UNKNOWN;
    result->quarantined = false;
    reason(result, "User takeover совпал с readiness restore");
    return true;
  }
  if (restored.state != META_READINESS_SCAN_OWN_EVENT_ONLY ||
      restored.synthetic_tag != synthetic_tag ||
      !meta_executor_note_observed_event(executor, restored.synthetic_tag)) {
    return fail_unknown(executor, result,
                        "Readiness restore не получил exact own observer event");
  }
  result->restore_observed = true;
  MetaReadinessPoint restored_cursor = {0};
  if (!backend.read_cursor(backend.context, &restored_cursor) ||
      !same_point(restored_cursor, original)) {
    return fail_unknown(executor, result,
                        "Cursor readback после restore не совпал");
  }
  result->restore_readback_confirmed = true;
  result->input_ready = true;
  result->cleanup = META_CLEANUP_COMPLETE;
  result->interference = META_INTERFERENCE_NONE_OBSERVED;
  result->restoration = META_READINESS_RESTORE_RESTORED;
  result->quarantined = false;
  result->dispatch = META_DISPATCH_FINISHED;
  result->reason[0] = '\0';
  return true;
}
