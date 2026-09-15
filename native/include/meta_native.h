#ifndef META_NATIVE_H
#define META_NATIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define META_NATIVE_REF_CAPACITY 128
#define META_NATIVE_TEXT_CAPACITY 256
#define META_NATIVE_ABI_VERSION 2

typedef enum {
  META_UNKNOWN = -1,
  META_FALSE = 0,
  META_TRUE = 1,
} MetaTriState;

typedef enum {
  META_AX_READY,
  META_AX_NO_WINDOWS,
  META_AX_TIMED_OUT,
  META_AX_DENIED,
  META_AX_UNAVAILABLE,
  META_AX_FAILED,
} MetaAXStatus;

typedef enum {
  META_MAPPING_CORROBORATED,
  META_MAPPING_AMBIGUOUS,
  META_MAPPING_UNAVAILABLE,
} MetaMappingStatus;

typedef enum {
  META_SPACE_CURRENT,
  META_SPACE_NOT_CURRENT,
  META_SPACE_UNKNOWN,
} MetaSpaceVisibility;

typedef enum {
  META_ACTIONABILITY_AX,
  META_ACTIONABILITY_UNAVAILABLE,
} MetaActionability;

typedef enum {
  META_SURFACE_WINDOW,
  META_SURFACE_SHEET,
  META_SURFACE_POPUP,
  META_SURFACE_MENU,
  META_SURFACE_UNKNOWN,
} MetaSurfaceKind;

typedef struct {
  double x;
  double y;
  double width;
  double height;
} MetaRect;

typedef struct {
  int32_t pid;
  uint64_t launch_time_micros;
  const char *name;
  const char *bundle_id;
  MetaTriState hidden;
  MetaAXStatus ax_status;
} MetaApplicationInput;

typedef struct {
  int32_t pid;
  uint64_t launch_time_micros;
  uint64_t ax_token;
  uint64_t owner_ax_token;
  const char *title;
  const char *role;
  const char *subrole;
  MetaRect frame;
  MetaSurfaceKind surface_kind;
  MetaTriState minimized;
  MetaTriState fullscreen;
  MetaTriState focused;
  MetaTriState main;
  bool can_raise;
  bool can_close;
  bool can_minimize;
  bool can_move;
  bool can_resize;
} MetaAXWindowInput;

typedef struct {
  uint32_t window_id;
  int32_t pid;
  const char *title;
  MetaRect frame;
  MetaTriState on_screen;
} MetaCGWindowInput;

typedef struct {
  uint32_t display_id;
  MetaRect bounds;
  MetaRect usable_bounds;
  double scale;
  double rotation_degrees;
  bool main;
} MetaDisplayInput;

typedef struct {
  const MetaApplicationInput *applications;
  size_t application_count;
  const MetaAXWindowInput *ax_windows;
  size_t ax_window_count;
  const MetaCGWindowInput *cg_windows;
  size_t cg_window_count;
  const MetaDisplayInput *displays;
  size_t display_count;
  bool source_complete;
  uint64_t captured_at_micros;
} MetaInventoryInput;

typedef struct {
  char application_ref[META_NATIVE_REF_CAPACITY];
  char registration_nonce[65];
  int32_t pid;
  uint64_t launch_time_micros;
  char name[META_NATIVE_TEXT_CAPACITY];
  char bundle_id[META_NATIVE_TEXT_CAPACITY];
  MetaTriState hidden;
  MetaAXStatus ax_status;
  size_t window_count;
} MetaApplicationRecord;

typedef struct {
  char target_ref[META_NATIVE_REF_CAPACITY];
  char window_ref[META_NATIVE_REF_CAPACITY];
  char surface_ref[META_NATIVE_REF_CAPACITY];
  char application_ref[META_NATIVE_REF_CAPACITY];
  char owner_window_ref[META_NATIVE_REF_CAPACITY];
  uint64_t ax_token;
  uint32_t cg_window_id;
  int32_t pid;
  char title[META_NATIVE_TEXT_CAPACITY];
  char role[64];
  char subrole[64];
  MetaRect frame;
  MetaSurfaceKind surface_kind;
  MetaTriState application_hidden;
  MetaTriState minimized;
  MetaTriState on_screen;
  MetaSpaceVisibility space_visibility;
  MetaTriState fullscreen;
  MetaTriState focused;
  MetaTriState main;
  MetaMappingStatus mapping;
  MetaActionability actionability;
  bool can_raise;
  bool can_close;
  bool can_minimize;
  bool can_move;
  bool can_resize;
} MetaWindowRecord;

typedef struct {
  char display_ref[META_NATIVE_REF_CAPACITY];
  uint32_t display_id;
  MetaRect bounds;
  MetaRect usable_bounds;
  double scale;
  double rotation_degrees;
  bool main;
} MetaDisplayRecord;

typedef struct {
  char inventory_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t revision;
  uint64_t display_layout_revision;
  uint64_t captured_at_micros;
  bool complete;
  const MetaApplicationRecord *applications;
  size_t application_count;
  const MetaWindowRecord *windows;
  size_t window_count;
  const MetaDisplayRecord *displays;
  size_t display_count;
} MetaInventorySnapshot;

