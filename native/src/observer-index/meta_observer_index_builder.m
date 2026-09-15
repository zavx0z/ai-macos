#include "meta_observer_index_builder.h"

#include <stdint.h>

#define META_OBSERVER_INDEX_REFRESH_MILLIS 3500
#define META_OBSERVER_INDEX_TOTAL_MILLIS 4000

static void set_stage(MetaObserverIndexBuildDiagnostics *diagnostics,
                      MetaObserverIndexBuildStage stage,
                      uint64_t started,
                      uint64_t now) {
  if (diagnostics == NULL) return;
  diagnostics->stage = stage;
  diagnostics->elapsed_millis = now >= started ? now - started : 0;
}

static NSString *stage_name(MetaObserverIndexBuildStage stage) {
  switch (stage) {
    case MetaObserverIndexBuildStageReady: return @"ready";
    case MetaObserverIndexBuildStageInvalidBackend: return @"invalid-backend";
    case MetaObserverIndexBuildStageClockUnavailable: return @"clock-unavailable";
    case MetaObserverIndexBuildStageRefreshFailed: return @"refresh-failed";
    case MetaObserverIndexBuildStageRefreshDeadline: return @"refresh-deadline";
    case MetaObserverIndexBuildStageSnapshotUnavailable: return @"snapshot-unavailable";
    case MetaObserverIndexBuildStageForegroundReceiptInvalid: return @"foreground-receipt-invalid";
    case MetaObserverIndexBuildStageRecordCapacity: return @"record-capacity";
    case MetaObserverIndexBuildStageRecordFailed: return @"record-failed";
    case MetaObserverIndexBuildStageIndexDeadline: return @"index-deadline";
    case MetaObserverIndexBuildStageIndexPublicationFailed: return @"index-publication-failed";
  }
  return @"unknown";
}

static NSString *ax_status_name(MetaAXStatus status) {
  switch (status) {
    case META_AX_READY: return @"ready";
    case META_AX_NO_WINDOWS: return @"no-windows";
    case META_AX_TIMED_OUT: return @"timed-out";
    case META_AX_DENIED: return @"denied";
    case META_AX_UNAVAILABLE: return @"unavailable";
    case META_AX_FAILED: return @"failed";
  }
  return @"unknown";
}

NSString *meta_observer_index_build_failure_reason(
    const MetaObserverIndexBuildDiagnostics *diagnostics) {
  if (diagnostics == NULL) return @"Observer index diagnostics недоступны";
  MetaObserverSnapshotDiagnostics snapshot = diagnostics->snapshot;
  NSString *failedWindow = diagnostics->failed_window_index == SIZE_MAX
      ? @"none"
      : [NSString stringWithFormat:@"%zu",
                                   diagnostics->failed_window_index];
  return [NSString stringWithFormat:
      @"Observer index stage=%@ elapsedMs=%llu snapshotRevision=%llu snapshotComplete=%@ applications=%zu windows=%zu axRecords=%zu foregroundPid=%d foregroundBirthMicros=%llu foregroundAxStatus=%@ receiptMatches=%@ failedWindowIndex=%@",
      stage_name(diagnostics->stage),
      (unsigned long long)diagnostics->elapsed_millis,
      (unsigned long long)snapshot.snapshot_revision,
      snapshot.snapshot_complete ? @"true" : @"false",
      snapshot.application_count, snapshot.window_count,
      diagnostics->ax_record_count, snapshot.foreground_pid,
      (unsigned long long)snapshot.foreground_launch_time_micros,
      ax_status_name(snapshot.foreground_ax_status),
      snapshot.receipt_matches ? @"true" : @"false", failedWindow];
}

