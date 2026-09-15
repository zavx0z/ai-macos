#include "meta_ax_retained_snapshot.h"

#include <assert.h>
#include <stdio.h>

static NSDictionary *target(NSString *windowRef) {
  return @{
    @"kind" : @"window",
    @"ref" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"applicationRef" : @"application-1",
      @"windowRef" : windowRef,
    },
  };
}

static NSDictionary *element(NSString *snapshotId, NSString *elementRef) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"applicationRef" : @"application-1",
    @"snapshotId" : snapshotId,
    @"elementRef" : elementRef,
  };
}

static NSArray<NSDictionary *> *nodes(NSString *firstAction) {
  return @[
    @{
      @"elementRef" : @"ax-node:1",
      @"actions" : @[firstAction],
    },
    @{
      @"elementRef" : @"ax-node:2",
      @"actions" : @[],
    },
  ];
}

static void test_exact_press_and_latest_snapshot(void) {
  __block uint64_t now = 100;
  MetaAXRetainedSnapshotRegistry *registry =
      [[MetaAXRetainedSnapshotRegistry alloc]
          initWithClock:^uint64_t { return now; }
             ttlMillis:1000
          maxSnapshots:4
              maxNodes:10];
  NSObject *button = [NSObject new];
  NSObject *label = [NSObject new];
  NSObject *trimmed = [NSObject new];
  assert(([registry publishTarget:target(@"window-1")
                     inventoryId:@"inventory-1"
               inventoryRevision:7
                       snapshotId:@"snapshot-1"
                            nodes:nodes(@"AXPress")
                 borrowedElements:@{
                   @"ax-node:1" : button,
                   @"ax-node:2" : label,
                   @"ax-node:trimmed" : trimmed,
                 }]));
  __block id received = nil;
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:1")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:7
                             consume:^BOOL(id borrowedElement) {
                               received = borrowedElement;
                               return YES;
                             }] == META_AX_RETAINED_BORROW_OK);
  assert(received == button);
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:2")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:7
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_ACTION_UNAVAILABLE);
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:trimmed")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:7
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_SNAPSHOT_STALE);

  assert(([registry publishTarget:target(@"window-1")
                     inventoryId:@"inventory-2"
               inventoryRevision:8
                       snapshotId:@"snapshot-2"
                            nodes:@[@{
                              @"elementRef" : @"ax-node:1",
                              @"actions" : @[@"AXPress"],
                            }]
                 borrowedElements:@{@"ax-node:1" : button}]));
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:1")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:7
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_SNAPSHOT_STALE);
}

static void test_ttl_and_global_capacity_evict_oldest(void) {
  __block uint64_t now = 100;
  MetaAXRetainedSnapshotRegistry *registry =
      [[MetaAXRetainedSnapshotRegistry alloc]
          initWithClock:^uint64_t { return now; }
             ttlMillis:10
          maxSnapshots:2
              maxNodes:2];
  NSObject *first = [NSObject new];
  NSObject *second = [NSObject new];
  NSObject *third = [NSObject new];
  NSArray *oneNode = @[@{
    @"elementRef" : @"ax-node:1",
    @"actions" : @[@"AXPress"],
  }];
  assert(([registry publishTarget:target(@"window-1")
                     inventoryId:@"inventory-1"
               inventoryRevision:1
                       snapshotId:@"snapshot-1"
                            nodes:oneNode
                 borrowedElements:@{@"ax-node:1" : first}]));
  assert([registry publishTarget:target(@"window-2")
                     inventoryId:@"inventory-2"
               inventoryRevision:1
                       snapshotId:@"snapshot-2"
                            nodes:oneNode
                 borrowedElements:@{@"ax-node:1" : second}]);
  assert([registry publishTarget:target(@"window-3")
                     inventoryId:@"inventory-3"
               inventoryRevision:1
                       snapshotId:@"snapshot-3"
                            nodes:oneNode
                 borrowedElements:@{@"ax-node:1" : third}]);
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:1")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:1
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_SNAPSHOT_STALE);
  now = 110;
  assert([registry withPressElement:element(@"snapshot-2", @"ax-node:1")
                              target:target(@"window-2")
                         inventoryId:@"inventory-2"
                   inventoryRevision:1
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_SNAPSHOT_STALE);
}

static void test_invalid_publication_preserves_previous_snapshot(void) {
  __block uint64_t now = 100;
  MetaAXRetainedSnapshotRegistry *registry =
      [[MetaAXRetainedSnapshotRegistry alloc]
          initWithClock:^uint64_t { return now; }
             ttlMillis:1000
          maxSnapshots:2
              maxNodes:2];
  NSObject *button = [NSObject new];
  assert(([registry publishTarget:target(@"window-1")
                     inventoryId:@"inventory-1"
               inventoryRevision:1
                       snapshotId:@"snapshot-1"
                            nodes:@[@{
                              @"elementRef" : @"ax-node:1",
                              @"actions" : @[@"AXPress"],
                            }]
                 borrowedElements:@{@"ax-node:1" : button}]));
  assert(!([registry publishTarget:target(@"window-1")
                      inventoryId:@"inventory-2"
                inventoryRevision:2
                        snapshotId:@"snapshot-2"
                             nodes:@[@{
                               @"elementRef" : @"ax-node:missing",
                               @"actions" : @[@"AXPress"],
                             }]
                  borrowedElements:@{}]));
  assert([registry withPressElement:element(@"snapshot-1", @"ax-node:1")
                              target:target(@"window-1")
                         inventoryId:@"inventory-1"
                   inventoryRevision:1
                             consume:^BOOL(__unused id borrowedElement) {
                               return YES;
                             }] == META_AX_RETAINED_BORROW_OK);
}

int main(void) {
  @autoreleasepool {
    test_exact_press_and_latest_snapshot();
    test_ttl_and_global_capacity_evict_oldest();
    test_invalid_publication_preserves_previous_snapshot();
  }
  puts("AX retained snapshot tests passed");
  return 0;
}