typedef struct MetaRegistry MetaRegistry;

typedef struct {
  void *context;
  void *(*allocate_zeroed)(void *context, size_t count, size_t size);
  void *(*resize)(void *context, void *pointer, size_t size);
  void (*release)(void *context, void *pointer);
} MetaRegistryAllocator;

MetaRegistry *meta_registry_create(const char *native_generation);
MetaRegistry *meta_registry_create_with_allocator(
    const char *native_generation, MetaRegistryAllocator allocator);
void meta_registry_destroy(MetaRegistry *registry);
bool meta_registry_refresh(MetaRegistry *registry,
                           const MetaInventoryInput *input);
const MetaInventorySnapshot *meta_registry_snapshot(const MetaRegistry *registry);
const MetaWindowRecord *meta_registry_resolve_window(
    const MetaRegistry *registry, const char *window_ref);
const MetaWindowRecord *meta_registry_resolve_surface(
    const MetaRegistry *registry, const char *surface_ref);
const MetaWindowRecord *meta_registry_resolve_target(
    const MetaRegistry *registry, const char *target_ref);
const MetaApplicationRecord *meta_registry_resolve_application(
    const MetaRegistry *registry, const char *application_ref);

typedef enum {
  META_LEDGER_PENDING_DOWN,
  META_LEDGER_CONFIRMED_DOWN,
  META_LEDGER_PENDING_UP,
  META_LEDGER_RELEASED,
  META_LEDGER_UNCERTAIN,
} MetaLedgerState;

typedef enum {
  META_EXECUTOR_IDLE,
  META_EXECUTOR_DISPATCHING,
  META_EXECUTOR_CANCELLING,
  META_EXECUTOR_CANCELLED,
  META_EXECUTOR_FINISHED,
  META_EXECUTOR_FAILED,
  META_EXECUTOR_INTERRUPTED_UNKNOWN,
  META_EXECUTOR_QUARANTINED,
} MetaExecutorState;

typedef enum {
  META_DISPATCH_NONE,
  META_DISPATCH_ATTEMPTED,
  META_DISPATCH_PARTIAL,
  META_DISPATCH_FINISHED,
  META_DISPATCH_UNKNOWN,
} MetaDispatchState;

typedef enum {
  META_CLEANUP_COMPLETE,
  META_CLEANUP_INCOMPLETE,
  META_CLEANUP_UNKNOWN,
} MetaCleanupState;

typedef enum {
  META_OBSERVER_READY,
  META_OBSERVER_UNAVAILABLE,
  META_OBSERVER_REVOKED,
} MetaObserverState;

typedef enum {
  META_VERIFICATION_UNKNOWN,
  META_VERIFICATION_VERIFIED,
  META_VERIFICATION_FAILED,
} MetaVerificationState;

typedef enum {
  META_INTERFERENCE_UNKNOWN,
  META_INTERFERENCE_NONE_OBSERVED,
  META_INTERFERENCE_OBSERVED,
} MetaInterferenceState;

typedef enum {
  META_EVENT_KEY,
  META_EVENT_BUTTON,
} MetaHeldEventKind;

typedef enum {
  META_POINTER_MOVE,
  META_POINTER_DRAG,
} MetaPointerEventKind;

typedef enum {
  META_POINTER_LEFT,
  META_POINTER_RIGHT,
  META_POINTER_MIDDLE,
} MetaPointerButton;

typedef enum {
  META_SCROLL_LINE,
  META_SCROLL_PIXEL,
} MetaScrollUnit;

typedef struct {
  MetaPointerEventKind kind;
  MetaPointerButton button;
  double x;
  double y;
  uint64_t flags;
} MetaPointerEvent;

typedef struct {
  double x;
  double y;
  double dx;
  double dy;
  MetaScrollUnit unit;
  uint64_t flags;
} MetaScrollEvent;

typedef struct {
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t counter;
} MetaFence;

typedef struct {
  uint64_t sequence;
  MetaHeldEventKind kind;
  uint32_t code;
  MetaLedgerState state;
} MetaLedgerEntry;

typedef struct {
  char operation_id[META_NATIVE_REF_CAPACITY];
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t revision;
  bool has_previous_snapshot_sha256;
  char previous_snapshot_sha256[65];
  const MetaLedgerEntry *entries;
  size_t entry_count;
} MetaHeldInputLedgerSnapshot;

typedef struct {
  char request_id[META_NATIVE_REF_CAPACITY];
  MetaHeldInputLedgerSnapshot snapshot;
} MetaLedgerPersistenceRequest;

typedef struct {
  char request_id[META_NATIVE_REF_CAPACITY];
  char operation_id[META_NATIVE_REF_CAPACITY];
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t revision;
  char snapshot_sha256[65];
  uint64_t persisted_at_unix_micros;
  bool durable;
} MetaLedgerPersistenceAck;

