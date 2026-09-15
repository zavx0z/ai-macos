#include "meta_observer_target_index.h"

#include <libproc.h>
#include <string.h>
#include <time.h>

#define META_OBSERVER_RESOLVE_MAX_NODES 32
#define META_OBSERVER_RESOLVE_DEADLINE_MILLIS 500
#define META_OBSERVER_AX_TIMEOUT_MILLIS 100

@interface MetaObserverTargetRecord ()
@property(nonatomic, readonly) pid_t pid;
@property(nonatomic, readonly) uint64_t processStartMicros;
@property(nonatomic, readonly) AXUIElementRef element;
@property(nonatomic, readonly) NSDictionary *target;
- (instancetype)initWithBorrow:(const MetaAXTargetBorrow *)borrow
                   targetValue:(NSDictionary *)target;
@end

@implementation MetaObserverTargetRecord {
  AXUIElementRef _element;
  pid_t _pid;
  uint64_t _processStartMicros;
  NSDictionary *_target;
}

- (instancetype)initWithBorrow:(const MetaAXTargetBorrow *)borrow
                   targetValue:(NSDictionary *)target {
  self = [super init];
  if (self) {
    _element = (AXUIElementRef)CFRetain(borrow->element);
    _pid = borrow->target.pid;
    _processStartMicros = borrow->launch_time_micros;
    _target = [target copy];
  }
  return self;
}

- (void)dealloc {
  if (_element != NULL) CFRelease(_element);
}

- (pid_t)pid { return _pid; }
- (uint64_t)processStartMicros { return _processStartMicros; }
- (AXUIElementRef)element { return _element; }
- (NSDictionary *)target { return _target; }

@end

