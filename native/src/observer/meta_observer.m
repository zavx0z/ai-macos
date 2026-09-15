#include "meta_observer.h"

#import <AppKit/AppKit.h>

#include <libproc.h>
#include <unistd.h>
#include <time.h>

static uint64_t observer_monotonic_millis(void) {
  struct timespec value = {0};
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 +
         (uint64_t)value.tv_nsec / 1000000;
}

static uint64_t observer_process_start_micros(pid_t pid) {
  if (pid <= 0) return 0;
  struct proc_bsdinfo info = {0};
  const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) return 0;
  return (uint64_t)info.pbi_start_tvsec * 1000000ULL +
         (uint64_t)info.pbi_start_tvusec;
}

BOOL meta_observer_subscription_budget_init(
    MetaObserverSubscriptionBudget *budget,
    uint64_t now_millis,
    NSUInteger existing_windows) {
  if (budget == NULL ||
      existing_windows > META_OBSERVER_MAX_WINDOWS ||
      now_millis > UINT64_MAX - META_OBSERVER_SUBSCRIPTION_BUDGET_MILLIS) {
    return NO;
  }
  *budget = (MetaObserverSubscriptionBudget){
    .deadline_millis =
        now_millis + META_OBSERVER_SUBSCRIPTION_BUDGET_MILLIS,
    .remaining_windows = META_OBSERVER_MAX_WINDOWS - existing_windows,
  };
  return YES;
}

BOOL meta_observer_subscription_budget_admit_windows(
    MetaObserverSubscriptionBudget *budget,
    uint64_t now_millis,
    NSUInteger count) {
  if (budget == NULL || now_millis >= budget->deadline_millis ||
      count > META_OBSERVER_MAX_WINDOWS_PER_APPLICATION ||
      count > budget->remaining_windows) {
    return NO;
  }
  budget->remaining_windows -= count;
  return YES;
}

NSTimeInterval meta_observer_subscription_timeout_seconds(
    MetaObserverSubscriptionBudget budget,
    uint64_t now_millis) {
  if (now_millis >= budget.deadline_millis) return 0;
  const uint64_t remaining = budget.deadline_millis - now_millis;
  return (NSTimeInterval)MIN(remaining, 500) / 1000.0;
}

static NSString *observer_time(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

static NSString *event_tag(uint64_t tag) {
  return [NSString stringWithFormat:@"event-%016llx", tag];
}

static BOOL valid_identifier(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSData *data = [value dataUsingEncoding:NSASCIIStringEncoding];
  if (data == nil || data.length == 0 || data.length > 127) return NO;
  const unsigned char *bytes = data.bytes;
  for (NSUInteger index = 0; index < data.length; index += 1) {
    const unsigned char byte = bytes[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '.' || byte == '_' ||
          byte == ':' || byte == '-')) {
      return NO;
    }
  }
  return YES;
}

static NSString *bounded_reason(NSString *reason) {
  if (![reason isKindOfClass:NSString.class] || reason.length == 0) {
    return @"Observer недоступен без причины";
  }
  return reason.length <= 1024 ? [reason copy]
                               : [reason substringToIndex:1024];
}

static BOOL observer_window_structure_notification(NSString *notification) {
  return [@[
    (__bridge NSString *)kAXWindowCreatedNotification,
    (__bridge NSString *)kAXMovedNotification,
    (__bridge NSString *)kAXResizedNotification,
    (__bridge NSString *)kAXWindowMiniaturizedNotification,
    (__bridge NSString *)kAXWindowDeminiaturizedNotification,
    (__bridge NSString *)kAXUIElementDestroyedNotification,
  ] containsObject:notification];
}

static BOOL observer_focus_notification(NSString *notification) {
  return [notification isEqual:@"application-activated"] || [@[
    (__bridge NSString *)kAXFocusedWindowChangedNotification,
    (__bridge NSString *)kAXFocusedUIElementChangedNotification,
  ] containsObject:notification];
}

static id immutable_json_copy(id value) {
  if (value == nil) return nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  if (data == nil) return nil;
  return [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
}

static CGEventRef observe_input(CGEventTapProxy proxy, CGEventType type,
                                CGEventRef event, void *context) {
  (void)proxy;
  MetaNativeObserver *observer = (__bridge MetaNativeObserver *)context;
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    [observer recordInputFromPid:0 syntheticTag:0];
    [observer markUnavailable:@"CG event tap disabled: input coverage interrupted"];
    return event;
  }
  [observer
      recordInputFromPid:(pid_t)CGEventGetIntegerValueField(
                             event, kCGEventSourceUnixProcessID)
            syntheticTag:(uint64_t)CGEventGetIntegerValueField(
                             event, kCGEventSourceUserData)];
  return event;
}

@interface MetaNativeObserver ()
- (void)handleAXElement:(AXUIElementRef)element
                    pid:(pid_t)pid
           notification:(NSString *)notification
          sourceObserver:(nullable AXObserverRef)sourceObserver;
- (void)handleActivatedApplication:(NSRunningApplication *)application;
- (void)handleTerminatedApplication:(NSRunningApplication *)application;
- (uint64_t)processBirthForPid:(pid_t)pid;
- (BOOL)subscribeApplication:(NSRunningApplication *)application;
- (BOOL)subscribeWindowsForApplication:(AXUIElementRef)application
                               observer:(AXObserverRef)observer
                                    pid:(pid_t)pid
                                 budget:(MetaObserverSubscriptionBudget *)budget;
- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid;
- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid
                  budget:(MetaObserverSubscriptionBudget *)budget;
- (void)removeApplicationPid:(pid_t)pid;
- (BOOL)validTarget:(NSDictionary *)target;
@end

static void observe_ax(AXObserverRef observer, AXUIElementRef element,
                       CFStringRef notification, void *context) {
  (void)observer;
  MetaNativeObserver *native = (__bridge MetaNativeObserver *)context;
  pid_t pid = 0;
  if (AXUIElementGetPid(element, &pid) != kAXErrorSuccess || pid <= 0) {
    [native markUnavailable:@"AX focus callback не содержит valid PID"];
    return;
  }
  [native handleAXElement:element
                      pid:pid
             notification:(__bridge NSString *)notification
            sourceObserver:observer];
}

@implementation MetaNativeObserver {
  NSDictionary *_generation;
  NSLock *_lock;
  NSMutableArray<NSDictionary *> *_events;
  NSMutableDictionary<NSNumber *, NSDictionary *> *_syntheticOwnersByTag;
  NSMutableDictionary<NSString *, NSDictionary *> *_syntheticOwnersByEventTag;
  NSMutableArray *_workspaceTokens;
  NSMutableArray *_distributedTokens;
  NSMutableDictionary<NSNumber *, id> *_axObservers;
  NSMutableDictionary<NSNumber *, id> *_axApplications;
  NSMutableDictionary<NSNumber *, NSNumber *> *_axProcessBirths;
  NSMutableDictionary<NSNumber *, NSRunningApplication *> *_runningApplications;
  NSMutableDictionary<NSNumber *, NSMutableArray<id> *> *_axWindows;
  NSUInteger _axWindowCount;
  MetaObserverFocusResolver _focusResolver;
  MetaObserverEventSink _eventSink;
  CFMachPortRef _tap;
  CFRunLoopSourceRef _source;
  NSTimer *_heartbeatTimer;
  NSUInteger _bytes;
  uint64_t _sequence;
  uint64_t _dropped;
  BOOL _gap;
  BOOL _ready;
  BOOL _inputCoverage;
  BOOL _focusCoverage;
  BOOL _windowCoverage;
  BOOL _lifecycleCoverage;
  NSString *_reason;
  NSString *_startedAt;
  NSString *_coveredFrom;
  NSString *_coveredThrough;
  NSString *_heartbeat;
  NSString *_lastEvent;
  NSString *_startCursor;
  NSString *_cursor;
  NSDictionary *_sessionReadiness;
}

- (instancetype)initWithGeneration:(NSDictionary *)generation {
  self = [super init];
  if (self) {
    for (NSString *key in
         @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
      if (![generation[key] isKindOfClass:NSString.class] ||
          [generation[key] length] == 0) {
        return nil;
      }
    }
    _generation = [generation copy];
    _lock = [[NSLock alloc] init];
    _events = [NSMutableArray array];
    _syntheticOwnersByTag = [NSMutableDictionary dictionary];
    _syntheticOwnersByEventTag = [NSMutableDictionary dictionary];
    _workspaceTokens = [NSMutableArray array];
    _distributedTokens = [NSMutableArray array];
    _axObservers = [NSMutableDictionary dictionary];
    _axApplications = [NSMutableDictionary dictionary];
    _axProcessBirths = [NSMutableDictionary dictionary];
    _runningApplications = [NSMutableDictionary dictionary];
    _axWindows = [NSMutableDictionary dictionary];
    _startedAt = observer_time();
    _coveredFrom = _startedAt;
    _coveredThrough = _startedAt;
    _heartbeat = _startedAt;
    _startCursor = [@"observer-" stringByAppendingString:NSUUID.UUID.UUIDString];
    _cursor = _startCursor;
    _sequence = 1;
    _reason = @"Observer не запущен";
    _sessionReadiness = @{
      @"state" : @"unknown",
      @"lockState" : @"unknown",
      @"evidence" : @"Current session state не подтверждён",
      @"observedAt" : _startedAt,
    };
  }
  return self;
}

- (void)setFocusResolver:(MetaObserverFocusResolver)resolver {
  [_lock lock];
  _focusResolver = [resolver copy];
  [_lock unlock];
}

- (void)setEventSink:(MetaObserverEventSink)sink {
  [_lock lock];
  _eventSink = [sink copy];
  [_lock unlock];
}