typedef struct {
  MetaExecutorState execution;
  MetaDispatchState dispatch;
  MetaCleanupState cleanup;
  char operation_id[META_NATIVE_REF_CAPACITY];
  MetaFence high_water_fence;
  MetaFence accepted_fence;
  bool has_high_water_fence;
  bool has_accepted_fence;
  char last_checkpoint[META_NATIVE_REF_CAPACITY];
  MetaVerificationState target_verification;
  MetaInterferenceState user_interference;
  bool cancellation_requested;
  bool restoration_allowed;
  bool quarantined;
  size_t held_count;
  uint64_t dispatch_attempts;
  uint64_t ledger_revision;
  MetaObserverState observer_state;
} MetaExecutorStatus;

typedef struct {
  void *context;
  uint64_t (*monotonic_millis)(void *context);
  bool (*verify_target)(void *context, const char *target_ref);
  bool (*persist_ledger)(void *context,
                         const MetaLedgerPersistenceRequest *request,
                         MetaLedgerPersistenceAck *ack);
  bool (*post_held_event)(void *context, MetaHeldEventKind kind, uint32_t code,
                          bool down, uint64_t synthetic_tag);
  bool (*post_text_cluster)(void *context, const uint16_t *utf16_units,
                            size_t utf16_count, uint64_t synthetic_tag);
  bool (*post_pointer_event)(void *context,
                             const MetaPointerEvent *event,
                             uint64_t synthetic_tag);
  bool (*post_scroll_event)(void *context,
                            const MetaScrollEvent *event,
                            uint64_t synthetic_tag);
  bool (*set_event_flags)(void *context, uint64_t flags);
} MetaExecutorBackend;

typedef struct MetaExecutor MetaExecutor;

typedef struct {
  bool present;
  char recovery_id[META_NATIVE_REF_CAPACITY];
  char operation_id[META_NATIVE_REF_CAPACITY];
  char source_runtime_epoch[META_NATIVE_REF_CAPACITY];
  char source_login_session_id[META_NATIVE_REF_CAPACITY];
  char source_native_generation[META_NATIVE_REF_CAPACITY];
  uint64_t ledger_revision;
  size_t held_count;
  MetaCleanupState cleanup;
  bool quarantined;
} MetaRecoveryLedgerStatus;

MetaExecutor *meta_executor_create(const char *native_generation,
                                   uint64_t watchdog_timeout_millis,
                                   MetaExecutorBackend backend);
void meta_executor_destroy(MetaExecutor *executor);
bool meta_executor_open_runtime_epoch(MetaExecutor *executor,
                                      const char *runtime_epoch,
                                      const char *login_session_id);
bool meta_executor_restore_ledger(
    MetaExecutor *executor,
    const MetaHeldInputLedgerSnapshot *persisted_snapshot);
bool meta_executor_begin(MetaExecutor *executor, const char *operation_id,
                         const char *target_ref, MetaFence fence,
                         uint64_t deadline_millis);
bool meta_executor_checkpoint(MetaExecutor *executor, const char *stage);
bool meta_executor_post_down(MetaExecutor *executor, MetaHeldEventKind kind,
                             uint32_t code);
bool meta_executor_post_up(MetaExecutor *executor, MetaHeldEventKind kind,
                           uint32_t code);
bool meta_executor_post_text_cluster(MetaExecutor *executor,
                                     const uint16_t *utf16_units,
                                     size_t utf16_count,
                                     const char *checkpoint);
bool meta_executor_post_pointer_event(MetaExecutor *executor,
                                      const MetaPointerEvent *event,
                                      const char *checkpoint);
bool meta_executor_post_scroll_event(MetaExecutor *executor,
                                     const MetaScrollEvent *event,
                                     const char *checkpoint);
bool meta_executor_set_event_flags(MetaExecutor *executor,
                                   uint64_t flags,
                                   const char *checkpoint);
bool meta_executor_finish(MetaExecutor *executor);
bool meta_executor_cancel(MetaExecutor *executor);
bool meta_executor_cancel_operation(MetaExecutor *executor,
                                    const char *operation_id,
                                    MetaFence accepted_fence);
bool meta_executor_advance_fence(MetaExecutor *executor,
                                 MetaFence high_water_fence);
bool meta_executor_heartbeat(MetaExecutor *executor,
                             const char *runtime_epoch,
                             const char *login_session_id);
bool meta_executor_watchdog_tick(MetaExecutor *executor);
void meta_executor_set_observer_state(MetaExecutor *executor,
                                      MetaObserverState state);
bool meta_executor_note_observed_event(MetaExecutor *executor,
                                       uint64_t synthetic_tag);
uint64_t meta_executor_synthetic_tag(const MetaExecutor *executor);
MetaExecutorStatus meta_executor_status(const MetaExecutor *executor);
MetaRecoveryLedgerStatus meta_executor_recovery_status(
    const MetaExecutor *executor);
size_t meta_executor_copy_ledger(const MetaExecutor *executor,
                                 MetaLedgerEntry *entries, size_t capacity);

#endif
