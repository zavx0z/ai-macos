#include "meta_application_command.h"

#include <stdio.h>
#include <string.h>

@interface MetaApplicationLaunchEntry : NSObject
@property(nonatomic) MetaApplicationLaunchTask *task;
@property(nonatomic, copy) NSDictionary *operation;
@property(nonatomic) BOOL publicActivationRequested;
@property(nonatomic) BOOL parentActivationAttempted;
@property(nonatomic) BOOL parentActivationSucceeded;
@property(nonatomic) BOOL parentActivationInFlight;
@property(nonatomic) BOOL parentActivationAbandoned;
@property(nonatomic, copy) NSDictionary *mappedValue;
@end

@implementation MetaApplicationLaunchEntry
@end

static BOOL string_value(id value, NSUInteger maximum) {
  return [value isKindOfClass:NSString.class] && [value length] > 0 &&
         [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= maximum;
}

static BOOL number_value(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         [value doubleValue] == [value unsignedLongLongValue];
}

static BOOL boolean_value(id value) {
  return [value isEqual:@YES] || [value isEqual:@NO];
}

static BOOL copy_string(char *target, size_t capacity, id value) {
  if (!string_value(value, capacity - 1)) return NO;
  snprintf(target, capacity, "%s", [value UTF8String]);
  return YES;
}

static NSDictionary *contract_error(NSString *stage, NSString *message) {
  return @{
    @"code": @"operation-outcome-unknown",
    @"message": message,
    @"stage": stage,
    @"retryable": @NO,
    @"replayAllowed": @NO,
    @"recoveryAction": @"get-operation",
  };
}

static NSDictionary *unknown_launch(NSString *reason) {
  return @{
    @"state": @"unknown",
    @"reason": reason,
    @"errors": @[contract_error(@"application-launch", reason)],
  };
}

static NSDictionary *abandoned_activation(NSDictionary *mapped) {
  NSDictionary *application = mapped[@"application"];
  if (![mapped[@"state"] isEqual:@"running"] || application == nil) {
    return mapped;
  }
  NSString *reason =
      @"Application launch drained before requested activation";
  return @{
    @"state": @"unknown",
    @"reason": reason,
    @"candidate": application,
    @"errors": @[contract_error(@"application-activate", reason)],
  };
}

static NSDictionary *unknown_quit(NSDictionary *application,
                                  NSString *reason) {
  return @{
    @"state": @"unknown",
    @"application": application,
    @"reason": reason,
    @"errors": @[contract_error(@"application-quit", reason)],
  };
}

static NSString *launch_state(MetaApplicationLaunchTaskState state) {
  switch (state) {
    case META_APPLICATION_LAUNCH_TASK_PENDING: return @"pending";
    case META_APPLICATION_LAUNCH_TASK_WAITING_LATE_CALLBACK:
      return @"waiting-late-callback";
    case META_APPLICATION_LAUNCH_TASK_COMPLETED: return @"completed";
    case META_APPLICATION_LAUNCH_TASK_FAILED_AFTER_DISPATCH:
      return @"failed-after-dispatch";
    case META_APPLICATION_LAUNCH_TASK_REJECTED_NO_DISPATCH:
      return @"rejected-no-dispatch";
  }
}

static BOOL generation_matches(NSDictionary *generation,
                               NSDictionary *value) {
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (![value[key] isEqual:generation[key]]) return NO;
  }
  return YES;
}

@implementation MetaApplicationCommandBinder {
  NSDictionary *_generation;
  MetaApplicationBundles *_bundles;
  MetaApplicationBackend _backend;
  MetaApplicationCandidateResolver _candidateResolver;
  MetaApplicationReferenceResolver _referenceResolver;
  NSMutableDictionary<NSString *, MetaApplicationLaunchEntry *> *_launches;
  NSLock *_lock;
  BOOL _sealed;
}

