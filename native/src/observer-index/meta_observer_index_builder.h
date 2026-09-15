#ifndef META_OBSERVER_INDEX_BUILDER_H
#define META_OBSERVER_INDEX_BUILDER_H

#import <Foundation/Foundation.h>

#include "../observer-command/meta_observer_command.h"

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  void *_Nullable context;
  uint64_t (*monotonic_millis)(void *context);
  bool (*refresh_inventory)(void *context, uint64_t budget_millis);
  const MetaInventorySnapshot *_Nullable (*_Nonnull snapshot)(void *context);
  bool (*snapshot_ready)(void *context,
                         const MetaInventorySnapshot *snapshot);
  MetaObserverTargetRecord *_Nullable (*_Nonnull record_for_window)(
      void *context,
      const MetaWindowRecord *window,
      const MetaInventorySnapshot *snapshot,
      NSDictionary *generation);
} MetaObserverIndexBuilderBackend;

// Выполняет AX inventory slice не более 3.5s и оставляет не менее 2.5s
// outer 6s request для index publication, main-runloop subscription и ответа.
MetaObserverPreparedIndex *_Nullable meta_observer_build_current_index(
    MetaObserverIndexBuilderBackend backend,
    NSDictionary *generation,
    uint64_t index_revision);

NS_ASSUME_NONNULL_END

#endif
