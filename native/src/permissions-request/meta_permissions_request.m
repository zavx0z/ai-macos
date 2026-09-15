#include "meta_permissions_request.h"

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

typedef NS_ENUM(NSUInteger, MetaPermissionRequestState) {
  MetaPermissionNotRequested,
  MetaPermissionNotNeeded,
  MetaPermissionQueued,
  MetaPermissionRequesting,
  MetaPermissionFinished,
  MetaPermissionUnsupported,
  MetaPermissionFailed,
  MetaPermissionCancelled,
};

@interface MetaPermissionRecord : NSObject
@property(nonatomic) BOOL beforeGranted;
@property(nonatomic) BOOL currentGranted;
@property(nonatomic) MetaPermissionRequestState state;
@property(nonatomic) BOOL promptRequested;
@property(nonatomic) BOOL hasRequestReturn;
@property(nonatomic) BOOL requestReturnedGranted;
@property(nonatomic, copy, nullable) NSString *error;
@end
@implementation MetaPermissionRecord
@end

static NSString *permission_name(MetaPermissionGroup permission) {
  switch (permission) {
    case MetaPermissionAccessibility: return @"accessibility";
    case MetaPermissionScreenRecording: return @"screenRecording";
    case MetaPermissionPostEvents: return @"postEvents";
    case MetaPermissionInputMonitoring: return @"inputMonitoring";
    case MetaPermissionGroupCount: return @"invalid";
  }
}

static NSString *state_name(MetaPermissionRequestState state) {
  switch (state) {
    case MetaPermissionNotRequested: return @"not-requested";
    case MetaPermissionNotNeeded: return @"not-needed";
    case MetaPermissionQueued: return @"queued";
    case MetaPermissionRequesting: return @"requesting";
    case MetaPermissionFinished: return @"finished";
    case MetaPermissionUnsupported: return @"unsupported";
    case MetaPermissionFailed: return @"failed";
    case MetaPermissionCancelled: return @"cancelled";
  }
}

@interface MetaPermissionsRequestController ()
- (void)runPermission:(MetaPermissionGroup)permission;
@end

@implementation MetaPermissionsRequestController {
  id<MetaPermissionsRequestBackend> _backend;
  NSArray<MetaPermissionRecord *> *_records;
  NSLock *_lock;
  dispatch_queue_t _requestQueue;
  BOOL _sealed;
}

- (instancetype)initWithBackend:(id<MetaPermissionsRequestBackend>)backend {
  if (backend == nil) return nil;
  self = [super init];
  if (self) {
    _backend = backend;
    _lock = [[NSLock alloc] init];
    _requestQueue = dispatch_queue_create("meta.native.permission-requests", DISPATCH_QUEUE_SERIAL);
    NSMutableArray *records = [NSMutableArray arrayWithCapacity:MetaPermissionGroupCount];
    for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) {
      MetaPermissionRecord *record = [MetaPermissionRecord new];
      MetaPermissionGroup permission = (MetaPermissionGroup)index;
      if (![_backend supportsPermission:permission]) {
        record.state = MetaPermissionUnsupported;
        record.error = @"Official permission request API недоступен";
      } else {
        record.beforeGranted = [_backend currentGrantForPermission:permission];
        record.currentGranted = record.beforeGranted;
        record.state = record.beforeGranted ? MetaPermissionNotNeeded : MetaPermissionNotRequested;
      }
      [records addObject:record];
    }
    _records = records;
  }
  return self;
}

- (void)refreshCurrentGrants {
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) {
    MetaPermissionGroup permission = (MetaPermissionGroup)index;
    if (![_backend supportsPermission:permission]) continue;
    BOOL granted = [_backend currentGrantForPermission:permission];
    [_lock lock];
    MetaPermissionRecord *record = _records[index];
    record.currentGranted = granted;
    if (granted && record.state == MetaPermissionNotRequested) {
      record.state = MetaPermissionNotNeeded;
    }
    [_lock unlock];
  }
}

- (void)queueMissing {
  [self refreshCurrentGrants];
  NSMutableArray<NSNumber *> *queued = [NSMutableArray array];
  [_lock lock];
  if (_sealed) {
    [_lock unlock];
    return;
  }
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) {
    MetaPermissionRecord *record = _records[index];
    if (record.currentGranted && record.state == MetaPermissionNotRequested) {
      record.state = MetaPermissionNotNeeded;
    } else if (!record.currentGranted && record.state == MetaPermissionNotRequested) {
      record.state = MetaPermissionQueued;
      [queued addObject:@(index)];
    }
  }
  [_lock unlock];
  if (queued.count == 0) return;
  dispatch_async(_requestQueue, ^{
    @autoreleasepool {
      for (NSNumber *value in queued) [self runPermission:(MetaPermissionGroup)value.unsignedIntegerValue];
    }
  });
}