- (instancetype)initWithGeneration:(NSDictionary *)generation
                            bundles:(MetaApplicationBundles *)bundles
                            backend:(MetaApplicationBackend)backend
                  candidateResolver:(MetaApplicationCandidateResolver)candidateResolver
                  referenceResolver:(MetaApplicationReferenceResolver)referenceResolver {
  self = [super init];
  if (self) {
    if (bundles == nil || candidateResolver == nil ||
        referenceResolver == nil ||
        backend.monotonic_millis == NULL ||
        backend.start_launch == NULL || backend.activate == NULL ||
        backend.lookup == NULL || backend.terminate == NULL ||
        backend.wait_millis == NULL) return nil;
    for (NSString *key in
         @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
      if (!string_value(generation[key], 64)) return nil;
    }
    _generation = @{
      @"runtimeEpoch": generation[@"runtimeEpoch"],
      @"loginSessionId": generation[@"loginSessionId"],
      @"nativeGeneration": generation[@"nativeGeneration"],
    };
    _bundles = bundles;
    _backend = backend;
    _candidateResolver = [candidateResolver copy];
    _referenceResolver = [referenceResolver copy];
    _launches = [NSMutableDictionary dictionary];
    _lock = [[NSLock alloc] init];
  }
  return self;
}

- (NSDictionary *)resolve:(NSDictionary *)request
                 evidence:(NSDictionary *)evidence {
  NSString *path = request[@"path"];
  NSString *bundleId = request[@"bundleId"];
  if (!string_value(path, 4096) || ![path isAbsolutePath] ||
      !string_value(bundleId, 255) ||
      !string_value(evidence[@"sourceResponseRef"], 127) ||
      !string_value(evidence[@"inventoryId"], 127) ||
      !number_value(evidence[@"inventoryRevision"]) ||
      !string_value(evidence[@"observedAt"], 64)) return nil;
  NSDictionary *reference = [_bundles resolvePath:path bundleId:bundleId];
  if (reference == nil || !generation_matches(_generation, reference)) {
    return nil;
  }
  return @{
    @"requestedPath": path,
    @"sourceResponseRef": evidence[@"sourceResponseRef"],
    @"inventoryId": evidence[@"inventoryId"],
    @"inventoryRevision": evidence[@"inventoryRevision"],
    @"observedAt": evidence[@"observedAt"],
    @"target": @{@"kind": @"application-bundle", @"ref": reference},
  };
}

- (NSDictionary *)startLaunch:(NSDictionary *)request
                     operation:(NSDictionary *)operation
                     requestId:(NSString *)requestId
                deadlineMillis:(uint64_t)deadlineMillis {
  if (!string_value(requestId, 127) ||
      !generation_matches(_generation, operation) ||
      !string_value(operation[@"operationId"], 127) ||
      ![operation[@"fence"] isKindOfClass:NSDictionary.class] ||
      !generation_matches(_generation, operation[@"fence"]) ||
      !number_value(operation[@"fence"][@"counter"]) ||
      ![request[@"bundle"] isKindOfClass:NSDictionary.class] ||
      !generation_matches(_generation, request[@"bundle"]) ||
      ![_bundles validateReference:request[@"bundle"]] ||
      !boolean_value(request[@"activate"]) ||
      !boolean_value(request[@"newInstance"]) ||
      ![operation[@"target"][@"kind"] isEqual:@"application-bundle"] ||
      ![operation[@"target"][@"ref"] isEqual:request[@"bundle"]]) {
    return nil;
  }
  NSString *launchTaskRef =
      [@"application-launch-" stringByAppendingString:NSUUID.UUID.UUIDString];
  MetaApplicationLaunchRequest nativeRequest = {
      .fence_counter = [operation[@"fence"][@"counter"] unsignedLongLongValue],
      .create_new_instance = [request[@"newInstance"] boolValue],
      .activate = false,
      .deadline_millis = deadlineMillis,
  };
  if (!copy_string(nativeRequest.launch_task_ref,
                   sizeof(nativeRequest.launch_task_ref), launchTaskRef) ||
      !copy_string(nativeRequest.request_id,
                   sizeof(nativeRequest.request_id), requestId) ||
      !copy_string(nativeRequest.operation_id,
                   sizeof(nativeRequest.operation_id),
                   operation[@"operationId"]) ||
      !copy_string(nativeRequest.runtime_epoch,
                   sizeof(nativeRequest.runtime_epoch),
                   _generation[@"runtimeEpoch"]) ||
      !copy_string(nativeRequest.login_session_id,
                   sizeof(nativeRequest.login_session_id),
                   _generation[@"loginSessionId"]) ||
      !copy_string(nativeRequest.native_generation,
                   sizeof(nativeRequest.native_generation),
                   _generation[@"nativeGeneration"]) ||
      !copy_string(nativeRequest.application_url,
                   sizeof(nativeRequest.application_url),
                   request[@"bundle"][@"path"]) ||
      !copy_string(nativeRequest.expected_bundle_id,
                   sizeof(nativeRequest.expected_bundle_id),
                   request[@"bundle"][@"bundleId"])) return nil;
  [_lock lock];
  if (_sealed || _launches.count >= 128) {
    [_lock unlock];
    return nil;
  }
  MetaApplicationLaunchTask *task = meta_application_launch_task_start(
      _backend, &nativeRequest);
  if (task == NULL) {
    [_lock unlock];
    return nil;
  }
  MetaApplicationLaunchEntry *entry = [[MetaApplicationLaunchEntry alloc] init];
  entry.task = task;
  entry.operation = [operation copy];
  entry.publicActivationRequested = [request[@"activate"] boolValue];
  _launches[launchTaskRef] = entry;
  [_lock unlock];
  return [self launchStatus:launchTaskRef requestId:requestId];
}