static BOOL valid_identifier(NSString *value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 ||
      value.length > maximum) {
    return NO;
  }
  unichar first = [value characterAtIndex:0];
  const BOOL valid_first =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return valid_first &&
         [value rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

MetaObserverTargetRecord *meta_observer_target_record_create(
    const MetaAXTargetBorrow *borrow,
    NSString *runtimeEpoch,
    NSString *loginSessionId,
    NSString *nativeGeneration) {
  if (borrow == NULL || borrow->element == NULL || borrow->target.pid <= 0 ||
      borrow->launch_time_micros == 0 ||
      !valid_identifier(runtimeEpoch, 64) ||
      !valid_identifier(loginSessionId, 64) ||
      !valid_identifier(nativeGeneration, 64) ||
      strcmp(borrow->native_generation, nativeGeneration.UTF8String) != 0 ||
      !valid_identifier(@(borrow->target.application_ref), 127)) {
    return nil;
  }
  NSDictionary *reference = nil;
  NSString *kind = nil;
  if (borrow->target.surface_kind == META_SURFACE_WINDOW &&
      valid_identifier(@(borrow->target.window_ref), 127) &&
      strcmp(borrow->target.target_ref, borrow->target.window_ref) == 0) {
    kind = @"window";
    reference = @{
      @"runtimeEpoch" : runtimeEpoch,
      @"loginSessionId" : loginSessionId,
      @"nativeGeneration" : nativeGeneration,
      @"applicationRef" : @(borrow->target.application_ref),
      @"windowRef" : @(borrow->target.window_ref),
    };
  } else if (borrow->target.surface_kind == META_SURFACE_SHEET &&
             valid_identifier(@(borrow->target.surface_ref), 127) &&
             valid_identifier(@(borrow->target.owner_window_ref), 127) &&
             strcmp(borrow->target.target_ref,
                    borrow->target.surface_ref) == 0) {
    kind = @"surface";
    reference = @{
      @"runtimeEpoch" : runtimeEpoch,
      @"loginSessionId" : loginSessionId,
      @"nativeGeneration" : nativeGeneration,
      @"applicationRef" : @(borrow->target.application_ref),
      @"surfaceRef" : @(borrow->target.surface_ref),
      @"ownerWindowRef" : @(borrow->target.owner_window_ref),
    };
  }
  if (reference == nil || kind == nil) return nil;
  return [[MetaObserverTargetRecord alloc]
      initWithBorrow:borrow
         targetValue:@{@"kind" : kind, @"ref" : reference}];
}

static bool valid_backend(MetaObserverTargetBackend backend) {
  return backend.monotonic_millis != NULL &&
         backend.process_start_micros != NULL &&
         backend.copy_focused_window != NULL &&
         backend.copy_focused_element != NULL &&
         backend.copy_parent != NULL && backend.get_pid != NULL &&
         backend.equal != NULL && backend.release != NULL;
}

static uint64_t remaining_millis(MetaObserverTargetBackend backend,
                                 uint64_t started_at) {
  const uint64_t now = backend.monotonic_millis(backend.context);
  if (now < started_at ||
      now - started_at >= META_OBSERVER_RESOLVE_DEADLINE_MILLIS) {
    return 0;
  }
  return META_OBSERVER_RESOLVE_DEADLINE_MILLIS - (now - started_at);
}

static uint64_t call_timeout(MetaObserverTargetBackend backend,
                             uint64_t started_at) {
  const uint64_t remaining = remaining_millis(backend, started_at);
  if (remaining == 0) return 0;
  return remaining < META_OBSERVER_AX_TIMEOUT_MILLIS
             ? remaining
             : META_OBSERVER_AX_TIMEOUT_MILLIS;
}

static NSDictionary *resolve_ancestry(
    NSArray<MetaObserverTargetRecord *> *records,
    pid_t pid,
    uint64_t process_start,
    AXUIElementRef candidate,
    bool candidate_owned,
    uint64_t started_at,
    MetaObserverTargetBackend backend) {
  AXUIElementRef visited[META_OBSERVER_RESOLVE_MAX_NODES] = {0};
  bool owned[META_OBSERVER_RESOLVE_MAX_NODES] = {0};
  size_t count = 1;
  visited[0] = candidate;
  owned[0] = candidate_owned;
  NSDictionary *resolved = nil;
  for (;;) {
    AXUIElementRef current = visited[count - 1];
    if (remaining_millis(backend, started_at) == 0) break;
    pid_t current_pid = 0;
    if (backend.get_pid(backend.context, current, &current_pid) !=
            kAXErrorSuccess ||
        current_pid != pid || remaining_millis(backend, started_at) == 0) {
      break;
    }
    MetaObserverTargetRecord *match = nil;
    bool ambiguous = false;
    for (MetaObserverTargetRecord *record in records) {
      if (record.pid != pid || record.processStartMicros != process_start) {
        continue;
      }
      if (backend.equal(backend.context, current, record.element)) {
        if (match != nil && ![match.target isEqual:record.target]) {
          ambiguous = true;
          break;
        }
        match = record;
      }
    }
    if (ambiguous) break;
    if (match != nil) {
      const uint64_t after =
          backend.process_start_micros(backend.context, pid);
      if (after == process_start &&
          remaining_millis(backend, started_at) > 0) {
        resolved = match.target;
      }
      break;
    }
    if (count == META_OBSERVER_RESOLVE_MAX_NODES) break;
    const uint64_t timeout = call_timeout(backend, started_at);
    if (timeout == 0) break;
    AXUIElementRef parent = NULL;
    const AXError error = backend.copy_parent(
        backend.context, current, timeout, &parent);
    if (error != kAXErrorSuccess || parent == NULL ||
        remaining_millis(backend, started_at) == 0) {
      if (parent != NULL) backend.release(backend.context, parent);
      break;
    }
    bool cycle = false;
    for (size_t index = 0; index < count; index += 1) {
      if (backend.equal(backend.context, parent, visited[index])) {
        cycle = true;
        break;
      }
    }
    if (cycle) {
      backend.release(backend.context, parent);
      break;
    }
    visited[count] = parent;
    owned[count] = true;
    count += 1;
  }
  for (size_t index = 0; index < count; index += 1) {
    if (owned[index]) backend.release(backend.context, visited[index]);
  }
  return resolved;
}

static bool focus_notification(NSString *notification) {
  return [notification
             isEqual:(__bridge NSString *)kAXFocusedWindowChangedNotification] ||
         [notification
             isEqual:(__bridge NSString *)kAXFocusedUIElementChangedNotification] ||
         [notification isEqual:@"application-activated"];
}

@implementation MetaObserverTargetIndex {
  NSLock *_lock;
  NSArray<MetaObserverTargetRecord *> *_records;
  MetaObserverTargetBackend _backend;
}

- (instancetype)init {
  return [self initWithBackend:meta_observer_target_system_backend()];
}

- (instancetype)initWithBackend:(MetaObserverTargetBackend)backend {
  if (!valid_backend(backend)) return nil;
  self = [super init];
  if (self) {
    _lock = [[NSLock alloc] init];
    _records = @[];
    _backend = backend;
  }
  return self;
}

- (BOOL)replaceRecords:(NSArray<MetaObserverTargetRecord *> *)records {
  if (![records isKindOfClass:NSArray.class] ||
      records.count > META_OBSERVER_TARGET_INDEX_MAX_RECORDS) {
    return NO;
  }
  for (id record in records) {
    if (![record isMemberOfClass:MetaObserverTargetRecord.class]) return NO;
    MetaObserverTargetRecord *target = record;
    if (target.element == NULL || target.pid <= 0 ||
        target.processStartMicros == 0 ||
        ![target.target isKindOfClass:NSDictionary.class]) {
      return NO;
    }
  }
  NSArray *replacement = [records copy];
  [_lock lock];
  _records = replacement;
  [_lock unlock];
  return YES;
}

- (NSDictionary *)resolveFocusForPid:(pid_t)pid
                              element:(AXUIElementRef)element
                         notification:(NSString *)notification {
  if (pid <= 0 || element == NULL ||
      ![notification isKindOfClass:NSString.class] ||
      notification.length == 0) {
    return nil;
  }
  [_lock lock];
  NSArray<MetaObserverTargetRecord *> *records = _records;
  [_lock unlock];
  if (records.count == 0) return nil;
  const uint64_t started_at =
      _backend.monotonic_millis(_backend.context);
  const uint64_t process_start =
      _backend.process_start_micros(_backend.context, pid);
  if (started_at == UINT64_MAX || process_start == 0 ||
      remaining_millis(_backend, started_at) == 0) {
    return nil;
  }
  bool known_process = false;
  for (MetaObserverTargetRecord *record in records) {
    if (record.pid == pid && record.processStartMicros == process_start) {
      known_process = true;
      break;
    }
  }
  if (!known_process) return nil;

  const bool created = [notification
      isEqual:(__bridge NSString *)kAXWindowCreatedNotification];
  if (!created && focus_notification(notification)) {
    const uint64_t element_timeout = call_timeout(_backend, started_at);
    if (element_timeout == 0) return nil;
    AXUIElementRef focused_element = NULL;
    if (_backend.copy_focused_element(
            _backend.context, element, element_timeout,
            &focused_element) == kAXErrorSuccess &&
        focused_element != NULL) {
      NSDictionary *resolved = resolve_ancestry(
          records, pid, process_start, focused_element, true,
          started_at, _backend);
      if (resolved != nil) return resolved;
    } else if (focused_element != NULL) {
      _backend.release(_backend.context, focused_element);
    }
    const uint64_t window_timeout = call_timeout(_backend, started_at);
    if (window_timeout == 0) return nil;
    AXUIElementRef focused_window = NULL;
    if (_backend.copy_focused_window(
            _backend.context, element, window_timeout,
            &focused_window) == kAXErrorSuccess &&
        focused_window != NULL) {
      NSDictionary *resolved = resolve_ancestry(
          records, pid, process_start, focused_window, true,
          started_at, _backend);
      if (resolved != nil) return resolved;
    } else if (focused_window != NULL) {
      _backend.release(_backend.context, focused_window);
    }
  }
  return resolve_ancestry(records, pid, process_start, element, false,
                          started_at, _backend);
}

@end

static uint64_t system_monotonic_millis(void *context) {
  (void)context;
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000 +
         (uint64_t)value.tv_nsec / 1000000;
}

static uint64_t system_process_start(void *context, pid_t pid) {
  (void)context;
  struct proc_bsdinfo info = {0};
  const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) return 0;
  return (uint64_t)info.pbi_start_tvsec * 1000000ULL +
         (uint64_t)info.pbi_start_tvusec;
}

