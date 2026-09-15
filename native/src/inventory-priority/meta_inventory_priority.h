#ifndef META_INVENTORY_PRIORITY_H
#define META_INVENTORY_PRIORITY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  int32_t pid;
  uint64_t launch_time_micros;
  const char *name;
  bool foreground;
} MetaInventoryPriorityCandidate;

typedef struct {
  bool has_pid;
  int32_t pid;
  bool has_launch_time;
  uint64_t launch_time_micros;
  const char *name;
} MetaInventoryPriority;

// Возвращает стабильный порядок: foreground, совпавший scheduling hint, rest.
// Hint не фильтрует кандидатов и не является identity authority.
bool meta_inventory_priority_order(
    const MetaInventoryPriorityCandidate *candidates,
    size_t count,
    const MetaInventoryPriority *priority,
    size_t *indices,
    size_t capacity);

#endif