- (BOOL)start {
  if (![NSThread isMainThread] || _tap != NULL) return NO;
  if (!CGPreflightListenEventAccess()) {
    [self markUnavailable:@"Event observation permission не выдано helper"];
    return NO;
  }
  [_lock lock];
  const BOOL hasResolver = _focusResolver != nil;
  [_lock unlock];
  if (!AXIsProcessTrusted() || !hasResolver) {
    [self markUnavailable:@"AX focus resolver или Accessibility недоступны"];
    return NO;
  }

  CGEventMask mask =
      CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
      CGEventMaskBit(kCGEventFlagsChanged) |
      CGEventMaskBit(kCGEventMouseMoved) |
      CGEventMaskBit(kCGEventLeftMouseDown) |
      CGEventMaskBit(kCGEventLeftMouseUp) |
      CGEventMaskBit(kCGEventRightMouseDown) |
      CGEventMaskBit(kCGEventRightMouseUp) |
      CGEventMaskBit(kCGEventOtherMouseDown) |
      CGEventMaskBit(kCGEventOtherMouseUp) |
      CGEventMaskBit(kCGEventLeftMouseDragged) |
      CGEventMaskBit(kCGEventRightMouseDragged) |
      CGEventMaskBit(kCGEventOtherMouseDragged) |
      CGEventMaskBit(kCGEventScrollWheel);
  _tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap,
                          kCGEventTapOptionListenOnly, mask, observe_input,
                          (__bridge void *)self);
  if (_tap == NULL) {
    [self markUnavailable:@"CG event tap unavailable"];
    return NO;
  }
  _source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, _tap, 0);
  if (_source == NULL) {
    CFMachPortInvalidate(_tap);
    CFRelease(_tap);
    _tap = NULL;
    [self markUnavailable:@"CG event tap runloop source unavailable"];
    return NO;
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), _source, kCFRunLoopCommonModes);
  CGEventTapEnable(_tap, true);
  [self recordCoverageKind:@"input" available:YES reason:nil];

  NSRunningApplication *frontmost =
      NSWorkspace.sharedWorkspace.frontmostApplication;
  BOOL subscriptionsReady = frontmost != nil &&
                            [self subscribeApplication:frontmost];
  [self recordCoverageKind:@"focus"
                 available:subscriptionsReady
                    reason:subscriptionsReady
                               ? nil
                               : @"Одна или несколько AX focus subscriptions недоступны"];
  [self recordCoverageKind:@"window-structure"
                 available:subscriptionsReady
                    reason:subscriptionsReady
                               ? nil
                               : @"AX window structure coverage неполна"];
  if (!subscriptionsReady) {
    [self stop];
    [self markUnavailable:
              @"AX subscription budget, window cap или registration недоступны"];
    return NO;
  }

  NSNotificationCenter *workspaceCenter =
      NSWorkspace.sharedWorkspace.notificationCenter;
  __weak MetaNativeObserver *weakSelf = self;
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceDidActivateApplicationNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(NSNotification *note) {
                              MetaNativeObserver *observer = weakSelf;
                              NSRunningApplication *application =
                                  note.userInfo[NSWorkspaceApplicationKey];
                              if (observer == nil || application == nil) return;
                              [observer handleActivatedApplication:application];
                            }]];
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(NSNotification *note) {
                              NSRunningApplication *application =
                                  note.userInfo[NSWorkspaceApplicationKey];
                              if (application != nil) {
                                [weakSelf handleTerminatedApplication:application];
                              }
                            }]];

  NSDictionary *workspaceLifecycle = @{
    NSWorkspaceWillSleepNotification : @"sleep",
    NSWorkspaceDidWakeNotification : @"wake",
  };
  for (NSString *name in workspaceLifecycle) {
    NSString *lifecycle = workspaceLifecycle[name];
    [_workspaceTokens
        addObject:[workspaceCenter addObserverForName:name
                                              object:nil
                                               queue:NSOperationQueue.mainQueue
                                          usingBlock:^(__unused NSNotification *note) {
                                            [weakSelf recordLifecycle:lifecycle
                                                   nextLoginSessionId:nil];
                                            [weakSelf recordCurrentSessionReadiness:@{
                                              @"state" : [lifecycle isEqual:@"sleep"] ? @"inactive" : @"unknown",
                                              @"lockState" : @"unknown",
                                              @"evidence" : name,
                                            }];
                                            [weakSelf markUnavailable:@"Session lifecycle изменился; требуется новый observer snapshot"];
                                          }]];
  }
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceSessionDidResignActiveNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(__unused NSNotification *note) {
                              [weakSelf recordUnresolvedFocus:@"Workspace session стала inactive; lock/Fast User Switching не различены"];
                              [weakSelf recordCurrentSessionReadiness:@{
                                @"state" : @"inactive",
                                @"lockState" : @"unknown",
                                @"evidence" : @"NSWorkspaceSessionDidResignActiveNotification",
                              }];
                            }]];
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceSessionDidBecomeActiveNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(__unused NSNotification *note) {
                              [weakSelf recordUnresolvedFocus:@"Workspace session снова active; unlocked state требует нового positive evidence"];
                              [weakSelf recordCurrentSessionReadiness:@{
                                @"state" : @"unknown",
                                @"lockState" : @"unknown",
                                @"evidence" : @"NSWorkspaceSessionDidBecomeActiveNotification",
                              }];
                            }]];
  NSDistributedNotificationCenter *distributed =
      NSDistributedNotificationCenter.defaultCenter;
  NSDictionary *screenLifecycle = @{
    @"com.apple.screenIsLocked" : @"lock",
    @"com.apple.screenIsUnlocked" : @"unlock",
  };
  for (NSString *name in screenLifecycle) {
    NSString *lifecycle = screenLifecycle[name];
    [_distributedTokens
        addObject:[distributed addObserverForName:name
                                           object:nil
                                            queue:NSOperationQueue.mainQueue
                                       usingBlock:^(__unused NSNotification *note) {
                                         [weakSelf recordLifecycle:lifecycle
                                                nextLoginSessionId:nil];
                                         [weakSelf recordCurrentSessionReadiness:@{
                                           @"state" : @"unknown",
                                           @"lockState" : [lifecycle isEqual:@"lock"] ? @"locked" : @"unknown",
                                           @"evidence" : name,
                                         }];
                                         [weakSelf markUnavailable:@"Lock state изменился; требуется новый observer snapshot"];
                                       }]];
  }
  [self recordCoverageKind:@"lifecycle" available:YES reason:nil];
  _heartbeatTimer = [NSTimer
      scheduledTimerWithTimeInterval:0.25
                              repeats:YES
                                block:^(__unused NSTimer *timer) {
                                  [weakSelf recordHeartbeat];
                                }];
  return [self.coverage[@"state"] isEqual:@"ready"];
}

