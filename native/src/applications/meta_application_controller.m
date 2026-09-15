#include "meta_application_controller.h"

#import <AppKit/AppKit.h>
#include <libproc.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void copy_text(char *target, size_t capacity, const char *source) {
  if (capacity == 0) return;
  snprintf(target, capacity, "%s", source == NULL ? "" : source);
}

static bool valid_text(const char *value, size_t capacity) {
  return value != NULL && value[0] != '\0' &&
         strnlen(value, capacity) < capacity;
}

static bool same_process(const MetaApplicationProcess *left,
                         const MetaApplicationProcess *right) {
  return left->pid == right->pid &&
         left->launch_time_micros == right->launch_time_micros &&
         strcmp(left->bundle_id, right->bundle_id) == 0;
}

static bool valid_quit_backend(MetaApplicationBackend backend) {
  return backend.monotonic_millis != NULL && backend.lookup != NULL &&
         backend.terminate != NULL &&
         backend.wait_millis != NULL;
}

bool meta_application_quit(MetaApplicationBackend backend,
                           const MetaApplicationQuitRequest *request,
                           MetaApplicationQuitResult *result) {
  if (result == NULL) return false;
  *result = (MetaApplicationQuitResult){0};
  if (!valid_quit_backend(backend) || request == NULL ||
      !valid_text(request->application_ref, META_APPLICATION_REF_CAPACITY) ||
      !valid_text(request->registration_nonce,
                  sizeof(request->registration_nonce)) ||
      request->process.pid <= 0 || request->process.launch_time_micros == 0 ||
      !valid_text(request->process.bundle_id,
                  META_APPLICATION_BUNDLE_CAPACITY)) {
    result->outcome = META_APPLICATION_QUIT_REJECTED;
    copy_text(result->error, sizeof(result->error), "invalid exact process ref");
    return true;
  }
  if (request->deadline_millis <= backend.monotonic_millis(backend.context)) {
    result->outcome = META_APPLICATION_QUIT_REJECTED;
    copy_text(result->error, sizeof(result->error),
              "quit deadline expired before dispatch");
    return true;
  }
  MetaApplicationProcess observed = {0};
  MetaApplicationLookupStatus lookup = backend.lookup(
      backend.context, request->process.pid, &observed);
  if (lookup == META_APPLICATION_LOOKUP_ABSENT ||
      (lookup == META_APPLICATION_LOOKUP_FOUND &&
       !same_process(&request->process, &observed))) {
    result->outcome = META_APPLICATION_QUIT_TARGET_STALE;
    if (lookup == META_APPLICATION_LOOKUP_FOUND) result->observed_process = observed;
    copy_text(result->error, sizeof(result->error),
              "process incarnation is no longer current");
    return true;
  }
  if (lookup != META_APPLICATION_LOOKUP_FOUND) {
    result->outcome = META_APPLICATION_QUIT_OUTCOME_UNKNOWN;
    copy_text(result->error, sizeof(result->error),
              "cannot verify process incarnation before quit");
    return true;
  }
  if (request->deadline_millis <= backend.monotonic_millis(backend.context)) {
    result->outcome = META_APPLICATION_QUIT_REJECTED;
    result->process_running = true;
    result->observed_process = observed;
    copy_text(result->error, sizeof(result->error),
              "quit deadline expired after identity verification");
    return true;
  }
  MetaApplicationWorkspaceTerminateStatus termination = backend.terminate(
      backend.context, &request->process, request->deadline_millis);
  if (termination == META_APPLICATION_TERMINATE_TARGET_STALE) {
    result->outcome = META_APPLICATION_QUIT_TARGET_STALE;
    copy_text(result->error, sizeof(result->error),
              "process changed before terminate request");
    return true;
  }
  if (termination == META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH) {
    result->outcome = META_APPLICATION_QUIT_REJECTED;
    result->process_running = true;
    result->observed_process = observed;
    copy_text(result->error, sizeof(result->error),
              "quit deadline expired before terminate request");
    return true;
  }
  if (termination == META_APPLICATION_TERMINATE_REJECTED) {
    result->outcome = META_APPLICATION_QUIT_REJECTED;
    result->mutation_attempted = true;
    result->process_running = true;
    result->observed_process = observed;
    copy_text(result->error, sizeof(result->error),
              "application rejected terminate request");
    return true;
  }
  if (termination != META_APPLICATION_TERMINATE_ACCEPTED) {
    result->outcome = META_APPLICATION_QUIT_OUTCOME_UNKNOWN;
    copy_text(result->error, sizeof(result->error),
              "terminate request result is unknown");
    return true;
  }
  result->mutation_attempted = true;
  result->termination_requested = true;
  while (backend.monotonic_millis(backend.context) <
         request->deadline_millis) {
    observed = (MetaApplicationProcess){0};
    lookup = backend.lookup(backend.context, request->process.pid, &observed);
    if (lookup == META_APPLICATION_LOOKUP_ABSENT ||
        (lookup == META_APPLICATION_LOOKUP_FOUND &&
         !same_process(&request->process, &observed))) {
      result->outcome = META_APPLICATION_QUIT_TERMINATED;
      return true;
    }
    if (lookup == META_APPLICATION_LOOKUP_FAILED) {
      result->outcome = META_APPLICATION_QUIT_OUTCOME_UNKNOWN;
      copy_text(result->error, sizeof(result->error),
                "cannot verify process state after terminate request");
      return true;
    }
    result->observed_process = observed;
    backend.wait_millis(backend.context, 10);
  }
  result->outcome = META_APPLICATION_QUIT_STILL_RUNNING;
  result->process_running = true;
  result->attention_may_be_required = true;
  copy_text(result->error, sizeof(result->error),
            "application remains running and may require user attention");
  return true;
}

