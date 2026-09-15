#ifndef META_CURSOR_DISPLAY_H
#define META_CURSOR_DISPLAY_H

#import <Foundation/Foundation.h>

#include "../input-target/meta_geometry_probe.h"

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  void *_Nullable context;
  const MetaInventorySnapshot *_Nullable (*_Nullable snapshot)(void *context);
  bool (*_Nullable probe_topology)(void *context,
                                   const MetaInventorySnapshot *snapshot,
                                   MetaTopologyProbe *output);
  bool (*_Nullable current_topology_epoch)(void *context, uint64_t *epoch);
  bool (*_Nullable read_cursor)(void *context, double *x, double *y);
} MetaCursorDisplayBackend;

// Возвращает удерживаемое JSON-значение и никогда не создаёт новый display identity.
NSDictionary *_Nullable meta_cursor_display_read(
    MetaMacOSBackend *owner,
    NSDictionary *trustedGeneration,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t displayLayoutRevision);

NSDictionary *_Nullable meta_cursor_display_read_with_backend(
    NSDictionary *trustedGeneration,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t displayLayoutRevision,
    MetaCursorDisplayBackend backend);

NS_ASSUME_NONNULL_END

#endif