- (void)stop {
  if (![NSThread isMainThread]) return;
  [_heartbeatTimer invalidate];
  _heartbeatTimer = nil;
  if (_tap != NULL) CFMachPortInvalidate(_tap);
  if (_source != NULL) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), _source, kCFRunLoopCommonModes);
    CFRelease(_source);
    _source = NULL;
  }
  if (_tap != NULL) {
    CFRelease(_tap);
    _tap = NULL;
  }
  for (NSNumber *pid in _axObservers.allKeys) {
    [self removeApplicationPid:pid.intValue];
  }
  NSNotificationCenter *workspaceCenter =
      NSWorkspace.sharedWorkspace.notificationCenter;
  for (id token in _workspaceTokens) [workspaceCenter removeObserver:token];
  [_workspaceTokens removeAllObjects];
  NSDistributedNotificationCenter *distributed =
      NSDistributedNotificationCenter.defaultCenter;
  for (id token in _distributedTokens) [distributed removeObserver:token];
  [_distributedTokens removeAllObjects];
  [self markUnavailable:@"Observer остановлен"];
  [_lock lock];
  _inputCoverage = NO;
  _focusCoverage = NO;
  _windowCoverage = NO;
  _lifecycleCoverage = NO;
  [_lock unlock];
}

- (BOOL)subscribeApplication:(NSRunningApplication *)application {
  const pid_t pid = application.processIdentifier;
  if (pid <= 0) return NO;
  const uint64_t processBirth = [self processBirthForPid:pid];
  if (processBirth == 0) return NO;
  NSNumber *subscribedBirth = _axProcessBirths[@(pid)];
  if (_axObservers[@(pid)] != nil &&
      subscribedBirth.unsignedLongLongValue == processBirth) {
    return YES;
  }
  if (_axObservers[@(pid)] != nil || subscribedBirth != nil) {
    [self removeApplicationPid:pid];
  }
  if (_axObservers.count >= META_OBSERVER_MAX_APPLICATIONS) return NO;
  MetaObserverSubscriptionBudget budget = {0};
  if (!meta_observer_subscription_budget_init(
          &budget, observer_monotonic_millis(), _axWindowCount)) {
    return NO;
  }
  AXObserverRef observer = NULL;
  if (AXObserverCreate(pid, observe_ax, &observer) != kAXErrorSuccess ||
      observer == NULL || observer_monotonic_millis() >= budget.deadline_millis) {
    if (observer != NULL) CFRelease(observer);
    return NO;
  }
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (app == NULL) {
    CFRelease(observer);
    return NO;
  }
  NSArray<NSString *> *notifications = @[
    (__bridge NSString *)kAXFocusedWindowChangedNotification,
    (__bridge NSString *)kAXFocusedUIElementChangedNotification,
    (__bridge NSString *)kAXWindowCreatedNotification,
  ];
  BOOL subscribed = YES;
  for (NSString *name in notifications) {
    const uint64_t now = observer_monotonic_millis();
    NSTimeInterval timeout =
        meta_observer_subscription_timeout_seconds(budget, now);
    if (timeout <= 0 ||
        AXUIElementSetMessagingTimeout(app, (float)timeout) !=
            kAXErrorSuccess) {
      subscribed = NO;
      break;
    }
    AXError error = AXObserverAddNotification(
        observer, app, (__bridge CFStringRef)name, (__bridge void *)self);
    if (error != kAXErrorSuccess && error != kAXErrorNotificationAlreadyRegistered) {
      subscribed = NO;
      break;
    }
    if (observer_monotonic_millis() >= budget.deadline_millis) {
      subscribed = NO;
      break;
    }
  }
  if (subscribed) {
    subscribed = [self subscribeWindowsForApplication:app
                                              observer:observer
                                                   pid:pid
                                                budget:&budget];
  }
  if (subscribed && [self processBirthForPid:pid] != processBirth) {
    subscribed = NO;
  }
  if (!subscribed) {
    NSUInteger partial = [_axWindows[@(pid)] count];
    [_axWindows removeObjectForKey:@(pid)];
    _axWindowCount = partial > _axWindowCount ? 0
                                              : _axWindowCount - partial;
    CFRelease(app);
    CFRelease(observer);
    return NO;
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer),
                     kCFRunLoopCommonModes);
  _axObservers[@(pid)] = CFBridgingRelease(observer);
  _axApplications[@(pid)] = CFBridgingRelease(app);
  _axProcessBirths[@(pid)] = @(processBirth);
  _runningApplications[@(pid)] = application;
  return YES;
}

