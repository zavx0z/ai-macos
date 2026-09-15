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

static bool valid_backend(MetaApplicationBackend backend) {
  return backend.monotonic_millis != NULL && backend.launch != NULL &&
         backend.lookup != NULL && backend.terminate != NULL &&
         backend.wait_millis != NULL;
}

bool meta_application_launch(MetaApplicationBackend backend,
                             const MetaApplicationLaunchRequest *request,
                             MetaApplicationLaunchResult *result) {
  if (result == NULL) return false;
  *result = (MetaApplicationLaunchResult){0};
  if (!valid_backend(backend) || request == NULL ||
      !valid_text(request->application_url, META_APPLICATION_URL_CAPACITY) ||
      request->application_url[0] != '/' ||
      !valid_text(request->expected_bundle_id,
                  META_APPLICATION_BUNDLE_CAPACITY) ||
      request->deadline_millis <= backend.monotonic_millis(backend.context)) {
    result->outcome = META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH;
    copy_text(result->error, sizeof(result->error),
              "invalid launch request or expired deadline");
    return true;
  }
  bool reused = false;
  MetaApplicationProcess process = {0};
  MetaApplicationWorkspaceLaunchStatus status = backend.launch(
      backend.context, request, &process, &reused);
  if (status == META_APPLICATION_LAUNCH_REJECTED) {
    result->outcome = META_APPLICATION_LAUNCH_REJECTED_NO_DISPATCH;
    copy_text(result->error, sizeof(result->error),
              "workspace rejected launch before dispatch");
    return true;
  }
  result->mutation_attempted = true;
  if (backend.monotonic_millis(backend.context) >= request->deadline_millis) {
    result->outcome = META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN;
    if (status == META_APPLICATION_LAUNCH_COMPLETED && process.pid > 0 &&
        process.launch_time_micros > 0 &&
        strcmp(process.bundle_id, request->expected_bundle_id) == 0) {
      result->process_present = true;
      result->reused_existing_process = reused;
      result->process = process;
    }
    copy_text(result->error, sizeof(result->error),
              "workspace launch crossed operation deadline");
    return true;
  }
  if (status != META_APPLICATION_LAUNCH_COMPLETED || process.pid <= 0 ||
      process.launch_time_micros == 0 ||
      strcmp(process.bundle_id, request->expected_bundle_id) != 0) {
    result->outcome = META_APPLICATION_LAUNCH_OUTCOME_UNKNOWN;
    copy_text(result->error, sizeof(result->error),
              status == META_APPLICATION_LAUNCH_TIMED_OUT
                  ? "workspace launch timed out after dispatch"
                  : "workspace launch result lacks exact process identity");
    return true;
  }
  result->outcome = META_APPLICATION_LAUNCH_READY;
  result->process_present = true;
  result->reused_existing_process = reused;
  result->process = process;
  return true;
}

bool meta_application_quit(MetaApplicationBackend backend,
                           const MetaApplicationQuitRequest *request,
                           MetaApplicationQuitResult *result) {
  if (result == NULL) return false;
  *result = (MetaApplicationQuitResult){0};
  if (!valid_backend(backend) || request == NULL ||
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

static MetaApplicationWorkspaceLaunchStatus system_launch(
    void *context,
    const MetaApplicationLaunchRequest *request,
    MetaApplicationProcess *process,
    bool *reused_existing_process) {
  (void)context;
  @autoreleasepool {
    NSString *path = @(request->application_url);
    NSURL *url = [[NSURL fileURLWithPath:path]
        URLByResolvingSymlinksInPath];
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    if (bundle == nil ||
        ![bundle.bundleIdentifier isEqual:@(request->expected_bundle_id)]) {
      return META_APPLICATION_LAUNCH_REJECTED;
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
    configuration.activates = request->activate;
    configuration.createsNewApplicationInstance =
        request->create_new_instance;
    if (system_monotonic_millis(NULL) >= request->deadline_millis) {
      return META_APPLICATION_LAUNCH_REJECTED;
    }
    dispatch_semaphore_t completion = dispatch_semaphore_create(0);
    __block NSRunningApplication *launched = nil;
    __block NSError *launchError = nil;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:url
                                        configuration:configuration
                                    completionHandler:^(
                                        NSRunningApplication *application,
                                        NSError *error) {
      launched = application;
      launchError = error;
      dispatch_semaphore_signal(completion);
    }];
    uint64_t now = system_monotonic_millis(NULL);
    if (now >= request->deadline_millis) {
      return META_APPLICATION_LAUNCH_TIMED_OUT;
    }
    uint64_t remaining = request->deadline_millis - now;
    long completed = dispatch_semaphore_wait(
        completion,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)remaining * NSEC_PER_MSEC));
    if (completed != 0) return META_APPLICATION_LAUNCH_TIMED_OUT;
    if (launchError != nil ||
        !copy_running_process(launched, process) ||
        strcmp(process->bundle_id, request->expected_bundle_id) != 0) {
      return META_APPLICATION_LAUNCH_FAILED_AFTER_DISPATCH;
    }
    NSString *identity = [NSString stringWithFormat:@"%d:%llu", process->pid,
      (unsigned long long)process->launch_time_micros];
    *reused_existing_process = [existing containsObject:identity];
    return META_APPLICATION_LAUNCH_COMPLETED;
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
      .launch = system_launch,
      .lookup = system_lookup,
      .terminate = system_terminate,
      .wait_millis = system_wait_millis,
  };
}
