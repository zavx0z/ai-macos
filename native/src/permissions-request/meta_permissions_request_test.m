#include "meta_permissions_request.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

@interface FixturePermissionsBackend : NSObject <MetaPermissionsRequestBackend> {
@public
  BOOL supported[MetaPermissionGroupCount];
  BOOL granted[MetaPermissionGroupCount];
  BOOL returned[MetaPermissionGroupCount];
  BOOL fail[MetaPermissionGroupCount];
  NSUInteger calls[MetaPermissionGroupCount];
}
@end

@implementation FixturePermissionsBackend
- (instancetype)init {
  self = [super init];
  if (self) for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) supported[index] = YES;
  return self;
}
- (BOOL)supportsPermission:(MetaPermissionGroup)permission { return supported[permission]; }
- (BOOL)currentGrantForPermission:(MetaPermissionGroup)permission { return granted[permission]; }
- (BOOL)requestPermission:(MetaPermissionGroup)permission returnedGranted:(BOOL *)returnedGranted error:(NSString **)error {
  calls[permission] += 1;
  if (fail[permission]) {
    if (error != NULL) *error = @"Injected official request failure";
    return NO;
  }
  *returnedGranted = returned[permission];
  if (returned[permission] && permission != MetaPermissionScreenRecording) granted[permission] = YES;
  return YES;
}
@end

static NSDictionary *wait_finished(MetaPermissionsRequestController *controller) {
  for (NSUInteger attempt = 0; attempt < 2000; attempt += 1) {
    NSDictionary *value = [controller handleCommand:@"status"];
    if ([value[@"requestsFinished"] boolValue]) return value;
    usleep(1000);
  }
  return nil;
}

static void test_requests_each_missing_permission_once(void) {
  FixturePermissionsBackend *backend = [FixturePermissionsBackend new];
  backend->granted[MetaPermissionAccessibility] = YES;
  backend->returned[MetaPermissionScreenRecording] = YES;
  backend->returned[MetaPermissionPostEvents] = YES;
  backend->returned[MetaPermissionInputMonitoring] = YES;
  MetaPermissionsRequestController *controller = [[MetaPermissionsRequestController alloc] initWithBackend:backend];
  NSDictionary *passive = [controller handleCommand:@"status"];
  assert(![passive[@"requestsFinished"] boolValue]);
  assert([passive[@"permissions"][@"screenRecording"][@"requestState"] isEqual:@"not-requested"]);
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) assert(backend->calls[index] == 0);
  NSDictionary *started = [controller handleCommand:@"request-missing"];
  assert(started != nil && ![started[@"allGranted"] boolValue]);
  NSDictionary *finished = wait_finished(controller);
  assert(finished != nil && [finished[@"requestsFinished"] boolValue]);
  assert(![finished[@"allGranted"] boolValue]);
  assert([finished[@"restartState"] isEqual:@"unknown"] && ![finished[@"restartNeeded"] boolValue]);
  NSDictionary *screen = finished[@"permissions"][@"screenRecording"];
  assert([screen[@"requestState"] isEqual:@"finished"] && [screen[@"requestReturnedGranted"] isEqual:@YES]);
  assert(![screen[@"currentGranted"] boolValue] && [screen[@"restartState"] isEqual:@"unknown"]);
  assert(backend->calls[MetaPermissionAccessibility] == 0);
  for (NSUInteger index = 1; index < MetaPermissionGroupCount; index += 1) assert(backend->calls[index] == 1);
  [controller handleCommand:@"request-missing"];
  usleep(10000);
  for (NSUInteger index = 1; index < MetaPermissionGroupCount; index += 1) assert(backend->calls[index] == 1);
  backend->granted[MetaPermissionScreenRecording] = YES;
  NSDictionary *granted = [controller handleCommand:@"status"];
  assert([granted[@"allGranted"] boolValue] && [granted[@"restartState"] isEqual:@"not-required"]);
}

static void test_unsupported_and_failed_are_terminal_without_repeat(void) {
  FixturePermissionsBackend *backend = [FixturePermissionsBackend new];
  backend->supported[MetaPermissionScreenRecording] = NO;
  backend->fail[MetaPermissionPostEvents] = YES;
  backend->returned[MetaPermissionAccessibility] = YES;
  backend->returned[MetaPermissionInputMonitoring] = YES;
  MetaPermissionsRequestController *controller = [[MetaPermissionsRequestController alloc] initWithBackend:backend];
  [controller handleCommand:@"request-missing"];
  NSDictionary *finished = wait_finished(controller);
  assert(finished != nil && [finished[@"requestsFinished"] boolValue]);
  NSDictionary *screen = finished[@"permissions"][@"screenRecording"];
  NSDictionary *post = finished[@"permissions"][@"postEvents"];
  assert([screen[@"requestState"] isEqual:@"unsupported"] && screen[@"error"] != nil);
  assert([post[@"requestState"] isEqual:@"failed"] && post[@"error"] != nil);
  assert(backend->calls[MetaPermissionScreenRecording] == 0 && backend->calls[MetaPermissionPostEvents] == 1);
  [controller handleCommand:@"request-missing"];
  usleep(10000);
  assert(backend->calls[MetaPermissionPostEvents] == 1);
}

static void test_initial_grant_revocation_does_not_repeat_prompt(void) {
  FixturePermissionsBackend *backend = [FixturePermissionsBackend new];
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) backend->granted[index] = YES;
  MetaPermissionsRequestController *controller = [[MetaPermissionsRequestController alloc] initWithBackend:backend];
  NSDictionary *initial = [controller handleCommand:@"status"];
  assert([initial[@"allGranted"] boolValue]);
  backend->granted[MetaPermissionAccessibility] = NO;
  NSDictionary *revoked = [controller handleCommand:@"request-missing"];
  NSDictionary *accessibility = revoked[@"permissions"][@"accessibility"];
  assert([accessibility[@"beforeGranted"] boolValue] && ![accessibility[@"currentGranted"] boolValue]);
  assert([accessibility[@"requestState"] isEqual:@"not-needed"]);
  usleep(10000);
  assert(backend->calls[MetaPermissionAccessibility] == 0);
}

int main(void) {
  @autoreleasepool {
    test_requests_each_missing_permission_once();
    test_unsupported_and_failed_are_terminal_without_repeat();
    test_initial_grant_revocation_does_not_repeat_prompt();
    puts("permission request controller tests passed; no live SDK APIs");
  }
  return 0;
}