- (BOOL)subscribeWindowsForApplication:(AXUIElementRef)application
                               observer:(AXObserverRef)observer
                                    pid:(pid_t)pid
                                 budget:(MetaObserverSubscriptionBudget *)budget {
  const uint64_t countStart = observer_monotonic_millis();
  NSTimeInterval timeout =
      meta_observer_subscription_timeout_seconds(*budget, countStart);
  if (timeout <= 0 ||
      AXUIElementSetMessagingTimeout(application, (float)timeout) !=
          kAXErrorSuccess) {
    return NO;
  }
  CFIndex count = 0;
  AXError error = AXUIElementGetAttributeValueCount(
      application, kAXWindowsAttribute, &count);
  if (error != kAXErrorSuccess || count < 0 ||
      !meta_observer_subscription_budget_admit_windows(
          budget, observer_monotonic_millis(), (NSUInteger)count)) {
    return NO;
  }
  if (count == 0) return YES;
  timeout = meta_observer_subscription_timeout_seconds(
      *budget, observer_monotonic_millis());
  if (timeout <= 0 ||
      AXUIElementSetMessagingTimeout(application, (float)timeout) !=
          kAXErrorSuccess) {
    return NO;
  }
  CFArrayRef copied = NULL;
  error = AXUIElementCopyAttributeValues(
      application, kAXWindowsAttribute, 0, count, &copied);
  if (error != kAXErrorSuccess || copied == NULL ||
      CFGetTypeID(copied) != CFArrayGetTypeID() ||
      CFArrayGetCount(copied) != count ||
      observer_monotonic_millis() >= budget->deadline_millis) {
    if (copied != NULL) CFRelease(copied);
    return NO;
  }
  NSArray *windows = CFBridgingRelease(copied);
  for (id item in windows) {
    AXUIElementRef window = (__bridge AXUIElementRef)item;
    if (![self subscribeWindow:window
                       observer:observer
                            pid:pid
                         budget:budget]) return NO;
  }
  return YES;
}

- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid {
  MetaObserverSubscriptionBudget budget = {0};
  if (!meta_observer_subscription_budget_init(
          &budget, observer_monotonic_millis(), _axWindowCount) ||
      !meta_observer_subscription_budget_admit_windows(
          &budget, observer_monotonic_millis(), 1)) {
    return NO;
  }
  return [self subscribeWindow:window
                      observer:observer
                           pid:pid
                        budget:&budget];
}

- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid
                  budget:(MetaObserverSubscriptionBudget *)budget {
  if (window == NULL || observer == NULL || budget == NULL) return NO;
  NSMutableArray<id> *stored = _axWindows[@(pid)];
  if ([stored containsObject:(__bridge id)window]) return YES;
  NSArray<NSString *> *notifications = @[
    (__bridge NSString *)kAXMovedNotification,
    (__bridge NSString *)kAXResizedNotification,
    (__bridge NSString *)kAXWindowMiniaturizedNotification,
    (__bridge NSString *)kAXWindowDeminiaturizedNotification,
    (__bridge NSString *)kAXUIElementDestroyedNotification,
  ];
  for (NSString *name in notifications) {
    const uint64_t now = observer_monotonic_millis();
    NSTimeInterval timeout =
        meta_observer_subscription_timeout_seconds(*budget, now);
    if (timeout <= 0 ||
        AXUIElementSetMessagingTimeout(window, (float)timeout) !=
            kAXErrorSuccess) {
      return NO;
    }
    AXError error = AXObserverAddNotification(
        observer, window, (__bridge CFStringRef)name, (__bridge void *)self);
    if (error != kAXErrorSuccess &&
        error != kAXErrorNotificationAlreadyRegistered) {
      return NO;
    }
    if (observer_monotonic_millis() >= budget->deadline_millis) return NO;
  }
  if (stored == nil) {
    stored = [NSMutableArray array];
    _axWindows[@(pid)] = stored;
  }
  [stored addObject:(__bridge id)window];
  _axWindowCount += 1;
  return YES;
}

- (void)removeApplicationPid:(pid_t)pid {
  id stored = _axObservers[@(pid)];
  if (stored != nil) {
    AXObserverRef observer = (__bridge AXObserverRef)stored;
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer),
                          kCFRunLoopCommonModes);
  }
  [_axObservers removeObjectForKey:@(pid)];
  [_axApplications removeObjectForKey:@(pid)];
  [_axProcessBirths removeObjectForKey:@(pid)];
  [_runningApplications removeObjectForKey:@(pid)];
  NSUInteger removed = [_axWindows[@(pid)] count];
  [_axWindows removeObjectForKey:@(pid)];
  _axWindowCount = removed > _axWindowCount ? 0 : _axWindowCount - removed;
}