- (NSDictionary *)launchStatus:(NSString *)launchTaskRef
                      requestId:(NSString *)requestId {
  if (!string_value(launchTaskRef, 127) || !string_value(requestId, 127)) {
    return nil;
  }
  [_lock lock];
  MetaApplicationLaunchEntry *entry = _launches[launchTaskRef];
  NSDictionary *mappedValue = entry.mappedValue;
  const BOOL publicActivationRequested = entry.publicActivationRequested;
  const BOOL parentActivationAttempted = entry.parentActivationAttempted;
  const BOOL parentActivationSucceeded = entry.parentActivationSucceeded;
  const BOOL parentActivationInFlight = entry.parentActivationInFlight;
  const BOOL parentActivationAbandoned = entry.parentActivationAbandoned;
  [_lock unlock];
  if (entry == nil) return nil;
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(entry.task);
  const BOOL mappedRunning = [mappedValue[@"state"] isEqual:@"running"];
  const BOOL requiresActivation = publicActivationRequested && mappedRunning &&
                                  !status.timed_out &&
                                  !status.cancellation_requested &&
                                  !parentActivationAbandoned;
  const BOOL activationSettled = !requiresActivation ||
      (parentActivationAttempted && !parentActivationInFlight);
  const BOOL effectiveTerminal = status.drained && mappedValue != nil &&
                                 activationSettled;
  NSMutableDictionary *result = [@{
    @"launchTaskRef": @(status.launch_task_ref),
    @"requestId": requestId,
    @"originRequestId": @(status.request_id),
    @"operationId": @(status.operation_id),
    @"runtimeEpoch": @(status.runtime_epoch),
    @"loginSessionId": @(status.login_session_id),
    @"nativeGeneration": @(status.native_generation),
    @"fence": @{
      @"runtimeEpoch": @(status.runtime_epoch),
      @"loginSessionId": @(status.login_session_id),
      @"nativeGeneration": @(status.native_generation),
      @"counter": @(status.fence_counter),
    },
    @"revision": @(status.revision),
    @"state": launch_state(status.state),
    @"mutationAttempted": @(status.mutation_attempted),
    @"cancellationRequested": @(status.cancellation_requested),
    @"timedOut": @(status.timed_out),
    @"callbackReceived": @(status.callback_received),
    @"drained": @(status.drained),
    @"lateCompletion": @(status.late_completion),
    @"publicActivationRequested": @(publicActivationRequested),
    @"activationDelegatedToParent": @YES,
    @"parentActivationAttempted": @(parentActivationAttempted),
    @"parentActivationSucceeded": @(parentActivationSucceeded),
    @"parentActivationInFlight": @(parentActivationInFlight),
    @"parentActivationAbandoned": @(parentActivationAbandoned),
    @"effectiveTerminal": @(effectiveTerminal),
    @"effectiveCleanup": effectiveTerminal ? @"complete" : @"unknown",
  } mutableCopy];
  if (status.error[0] != '\0') result[@"reason"] = @(status.error);
  if (status.process_present) {
    result[@"candidateProcess"] = @{
      @"pid": @(status.process.pid),
      @"launchTimeMicros":
          [NSString stringWithFormat:@"%llu",
                                     (unsigned long long)
                                         status.process.launch_time_micros],
      @"bundleId": @(status.process.bundle_id),
    };
  }
  if (mappedValue != nil) result[@"value"] = mappedValue;
  return result;
}

