#include "meta_application_controller.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct MetaApplicationLaunchTask {
  atomic_uint references;
  pthread_mutex_t mutex;
  MetaApplicationBackend backend;
  MetaApplicationLaunchRequest request;
  MetaApplicationLaunchTaskStatus status;
};

static void copy_text(char *target, size_t capacity, const char *source) {
  if (capacity == 0) return;
  snprintf(target, capacity, "%s", source == NULL ? "" : source);
}

static bool valid_text(const char *value, size_t capacity) {
  return value != NULL && value[0] != '\0' &&
         strnlen(value, capacity) < capacity;
}

static bool valid_request(const MetaApplicationLaunchRequest *request) {
  return request != NULL &&
         valid_text(request->launch_task_ref,
                    sizeof(request->launch_task_ref)) &&
         valid_text(request->request_id, sizeof(request->request_id)) &&
         valid_text(request->operation_id, sizeof(request->operation_id)) &&
         valid_text(request->runtime_epoch, sizeof(request->runtime_epoch)) &&
         valid_text(request->login_session_id,
                    sizeof(request->login_session_id)) &&
         valid_text(request->native_generation,
                    sizeof(request->native_generation)) &&
         request->fence_counter > 0 &&
         valid_text(request->application_url,
                    sizeof(request->application_url)) &&
         request->application_url[0] == '/' &&
         valid_text(request->expected_bundle_id,
                    sizeof(request->expected_bundle_id)) &&
         request->deadline_millis > 0;
}

static bool valid_backend(MetaApplicationBackend backend) {
  return backend.monotonic_millis != NULL && backend.start_launch != NULL &&
         backend.activate != NULL && backend.wait_millis != NULL;
}

static void retain_task(MetaApplicationLaunchTask *task) {
  atomic_fetch_add(&task->references, 1);
}

static void drop_task(MetaApplicationLaunchTask *task) {
  if (atomic_fetch_sub(&task->references, 1) != 1) return;
  pthread_mutex_destroy(&task->mutex);
  memset(task, 0, sizeof(*task));
  free(task);
}

static void mark_deadline_locked(MetaApplicationLaunchTask *task) {
  if (task->status.drained || task->status.timed_out ||
      task->backend.monotonic_millis(task->backend.context) <
          task->request.deadline_millis) {
    return;
  }
  task->status.timed_out = true;
  task->status.state = META_APPLICATION_LAUNCH_TASK_WAITING_LATE_CALLBACK;
  task->status.revision += 1;
  copy_text(task->status.error, sizeof(task->status.error),
            "launch deadline expired; NSWorkspace callback still pending");
}

static void launch_completion(
    void *context,
    MetaApplicationWorkspaceLaunchCompletionStatus completion_status,
    const MetaApplicationProcess *process,
    bool reused_existing_process,
    const char *error) {
  MetaApplicationLaunchTask *task = context;
  bool valid_process = completion_status ==
                           META_APPLICATION_LAUNCH_CALLBACK_COMPLETED &&
                       process != NULL && process->pid > 0 &&
                       process->launch_time_micros > 0 &&
                       strcmp(process->bundle_id,
                              task->request.expected_bundle_id) == 0;
  pthread_mutex_lock(&task->mutex);
  if (task->status.callback_received) {
    pthread_mutex_unlock(&task->mutex);
    return;
  }
  mark_deadline_locked(task);
  task->status.callback_received = true;
  task->status.late_completion = task->status.timed_out;
  task->status.revision += 1;
  if (valid_process) {
    task->status.process_present = true;
    task->status.reused_existing_process = reused_existing_process;
    task->status.process = *process;
  }
  const bool activate = valid_process && task->request.activate &&
                        !task->status.cancellation_requested &&
                        !task->status.timed_out &&
                        task->backend.monotonic_millis(task->backend.context) <
                            task->request.deadline_millis;
  pthread_mutex_unlock(&task->mutex);

  MetaApplicationActivationStatus activation = META_APPLICATION_ACTIVATION_FAILED;
  if (activate) {
    activation = task->backend.activate(task->backend.context, process,
                                        task->request.deadline_millis);
  }

  pthread_mutex_lock(&task->mutex);
  if (activate) {
    task->status.activation_attempted = true;
    task->status.activation_succeeded =
        activation == META_APPLICATION_ACTIVATION_SUCCEEDED;
    if (activation == META_APPLICATION_ACTIVATION_EXPIRED) {
      task->status.timed_out = true;
      task->status.late_completion = true;
    }
  }
  if (valid_process) {
    task->status.state = META_APPLICATION_LAUNCH_TASK_COMPLETED;
    if (activate && !task->status.activation_succeeded) {
      copy_text(task->status.error, sizeof(task->status.error),
                "launch completed but explicit activation was not confirmed");
    } else if (!task->status.timed_out &&
               !task->status.cancellation_requested) {
      task->status.error[0] = '\0';
    }
  } else {
    task->status.state =
        META_APPLICATION_LAUNCH_TASK_FAILED_AFTER_DISPATCH;
    copy_text(task->status.error, sizeof(task->status.error),
              error == NULL
                  ? "workspace callback lacks exact process identity"
                  : error);
  }
  task->status.drained = true;
  task->status.revision += 1;
  pthread_mutex_unlock(&task->mutex);
  drop_task(task);
}