static uint64_t system_monotonic_millis(void *context) {
  (void)context;
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}

static uint64_t process_start_micros(pid_t pid) {
  struct proc_bsdinfo info = {0};
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) return 0;
  return (uint64_t)info.pbi_start_tvsec * 1000000ULL +
         (uint64_t)info.pbi_start_tvusec;
}

static bool copy_running_process(NSRunningApplication *application,
                                 MetaApplicationProcess *process) {
  if (application == nil || application.terminated || process == NULL ||
      application.processIdentifier <= 0 ||
      ![application.bundleIdentifier isKindOfClass:NSString.class]) {
    return false;
  }
  uint64_t started = process_start_micros(application.processIdentifier);
  const char *bundle = application.bundleIdentifier.UTF8String;
  if (started == 0 || bundle == NULL ||
      strnlen(bundle, META_APPLICATION_BUNDLE_CAPACITY) >=
          META_APPLICATION_BUNDLE_CAPACITY) {
    return false;
  }
  *process = (MetaApplicationProcess){
      .pid = application.processIdentifier,
      .launch_time_micros = started,
  };
  copy_text(process->bundle_id, sizeof(process->bundle_id), bundle);
  return true;
}

static MetaApplicationLookupStatus system_lookup(
    void *context,
    int32_t pid,
    MetaApplicationProcess *process) {
  (void)context;
  @autoreleasepool {
    NSRunningApplication *application =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (application == nil || application.terminated) {
      return META_APPLICATION_LOOKUP_ABSENT;
    }
    return copy_running_process(application, process)
               ? META_APPLICATION_LOOKUP_FOUND
               : META_APPLICATION_LOOKUP_FAILED;
  }
}

