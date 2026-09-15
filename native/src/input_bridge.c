#include "meta_input_bridge.h"

#include <stdio.h>

bool meta_input_execute_key(MetaExecutor *executor,
                            uint32_t key_code,
                            uint64_t flags) {
  if (executor == NULL || key_code > UINT16_MAX ||
      !meta_executor_set_event_flags(executor, flags, "key-flags") ||
      !meta_executor_post_down(executor, META_EVENT_KEY, key_code) ||
      !meta_executor_post_up(executor, META_EVENT_KEY, key_code)) {
    return false;
  }
  return meta_executor_finish(executor);
}

bool meta_input_execute_shortcut(MetaExecutor *executor,
                                 const MetaTimedKeyStroke *strokes,
                                 size_t stroke_count,
                                 uint64_t action_deadline_millis,
                                 MetaInputBridgeClock clock,
                                 size_t *completed_strokes) {
  if (executor == NULL || strokes == NULL || completed_strokes == NULL ||
      stroke_count == 0 || stroke_count > 64 ||
      clock.monotonic_millis == NULL || clock.wait_until == NULL) {
    if (executor != NULL) meta_executor_cancel(executor);
    return false;
  }
  *completed_strokes = 0;
  uint64_t previous_offset = 0;
  for (size_t index = 0; index < stroke_count; index += 1) {
    if (strokes[index].key_code > UINT16_MAX ||
        (index == 0 && strokes[index].offset_millis != 0) ||
        (index > 0 && strokes[index].offset_millis < previous_offset) ||
        strokes[index].offset_millis > 5000) {
      meta_executor_cancel(executor);
      return false;
    }
    previous_offset = strokes[index].offset_millis;
  }
  const uint64_t started_at = clock.monotonic_millis(clock.context);
  if (action_deadline_millis <= started_at ||
      action_deadline_millis - started_at > 5000 ||
      started_at + previous_offset > action_deadline_millis) {
    meta_executor_cancel(executor);
    return false;
  }
  for (size_t index = 0; index < stroke_count; index += 1) {
    if (!clock.wait_until(clock.context,
                          started_at + strokes[index].offset_millis)) {
      meta_executor_cancel(executor);
      return false;
    }
    if (!meta_executor_set_event_flags(executor, strokes[index].flags,
                                       "shortcut-flags") ||
        !meta_executor_post_down(executor, META_EVENT_KEY,
                                 strokes[index].key_code) ||
        !meta_executor_post_up(executor, META_EVENT_KEY,
                               strokes[index].key_code)) {
      return false;
    }
    *completed_strokes += 1;
  }
  return meta_executor_finish(executor);
}

bool meta_input_execute_hover(MetaExecutor *executor,
                              double x,
                              double y,
                              uint64_t flags) {
  MetaPointerEvent event = {
      .kind = META_POINTER_MOVE,
      .button = META_POINTER_LEFT,
      .x = x,
      .y = y,
      .flags = flags,
  };
  return meta_executor_post_pointer_event(executor, &event, "hover") &&
         meta_executor_finish(executor);
}

bool meta_input_execute_click(MetaExecutor *executor,
                              double x,
                              double y,
                              MetaPointerButton button,
                              uint32_t count,
                              uint64_t flags) {
  if (executor == NULL || button > META_POINTER_MIDDLE || count == 0 ||
      count > 3) {
    if (executor != NULL) meta_executor_cancel(executor);
    return false;
  }
  MetaPointerEvent move = {
      .kind = META_POINTER_MOVE,
      .button = button,
      .x = x,
      .y = y,
      .flags = flags,
  };
  if (!meta_executor_post_pointer_event(executor, &move, "click-move")) {
    return false;
  }
  for (uint32_t index = 0; index < count; index += 1) {
    if (!meta_executor_post_down(executor, META_EVENT_BUTTON,
                                 (uint32_t)button) ||
        !meta_executor_post_up(executor, META_EVENT_BUTTON,
                               (uint32_t)button)) {
      return false;
    }
  }
  return meta_executor_finish(executor);
}

bool meta_input_execute_scroll(MetaExecutor *executor,
                               MetaScrollEvent event) {
  if (executor == NULL || event.unit > META_SCROLL_PIXEL ||
      (event.dx == 0 && event.dy == 0)) {
    if (executor != NULL) meta_executor_cancel(executor);
    return false;
  }
  MetaPointerEvent move = {
      .kind = META_POINTER_MOVE,
      .button = META_POINTER_LEFT,
      .x = event.x,
      .y = event.y,
      .flags = event.flags,
  };
  return meta_executor_post_pointer_event(executor, &move, "scroll-anchor") &&
         meta_executor_post_scroll_event(executor, &event, "scroll") &&
         meta_executor_finish(executor);
}