- (void)handleAXElement:(AXUIElementRef)element
                    pid:(pid_t)pid
           notification:(NSString *)notification
          sourceObserver:(AXObserverRef)sourceObserver {
  id storedObserver = _axObservers[@(pid)];
  if (storedObserver == nil ||
      (sourceObserver != NULL &&
       (__bridge AXObserverRef)storedObserver != sourceObserver)) {
    [self markUnavailable:
              @"AX callback не принадлежит current raw subscription"];
    return;
  }
  NSNumber *subscribedBirth = _axProcessBirths[@(pid)];
  const uint64_t currentBirth = [self processBirthForPid:pid];
  if (subscribedBirth == nil || currentBirth == 0 ||
      subscribedBirth.unsignedLongLongValue != currentBirth) {
    [self markUnavailable:
              @"AX callback PID incarnation не совпадает с raw subscription"];
    return;
  }
  BOOL windowCreated = [notification
      isEqual:(__bridge NSString *)kAXWindowCreatedNotification];
  BOOL windowStructure =
      observer_window_structure_notification(notification);
  BOOL focus = observer_focus_notification(notification);
  if (!windowStructure && !focus) {
    [self markUnavailable:@"AX callback notification не была подписана"];
    return;
  }
  if (windowCreated) {
    if (![self subscribeWindow:element
                      observer:(__bridge AXObserverRef)storedObserver
                           pid:pid]) {
      [self recordCoverageKind:@"window-structure"
                     available:NO
                        reason:@"Новое AX window не получило полный набор structure subscriptions"];
      return;
    }
  }
  [_lock lock];
  MetaObserverFocusResolver resolver = _focusResolver;
  [_lock unlock];
  NSDictionary *target = resolver == nil ? nil : resolver(pid, element, notification);
  if (![self validTarget:target]) {
    if (windowStructure) {
      [self recordGlobalWindowStructure];
    } else {
      [self recordGlobalFocus];
    }
    return;
  }
  if (windowCreated) {
    [self recordWindowStructureTarget:target];
  } else if (windowStructure) {
    [self recordWindowStructureTarget:target];
  } else {
    [self recordFocusTarget:target syntheticTag:0];
  }
}

- (void)handleActivatedApplication:(NSRunningApplication *)application {
  if (![self subscribeApplication:application]) {
    [self recordUnresolvedFocus:
              @"AX subscription нового foreground application не удалась"];
    return;
  }
  AXUIElementRef element =
      AXUIElementCreateApplication(application.processIdentifier);
  if (element == NULL) {
    [self markUnavailable:
              @"AX element нового foreground application недоступен"];
    return;
  }
  [self handleAXElement:element
                    pid:application.processIdentifier
           notification:@"application-activated"
          sourceObserver:NULL];
  CFRelease(element);
}

- (void)handleTerminatedApplication:(NSRunningApplication *)application {
  const pid_t pid = application.processIdentifier;
  NSRunningApplication *subscribed = _runningApplications[@(pid)];
  NSNumber *subscribedBirth = _axProcessBirths[@(pid)];
  if (pid <= 0 || subscribed == nil || subscribedBirth == nil) return;
  const uint64_t currentBirth = [self processBirthForPid:pid];
  if (subscribed != application && ![subscribed isEqual:application]) {
    if (currentBirth == subscribedBirth.unsignedLongLongValue) return;
    [self markUnavailable:
              @"Terminate callback не совпадает с raw subscription incarnation"];
    return;
  }
  if (currentBirth != 0 &&
      currentBirth != subscribedBirth.unsignedLongLongValue) {
    [self markUnavailable:
              @"Terminate callback PID уже принадлежит другой incarnation"];
    return;
  }
  [self removeApplicationPid:pid];
  [self recordGlobalWindowStructure];
}

- (uint64_t)processBirthForPid:(pid_t)pid {
  return observer_process_start_micros(pid);
}

- (BOOL)registerSyntheticTag:(uint64_t)tag
                 operationId:(NSString *)operationId
               interactionId:(NSString *)interactionId
                      target:(NSDictionary *)target {
  if (tag == 0 || !valid_identifier(operationId) ||
      (interactionId != nil && !valid_identifier(interactionId)) ||
      ![self validTarget:target]) {
    return NO;
  }
  NSString *tagName = event_tag(tag);
  NSMutableDictionary *owner = [@{
    @"operationId" : operationId,
    @"target" : immutable_json_copy(target),
    @"syntheticTag" : tagName,
  } mutableCopy];
  if (interactionId.length > 0) owner[@"interactionId"] = interactionId;
  [_lock lock];
  NSDictionary *existing = _syntheticOwnersByTag[@(tag)];
  BOOL accepted =
      (existing == nil && _syntheticOwnersByTag.count < 1024) ||
      [existing isEqual:owner];
  if (accepted) {
    _syntheticOwnersByTag[@(tag)] = owner;
    _syntheticOwnersByEventTag[tagName] = owner;
  }
  [_lock unlock];
  if (!accepted) [self markUnavailable:@"Synthetic owner budget или identity conflict"];
  return accepted;
}

- (void)unregisterSyntheticTag:(uint64_t)tag {
  [_lock lock];
  NSDictionary *owner = _syntheticOwnersByTag[@(tag)];
  NSString *tagName = owner[@"syntheticTag"];
  [_syntheticOwnersByTag removeObjectForKey:@(tag)];
  if (tagName != nil) [_syntheticOwnersByEventTag removeObjectForKey:tagName];
  [_lock unlock];
}

- (NSDictionary *)syntheticOwnerForEventTag:(NSString *)eventTagValue {
  [_lock lock];
  NSDictionary *owner =
      immutable_json_copy(_syntheticOwnersByEventTag[eventTagValue]);
  [_lock unlock];
  return owner;
}

