#ifndef META_POINT_TARGET_H
#define META_POINT_TARGET_H

#include <sys/types.h>

#include "meta_macos.h"

typedef struct {
  void *context;
  uint64_t (*monotonic_millis)(void *context);
  AXUIElementRef (*create_system_wide)(void *context);
  void (*set_messaging_timeout)(void *context, AXUIElementRef element,
                                double seconds);
  AXError (*copy_element_at_position)(void *context,
                                      AXUIElementRef system_wide,
                                      double x, double y,
                                      AXUIElementRef *element);
  AXError (*copy_parent)(void *context, AXUIElementRef element,
                         AXUIElementRef *parent);
  AXError (*get_pid)(void *context, AXUIElementRef element, pid_t *pid);
  bool (*equal)(void *context, AXUIElementRef left, AXUIElementRef right);
  void (*release)(void *context, AXUIElementRef element);
} MetaPointTargetBackend;

typedef enum {
  META_POINT_TARGET_RELATION_NONE,
  META_POINT_TARGET_RELATION_EXACT,
  META_POINT_TARGET_RELATION_OWNED_DESCENDANT,
} MetaPointTargetRelation;

// Используется только внутри meta_macos_with_ax_target callback. Borrow уже
// связывает AX element с current process incarnation и native generation.
bool meta_point_matches_borrow(const MetaAXTargetBorrow *borrow,
                               double x, double y);

MetaPointTargetRelation meta_point_relation_to_borrow(
    const MetaAXTargetBorrow *borrow,
    double x, double y);

// Тестовый seam сохраняет те же лимиты: 32 AX nodes, 500 ms whole deadline и
// не более 100 ms messaging timeout для каждого следующего AX call.
bool meta_point_matches_borrow_with_backend(
    const MetaAXTargetBorrow *borrow,
    double x, double y,
    MetaPointTargetBackend backend);

MetaPointTargetRelation meta_point_relation_to_borrow_with_backend(
    const MetaAXTargetBorrow *borrow,
    double x, double y,
    MetaPointTargetBackend backend);

#endif