bool meta_input_execute_drag(MetaExecutor *executor,
                             const MetaTimedPointerPoint *trajectory,
                             size_t point_count,
                             MetaPointerButton button,
                             uint64_t flags,
                             uint64_t action_deadline_millis,
                             MetaInputBridgeClock clock,
                             size_t *completed_points) {
  if (executor == NULL || trajectory == NULL || completed_points == NULL ||
      point_count < 2 || point_count > 512 ||
      button > META_POINTER_MIDDLE || clock.monotonic_millis == NULL ||
      clock.wait_until == NULL) {
    if (executor != NULL) meta_executor_cancel(executor);
    return false;
  }
  *completed_points = 0;
  uint64_t previous_offset = 0;
  for (size_t index = 0; index < point_count; index += 1) {
    if ((index == 0 && trajectory[index].offset_millis != 0) ||
        (index > 0 && trajectory[index].offset_millis < previous_offset) ||
        trajectory[index].offset_millis > 5000) {
      meta_executor_cancel(executor);
      return false;
    }
    previous_offset = trajectory[index].offset_millis;
  }
  const uint64_t started_at = clock.monotonic_millis(clock.context);
  if (action_deadline_millis <= started_at ||
      action_deadline_millis - started_at > 5000 ||
      started_at + previous_offset > action_deadline_millis) {
    meta_executor_cancel(executor);
    return false;
  }
  MetaPointerEvent event = {
      .kind = META_POINTER_MOVE,
      .button = button,
      .x = trajectory[0].x,
      .y = trajectory[0].y,
      .flags = flags,
  };
  if (!meta_executor_post_pointer_event(executor, &event, "drag-start") ||
      !meta_executor_post_down(executor, META_EVENT_BUTTON,
                               (uint32_t)button)) {
    return false;
  }
  *completed_points = 1;
  for (size_t index = 1; index < point_count; index += 1) {
    if (!clock.wait_until(clock.context,
                          started_at + trajectory[index].offset_millis)) {
      meta_executor_cancel(executor);
      return false;
    }
    event.kind = META_POINTER_DRAG;
    event.x = trajectory[index].x;
    event.y = trajectory[index].y;
    char checkpoint[META_NATIVE_REF_CAPACITY] = {0};
    snprintf(checkpoint, sizeof(checkpoint), "drag-point-%zu", index + 1);
    if (!meta_executor_post_pointer_event(executor, &event, checkpoint)) {
      return false;
    }
    *completed_points += 1;
  }
  if (!meta_executor_post_up(executor, META_EVENT_BUTTON,
                             (uint32_t)button)) {
    return false;
  }
  return meta_executor_finish(executor);
}

bool meta_input_execute_text_schedule(
    MetaExecutor *executor,
    const MetaTextCluster *clusters,
    size_t cluster_count,
    uint64_t action_deadline_millis,
    MetaInputBridgeClock clock,
    MetaTextExecutionReport *report) {
  if (executor == NULL || report == NULL || clock.monotonic_millis == NULL ||
      clock.wait_until == NULL || cluster_count == 0 || cluster_count > 10000 ||
      (cluster_count > 0 && clusters == NULL)) {
    return false;
  }
  *report = (MetaTextExecutionReport){.total_clusters = cluster_count};
  size_t total_utf16 = 0;
  uint64_t previous_offset = 0;
  for (size_t index = 0; index < cluster_count; index += 1) {
    const MetaTextCluster *cluster = &clusters[index];
    if (cluster->utf16_units == NULL || cluster->utf16_count == 0 ||
        cluster->utf16_count > 10000 ||
        (index == 0 && cluster->offset_millis != 0) ||
        (index > 0 && cluster->offset_millis < previous_offset) ||
        cluster->offset_millis > 30000 ||
        total_utf16 + cluster->utf16_count > 10000) {
      meta_executor_cancel(executor);
      return false;
    }
    total_utf16 += cluster->utf16_count;
    previous_offset = cluster->offset_millis;
  }
  const uint64_t started_at = clock.monotonic_millis(clock.context);
  if (action_deadline_millis <= started_at ||
      action_deadline_millis - started_at > 30000) {
    meta_executor_cancel(executor);
    return false;
  }
  for (size_t index = 0; index < cluster_count; index += 1) {
    const MetaTextCluster *cluster = &clusters[index];
    const uint64_t cluster_deadline = started_at + cluster->offset_millis;
    if (cluster_deadline > action_deadline_millis ||
        !clock.wait_until(clock.context, cluster_deadline)) {
      meta_executor_cancel(executor);
      return false;
    }
    char checkpoint[META_NATIVE_REF_CAPACITY] = {0};
    snprintf(checkpoint, sizeof(checkpoint), "text-cluster-%zu", index + 1);
    if (!meta_executor_post_text_cluster(
            executor, cluster->utf16_units, cluster->utf16_count,
            checkpoint)) {
      return false;
    }
    report->completed_clusters += 1;
  }
  return meta_executor_finish(executor);
}
