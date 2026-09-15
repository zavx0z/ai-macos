#ifndef META_OBSERVER_INDEX_BUILDER_H
#define META_OBSERVER_INDEX_BUILDER_H

#import <Foundation/Foundation.h>

#include "../observer-command/meta_observer_command.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSUInteger, MetaObserverIndexBuildStage) {
  MetaObserverIndexBuildStageReady,
  MetaObserverIndexBuildStageInvalidBackend,
  MetaObserverIndexBuildStageClockUnavailable,
  MetaObserverIndexBuildStageRefreshFailed,
  MetaObserverIndexBuildStageRefreshDeadline,
  MetaObserverIndexBuildStageSnapshotUnavailable,
  MetaObserverIndexBuildStageForegroundReceiptInvalid,
  MetaObserverIndexBuildStageRecordCapacity,
  MetaObserverIndexBuildStageRecordFailed,
  MetaObserverIndexBuildStageIndexDeadline,
  MetaObserverIndexBuildStageIndexPublicationFailed,
};

typedef struct {
  MetaObserverIndexBuildStage stage;
  uint64_t elapsed_millis;
  size_t ax_record_count;
  size_t failed_window_index;
  MetaObserverSnapshotDiagnostics snapshot;
} MetaObserverIndexBuildDiagnostics;

typedef struct {
  void *_Nullable context;
  uint64_t (*monotonic_millis)(void *context);
  bool (*refresh_inventory)(void *context, uint64_t budget_millis);
  const MetaInventorySnapshot *_Nullable (*_Nonnull snapshot)(void *context);
  bool (*snapshot_ready)(void *context,
                         const MetaInventorySnapshot *snapshot);
  bool (*snapshot_diagnostics)(
      void *context,
      const MetaInventorySnapshot *_Nullable snapshot,
      MetaObserverSnapshotDiagnostics *diagnostics);
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
    uint64_t index_revision,
    MetaObserverIndexBuildDiagnostics *_Nullable diagnostics);

NSString *meta_observer_index_build_failure_reason(
    const MetaObserverIndexBuildDiagnostics *diagnostics);

NS_ASSUME_NONNULL_END

#endif