- (void)recordKind:(NSString *)kind
             source:(NSString *)source
                tag:(uint64_t)tag
             target:(NSDictionary *)target
          lifecycle:(NSString *)lifecycle
 nextLoginSessionId:(NSString *)nextLoginSessionId {
  [_lock lock];
  NSString *time = observer_time();
  NSString *cursor =
      [NSString stringWithFormat:@"%@:s%llu", _startCursor, _sequence];
  NSMutableDictionary *event = [_generation mutableCopy];
  [event addEntriesFromDictionary:@{
    @"eventId" : cursor,
    @"cursor" : cursor,
    @"sequence" : @(_sequence),
    @"observedAt" : time,
    @"kind" : kind,
    @"source" : source,
  }];
  if ([source isEqual:@"synthetic"]) event[@"syntheticTag"] = event_tag(tag);
  if (target != nil) event[@"target"] = immutable_json_copy(target);
  if (lifecycle != nil) event[@"lifecycle"] = lifecycle;
  if (nextLoginSessionId != nil) {
    event[@"nextLoginSessionId"] = nextLoginSessionId;
  }
  NSUInteger bytes =
      [NSJSONSerialization dataWithJSONObject:event options:0 error:NULL].length;
  _sequence += 1;
  _cursor = cursor;
  _lastEvent = time;
  _coveredThrough = time;
  _heartbeat = time;
  MetaObserverEventSink sink = _eventSink;
  BOOL accepted = NO;
  if (sink != nil) {
    accepted = YES;
  } else if (_events.count >= 1000 || bytes > 1024 * 1024 - _bytes) {
    _dropped += 1;
    _gap = YES;
    _ready = NO;
    _reason = @"Observer event buffer overflow";
  } else {
    [_events addObject:event];
    _bytes += bytes;
    accepted = YES;
  }
  NSDictionary *published = accepted ? immutable_json_copy(event) : nil;
  [_lock unlock];
  if (sink != nil && published != nil) {
    @try {
      sink(published);
    } @catch (__unused NSException *exception) {
      [self markUnavailable:@"Observer event sink failed"];
    }
  }
}

- (void)recordInputFromPid:(pid_t)pid syntheticTag:(uint64_t)tag {
  [_lock lock];
  NSDictionary *owner = pid == getpid() && tag != 0
                            ? _syntheticOwnersByTag[@(tag)]
                            : nil;
  [_lock unlock];
  [self recordKind:@"input"
             source:owner == nil ? @"unknown" : @"synthetic"
                tag:tag
             target:owner[@"target"]
          lifecycle:nil
 nextLoginSessionId:nil];
}

- (void)recordFocusTarget:(NSDictionary *)target syntheticTag:(uint64_t)tag {
  if (![self validTarget:target]) {
    [self markUnavailable:@"Focus event не содержит exact runtime target"];
    return;
  }
  [_lock lock];
  NSDictionary *owner = tag == 0 ? nil : _syntheticOwnersByTag[@(tag)];
  BOOL matches = owner != nil && [owner[@"target"] isEqual:target];
  [_lock unlock];
  [self recordKind:@"focus"
             source:matches ? @"synthetic" : @"unknown"
                tag:tag
             target:target
          lifecycle:nil
 nextLoginSessionId:nil];
}

- (void)recordGlobalFocus {
  [self recordKind:@"focus"
             source:@"unknown"
                tag:0
             target:nil
          lifecycle:nil
 nextLoginSessionId:nil];
}

- (void)recordUnresolvedFocus:(NSString *)reason {
  [self recordGlobalFocus];
  [self markUnavailable:reason];
}

- (void)recordWindowStructureTarget:(NSDictionary *)target {
  if (![self validTarget:target]) {
    [self markUnavailable:@"Window event не содержит exact runtime target"];
    return;
  }
  [self recordKind:@"window-structure"
             source:@"unknown"
                tag:0
             target:target
          lifecycle:nil
 nextLoginSessionId:nil];
}

- (void)recordGlobalWindowStructure {
  [self recordKind:@"window-structure"
             source:@"unknown"
                tag:0
             target:nil
          lifecycle:nil
 nextLoginSessionId:nil];
}

- (void)recordLifecycle:(NSString *)lifecycle
      nextLoginSessionId:(NSString *)nextLoginSessionId {
  if (![@[
        @"sleep", @"wake", @"lock", @"unlock", @"logout",
        @"login-session-change"
      ] containsObject:lifecycle]) {
    return;
  }
  if ([lifecycle isEqual:@"login-session-change"] &&
      nextLoginSessionId.length == 0) {
    [self markUnavailable:@"Login session change не содержит новый session ID"];
    return;
  }
  [self recordKind:@"lifecycle"
             source:@"unknown"
                tag:0
             target:nil
          lifecycle:lifecycle
 nextLoginSessionId:nextLoginSessionId];
}

- (void)recordCoverageKind:(NSString *)kind
                 available:(BOOL)available
                    reason:(NSString *)reason {
  [_lock lock];
  if ([kind isEqual:@"input"]) _inputCoverage = available;
  else if ([kind isEqual:@"focus"]) _focusCoverage = available;
  else if ([kind isEqual:@"window-structure"]) _windowCoverage = available;
  else if ([kind isEqual:@"lifecycle"]) _lifecycleCoverage = available;
  else {
    [_lock unlock];
    [self markUnavailable:@"Неизвестный observer coverage kind"];
    return;
  }
  if (!available) {
    _gap = YES;
    _reason = [reason copy] ?: @"Observer subscription недоступна";
  }
  BOOL nextReady = !_gap && _inputCoverage && _focusCoverage &&
                   _windowCoverage && _lifecycleCoverage;
  if (nextReady && !_ready) {
    NSString *time = observer_time();
    _coveredFrom = time;
    _coveredThrough = time;
    _heartbeat = time;
    _startCursor = [@"observer-"
        stringByAppendingString:NSUUID.UUID.UUIDString];
    _cursor = _startCursor;
    [_events removeAllObjects];
    _bytes = 0;
  }
  _ready = nextReady;
  if (_ready) _reason = nil;
  [_lock unlock];
}

