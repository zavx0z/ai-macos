#include "meta_inventory_priority.h"

#include <string.h>

static bool matches(const MetaInventoryPriorityCandidate *candidate,
                    const MetaInventoryPriority *priority) {
  if (priority == NULL) return false;
  const bool constrained = priority->has_pid || priority->has_launch_time ||
                           (priority->name != NULL && priority->name[0] != '\0');
  if (!constrained) return false;
  if (priority->has_pid && candidate->pid != priority->pid) return false;
  if (priority->has_launch_time &&
      candidate->launch_time_micros != priority->launch_time_micros) {
    return false;
  }
  if (priority->name != NULL && priority->name[0] != '\0' &&
      (candidate->name == NULL || strcmp(candidate->name, priority->name) != 0)) {
    return false;
  }
  return true;
}

bool meta_inventory_priority_order(
    const MetaInventoryPriorityCandidate *candidates,
    size_t count,
    const MetaInventoryPriority *priority,
    size_t *indices,
    size_t capacity) {
  if ((count > 0 && (candidates == NULL || indices == NULL)) ||
      capacity < count) {
    return false;
  }
  size_t output = 0;
  for (size_t index = 0; index < count; index += 1) {
    if (candidates[index].foreground) indices[output++] = index;
  }
  for (size_t index = 0; index < count; index += 1) {
    if (!candidates[index].foreground && matches(&candidates[index], priority)) {
      indices[output++] = index;
    }
  }
  for (size_t index = 0; index < count; index += 1) {
    if (!candidates[index].foreground &&
        !matches(&candidates[index], priority)) {
      indices[output++] = index;
    }
  }
  return output == count;
}