- (NSDictionary *)finalizeLaunch:(NSString *)launchTaskRef
                        requestId:(NSString *)requestId {
  [_lock lock];
  MetaApplicationLaunchEntry *entry = _launches[launchTaskRef];
  [_lock unlock];
  if (entry == nil) return nil;
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(entry.task);
  if (!status.drained) return [self launchStatus:launchTaskRef
                                      requestId:requestId];
  [_lock lock];
  const BOOL needsMapping = entry.mappedValue == nil;
  [_lock unlock];
  if (needsMapping) {
    NSDictionary *mapped = [self mapLaunchStatus:status entry:entry];
    [_lock lock];
    if (entry.mappedValue == nil) {
      entry.mappedValue = entry.parentActivationAbandoned
                              ? abandoned_activation(mapped)
                              : mapped;
    }
    [_lock unlock];
  }
  return [self launchStatus:launchTaskRef requestId:requestId];
}

- (NSDictionary *)activateLaunch:(NSString *)launchTaskRef
                  deadlineMillis:(uint64_t)deadlineMillis {
  [_lock lock];
  MetaApplicationLaunchEntry *entry = _launches[launchTaskRef];
  if (entry == nil || !entry.publicActivationRequested ||
      entry.parentActivationAttempted || entry.parentActivationAbandoned) {
    [_lock unlock];
    return nil;
  }
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(entry.task);
  if (!status.drained || status.state != META_APPLICATION_LAUNCH_TASK_COMPLETED ||
      !status.process_present || status.timed_out ||
      status.cancellation_requested || entry.mappedValue == nil ||
      ![entry.mappedValue[@"state"] isEqual:@"running"] ||
      _backend.monotonic_millis(_backend.context) >= deadlineMillis) {
    [_lock unlock];
    return nil;
  }
  entry.parentActivationAttempted = YES;
  entry.parentActivationInFlight = YES;
  [_lock unlock];
  MetaApplicationActivationStatus activation = _backend.activate(
      _backend.context, &status.process, deadlineMillis);
  [_lock lock];
  entry.parentActivationInFlight = NO;
  entry.parentActivationSucceeded =
      activation == META_APPLICATION_ACTIVATION_SUCCEEDED;
  if (!entry.parentActivationSucceeded) {
    NSDictionary *application = entry.mappedValue[@"application"];
    entry.mappedValue = @{
      @"state": @"unknown",
      @"reason": @"Application запущено, но explicit activation не подтверждена",
      @"candidate": application,
      @"errors": @[contract_error(
          @"application-activate",
          @"Application запущено, но explicit activation не подтверждена")],
    };
  }
  [_lock unlock];
  return [self launchStatus:launchTaskRef requestId:@"activation-status"];
}

- (NSDictionary *)cancelLaunch:(NSString *)launchTaskRef
                      requestId:(NSString *)requestId {
  [_lock lock];
  MetaApplicationLaunchEntry *entry = _launches[launchTaskRef];
  [_lock unlock];
  if (entry == nil) return nil;
  meta_application_launch_task_cancel(entry.task);
  return [self launchStatus:launchTaskRef requestId:requestId];
}

