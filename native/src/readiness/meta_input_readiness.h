#ifndef META_INPUT_READINESS_H
#define META_INPUT_READINESS_H

#include "meta_native.h"

#define META_READINESS_REASON_CAPACITY 1025

typedef enum {
  META_READINESS_LOCK_UNKNOWN,
  META_READINESS_LOCK_LOCKED,
} MetaReadinessLockState;

typedef enum {
  META_READINESS_SECURE_INPUT_UNKNOWN,
  META_READINESS_SECURE_INPUT_OFF,
  META_READINESS_SECURE_INPUT_ON,
} MetaReadinessSecureInputState;

typedef enum {
  META_READINESS_SCAN_OWN_EVENT_ONLY,
  META_READINESS_SCAN_NO_EVENTS,
  META_READINESS_SCAN_USER_TAKEOVER,
  META_READINESS_SCAN_UNKNOWN,
} MetaReadinessScanState;

typedef enum {
  META_READINESS_RESTORE_NOT_ATTEMPTED,
  META_READINESS_RESTORE_RESTORED,
  META_READINESS_RESTORE_SKIPPED_USER_TAKEOVER,
  META_READINESS_RESTORE_FAILED,
  META_READINESS_RESTORE_UNKNOWN,
} MetaReadinessRestorationState;

typedef struct {
  bool audit_identity_verified;
  bool audit_session_matches;
  uint32_t real_uid;
  uint32_t effective_uid;
  uint32_t audit_uid;
  uint32_t session_uid;
  bool active_console;
  bool on_console;
  bool login_done;
  MetaReadinessLockState lock_state;
  MetaReadinessSecureInputState secure_input;
} MetaReadinessSessionFacts;

typedef struct {
  bool accessibility;
  bool post_events;
  bool listen_events;
} MetaReadinessPermissions;

typedef struct {
  double x;
  double y;
} MetaReadinessPoint;

typedef struct {
  char display_ref[META_NATIVE_REF_CAPACITY];
  MetaRect bounds;
} MetaReadinessDisplay;

typedef struct {
  bool ready;
  bool continuous;
  bool gap_detected;
  char cursor[META_NATIVE_REF_CAPACITY];
} MetaReadinessObserverSnapshot;

typedef struct {
  MetaReadinessScanState state;
  uint64_t synthetic_tag;
  char cursor[META_NATIVE_REF_CAPACITY];
} MetaReadinessEventScan;

typedef struct {
  bool input_ready;
  bool quarantined;
  bool move_posted;
  bool move_observed;
  bool move_readback_confirmed;
  bool restore_posted;
  bool restore_observed;
  bool restore_readback_confirmed;
  MetaDispatchState dispatch;
  MetaCleanupState cleanup;
  MetaInterferenceState interference;
  MetaReadinessRestorationState restoration;
  MetaReadinessPoint original_cursor;
  MetaReadinessPoint probe_cursor;
  char display_ref[META_NATIVE_REF_CAPACITY];
  char reason[META_READINESS_REASON_CAPACITY];
} MetaInputReadinessResult;

typedef struct {
  void *context;
  bool (*read_session)(void *context, MetaReadinessSessionFacts *facts);
  bool (*read_permissions)(void *context,
                           MetaReadinessPermissions *permissions);
  bool (*read_observer)(void *context,
                        MetaReadinessObserverSnapshot *snapshot);
  bool (*read_cursor)(void *context, MetaReadinessPoint *point);
  bool (*resolve_display)(void *context, MetaReadinessPoint point,
                          MetaReadinessDisplay *display);
  // Сканирование выполняет bounded wait и возвращает только события после
  // exact opaque cursor. require_own_event запрещает NO_EVENTS.
  bool (*scan_events)(void *context, const char *after_cursor,
                      uint64_t expected_synthetic_tag,
                      bool require_own_event, uint64_t timeout_millis,
                      MetaReadinessEventScan *scan);
} MetaInputReadinessBackend;

// Выполняется только внутри уже принятой native operation на том же parent
// MetaExecutor. Модуль не создаёт executor и не отправляет CGEvent напрямую.
bool meta_input_readiness_probe_active(MetaExecutor *executor,
                                       const char *expected_display_ref,
                                       MetaInputReadinessBackend backend,
                                       MetaInputReadinessResult *result);

#endif
