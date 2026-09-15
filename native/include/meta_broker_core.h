#ifndef META_BROKER_CORE_H
#define META_BROKER_CORE_H

#include "meta_capture_router.h"
#include "meta_native.h"

typedef struct {
  bool acknowledged;
  bool executor_stopped;
  size_t capture_tasks_cancelled;
  size_t capture_task_count;
  bool all_capture_tasks_drained;
  MetaCleanupState cleanup;
  bool quarantined;
} MetaBrokerCancelResult;

typedef struct {
  MetaExecutorStatus executor;
  size_t capture_task_count;
  bool all_capture_tasks_drained;
  MetaCleanupState cleanup;
  bool quarantined;
} MetaBrokerOperationStatus;

typedef struct MetaBrokerCore MetaBrokerCore;

MetaBrokerCore *meta_broker_core_create(MetaExecutor *executor,
                                        MetaCaptureRouter *capture_router);
void meta_broker_core_destroy(MetaBrokerCore *broker);
typedef enum {
  META_BROKER_ROTATION_INVALID,
  META_BROKER_ROTATION_SEALED_PENDING,
  META_BROKER_ROTATION_READY,
} MetaBrokerRotationState;

MetaBrokerRotationState meta_broker_core_begin_rotation(MetaBrokerCore *broker);
bool meta_broker_core_seal_for_rotation(MetaBrokerCore *broker);
MetaBrokerCancelResult meta_broker_core_cancel_operation(
    MetaBrokerCore *broker,
    const char *operation_id,
    MetaFence accepted_fence);
MetaBrokerOperationStatus meta_broker_core_operation_status(
    MetaBrokerCore *broker,
    const char *operation_id);
size_t meta_broker_core_release_drained_operation(
    MetaBrokerCore *broker,
    const char *operation_id,
    bool recovery_authorized);

#endif