- (void)recordHeartbeat {
  if (_tap != NULL &&
      (!CGPreflightListenEventAccess() || !AXIsProcessTrusted() ||
       !CGEventTapIsEnabled(_tap))) {
    [self recordInputFromPid:0 syntheticTag:0];
    [self recordUnresolvedFocus:@"Passive observer readiness recheck failed"];
    return;
  }
  [_lock lock];
  if (_ready) {
    NSString *time = observer_time();
    _coveredThrough = time;
    _heartbeat = time;
  }
  [_lock unlock];
}

- (void)recordCurrentSessionReadiness:(NSDictionary *)readiness {
  NSString *state = readiness[@"state"];
  NSString *lockState = readiness[@"lockState"];
  NSString *evidence = readiness[@"evidence"];
  BOOL valid = [@[@"active-console", @"inactive", @"unknown"]
                   containsObject:state] &&
               [@[@"locked", @"unknown"] containsObject:lockState] &&
               [evidence isKindOfClass:NSString.class] && evidence.length > 0;
  if ([state isEqual:@"active-console"]) {
    NSNumber *userId = readiness[@"userId"];
    NSNumber *onConsole = readiness[@"onConsole"];
    NSNumber *loginDone = readiness[@"loginDone"];
    NSNumber *auditSessionId = readiness[@"auditSessionId"];
    valid = valid && [userId isKindOfClass:NSNumber.class] && userId.longLongValue >= 0 &&
            [onConsole isEqual:@YES] && [loginDone isEqual:@YES] &&
            [auditSessionId isKindOfClass:NSNumber.class] &&
            auditSessionId.longLongValue >= 0;
  }
  NSMutableDictionary *value = [@{
    @"state" : valid ? state : @"unknown",
    @"lockState" : valid ? lockState : @"unknown",
    @"evidence" : bounded_reason(valid ? evidence : @"Session readiness facts не прошли validation"),
    @"observedAt" : observer_time(),
  } mutableCopy];
  for (NSString *key in @[@"userId", @"onConsole", @"loginDone", @"auditSessionId"]) {
    if (valid && readiness[key] != nil) value[key] = readiness[key];
  }
  [_lock lock];
  _sessionReadiness = immutable_json_copy(value);
  [_lock unlock];
}

- (NSDictionary *)currentSessionReadiness {
  [_lock lock];
  NSDictionary *value = immutable_json_copy(_sessionReadiness);
  [_lock unlock];
  return value;
}

- (void)markUnavailable:(NSString *)reason {
  [_lock lock];
  _ready = NO;
  _gap = YES;
  _reason = bounded_reason(reason);
  [_lock unlock];
}

- (NSDictionary *)coverage {
  [_lock lock];
  NSMutableArray<NSString *> *kinds = [NSMutableArray array];
  if (_inputCoverage) [kinds addObject:@"input"];
  if (_focusCoverage) [kinds addObject:@"focus"];
  if (_windowCoverage) [kinds addObject:@"window-structure"];
  if (_lifecycleCoverage) [kinds addObject:@"lifecycle"];
  NSMutableDictionary *value = [_generation mutableCopy];
  [value addEntriesFromDictionary:@{
    @"state" : _ready ? @"ready" : @"unavailable",
    @"coverageStartCursor" : _startCursor,
    @"cursor" : _cursor,
    @"nextSequence" : @(_sequence),
    @"startedAt" : _startedAt,
    @"coveredFrom" : _coveredFrom,
    @"coveredThrough" : _coveredThrough,
    @"heartbeatAt" : _heartbeat,
    @"coveredKinds" : kinds,
    @"droppedEvents" : @(_dropped),
    @"gapDetected" : _gap ? @YES : @NO,
  }];
  if (!_ready) {
    value[@"reason"] =
        _reason ?: @"Непрерывность observer не подтверждена";
  }
  if (_lastEvent != nil) value[@"lastEventAt"] = _lastEvent;
  [_lock unlock];
  return value;
}

- (NSArray<NSDictionary *> *)takeEvents {
  [_lock lock];
  NSArray *events = immutable_json_copy(_events);
  [_events removeAllObjects];
  _bytes = 0;
  [_lock unlock];
  return events;
}

- (BOOL)validTarget:(NSDictionary *)target {
  if (![target isKindOfClass:NSDictionary.class] ||
      ![@[
        @"application", @"window", @"surface", @"element", @"display",
        @"desktop-layout"
      ] containsObject:target[@"kind"]]) {
    return NO;
  }
  NSDictionary *reference = target[@"ref"];
  if (![reference isKindOfClass:NSDictionary.class]) return NO;
  NSData *encoded =
      [NSJSONSerialization dataWithJSONObject:target options:0 error:NULL];
  if (encoded == nil || encoded.length > 16 * 1024) return NO;
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (![reference[key] isEqual:_generation[key]]) return NO;
  }
  NSDictionary<NSString *, NSString *> *identityKeys = @{
    @"application" : @"applicationRef",
    @"window" : @"windowRef",
    @"surface" : @"surfaceRef",
    @"element" : @"elementRef",
    @"display" : @"displayRef",
    @"desktop-layout" : @"layoutRef",
  };
  id identity = reference[identityKeys[target[@"kind"]]];
  return [identity isKindOfClass:NSString.class] && [identity length] > 0;
}

@end
