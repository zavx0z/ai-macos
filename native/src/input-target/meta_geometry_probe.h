#ifndef META_GEOMETRY_PROBE_H
#define META_GEOMETRY_PROBE_H

#include "meta_macos.h"

#define META_GEOMETRY_PROBE_MAX_DISPLAYS 64

typedef struct {
  MetaRect expected_frame;
  MetaRect actual_frame;
  bool frame_unchanged;
  bool topology_unchanged;
  uint64_t observed_at_unix_micros;
} MetaBorrowedGeometryProbe;

typedef struct {
  bool topology_unchanged;
  uint64_t observed_at_unix_micros;
} MetaTopologyProbe;

typedef struct {
  void *context;
  bool (*clock)(void *context, uint64_t *monotonic_millis,
                uint64_t *unix_micros);
  bool (*copy_ax_frame)(void *context, AXUIElementRef element,
                        uint64_t per_call_timeout_millis,
                        MetaRect *frame);
  bool (*current_displays)(void *context, MetaDisplayRecord *displays,
                           size_t capacity, size_t *count, bool *complete);
  AXError (*set_ax_timeout)(void *context, AXUIElementRef element,
                            uint64_t timeout_millis);
  AXError (*copy_ax_position)(void *context, AXUIElementRef element,
                              double *x, double *y);
  AXError (*copy_ax_size)(void *context, AXUIElementRef element,
                          double *width, double *height);
  bool (*current_topology_epoch)(void *context, uint64_t *epoch);
} MetaGeometryProbeBackend;

// Проверяет только fresh geometry относительно уже связанного snapshot.
// Capture metadata и point ownership проверяются отдельными владельцами.
bool meta_macos_probe_borrowed_geometry(
    MetaMacOSBackend *owner,
    const MetaAXTargetBorrow *borrow,
    const MetaInventorySnapshot *bound_snapshot,
    MetaBorrowedGeometryProbe *output);

bool meta_macos_probe_borrowed_geometry_with_backend(
    const MetaAXTargetBorrow *borrow,
    const MetaInventorySnapshot *bound_snapshot,
    MetaBorrowedGeometryProbe *output,
    MetaGeometryProbeBackend backend);

// Display и desktop-layout используют только полный topology snapshot.
// AX frame и window identity в этом пути отсутствуют.
bool meta_macos_probe_topology(
    MetaMacOSBackend *owner,
    const MetaInventorySnapshot *bound_snapshot,
    MetaTopologyProbe *output);

bool meta_macos_probe_topology_with_backend(
    const MetaInventorySnapshot *bound_snapshot,
    MetaTopologyProbe *output,
    MetaGeometryProbeBackend backend);

#endif
