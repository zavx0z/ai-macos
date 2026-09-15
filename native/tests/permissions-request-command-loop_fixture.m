#include "meta_command_loop.h"
#include "permissions-request/meta_permissions_request.h"

#include <stdio.h>
#include <unistd.h>

@interface FixturePermissionSDK : NSObject <MetaPermissionsRequestBackend> {
@public
  BOOL granted[MetaPermissionGroupCount];
  NSUInteger calls[MetaPermissionGroupCount];
}
@end

@implementation FixturePermissionSDK
- (BOOL)supportsPermission:(MetaPermissionGroup)permission { return permission < MetaPermissionGroupCount; }
- (BOOL)currentGrantForPermission:(MetaPermissionGroup)permission { return granted[permission]; }
- (BOOL)requestPermission:(MetaPermissionGroup)permission returnedGranted:(BOOL *)returnedGranted error:(NSString **)error {
  if (error != NULL) *error = nil;
  calls[permission] += 1;
  usleep(300000);
  granted[permission] = YES;
  *returnedGranted = YES;
  return YES;
}
@end

@interface PermissionsCommandBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithReportPath:(NSString *)reportPath;
@end

@implementation PermissionsCommandBackend {
  FixturePermissionSDK *_sdk;
  MetaPermissionsRequestController *_requests;
  NSString *_reportPath;
}
- (instancetype)initWithReportPath:(NSString *)reportPath {
  self = [super init];
  if (self) {
    _reportPath = [reportPath copy];
    _sdk = [FixturePermissionSDK new];
    _sdk->granted[MetaPermissionAccessibility] = YES;
    _requests = [[MetaPermissionsRequestController alloc] initWithBackend:_sdk];
  }
  return self;
}
- (NSDictionary *)sessionIdentity {
  return @{@"source": @"darwin-audit", @"uid": @501, @"effectiveUid": @501,
    @"verified": @NO, @"reason": @"Injected fixture не вызывает audit syscall"};
}
- (NSDictionary *)permissions {
  return @{@"accessibility": _sdk->granted[MetaPermissionAccessibility] ? @YES : @NO,
    @"screenRecording": _sdk->granted[MetaPermissionScreenRecording] ? @YES : @NO,
    @"postEvents": _sdk->granted[MetaPermissionPostEvents] ? @YES : @NO,
    @"inputMonitoring": _sdk->granted[MetaPermissionInputMonitoring] ? @YES : @NO};
}
- (NSDictionary *)permissionsRequest:(NSDictionary *)request { return [_requests handleCommand:request[@"command"]]; }
- (NSArray<NSDictionary *> *)capabilityCatalog { return @[@{@"id": @"runtime.identity", @"state": @"ready"}]; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary {
  (void)request; (void)emitBinary; return nil;
}
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation {
  BOOL ready = [_requests seal];
  NSMutableDictionary *calls = [NSMutableDictionary dictionary];
  NSArray *names = @[@"accessibility", @"screenRecording", @"postEvents", @"inputMonitoring"];
  for (NSUInteger index = 0; index < MetaPermissionGroupCount; index += 1) calls[names[index]] = @(_sdk->calls[index]);
  NSData *data = [NSJSONSerialization dataWithJSONObject:calls options:0 error:NULL];
  return ready && data != nil && [data writeToFile:_reportPath atomically:YES];
}
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2) return 64;
    PermissionsCommandBackend *backend = [[PermissionsCommandBackend alloc] initWithReportPath:@(argv[1])];
    return meta_command_loop_run(backend, @"permissions-fixture-build", @"/tmp/permissions-fixture",
      @"native-permissions", STDIN_FILENO, STDOUT_FILENO);
  }
}