static AXError copy_attribute(AXUIElementRef element, CFStringRef attribute,
                              uint64_t timeout_millis,
                              AXUIElementRef *output) {
  if (element == NULL || output == NULL || timeout_millis == 0 ||
      timeout_millis > META_OBSERVER_AX_TIMEOUT_MILLIS) {
    return kAXErrorIllegalArgument;
  }
  AXUIElementSetMessagingTimeout(element, (float)timeout_millis / 1000.0f);
  CFTypeRef value = NULL;
  const AXError error = AXUIElementCopyAttributeValue(
      element, attribute, &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != AXUIElementGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return error == kAXErrorSuccess ? kAXErrorIllegalArgument : error;
  }
  *output = (AXUIElementRef)value;
  return kAXErrorSuccess;
}

static AXError copy_focused_window(void *context, AXUIElementRef element,
                                   uint64_t timeout_millis,
                                   AXUIElementRef *focused) {
  (void)context;
  return copy_attribute(element, kAXFocusedWindowAttribute, timeout_millis,
                        focused);
}

static AXError copy_focused_element(void *context, AXUIElementRef element,
                                    uint64_t timeout_millis,
                                    AXUIElementRef *focused) {
  (void)context;
  return copy_attribute(element, kAXFocusedUIElementAttribute, timeout_millis,
                        focused);
}

static AXError copy_parent(void *context, AXUIElementRef element,
                           uint64_t timeout_millis,
                           AXUIElementRef *parent) {
  (void)context;
  return copy_attribute(element, kAXParentAttribute, timeout_millis, parent);
}

static AXError get_pid(void *context, AXUIElementRef element, pid_t *pid) {
  (void)context;
  return AXUIElementGetPid(element, pid);
}

static bool equal(void *context, AXUIElementRef left, AXUIElementRef right) {
  (void)context;
  return CFEqual(left, right);
}

static void release(void *context, AXUIElementRef element) {
  (void)context;
  CFRelease(element);
}

MetaObserverTargetBackend meta_observer_target_system_backend(void) {
  return (MetaObserverTargetBackend){
      .monotonic_millis = system_monotonic_millis,
      .process_start_micros = system_process_start,
      .copy_focused_window = copy_focused_window,
      .copy_focused_element = copy_focused_element,
      .copy_parent = copy_parent,
      .get_pid = get_pid,
      .equal = equal,
      .release = release,
  };
}
