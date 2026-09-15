#include "meta_owned_sheet_discovery.h"

#include <assert.h>
#include <stdio.h>

#include "meta_native.h"
#include "meta_serialization.h"

@interface SheetNode : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, copy) NSString *role;
@property(nonatomic, weak) SheetNode *parent;
@property(nonatomic, copy) NSArray<SheetNode *> *children;
@end
@implementation SheetNode
@end

@interface SheetBackend : NSObject <MetaOwnedSheetDiscoveryBackend>
@property(nonatomic) uint64_t now;
@property(nonatomic) BOOL failChildren;
@end
@implementation SheetBackend
- (uint64_t)monotonicMillis { return self.now; }
- (BOOL)prepareElement:(id)element timeoutMillis:(uint64_t)timeoutMillis {
  return element != nil && timeoutMillis > 0 && timeoutMillis <= 100;
}
- (AXError)childCountForElement:(SheetNode *)element count:(NSUInteger *)count {
  if (self.failChildren) return kAXErrorCannotComplete;
  *count = element.children.count;
  return kAXErrorSuccess;
}
- (AXError)childrenForElement:(SheetNode *)element from:(NSUInteger)index
                        count:(NSUInteger)count value:(NSArray **)value {
  if (self.failChildren || index > element.children.count) {
    return kAXErrorCannotComplete;
  }
  NSUInteger length = MIN(count, element.children.count - index);
  *value = [element.children subarrayWithRange:NSMakeRange(index, length)];
  return kAXErrorSuccess;
}
- (AXError)roleForElement:(SheetNode *)element value:(NSString **)value {
  *value = element.role;
  return element.role == nil ? kAXErrorNoValue : kAXErrorSuccess;
}
- (AXError)pidForElement:(SheetNode *)element value:(pid_t *)value {
  *value = element.pid;
  return kAXErrorSuccess;
}
- (AXError)parentForElement:(SheetNode *)element value:(id *)value {
  *value = element.parent;
  return element.parent == nil ? kAXErrorNoValue : kAXErrorSuccess;
}
- (BOOL)element:(id)left equals:(id)right { return left == right; }
@end

static SheetNode *node(pid_t pid, NSString *role) {
  SheetNode *value = [[SheetNode alloc] init];
  value.pid = pid;
  value.role = role;
  value.children = @[];
  return value;
}

static void test_direct_sheet_reaches_real_registry_and_serialization(void) {
  SheetNode *primary = node(42, @"AXWindow");
  SheetNode *sheet = node(42, @"AXSheet");
  sheet.parent = primary;
  primary.children = @[node(42, @"AXButton"), sheet];
  SheetBackend *backend = [[SheetBackend alloc] init];
  MetaAXWindowInput windows[] = {
      {.pid = 42, .launch_time_micros = 100, .ax_token = 1,
       .title = "Primary", .role = "AXWindow",
       .frame = {.x = 0, .y = 0, .width = 500, .height = 400},
       .surface_kind = META_SURFACE_WINDOW},
      {.pid = 42, .launch_time_micros = 100, .ax_token = 3,
       .title = "Secondary", .role = "AXWindow",
       .frame = {.x = 600, .y = 0, .width = 500, .height = 400},
       .surface_kind = META_SURFACE_WINDOW},
      {.pid = 42, .launch_time_micros = 100, .ax_token = 2,
       .title = "", .role = "AXSheet",
       .frame = {.x = 0, .y = 0, .width = 500, .height = 400},
       .surface_kind = META_SURFACE_SHEET},
  };
  MetaAXWindowInput *windowValues = windows;
  __block NSUInteger consumed = 0;
  MetaOwnedSheetDiscoveryStatus status = meta_discover_direct_owned_sheets(
      primary, 42, 1000, backend, ^BOOL(id candidate) {
        assert(candidate == sheet);
        consumed += 1;
        return meta_ax_window_bind_owner(&windowValues[2],
                                         windowValues[0].ax_token) !=
               META_AX_OWNER_CONFLICT;
      });
  assert(status == MetaOwnedSheetDiscoveryComplete);
  assert(consumed == 1 && windows[2].owner_ax_token == 1);

  MetaApplicationInput application = {
      .pid = 42, .launch_time_micros = 100, .name = "Fixture",
      .hidden = META_FALSE, .ax_status = META_AX_READY};
  MetaInventoryInput input = {
      .applications = &application, .application_count = 1,
      .ax_windows = windows, .ax_window_count = 3,
      .source_complete = true, .display_topology_epoch = 1};
  MetaRegistry *registry = meta_registry_create("native-sheet-child");
  assert(registry != NULL && meta_registry_refresh(registry, &input));
  const MetaInventorySnapshot *snapshot = meta_registry_snapshot(registry);
  assert(snapshot->window_count == 3);
  CFDataRef data = meta_inventory_copy_json(snapshot, "sheet-child-response");
  assert(data != NULL);
  NSDictionary *json = [NSJSONSerialization
      JSONObjectWithData:(__bridge NSData *)data options:0 error:NULL];
  assert([json[@"windows"] count] == 2);
  NSDictionary *owner = json[@"windows"][0];
  assert([owner[@"surfaces"] count] == 1);
  assert([owner[@"surfaces"][0][@"ownerWindowRef"]
      isEqual:owner[@"windowRef"]]);
  assert([owner[@"surfaces"][0][@"title"] isEqual:@""]);
  CFRelease(data);
  meta_registry_destroy(registry);
}

static void test_parent_pid_and_deadline_fail_closed(void) {
  SheetNode *owner = node(42, @"AXWindow");
  SheetNode *other = node(42, @"AXWindow");
  SheetNode *sheet = node(42, @"AXSheet");
  owner.children = @[sheet];
  SheetBackend *backend = [[SheetBackend alloc] init];
  __block NSUInteger consumed = 0;

  sheet.parent = other;
  assert(meta_discover_direct_owned_sheets(owner, 42, 1000, backend,
      ^BOOL(__unused id candidate) { consumed += 1; return YES; }) ==
      MetaOwnedSheetDiscoveryFailed);
  assert(consumed == 0);

  sheet.parent = owner;
  sheet.pid = 99;
  assert(meta_discover_direct_owned_sheets(owner, 42, 1000, backend,
      ^BOOL(__unused id candidate) { consumed += 1; return YES; }) ==
      MetaOwnedSheetDiscoveryFailed);
  assert(consumed == 0);

  sheet.pid = 42;
  sheet.role = nil;
  assert(meta_discover_direct_owned_sheets(owner, 42, 1000, backend,
      ^BOOL(__unused id candidate) { consumed += 1; return YES; }) ==
      MetaOwnedSheetDiscoveryFailed);
  assert(consumed == 0);

  sheet.role = @"AXSheet";
  backend.now = 1000;
  assert(meta_discover_direct_owned_sheets(owner, 42, 1000, backend,
      ^BOOL(__unused id candidate) { consumed += 1; return YES; }) ==
      MetaOwnedSheetDiscoveryTimedOut);
  assert(consumed == 0);
}

int main(void) {
  @autoreleasepool {
    test_direct_sheet_reaches_real_registry_and_serialization();
    test_parent_pid_and_deadline_fail_closed();
  }
  puts("owned sheet discovery tests passed");
  return 0;
}
