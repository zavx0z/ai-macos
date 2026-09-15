#include "meta_observer_index_builder.h"

#define META_OBSERVER_INDEX_REFRESH_MILLIS 3500
#define META_OBSERVER_INDEX_TOTAL_MILLIS 4000

MetaObserverPreparedIndex *meta_observer_build_current_index(
    MetaObserverIndexBuilderBackend backend,
    NSDictionary *generation,
    uint64_t index_revision) {
  if (backend.monotonic_millis == NULL ||
      backend.refresh_inventory == NULL || backend.snapshot == NULL ||
      backend.snapshot_ready == NULL || backend.record_for_window == NULL ||
      ![generation isKindOfClass:NSDictionary.class] || index_revision == 0) {
    return nil;
  }
  const uint64_t started = backend.monotonic_millis(backend.context);
  if (started == 0 || started > UINT64_MAX - META_OBSERVER_INDEX_TOTAL_MILLIS)
    return nil;
  const uint64_t deadline = started + META_OBSERVER_INDEX_TOTAL_MILLIS;
  if (!backend.refresh_inventory(backend.context,
                                 META_OBSERVER_INDEX_REFRESH_MILLIS) ||
      backend.monotonic_millis(backend.context) >= deadline) return nil;
  const MetaInventorySnapshot *snapshot = backend.snapshot(backend.context);
  if (snapshot == NULL ||
      !backend.snapshot_ready(backend.context, snapshot)) return nil;
  NSMutableArray<MetaObserverTargetRecord *> *records = [NSMutableArray array];
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    if (backend.monotonic_millis(backend.context) >= deadline) return nil;
    const MetaWindowRecord *window = &snapshot->windows[index];
    if (window->surface_kind != META_SURFACE_WINDOW &&
        window->surface_kind != META_SURFACE_SHEET) continue;
    if (window->actionability != META_ACTIONABILITY_AX ||
        window->target_ref[0] == '\0') continue;
    if (records.count >= META_OBSERVER_TARGET_INDEX_MAX_RECORDS) return nil;
    MetaObserverTargetRecord *record = backend.record_for_window(
        backend.context, window, snapshot, generation);
    if (record == nil) return nil;
    [records addObject:record];
  }
  if (backend.monotonic_millis(backend.context) >= deadline) return nil;
  MetaObserverTargetIndex *index = [[MetaObserverTargetIndex alloc] init];
  if (![index replaceRecords:records]) return nil;
  return meta_observer_prepared_index_create(
      index, @(snapshot->inventory_id), snapshot->revision, index_revision);
}