- (void)runPermission:(MetaPermissionGroup)permission {
  BOOL current = [_backend currentGrantForPermission:permission];
  [_lock lock];
  MetaPermissionRecord *record = _records[permission];
  if (record.state != MetaPermissionQueued) {
    [_lock unlock];
    return;
  }
  record.currentGranted = current;
  if (current) {
    record.state = MetaPermissionNotNeeded;
    [_lock unlock];
    return;
  }
  record.state = MetaPermissionRequesting;
  record.promptRequested = YES;
  [_lock unlock];

  BOOL returnedGranted = NO;
  NSString *error = nil;
  BOOL completed = [_backend requestPermission:permission returnedGranted:&returnedGranted error:&error];
  BOOL after = [_backend currentGrantForPermission:permission];
  [_lock lock];
  record.currentGranted = after;
  record.hasRequestReturn = completed;
  record.requestReturnedGranted = returnedGranted;
  record.state = completed ? MetaPermissionFinished : MetaPermissionFailed;
  record.error = completed ? nil : (error ?: @"Official permission request завершился ошибкой");
  [_lock unlock];
}

- (NSDictionary *)snapshot {
  [self refreshCurrentGrants];
  NSMutableDictionary *permissions = [NSMutableDictionary dictionary];
  BOOL allGranted = YES;
  BOOL requestsFinished = YES;
  BOOL hasUnknownRestart = NO;
  [_lock lock];
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) {
    MetaPermissionRecord *record = _records[index];
    BOOL requestFinished = record.state == MetaPermissionFinished || record.state == MetaPermissionFailed;
    BOOL terminal = requestFinished || record.state == MetaPermissionNotNeeded ||
        record.state == MetaPermissionUnsupported || record.state == MetaPermissionCancelled;
    BOOL restartUnknown = !record.currentGranted &&
        (record.state == MetaPermissionRequesting || record.state == MetaPermissionFinished ||
         record.state == MetaPermissionUnsupported || record.state == MetaPermissionFailed);
    NSMutableDictionary *value = [@{
      @"beforeGranted" : record.beforeGranted ? @YES : @NO,
      @"currentGranted" : record.currentGranted ? @YES : @NO,
      @"requestState" : state_name(record.state),
      @"promptRequested" : record.promptRequested ? @YES : @NO,
      @"requestFinished" : requestFinished ? @YES : @NO,
      @"restartNeeded" : @NO,
      @"restartState" : restartUnknown ? @"unknown" : @"not-required",
    } mutableCopy];
    if (record.hasRequestReturn) value[@"requestReturnedGranted"] = record.requestReturnedGranted ? @YES : @NO;
    if (record.error != nil) value[@"error"] = record.error;
    if (restartUnknown) value[@"restartReason"] = @"Official API не сообщает, требуется ли перезапуск; текущий helper ещё не видит grant";
    permissions[permission_name((MetaPermissionGroup)index)] = value;
    allGranted = allGranted && record.currentGranted;
    requestsFinished = requestsFinished && terminal;
    hasUnknownRestart = hasUnknownRestart || restartUnknown;
  }
  [_lock unlock];
  return @{
    @"permissions" : permissions,
    @"requestsFinished" : requestsFinished ? @YES : @NO,
    @"allGranted" : allGranted ? @YES : @NO,
    @"restartNeeded" : @NO,
    @"restartState" : hasUnknownRestart ? @"unknown" : @"not-required",
  };
}

- (NSDictionary *)handleCommand:(NSString *)command {
  if (![command isEqual:@"request-missing"] && ![command isEqual:@"status"]) return nil;
  if ([command isEqual:@"request-missing"]) [self queueMissing];
  return [self snapshot];
}

- (BOOL)seal {
  BOOL ready = YES;
  [_lock lock];
  _sealed = YES;
  for (MetaPermissionRecord *record in _records) {
    if (record.state == MetaPermissionQueued) {
      record.state = MetaPermissionCancelled;
      record.error = @"Permission request отменён до official API при shutdown";
    } else if (record.state == MetaPermissionRequesting) {
      ready = NO;
    }
  }
  [_lock unlock];
  return ready;
}
@end

@interface MetaPermissionsSystemBackend : NSObject <MetaPermissionsRequestBackend>
@end

@implementation MetaPermissionsSystemBackend
- (BOOL)supportsPermission:(MetaPermissionGroup)permission {
  return permission < MetaPermissionGroupCount;
}
- (BOOL)currentGrantForPermission:(MetaPermissionGroup)permission {
  switch (permission) {
    case MetaPermissionAccessibility: return AXIsProcessTrusted();
    case MetaPermissionScreenRecording: return CGPreflightScreenCaptureAccess();
    case MetaPermissionPostEvents: return CGPreflightPostEventAccess();
    case MetaPermissionInputMonitoring: return CGPreflightListenEventAccess();
    case MetaPermissionGroupCount: return NO;
  }
}
- (BOOL)requestPermission:(MetaPermissionGroup)permission
          returnedGranted:(BOOL *)returnedGranted
                     error:(NSString **)error {
  if (returnedGranted == NULL) return NO;
  if (error != NULL) *error = nil;
  switch (permission) {
    case MetaPermissionAccessibility: {
      NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
      *returnedGranted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
      return YES;
    }
    case MetaPermissionScreenRecording:
      *returnedGranted = CGRequestScreenCaptureAccess();
      return YES;
    case MetaPermissionPostEvents:
      *returnedGranted = CGRequestPostEventAccess();
      return YES;
    case MetaPermissionInputMonitoring:
      *returnedGranted = CGRequestListenEventAccess();
      return YES;
    case MetaPermissionGroupCount:
      if (error != NULL) *error = @"Неизвестная permission group";
      return NO;
  }
}
@end

id<MetaPermissionsRequestBackend> meta_permissions_system_backend(void) {
  return [MetaPermissionsSystemBackend new];
}
