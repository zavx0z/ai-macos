#ifndef META_APPLICATION_CONTROLLER_H
#define META_APPLICATION_CONTROLLER_H

#include <stdbool.h>
#include <stdint.h>

#define META_APPLICATION_REF_CAPACITY 128
#define META_APPLICATION_BUNDLE_CAPACITY 256
#define META_APPLICATION_URL_CAPACITY 4096
#define META_APPLICATION_ERROR_CAPACITY 512

typedef struct {
  int32_t pid;
  uint64_t launch_time_micros;
  char bundle_id[META_APPLICATION_BUNDLE_CAPACITY];
} MetaApplicationProcess;

typedef enum {
  META_APPLICATION_LOOKUP_FOUND,
  META_APPLICATION_LOOKUP_ABSENT,
  META_APPLICATION_LOOKUP_FAILED,
} MetaApplicationLookupStatus;

typedef enum {
  META_APPLICATION_LAUNCH_ENQUEUED,
  META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH,
} MetaApplicationWorkspaceLaunchStart;

typedef enum {
  META_APPLICATION_LAUNCH_CALLBACK_COMPLETED,
  META_APPLICATION_LAUNCH_CALLBACK_FAILED,
} MetaApplicationWorkspaceLaunchCompletionStatus;

typedef enum {
  META_APPLICATION_ACTIVATION_SUCCEEDED,
  META_APPLICATION_ACTIVATION_TARGET_STALE,
  META_APPLICATION_ACTIVATION_EXPIRED,
  META_APPLICATION_ACTIVATION_FAILED,
} MetaApplicationActivationStatus;

typedef enum {
  META_APPLICATION_TERMINATE_ACCEPTED,
  META_APPLICATION_TERMINATE_REJECTED,
  META_APPLICATION_TERMINATE_TARGET_STALE,
  META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH,
  META_APPLICATION_TERMINATE_FAILED,
} MetaApplicationWorkspaceTerminateStatus;

typedef struct {
  char launch_task_ref[META_APPLICATION_REF_CAPACITY];
  char request_id[META_APPLICATION_REF_CAPACITY];
  char operation_id[META_APPLICATION_REF_CAPACITY];
  char runtime_epoch[65];
  char login_session_id[65];
  char native_generation[65];
  uint64_t fence_counter;
  char application_url[META_APPLICATION_URL_CAPACITY];
  char expected_bundle_id[META_APPLICATION_BUNDLE_CAPACITY];
  bool create_new_instance;
  bool activate;
  uint64_t deadline_millis;
} MetaApplicationLaunchRequest;

typedef enum {
  META_APPLICATION_LAUNCH_TASK_PENDING,
  META_APPLICATION_LAUNCH_TASK_WAITING_LATE_CALLBACK,
  META_APPLICATION_LAUNCH_TASK_COMPLETED,
  META_APPLICATION_LAUNCH_TASK_FAILED_AFTER_DISPATCH,
  META_APPLICATION_LAUNCH_TASK_REJECTED_NO_DISPATCH,
} MetaApplicationLaunchTaskState;

typedef struct {
  char launch_task_ref[META_APPLICATION_REF_CAPACITY];
  char request_id[META_APPLICATION_REF_CAPACITY];
  char operation_id[META_APPLICATION_REF_CAPACITY];
  char runtime_epoch[65];
  char login_session_id[65];
  char native_generation[65];
  uint64_t fence_counter;
  uint64_t revision;
  MetaApplicationLaunchTaskState state;
  bool mutation_attempted;
  bool cancellation_requested;
  bool timed_out;
  bool callback_received;
  bool drained;
  bool late_completion;
  bool process_present;
  bool reused_existing_process;
  bool activation_requested;
  bool activation_attempted;
  bool activation_succeeded;
  MetaApplicationProcess process;
  char error[META_APPLICATION_ERROR_CAPACITY];
} MetaApplicationLaunchTaskStatus;

typedef void (*MetaApplicationLaunchCompletion)(
    void *context,
    MetaApplicationWorkspaceLaunchCompletionStatus status,
    const MetaApplicationProcess *process,
    bool reused_existing_process,
    const char *error);

typedef struct {
  char application_ref[META_APPLICATION_REF_CAPACITY];
  char registration_nonce[65];
  MetaApplicationProcess process;
  uint64_t deadline_millis;
} MetaApplicationQuitRequest;

typedef enum {
  META_APPLICATION_QUIT_TERMINATED,
  META_APPLICATION_QUIT_STILL_RUNNING,
  META_APPLICATION_QUIT_TARGET_STALE,
  META_APPLICATION_QUIT_REJECTED,
  META_APPLICATION_QUIT_OUTCOME_UNKNOWN,
} MetaApplicationQuitOutcome;

typedef struct {
  MetaApplicationQuitOutcome outcome;
  bool mutation_attempted;
  bool termination_requested;
  bool process_running;
  bool attention_may_be_required;
  MetaApplicationProcess observed_process;
  char error[META_APPLICATION_ERROR_CAPACITY];
} MetaApplicationQuitResult;

typedef struct {
  void *context;
  uint64_t (*monotonic_millis)(void *context);
  MetaApplicationWorkspaceLaunchStart (*start_launch)(
      void *context,
      const MetaApplicationLaunchRequest *request,
      MetaApplicationLaunchCompletion completion,
      void *completion_context);
  MetaApplicationActivationStatus (*activate)(
      void *context,
      const MetaApplicationProcess *expected,
      uint64_t deadline_millis);
  MetaApplicationLookupStatus (*lookup)(
      void *context,
      int32_t pid,
      MetaApplicationProcess *process);
  MetaApplicationWorkspaceTerminateStatus (*terminate)(
      void *context,
      const MetaApplicationProcess *expected,
      uint64_t deadline_millis);
  void (*wait_millis)(void *context, uint64_t millis);
} MetaApplicationBackend;

typedef struct MetaApplicationLaunchTask MetaApplicationLaunchTask;

MetaApplicationLaunchTask *meta_application_launch_task_start(
    MetaApplicationBackend backend,
    const MetaApplicationLaunchRequest *request);

MetaApplicationLaunchTaskStatus meta_application_launch_task_status(
    MetaApplicationLaunchTask *task);

MetaApplicationLaunchTaskStatus meta_application_launch_task_wait(
    MetaApplicationLaunchTask *task,
    uint64_t wait_deadline_millis);

bool meta_application_launch_task_cancel(MetaApplicationLaunchTask *task);

bool meta_application_launch_task_release(MetaApplicationLaunchTask *task);

bool meta_application_quit(MetaApplicationBackend backend,
                           const MetaApplicationQuitRequest *request,
                           MetaApplicationQuitResult *result);

MetaApplicationBackend meta_application_system_backend(void);

#endif
