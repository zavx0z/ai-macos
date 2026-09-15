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
  META_APPLICATION_LAUNCH_COMPLETED,
  META_APPLICATION_LAUNCH_TIMED_OUT,
  META_APPLICATION_LAUNCH_REJECTED,
  META_APPLICATION_LAUNCH_FAILED_AFTER_DISPATCH,
} MetaApplicationWorkspaceLaunchStatus;

typedef enum {
  META_APPLICATION_TERMINATE_ACCEPTED,
  META_APPLICATION_TERMINATE_REJECTED,
  META_APPLICATION_TERMINATE_TARGET_STALE,
  META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH,
  META_APPLICATION_TERMINATE_FAILED,
} MetaApplicationWorkspaceTerminateStatus;

typedef struct {
  char application_url[META_APPLICATION_URL_CAPACITY];
  char expected_bundle_id[META_APPLICATION_BUNDLE_CAPACITY];
  bool create_new_instance;
  bool activate;
  uint64_t deadline_millis;
} MetaApplicationLaunchRequest;

typedef enum {
  META_APPLICATION_LAUNCH_READY,
  META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH,
  META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN,
} MetaApplicationLaunchOutcome;

typedef struct {
  MetaApplicationLaunchOutcome outcome;
  bool mutation_attempted;
  bool process_present;
  bool reused_existing_process;
  MetaApplicationProcess process;
  char error[META_APPLICATION_ERROR_CAPACITY];
} MetaApplicationLaunchResult;

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
  MetaApplicationWorkspaceLaunchStatus (*launch)(
      void *context,
      const MetaApplicationLaunchRequest *request,
      MetaApplicationProcess *process,
      bool *reused_existing_process);
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

bool meta_application_launch(MetaApplicationBackend backend,
                             const MetaApplicationLaunchRequest *request,
                             MetaApplicationLaunchResult *result);

bool meta_application_quit(MetaApplicationBackend backend,
                           const MetaApplicationQuitRequest *request,
                           MetaApplicationQuitResult *result);

MetaApplicationBackend meta_application_system_backend(void);

#endif