- (NSDictionary *)drainLaunchesUntil:(uint64_t)deadlineMillis {
  [_lock lock];
  _sealed = YES;
  for (MetaApplicationLaunchEntry *entry in _launches.allValues) {
    if (entry.publicActivationRequested &&
        !entry.parentActivationAttempted) {
      entry.parentActivationAbandoned = YES;
      if (entry.mappedValue != nil) {
        entry.mappedValue = abandoned_activation(entry.mappedValue);
      }
    }
  }
  NSArray<MetaApplicationLaunchEntry *> *entries = _launches.allValues;
  [_lock unlock];
  for (MetaApplicationLaunchEntry *entry in entries) {
    meta_application_launch_task_cancel(entry.task);
  }
  while (_backend.monotonic_millis(_backend.context) < deadlineMillis) {
    BOOL drained = YES;
    for (MetaApplicationLaunchEntry *entry in entries) {
      [_lock lock];
      const BOOL activationInFlight = entry.parentActivationInFlight;
      [_lock unlock];
      if (!meta_application_launch_task_status(entry.task).drained ||
          activationInFlight) {
        drained = NO;
        break;
      }
    }
    if (drained) break;
    _backend.wait_millis(_backend.context, 10);
  }
  NSMutableArray<NSString *> *active = [NSMutableArray array];
  [_lock lock];
  NSDictionary<NSString *, MetaApplicationLaunchEntry *> *launches =
      [_launches copy];
  [_lock unlock];
  for (NSString *taskRef in launches) {
    MetaApplicationLaunchEntry *entry = launches[taskRef];
    [_lock lock];
    const BOOL activationInFlight = entry.parentActivationInFlight;
    [_lock unlock];
    if (!meta_application_launch_task_status(entry.task).drained ||
        activationInFlight) {
      [active addObject:taskRef];
    }
  }
  return @{
    @"drained": @(active.count == 0),
    @"cleanup": active.count == 0 ? @"complete" : @"unknown",
    @"activeLaunchTaskRefs": [active sortedArrayUsingSelector:
                                      @selector(compare:)],
  };
}

- (BOOL)releaseLaunch:(NSString *)launchTaskRef {
  [_lock lock];
  MetaApplicationLaunchEntry *entry = _launches[launchTaskRef];
  if (entry == nil) {
    [_lock unlock];
    return NO;
  }
  MetaApplicationLaunchTaskStatus status =
      meta_application_launch_task_status(entry.task);
  const BOOL mappedRunning =
      [entry.mappedValue[@"state"] isEqual:@"running"];
  const BOOL requiresActivation = entry.publicActivationRequested &&
      mappedRunning && !status.timed_out &&
      !status.cancellation_requested &&
      !entry.parentActivationAbandoned;
  const BOOL effectiveTerminal = status.drained &&
      entry.mappedValue != nil &&
      (!requiresActivation ||
       (entry.parentActivationAttempted &&
        !entry.parentActivationInFlight));
  if (!effectiveTerminal ||
      !meta_application_launch_task_release(entry.task)) {
    [_lock unlock];
    return NO;
  }
  [_launches removeObjectForKey:launchTaskRef];
  [_lock unlock];
  return YES;
}

