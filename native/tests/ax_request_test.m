#include "meta_ax_request.h"
#include <assert.h>
#include <time.h>

@interface FixtureAX : NSObject <MetaAXInspectionBackend>
@end
@implementation FixtureAX
- (uint64_t)monotonicMillis {
  struct timespec now = {0}; clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
- (MetaAXReadStatus)ownerPidForElement:(id)element value:(pid_t *)value { (void)element; *value = 42; return META_AX_READ_OK; }
- (MetaAXReadStatus)stringAttribute:(NSString *)attribute forElement:(id)element value:(NSString **)value {
  (void)element;
  *value = [attribute isEqual:@"AXRole"] ? @"AXWindow" : @"fixture";
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)frameForElement:(id)element value:(CGRect *)value { (void)element; (void)value; return META_AX_READ_ABSENT; }
- (MetaAXReadStatus)actionsForElement:(id)element value:(NSArray<NSString *> **)value { (void)element; *value = @[]; return META_AX_READ_OK; }
- (MetaAXReadStatus)childCountForElement:(id)element value:(NSUInteger *)value { (void)element; *value = 0; return META_AX_READ_OK; }
- (MetaAXReadStatus)childrenForElement:(id)element from:(NSUInteger)index count:(NSUInteger)count value:(NSArray **)value {
  (void)element; (void)index; (void)count; *value = @[]; return META_AX_READ_OK;
}
@end

int main(void) {
  @autoreleasepool {
    MetaAXTargetBorrow borrow = {.inventory_revision = 7};
    snprintf(borrow.inventory_id, sizeof(borrow.inventory_id), "%s", "inventory-fixture");
    snprintf(borrow.native_generation, sizeof(borrow.native_generation), "%s", "native-fixture");
    snprintf(borrow.target.application_ref, sizeof(borrow.target.application_ref), "%s", "app-fixture");
    snprintf(borrow.target.target_ref, sizeof(borrow.target.target_ref), "%s", "window-fixture");
    snprintf(borrow.target.window_ref, sizeof(borrow.target.window_ref), "%s", "window-fixture");
    borrow.target.pid = 42;
    borrow.target.surface_kind = META_SURFACE_WINDOW;
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSMutableDictionary *ref = [@{@"runtimeEpoch": @"runtime-fixture", @"loginSessionId": @"login-fixture",
      @"nativeGeneration": @"native-fixture", @"applicationRef": @"app-fixture", @"windowRef": @"window-fixture"} mutableCopy];
    NSMutableDictionary *target = [@{@"kind": @"window", @"ref": ref} mutableCopy];
    NSDictionary *request = @{@"runtimeEpoch": @"runtime-fixture", @"loginSessionId": @"login-fixture", @"nativeGeneration": @"native-fixture",
      @"deadlineAt": [formatter stringFromDate:[NSDate dateWithTimeIntervalSinceNow:3]],
      @"payload": @{@"target": target, @"depth": @2, @"maxNodes": @10, @"maxBytes": @4096}};
    MetaAXInspectionContext inspection = {0};
    assert(meta_ax_build_request(&borrow, request, @"snapshot-fixture", &inspection));
    assert(strcmp(inspection.inventory_id, "inventory-fixture") == 0);
    assert(inspection.inventory_revision == 7);
    assert(strcmp(inspection.application_ref, "app-fixture") == 0);
    assert(strcmp(inspection.native_generation, "native-fixture") == 0);
    assert(strcmp(inspection.runtime_epoch, "runtime-fixture") == 0);
    assert(strcmp(inspection.login_session_id, "login-fixture") == 0);
    assert(strcmp(inspection.target_ref, "window-fixture") == 0);
    assert(strcmp(inspection.snapshot_id, "snapshot-fixture") == 0);
    assert(inspection.owner_pid == 42 && inspection.depth == 2 && inspection.max_nodes == 10 && inspection.max_bytes == 4096);
    assert(inspection.deadline_millis > 0 && inspection.per_call_timeout_millis == 500);
    NSDictionary *result = meta_ax_inspect_with_backend(@"root", inspection, [[FixtureAX alloc] init]);
    assert(result != nil && [result[@"nodeCount"] unsignedIntegerValue] == 1);

    target[@"kind"] = @"surface";
    ref[@"surfaceRef"] = @"surface-fixture";
    ref[@"ownerWindowRef"] = @"window-fixture";
    assert(!meta_ax_build_request(&borrow, request, @"snapshot-fixture", &inspection));
    borrow.target.surface_kind = META_SURFACE_SHEET;
    snprintf(borrow.target.surface_ref, sizeof(borrow.target.surface_ref), "%s", "surface-fixture");
    snprintf(borrow.target.target_ref, sizeof(borrow.target.target_ref), "%s", "surface-fixture");
    snprintf(borrow.target.owner_window_ref, sizeof(borrow.target.owner_window_ref), "%s", "window-fixture");
    assert(meta_ax_build_request(&borrow, request, @"snapshot-fixture", &inspection));
    ref[@"ownerWindowRef"] = @"foreign-window";
    assert(!meta_ax_build_request(&borrow, request, @"snapshot-fixture", &inspection));
    puts("AX request builder tests passed");
  }
  return 0;
}