static MetaApplicationWorkspaceLaunchStart system_start_launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationLaunchCompletion completion,
    void *completion_context) {
  (void)context;
  @autoreleasepool {
    NSString *path = @(request->application_url);
    NSURL *url = [[NSURL fileURLWithPath:path]
        URLByResolvingSymlinksInPath];
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    NSString *expectedBundleId = [@(request->expected_bundle_id) copy];
    if (bundle == nil ||
        ![bundle.bundleIdentifier isEqual:expectedBundleId]) {
      return META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH;
    }
    NSMutableSet<NSString *> *existing = [NSMutableSet set];
    for (NSRunningApplication *candidate in
         [NSRunningApplication runningApplicationsWithBundleIdentifier:
                                   bundle.bundleIdentifier]) {
      MetaApplicationProcess process = {0};
      if ([candidate.bundleURL.URLByResolvingSymlinksInPath isEqual:url] &&
          copy_running_process(candidate, &process)) {
        [existing addObject:[NSString stringWithFormat:@"%d:%llu", process.pid,
          (unsigned long long)process.launch_time_micros]];
      }
    }
    NSWorkspaceOpenConfiguration *configuration =
        [NSWorkspaceOpenConfiguration configuration];
    configuration.activates = false;
    configuration.createsNewApplicationInstance =
        request->create_new_instance;
    if (system_monotonic_millis(NULL) >= request->deadline_millis) {
      return META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH;
    }
    [NSWorkspace.sharedWorkspace openApplicationAtURL:url
                                        configuration:configuration
                                    completionHandler:^(
                                        NSRunningApplication *application,
                                        NSError *error) {
      MetaApplicationProcess process = {0};
      if (error != nil || !copy_running_process(application, &process) ||
          ![@(process.bundle_id) isEqual:expectedBundleId]) {
        completion(completion_context,
                   META_APPLICATION_LAUNCH_CALLBACK_FAILED, NULL, false,
                   error == nil ? "workspace callback lacks exact process identity"
                                : error.localizedDescription.UTF8String);
        return;
      }
      NSString *identity = [NSString stringWithFormat:@"%d:%llu", process.pid,
        (unsigned long long)process.launch_time_micros];
      completion(completion_context,
                 META_APPLICATION_LAUNCH_CALLBACK_COMPLETED, &process,
                 [existing containsObject:identity], NULL);
    }];
    return META_APPLICATION_LAUNCH_ENQUEUED;
  }
}

static MetaApplicationActivationStatus system_activate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  (void)context;
  @autoreleasepool {
    if (system_monotonic_millis(NULL) >= deadline_millis) {
      return META_APPLICATION_ACTIVATION_EXPIRED;
    }
    NSRunningApplication *application =
        [NSRunningApplication runningApplicationWithProcessIdentifier:
                                  expected->pid];
    MetaApplicationProcess current = {0};
    if (!copy_running_process(application, &current) ||
        !same_process(expected, &current)) {
      return META_APPLICATION_ACTIVATION_TARGET_STALE;
    }
    if (system_monotonic_millis(NULL) >= deadline_millis) {
      return META_APPLICATION_ACTIVATION_EXPIRED;
    }
    return [application activateWithOptions:NSApplicationActivateIgnoringOtherApps]
               ? META_APPLICATION_ACTIVATION_SUCCEEDED
               : META_APPLICATION_ACTIVATION_FAILED;
  }
}

static MetaApplicationWorkspaceTerminateStatus system_terminate(
    void *context,
    const MetaApplicationProcess *expected,
    uint64_t deadline_millis) {
  (void)context;
  @autoreleasepool {
    MetaApplicationProcess current = {0};
    MetaApplicationLookupStatus status = system_lookup(
        NULL, expected->pid, &current);
    if (status == META_APPLICATION_LOOKUP_ABSENT ||
        (status == META_APPLICATION_LOOKUP_FOUND &&
         !same_process(expected, &current))) {
      return META_APPLICATION_TERMINATE_TARGET_STALE;
    }
    if (status != META_APPLICATION_LOOKUP_FOUND) {
      return META_APPLICATION_TERMINATE_FAILED;
    }
    if (system_monotonic_millis(NULL) >= deadline_millis) {
      return META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH;
    }
    NSRunningApplication *application =
        [NSRunningApplication runningApplicationWithProcessIdentifier:
                                  expected->pid];
    current = (MetaApplicationProcess){0};
    if (!copy_running_process(application, &current) ||
        !same_process(expected, &current)) {
      return META_APPLICATION_TERMINATE_TARGET_STALE;
    }
    if (system_monotonic_millis(NULL) >= deadline_millis) {
      return META_APPLICATION_TERMINATE_EXPIRED_NO_DISPATCH;
    }
    return [application terminate] ? META_APPLICATION_TERMINATE_ACCEPTED
                                   : META_APPLICATION_TERMINATE_REJECTED;
  }
}

static void system_wait_millis(void *context, uint64_t millis) {
  (void)context;
  usleep((useconds_t)MIN(millis, 1000) * 1000);
}

MetaApplicationBackend meta_application_system_backend(void) {
  return (MetaApplicationBackend){
      .monotonic_millis = system_monotonic_millis,
      .start_launch = system_start_launch,
      .activate = system_activate,
      .lookup = system_lookup,
      .terminate = system_terminate,
      .wait_millis = system_wait_millis,
  };
}
