#include "meta_observer.h"

#import <AppKit/AppKit.h>

#include <unistd.h>

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
           notification:(NSString *)notification;
- (BOOL)subscribeApplication:(NSRunningApplication *)application;
- (BOOL)subscribeWindowsForApplication:(AXUIElementRef)application
                               observer:(AXObserverRef)observer
                                    pid:(pid_t)pid;
- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid;
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
             notification:(__bridge NSString *)notification];
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
  NSMutableDictionary<NSNumber *, NSMutableArray<id> *> *_axWindows;
  MetaObserverFocusResolver _focusResolver;
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
  NSString *_sessionState;
  NSString *_sessionEvidence;
  NSString *_sessionObservedAt;
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
    _axWindows = [NSMutableDictionary dictionary];
    _startedAt = observer_time();
    _coveredFrom = _startedAt;
    _coveredThrough = _startedAt;
    _heartbeat = _startedAt;
    _startCursor = [@"observer-" stringByAppendingString:NSUUID.UUID.UUIDString];
    _cursor = _startCursor;
    _sequence = 1;
    _reason = @"Observer не запущен";
    _sessionState = @"unknown";
    _sessionEvidence = @"Current session state не подтверждён";
    _sessionObservedAt = _startedAt;
  }
  return self;
}

- (void)setFocusResolver:(MetaObserverFocusResolver)resolver {
  [_lock lock];
  _focusResolver = [resolver copy];
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
                              if (![observer subscribeApplication:application]) {
                                [observer recordUnresolvedFocus:@"AX subscription нового foreground application не удалась"];
                                return;
                              }
                              AXUIElementRef element = AXUIElementCreateApplication(
                                  application.processIdentifier);
                              [observer handleAXElement:element
                                                   pid:application.processIdentifier
                                          notification:@"application-activated"];
                              CFRelease(element);
                            }]];
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(NSNotification *note) {
                              NSRunningApplication *application =
                                  note.userInfo[NSWorkspaceApplicationKey];
                              [weakSelf removeApplicationPid:
                                            application.processIdentifier];
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
                                            [weakSelf recordCurrentSessionReadiness:
                                                          [lifecycle isEqual:@"sleep"]
                                                              ? @"inactive"
                                                              : @"unknown"
                                                                       evidence:name];
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
                              [weakSelf recordCurrentSessionReadiness:@"inactive"
                                                              evidence:@"NSWorkspaceSessionDidResignActiveNotification"];
                            }]];
  [_workspaceTokens
      addObject:[workspaceCenter
                    addObserverForName:NSWorkspaceSessionDidBecomeActiveNotification
                                object:nil
                                 queue:NSOperationQueue.mainQueue
                            usingBlock:^(__unused NSNotification *note) {
                              [weakSelf recordUnresolvedFocus:@"Workspace session снова active; unlocked state требует нового positive evidence"];
                              [weakSelf recordCurrentSessionReadiness:@"unknown"
                                                              evidence:@"NSWorkspaceSessionDidBecomeActiveNotification"];
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
                                         [weakSelf recordCurrentSessionReadiness:
                                                       [lifecycle isEqual:@"lock"]
                                                           ? @"locked"
                                                           : @"unknown"
                                                                    evidence:name];
                                         [weakSelf markUnavailable:@"Lock state изменился; требуется новый observer snapshot"];
                                       }]];
  }
  [_lock lock];
  BOOL sessionReady = [_sessionState isEqual:@"active-unlocked"];
  [_lock unlock];
  [self recordCoverageKind:@"lifecycle"
                 available:sessionReady
                    reason:sessionReady
                               ? nil
                               : @"Initial active-unlocked session state не подтверждён"];
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
  if (_axObservers[@(pid)] != nil) return YES;
  AXObserverRef observer = NULL;
  if (AXObserverCreate(pid, observe_ax, &observer) != kAXErrorSuccess ||
      observer == NULL) {
    return NO;
  }
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  NSArray<NSString *> *notifications = @[
    (__bridge NSString *)kAXFocusedWindowChangedNotification,
    (__bridge NSString *)kAXFocusedUIElementChangedNotification,
    (__bridge NSString *)kAXWindowCreatedNotification,
  ];
  BOOL subscribed = YES;
  for (NSString *name in notifications) {
    AXError error = AXObserverAddNotification(
        observer, app, (__bridge CFStringRef)name, (__bridge void *)self);
    if (error != kAXErrorSuccess && error != kAXErrorNotificationAlreadyRegistered) {
      subscribed = NO;
      break;
    }
  }
  if (subscribed) {
    subscribed = [self subscribeWindowsForApplication:app
                                              observer:observer
                                                   pid:pid];
  }
  if (!subscribed) {
    [_axWindows removeObjectForKey:@(pid)];
    CFRelease(app);
    CFRelease(observer);
    return NO;
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer),
                     kCFRunLoopCommonModes);
  _axObservers[@(pid)] = CFBridgingRelease(observer);
  _axApplications[@(pid)] = CFBridgingRelease(app);
  return YES;
}

