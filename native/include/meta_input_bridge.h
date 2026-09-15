#ifndef META_INPUT_BRIDGE_H
#define META_INPUT_BRIDGE_H

#include "meta_native.h"

typedef struct {
  const uint16_t *utf16_units;
  size_t utf16_count;
  uint64_t offset_millis;
} MetaTextCluster;

typedef struct {
  void *context;
  uint64_t (*monotonic_millis)(void *context);
  bool (*wait_until)(void *context, uint64_t deadline_millis);
} MetaInputBridgeClock;

typedef struct {
  size_t completed_clusters;
  size_t total_clusters;
} MetaTextExecutionReport;

typedef struct {
  double x;
  double y;
  uint64_t offset_millis;
} MetaTimedPointerPoint;

typedef struct {
  uint32_t key_code;
  uint64_t flags;
  uint64_t offset_millis;
} MetaTimedKeyStroke;

bool meta_input_execute_key(MetaExecutor *executor,
                            uint32_t key_code,
                            uint64_t flags);
bool meta_input_execute_shortcut(MetaExecutor *executor,
                                 const MetaTimedKeyStroke *strokes,
                                 size_t stroke_count,
                                 uint64_t action_deadline_millis,
                                 MetaInputBridgeClock clock,
                                 size_t *completed_strokes);

bool meta_input_execute_hover(MetaExecutor *executor,
                              double x,
                              double y,
                              uint64_t flags);
bool meta_input_execute_click(MetaExecutor *executor,
                              double x,
                              double y,
                              MetaPointerButton button,
                              uint32_t count,
                              uint64_t flags);
bool meta_input_execute_scroll(MetaExecutor *executor,
                               MetaScrollEvent event);
bool meta_input_execute_drag(MetaExecutor *executor,
                             const MetaTimedPointerPoint *trajectory,
                             size_t point_count,
                             MetaPointerButton button,
                             uint64_t flags,
                             uint64_t action_deadline_millis,
                             MetaInputBridgeClock clock,
                             size_t *completed_points);

bool meta_input_execute_text_schedule(
    MetaExecutor *executor,
    const MetaTextCluster *clusters,
    size_t cluster_count,
    uint64_t action_deadline_millis,
    MetaInputBridgeClock clock,
    MetaTextExecutionReport *report);

#endif