MetaObserverPreparedIndex *meta_observer_build_current_index(
    MetaObserverIndexBuilderBackend backend,
    NSDictionary *generation,
    uint64_t index_revision,
    MetaObserverIndexBuildDiagnostics *diagnostics) {
  if (diagnostics != NULL) {
    *diagnostics = (MetaObserverIndexBuildDiagnostics){
        .stage = MetaObserverIndexBuildStageInvalidBackend,
        .failed_window_index = SIZE_MAX,
        .snapshot = {.foreground_ax_status = META_AX_UNAVAILABLE},
    };
  }
  if (backend.monotonic_millis == NULL ||
      backend.refresh_inventory == NULL || backend.snapshot == NULL ||
      backend.snapshot_ready == NULL || backend.snapshot_diagnostics == NULL ||
      backend.record_for_window == NULL ||
      ![generation isKindOfClass:NSDictionary.class] || index_revision == 0) {
    return nil;
  }
  const uint64_t started = backend.monotonic_millis(backend.context);
  if (started == 0 || started > UINT64_MAX - META_OBSERVER_INDEX_TOTAL_MILLIS) {
    set_stage(diagnostics, MetaObserverIndexBuildStageClockUnavailable,
              started, started);
    return nil;
  }
  const uint64_t deadline = started + META_OBSERVER_INDEX_TOTAL_MILLIS;
  if (!backend.refresh_inventory(backend.context,
                                 META_OBSERVER_INDEX_REFRESH_MILLIS)) {
    if (diagnostics != NULL) {
      backend.snapshot_diagnostics(backend.context, NULL,
                                   &diagnostics->snapshot);
    }
    set_stage(diagnostics, MetaObserverIndexBuildStageRefreshFailed, started,
              backend.monotonic_millis(backend.context));
    return nil;
  }
  uint64_t current = backend.monotonic_millis(backend.context);
  if (current >= deadline) {
    set_stage(diagnostics, MetaObserverIndexBuildStageRefreshDeadline,
              started, current);
    return nil;
  }
  const MetaInventorySnapshot *snapshot = backend.snapshot(backend.context);
  if (snapshot == NULL) {
    set_stage(diagnostics, MetaObserverIndexBuildStageSnapshotUnavailable,
              started, current);
    return nil;
  }
  if (diagnostics != NULL) {
    backend.snapshot_diagnostics(backend.context, snapshot,
                                 &diagnostics->snapshot);
  }
  if (!backend.snapshot_ready(backend.context, snapshot)) {
    set_stage(diagnostics,
              MetaObserverIndexBuildStageForegroundReceiptInvalid,
              started, current);
    return nil;
  }
  NSMutableArray<MetaObserverTargetRecord *> *records = [NSMutableArray array];
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    current = backend.monotonic_millis(backend.context);
    if (current >= deadline) {
      set_stage(diagnostics, MetaObserverIndexBuildStageIndexDeadline,
                started, current);
      return nil;
    }
    const MetaWindowRecord *window = &snapshot->windows[index];
    if (window->surface_kind != META_SURFACE_WINDOW &&
        window->surface_kind != META_SURFACE_SHEET) continue;
    if (window->actionability != META_ACTIONABILITY_AX ||
        window->target_ref[0] == '\0') continue;
    if (records.count >= META_OBSERVER_TARGET_INDEX_MAX_RECORDS) {
      set_stage(diagnostics, MetaObserverIndexBuildStageRecordCapacity,
                started, current);
      return nil;
    }
    MetaObserverTargetRecord *record = backend.record_for_window(
        backend.context, window, snapshot, generation);
    if (record == nil) {
      if (diagnostics != NULL) diagnostics->failed_window_index = index;
      set_stage(diagnostics, MetaObserverIndexBuildStageRecordFailed,
                started, current);
      return nil;
    }
    [records addObject:record];
    if (diagnostics != NULL) diagnostics->ax_record_count = records.count;
  }
  current = backend.monotonic_millis(backend.context);
  if (current >= deadline) {
    set_stage(diagnostics, MetaObserverIndexBuildStageIndexDeadline,
              started, current);
    return nil;
  }
  MetaObserverTargetIndex *index = [[MetaObserverTargetIndex alloc] init];
  if (![index replaceRecords:records]) {
    set_stage(diagnostics,
              MetaObserverIndexBuildStageIndexPublicationFailed,
              started, current);
    return nil;
  }
  MetaObserverPreparedIndex *prepared = meta_observer_prepared_index_create(
      index, @(snapshot->inventory_id), snapshot->revision, index_revision);
  set_stage(diagnostics,
            prepared == nil ? MetaObserverIndexBuildStageIndexPublicationFailed
                            : MetaObserverIndexBuildStageReady,
            started, backend.monotonic_millis(backend.context));
  return prepared;
}
