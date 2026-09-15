#ifndef META_CAPTURE_ROUTER_H
#define META_CAPTURE_ROUTER_H

#include "../src/capture/meta_capture.h"
#include "meta_native.h"

typedef struct {
  void *context;
  MetaCaptureTaskRef (*start)(void *context,
                              const MetaCaptureRequest *request,
                              dispatch_queue_t callback_queue,
                              MetaCaptureCompletion completion);
  void (*cancel)(void *context, MetaCaptureTaskRef task);
  bool (*status)(void *context, MetaCaptureTaskRef task,
                 MetaCaptureTaskStatus *status);
  void (*release_task)(void *context, MetaCaptureTaskRef task);
  void (*release_result)(void *context, MetaCaptureResult *result);
} MetaCaptureRouterBackend;

typedef struct MetaCaptureRouter MetaCaptureRouter;

MetaCaptureRouterBackend meta_capture_router_default_backend(void);

MetaCaptureRouter *meta_capture_router_create(
    const char *native_generation,
    MetaCaptureRouterBackend backend);
void meta_capture_router_destroy(MetaCaptureRouter *router);
bool meta_capture_router_seal_for_rotation(MetaCaptureRouter *router);
bool meta_capture_router_start(
    MetaCaptureRouter *router,
    const char *operation_id,
    const MetaCaptureRequest *request,
    char task_ref[META_NATIVE_REF_CAPACITY],
    MetaCaptureTaskStatus *status);
bool meta_capture_router_status(MetaCaptureRouter *router,
                                const char *task_ref,
                                MetaCaptureTaskStatus *status);
bool meta_capture_router_result(MetaCaptureRouter *router,
                                const char *task_ref,
                                MetaCaptureTaskStatus *status,
                                const MetaCaptureResult **result);
bool meta_capture_router_result_done(MetaCaptureRouter *router,
                                     const char *task_ref,
                                     const MetaCaptureResult *result);
bool meta_capture_router_cancel(MetaCaptureRouter *router,
                                const char *task_ref);
size_t meta_capture_router_cancel_operation(MetaCaptureRouter *router,
                                            const char *operation_id);
bool meta_capture_router_release(MetaCaptureRouter *router,
                                 const char *task_ref,
                                 bool recovery_authorized,
                                 bool *already_released);

typedef struct {
  char cleanup_request_id[META_NATIVE_REF_CAPACITY];
  char operation_id[META_NATIVE_REF_CAPACITY];
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  char task_ref[META_NATIVE_REF_CAPACITY];
  MetaFence accepted_fence;
  MetaFence current_high_water_fence;
  uint64_t expected_status_revision;
  char drained_evidence_ref[META_NATIVE_REF_CAPACITY];
  char terminal_receipt_ref[META_NATIVE_REF_CAPACITY];
} MetaCaptureReleaseAuthority;

typedef struct {
  MetaCaptureReleaseAuthority authority;
  uint64_t status_revision;
  bool already_released;
  bool cleanup_complete;
  bool drained;
} MetaCaptureReleaseReceipt;

bool meta_capture_router_release_authorized(
    MetaCaptureRouter *router,
    const MetaCaptureReleaseAuthority *authority,
    MetaCaptureReleaseReceipt *receipt);
bool meta_capture_router_forget_released(
    MetaCaptureRouter *router,
    const MetaCaptureReleaseReceipt *receipt);
size_t meta_capture_router_active_tasks(MetaCaptureRouter *router,
                                       char (*task_refs)[META_NATIVE_REF_CAPACITY],
                                       size_t capacity);

typedef struct {
  char task_ref[META_NATIVE_REF_CAPACITY];
  MetaCaptureTaskStatus status;
  bool result_available;
  bool released;
} MetaCaptureOperationTaskRecord;

size_t meta_capture_router_operation_tasks(
    MetaCaptureRouter *router,
    const char *operation_id,
    MetaCaptureOperationTaskRecord *records,
    size_t capacity);
size_t meta_capture_router_release_drained_operation(
    MetaCaptureRouter *router,
    const char *operation_id,
    bool recovery_authorized);

#endif
