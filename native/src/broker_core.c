#include "meta_broker_core.h"

#include <stdlib.h>
#include <string.h>

struct MetaBrokerCore {
  MetaExecutor *executor;
  MetaCaptureRouter *capture_router;
};

static bool valid_operation_id(const char *value) {
  if (value == NULL || value[0] == '\0') return false;
  const size_t length = strnlen(value, META_NATIVE_REF_CAPACITY);
  return length >= 1 && length < META_NATIVE_REF_CAPACITY;
}

static MetaBrokerOperationStatus operation_status(
    MetaBrokerCore *broker,
    const char *operation_id) {
  MetaBrokerOperationStatus result = {
      .executor = meta_executor_status(broker->executor),
      .all_capture_tasks_drained = true,
      .cleanup = META_CLEANUP_COMPLETE,
  };
  MetaCaptureOperationTaskRecord records[128] = {0};
  result.capture_task_count = meta_capture_router_operation_tasks(
      broker->capture_router, operation_id, records, 128);
  const size_t inspected = result.capture_task_count < 128
                               ? result.capture_task_count
                               : 128;
  for (size_t index = 0; index < inspected; index += 1) {
    if (records[index].released) continue;
    if (!records[index].status.drained ||
        records[index].status.cleanup != MetaCaptureCleanupComplete) {
      result.all_capture_tasks_drained = false;
      result.cleanup = records[index].status.cleanup ==
                               MetaCaptureCleanupUnknown
                           ? META_CLEANUP_UNKNOWN
                           : META_CLEANUP_INCOMPLETE;
    }
  }
  if (result.capture_task_count > 128) {
    result.all_capture_tasks_drained = false;
    result.cleanup = META_CLEANUP_UNKNOWN;
  }
  if (result.executor.cleanup != META_CLEANUP_COMPLETE) {
    result.cleanup = result.executor.cleanup;
  }
  result.quarantined = result.executor.quarantined ||
                       result.cleanup != META_CLEANUP_COMPLETE;
  return result;
}

MetaBrokerCore *meta_broker_core_create(MetaExecutor *executor,
                                        MetaCaptureRouter *capture_router) {
  if (executor == NULL || capture_router == NULL) return NULL;
  MetaBrokerCore *broker = calloc(1, sizeof(*broker));
  if (broker == NULL) return NULL;
  broker->executor = executor;
  broker->capture_router = capture_router;
  return broker;
}

void meta_broker_core_destroy(MetaBrokerCore *broker) {
  free(broker);
}

MetaBrokerCancelResult meta_broker_core_cancel_operation(
    MetaBrokerCore *broker,
    const char *operation_id,
    MetaFence accepted_fence) {
  if (broker == NULL || !valid_operation_id(operation_id)) {
    return (MetaBrokerCancelResult){0};
  }
  const bool executor_stopped = meta_executor_cancel_operation(
      broker->executor, operation_id, accepted_fence);
  const size_t captures_cancelled = meta_capture_router_cancel_operation(
      broker->capture_router, operation_id);
  const MetaBrokerOperationStatus status =
      operation_status(broker, operation_id);
  return (MetaBrokerCancelResult){
      .acknowledged = executor_stopped || captures_cancelled > 0,
      .executor_stopped = executor_stopped,
      .capture_tasks_cancelled = captures_cancelled,
      .capture_task_count = status.capture_task_count,
      .all_capture_tasks_drained = status.all_capture_tasks_drained,
      .cleanup = status.cleanup,
      .quarantined = status.quarantined,
  };
}

MetaBrokerOperationStatus meta_broker_core_operation_status(
    MetaBrokerCore *broker,
    const char *operation_id) {
  if (broker == NULL || !valid_operation_id(operation_id)) {
    return (MetaBrokerOperationStatus){
        .cleanup = META_CLEANUP_UNKNOWN,
        .quarantined = true,
    };
  }
  return operation_status(broker, operation_id);
}

size_t meta_broker_core_release_drained_operation(
    MetaBrokerCore *broker,
    const char *operation_id,
    bool recovery_authorized) {
  if (broker == NULL || !valid_operation_id(operation_id)) return 0;
  return meta_capture_router_release_drained_operation(
      broker->capture_router, operation_id, recovery_authorized);
}