- (NSDictionary *)quit:(NSDictionary *)request
              operation:(NSDictionary *)operation
         deadlineMillis:(uint64_t)deadlineMillis {
  NSDictionary *application = request[@"application"];
  if (!generation_matches(_generation, operation) ||
      !generation_matches(_generation, application) ||
      ![operation[@"target"][@"kind"] isEqual:@"application"] ||
      ![operation[@"target"][@"ref"] isEqual:application]) return nil;
  NSDictionary *record = _referenceResolver(application);
  if (![record isKindOfClass:NSDictionary.class] ||
      ![record[@"applicationRef"] isEqual:application[@"applicationRef"]] ||
      ![record[@"pid"] isEqual:application[@"pid"]] ||
      ![record[@"launchedAt"] isEqual:application[@"launchedAt"]] ||
      ![record[@"registrationNonce"]
          isEqual:application[@"registrationNonce"]] ||
      !string_value(record[@"bundleId"], 255) ||
      !number_value(record[@"launchTimeMicros"])) return nil;
  MetaApplicationQuitRequest nativeRequest = {
      .process = {
          .pid = [record[@"pid"] intValue],
          .launch_time_micros =
              [record[@"launchTimeMicros"] unsignedLongLongValue],
      },
      .deadline_millis = deadlineMillis,
  };
  if (!copy_string(nativeRequest.application_ref,
                   sizeof(nativeRequest.application_ref),
                   record[@"applicationRef"]) ||
      !copy_string(nativeRequest.registration_nonce,
                   sizeof(nativeRequest.registration_nonce),
                   record[@"registrationNonce"]) ||
      !copy_string(nativeRequest.process.bundle_id,
                   sizeof(nativeRequest.process.bundle_id),
                   record[@"bundleId"])) return nil;
  MetaApplicationQuitResult physical = {0};
  if (!meta_application_quit(_backend, &nativeRequest, &physical)) return nil;
  NSDictionary *value = nil;
  if (physical.outcome == META_APPLICATION_QUIT_TERMINATED) {
    value = @{@"state": @"terminated", @"application": application};
  } else if (physical.outcome == META_APPLICATION_QUIT_STILL_RUNNING) {
    value = @{
      @"state": @"still-running",
      @"application": application,
      @"attentionMayBeRequired": @(physical.attention_may_be_required),
    };
  } else {
    NSString *reason = physical.error[0] == '\0'
                           ? @"Application quit outcome unknown"
                           : @(physical.error);
    value = unknown_quit(application, reason);
  }
  return @{
    @"value": value,
    @"mutationAttempted": @(physical.mutation_attempted),
    @"terminationRequested": @(physical.termination_requested),
    @"processRunning": @(physical.process_running),
    @"attentionMayBeRequired": @(physical.attention_may_be_required),
  };
}

- (NSUInteger)activeLaunchCount {
  [_lock lock];
  const NSUInteger count = _launches.count;
  [_lock unlock];
  return count;
}

- (NSDictionary *)mapLaunchStatus:(MetaApplicationLaunchTaskStatus)status
                             entry:(MetaApplicationLaunchEntry *)entry {
  NSString *reason = status.error[0] == '\0'
                         ? @"Application launch outcome unknown"
                         : @(status.error);
  if (status.state != META_APPLICATION_LAUNCH_TASK_COMPLETED ||
      !status.process_present) return unknown_launch(reason);
  NSDictionary *record = _candidateResolver(&status.process, entry.operation);
  if (![record isKindOfClass:NSDictionary.class] ||
      !string_value(record[@"applicationRef"], 127) ||
      ![record[@"pid"] isEqual:@(status.process.pid)] ||
      ![record[@"bundleId"] isEqual:@(status.process.bundle_id)] ||
      !number_value(record[@"launchTimeMicros"]) ||
      [record[@"launchTimeMicros"] unsignedLongLongValue] !=
          status.process.launch_time_micros ||
      !string_value(record[@"launchedAt"], 64) ||
      !string_value(record[@"registrationNonce"], 64)) {
    return unknown_launch(@"Launched process не найден в refreshed native registry");
  }
  NSDictionary *application = @{
    @"runtimeEpoch": entry.operation[@"runtimeEpoch"],
    @"loginSessionId": entry.operation[@"loginSessionId"],
    @"nativeGeneration": entry.operation[@"nativeGeneration"],
    @"applicationRef": record[@"applicationRef"],
    @"pid": record[@"pid"],
    @"launchedAt": record[@"launchedAt"],
    @"registrationNonce": record[@"registrationNonce"],
  };
  if (status.timed_out || status.cancellation_requested) {
    return @{
      @"state": @"unknown",
      @"reason": reason,
      @"candidate": application,
      @"errors": @[contract_error(@"application-launch", reason)],
    };
  }
  [_lock lock];
  const BOOL activationAbandoned = entry.parentActivationAbandoned;
  [_lock unlock];
  if (activationAbandoned) {
    return abandoned_activation(@{
      @"state": @"running",
      @"application": application,
      @"reused": @(status.reused_existing_process),
    });
  }
  return @{
    @"state": @"running",
    @"application": application,
    @"reused": @(status.reused_existing_process),
  };
}

@end