- (BOOL)subscribeWindowsForApplication:(AXUIElementRef)application
                               observer:(AXObserverRef)observer
                                    pid:(pid_t)pid {
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute,
                                                 &value);
  if (error != kAXErrorSuccess || value == NULL ||
      CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return NO;
  }
  NSArray *windows = CFBridgingRelease(value);
  for (id item in windows) {
    AXUIElementRef window = (__bridge AXUIElementRef)item;
    if (![self subscribeWindow:window observer:observer pid:pid]) return NO;
  }
  return YES;
}

- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid {
  NSArray<NSString *> *notifications = @[
    (__bridge NSString *)kAXMovedNotification,
    (__bridge NSString *)kAXResizedNotification,
    (__bridge NSString *)kAXWindowMiniaturizedNotification,
    (__bridge NSString *)kAXWindowDeminiaturizedNotification,
    (__bridge NSString *)kAXUIElementDestroyedNotification,
  ];
  for (NSString *name in notifications) {
    AXError error = AXObserverAddNotification(
        observer, window, (__bridge CFStringRef)name, (__bridge void *)self);
    if (error != kAXErrorSuccess &&
        error != kAXErrorNotificationAlreadyRegistered) {
      return NO;
    }
  }
  NSMutableArray<id> *stored = _axWindows[@(pid)];
  if (stored == nil) {
    stored = [NSMutableArray array];
    _axWindows[@(pid)] = stored;
  }
  [stored addObject:(__bridge id)window];
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
  [_axWindows removeObjectForKey:@(pid)];
}

- (void)handleAXElement:(AXUIElementRef)element
                    pid:(pid_t)pid
           notification:(NSString *)notification {
  [_lock lock];
  MetaObserverFocusResolver resolver = _focusResolver;
  [_lock unlock];
  NSDictionary *target = resolver == nil ? nil : resolver(pid, element, notification);
  if (![self validTarget:target]) {
    [self recordUnresolvedFocus:@"AX callback не сопоставлен с exact runtime target"];
    return;
  }
  if ([notification isEqual:(__bridge NSString *)kAXWindowCreatedNotification]) {
    [self recordWindowStructureTarget:target];
    id stored = _axObservers[@(pid)];
    if (stored == nil ||
        ![self subscribeWindow:element
                      observer:(__bridge AXObserverRef)stored
                           pid:pid]) {
      [self recordCoverageKind:@"window-structure"
                     available:NO
                        reason:@"Новое AX window не получило полный набор structure subscriptions"];
    }
  } else if ([@[
               (__bridge NSString *)kAXMovedNotification,
               (__bridge NSString *)kAXResizedNotification,
               (__bridge NSString *)kAXWindowMiniaturizedNotification,
               (__bridge NSString *)kAXWindowDeminiaturizedNotification,
               (__bridge NSString *)kAXUIElementDestroyedNotification,
             ] containsObject:notification]) {
    [self recordWindowStructureTarget:target];
  } else {
    [self recordFocusTarget:target syntheticTag:0];
  }
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
  if (_events.count >= 1000 || bytes > 1024 * 1024 - _bytes) {
    _dropped += 1;
    _gap = YES;
    _ready = NO;
    _reason = @"Observer event buffer overflow";
  } else {
    [_events addObject:event];
    _bytes += bytes;
  }
  [_lock unlock];
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

- (void)recordUnresolvedFocus:(NSString *)reason {
  [self recordKind:@"focus"
             source:@"unknown"
                tag:0
             target:nil
          lifecycle:nil
 nextLoginSessionId:nil];
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
  if ([kind isEqual:@"lifecycle"] && available &&
      ![_sessionState isEqual:@"active-unlocked"]) {
    available = NO;
    reason = @"Lifecycle coverage требует positive active-unlocked evidence";
  }
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

- (void)recordCurrentSessionReadiness:(NSString *)state
                              evidence:(NSString *)evidence {
  if (![@[@"active-unlocked", @"locked", @"inactive", @"unknown"]
          containsObject:state]) {
    state = @"unknown";
  }
  [_lock lock];
  _sessionState = [state copy];
  _sessionEvidence = bounded_reason(evidence);
  _sessionObservedAt = observer_time();
  [_lock unlock];
  [self recordCoverageKind:@"lifecycle"
                 available:[state isEqual:@"active-unlocked"]
                    reason:[state isEqual:@"active-unlocked"]
                               ? nil
                               : @"Current session не подтверждена active-unlocked"];
}

- (NSDictionary *)currentSessionReadiness {
  [_lock lock];
  NSDictionary *value = @{
    @"state" : _sessionState,
    @"evidence" : _sessionEvidence,
    @"observedAt" : _sessionObservedAt,
  };
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