MetaApplicationLaunchTask *meta_application_launch_task_start(
    MetaApplicationBackend backend,
    const MetaApplicationLaunchRequest *request) {
  if (!valid_backend(backend) || !valid_request(request)) return NULL;
  MetaApplicationLaunchTask *task = calloc(1, sizeof(*task));
  if (task == NULL || pthread_mutex_init(&task->mutex, NULL) != 0) {
    free(task);
    return NULL;
  }
  atomic_init(&task->references, 1);
  task->backend = backend;
  task->request = *request;
  task->status = (MetaApplicationLaunchTaskStatus){
      .revision = 1,
      .state = META_APPLICATION_LAUNCH_TASK_PENDING,
      .mutation_attempted = true,
      .activation_requested = request->activate,
  };
  copy_text(task->status.launch_task_ref,
            sizeof(task->status.launch_task_ref),
            request->launch_task_ref);
  copy_text(task->status.request_id, sizeof(task->status.request_id),
            request->request_id);
  copy_text(task->status.operation_id, sizeof(task->status.operation_id),
            request->operation_id);
  copy_text(task->status.runtime_epoch, sizeof(task->status.runtime_epoch),
            request->runtime_epoch);
  copy_text(task->status.login_session_id,
            sizeof(task->status.login_session_id),
            request->login_session_id);
  copy_text(task->status.native_generation,
            sizeof(task->status.native_generation),
            request->native_generation);
  task->status.fence_counter = request->fence_counter;
  if (backend.monotonic_millis(backend.context) >=
      request->deadline_millis) {
    task->status.state = META_APPLICATION_LAUNCH_TASK_REJECTED_NO_DISPATCH;
    task->status.mutation_attempted = false;
    task->status.drained = true;
    copy_text(task->status.error, sizeof(task->status.error),
              "launch deadline expired before dispatch");
    return task;
  }
  retain_task(task);
  MetaApplicationWorkspaceLaunchStart started = backend.start_launch(
      backend.context, &task->request, launch_completion, task);
  if (started == META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH) {
    pthread_mutex_lock(&task->mutex);
    const bool callbackReceived = task->status.callback_received;
    if (!callbackReceived) {
      task->status.state =
          META_APPLICATION_LAUNCH_TASK_REJECTED_NO_DISPATCH;
      task->status.mutation_attempted = false;
      task->status.drained = true;
      task->status.revision += 1;
      copy_text(task->status.error, sizeof(task->status.error),
                "workspace rejected launch before dispatch");
    }
    pthread_mutex_unlock(&task->mutex);
    if (!callbackReceived) drop_task(task);
  }
  return task;
}

MetaApplicationLaunchTaskStatus meta_application_launch_task_status(
    MetaApplicationLaunchTask *task) {
  if (task == NULL) {
    return (MetaApplicationLaunchTaskStatus){
        .state = META_APPLICATION_LAUNCH_TASK_FAILED_AFTER_DISPATCH,
        .drained = true,
    };
  }
  pthread_mutex_lock(&task->mutex);
  mark_deadline_locked(task);
  MetaApplicationLaunchTaskStatus status = task->status;
  pthread_mutex_unlock(&task->mutex);
  return status;
}

MetaApplicationLaunchTaskStatus meta_application_launch_task_wait(
    MetaApplicationLaunchTask *task,
    uint64_t wait_deadline_millis) {
  if (task == NULL) return meta_application_launch_task_status(NULL);
  while (true) {
    MetaApplicationLaunchTaskStatus status =
        meta_application_launch_task_status(task);
    if (status.drained ||
        task->backend.monotonic_millis(task->backend.context) >=
            wait_deadline_millis) {
      return status;
    }
    task->backend.wait_millis(task->backend.context, 10);
  }
}

bool meta_application_launch_task_cancel(MetaApplicationLaunchTask *task) {
  if (task == NULL) return false;
  pthread_mutex_lock(&task->mutex);
  if (task->status.drained || task->status.cancellation_requested) {
    pthread_mutex_unlock(&task->mutex);
    return false;
  }
  mark_deadline_locked(task);
  task->status.cancellation_requested = true;
  task->status.state =
      META_APPLICATION_LAUNCH_TASK_WAITING_LATE_CALLBACK;
  task->status.revision += 1;
  copy_text(task->status.error, sizeof(task->status.error),
            "launch cancellation requested; NSWorkspace callback pending");
  pthread_mutex_unlock(&task->mutex);
  return true;
}

bool meta_application_launch_task_release(MetaApplicationLaunchTask *task) {
  if (task == NULL) return false;
  pthread_mutex_lock(&task->mutex);
  const bool drained = task->status.drained;
  pthread_mutex_unlock(&task->mutex);
  if (!drained) return false;
  drop_task(task);
  return true;
}
