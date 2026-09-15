#include "meta_ax_inspector.h"

#include <assert.h>
#include <stdio.h>

@interface FixtureNode : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, copy) NSString *role;
@property(nonatomic, copy) NSString *subrole;
@property(nonatomic, copy) NSString *title;
@property(nonatomic) CGRect frame;
@property(nonatomic, copy) NSArray<NSString *> *actions;
@property(nonatomic, strong) NSMutableArray<FixtureNode *> *children;
@end

@implementation FixtureNode
@end

@interface FixtureBackend : NSObject <MetaAXInspectionBackend>
@property(nonatomic) uint64_t now;
@property(nonatomic) uint64_t step;
@property(nonatomic) NSUInteger largestBatch;
@property(nonatomic, strong) NSMutableSet<NSString *> *readAttributes;
@end

@implementation FixtureBackend

- (instancetype)init {
  self = [super init];
  if (self) _readAttributes = [NSMutableSet set];
  return self;
}

- (void)advance { _now += _step; }
- (uint64_t)monotonicMillis { return _now; }

- (MetaAXReadStatus)ownerPidForElement:(FixtureNode *)element
                                 value:(pid_t *)value {
  [self advance];
  *value = element.pid;
  return META_AX_READ_OK;
}

- (MetaAXReadStatus)stringAttribute:(NSString *)attribute
                         forElement:(FixtureNode *)element
                              value:(NSString **)value {
  [self advance];
  [_readAttributes addObject:attribute];
  if ([attribute isEqual:@"role"]) *value = element.role;
  else if ([attribute isEqual:@"subrole"]) *value = element.subrole;
  else if ([attribute isEqual:@"title"]) *value = element.title;
  else return META_AX_READ_FAILED;
  return *value == nil ? META_AX_READ_ABSENT : META_AX_READ_OK;
}

- (MetaAXReadStatus)frameForElement:(FixtureNode *)element
                              value:(CGRect *)value {
  [self advance];
  *value = element.frame;
  return META_AX_READ_OK;
}

- (MetaAXReadStatus)actionsForElement:(FixtureNode *)element
                                value:(NSArray<NSString *> **)value {
  [self advance];
  *value = element.actions;
  return META_AX_READ_OK;
}

- (MetaAXReadStatus)childCountForElement:(FixtureNode *)element
                                   value:(NSUInteger *)value {
  [self advance];
  *value = element.children.count;
  return META_AX_READ_OK;
}

- (MetaAXReadStatus)childrenForElement:(FixtureNode *)element
                                  from:(NSUInteger)index
                                 count:(NSUInteger)count
                                 value:(NSArray **)value {
  [self advance];
  _largestBatch = MAX(_largestBatch, count);
  if (index > element.children.count) return META_AX_READ_FAILED;
  NSUInteger length = MIN(count, element.children.count - index);
  *value = [element.children subarrayWithRange:NSMakeRange(index, length)];
  return META_AX_READ_OK;
}

@end

static FixtureNode *node(NSString *role, NSString *title) {
  FixtureNode *value = [[FixtureNode alloc] init];
  value.pid = 501;
  value.role = role;
  value.subrole = @"";
  value.title = title;
  value.frame = CGRectMake(10, 20, 300, 200);
  value.actions = @[@"AXPress"];
  value.children = [NSMutableArray array];
  return value;
}

static MetaAXInspectionContext context(uint64_t deadline,
                                       NSUInteger maximumNodes,
                                       NSUInteger maximumBytes) {
  return (MetaAXInspectionContext){
      .runtime_epoch = "runtime-1",
      .login_session_id = "login-1",
      .native_generation = "native-1",
      .application_ref = "application-1",
      .inventory_id = "inventory-1",
      .inventory_revision = 7,
      .snapshot_id = "snapshot-1",
      .target_ref = "window-1",
      .owner_pid = 501,
      .depth = 12,
      .max_nodes = maximumNodes,
      .max_bytes = maximumBytes,
      .deadline_millis = deadline,
      .per_call_timeout_millis = 50,
  };
}

static void assert_encoded_bytes(NSDictionary *result) {
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:result
                                                     options:0
                                                       error:NULL];
  assert(encoded != nil);
  assert(encoded.length == [result[@"encodedBytes"] unsignedIntegerValue]);
}

static void test_bounded_tree(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  for (NSUInteger index = 0; index < 70; index += 1) {
    [root.children addObject:node(@"AXButton", @"Кнопка")];
  }
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 100, 1024 * 1024), backend);
  assert(result != nil);
  assert([result[@"complete"] boolValue]);
  assert([result[@"nodeCount"] unsignedIntegerValue] == 71);
  assert(backend.largestBatch == 32);
  assert(![backend.readAttributes containsObject:@"value"]);
  NSArray *nodes = result[@"nodes"];
  assert([nodes[1][@"parentElementRef"] isEqual:@"ax-node:1"]);
  assert_encoded_bytes(result);
}

static void test_cycle_is_incomplete(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  FixtureNode *child = node(@"AXGroup", @"");
  [root.children addObject:child];
  [child.children addObject:root];
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 10, 1024 * 1024), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodeCount"] unsignedIntegerValue] == 2);
  assert([result[@"errors"][0] containsString:@"cycle"]);
}

static void test_node_limit_is_incomplete(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  for (NSUInteger index = 0; index < 70; index += 1) {
    [root.children addObject:node(@"AXButton", @"Кнопка")];
  }
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 10, 1024 * 1024), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodeCount"] unsignedIntegerValue] == 10);
  assert(backend.largestBatch == 9);
}

static void test_depth_limit_is_incomplete(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  [root.children addObject:node(@"AXButton", @"Кнопка")];
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  MetaAXInspectionContext limited = context(1000, 10, 1024 * 1024);
  limited.depth = 0;
  NSDictionary *result = meta_ax_inspect_with_backend(root, limited, backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodeCount"] unsignedIntegerValue] == 1);
  assert([result[@"errors"][0] containsString:@"depth"]);
}

static void test_deadline_is_incomplete(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  [root.children addObject:node(@"AXButton", @"Кнопка")];
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  backend.step = 10;
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(35, 10, 1024 * 1024), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"errors"] count] > 0);
}

static void test_byte_budget_is_hard(void) {
  NSString *large = [@"я" stringByPaddingToLength:5000
                                        withString:@"я"
                                   startingAtIndex:0];
  FixtureNode *root = node(@"AXWindow", large);
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 10, 700), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"encodedBytes"] unsignedIntegerValue] <= 700);
  assert_encoded_bytes(result);
}

static void test_single_oversized_grapheme_never_crosses_string_limit(void) {
  NSMutableString *large = [NSMutableString stringWithString:@"a"];
  for (NSUInteger index = 0; index < 6000; index += 1) {
    [large appendString:@"\u0301"];
  }
  FixtureNode *root = node(@"AXWindow", large);
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 10, 1024 * 1024), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodes"][0][@"title"] length] <= 4096);
}

static void test_owner_mismatch_fails_closed(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  root.pid = 777;
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend(
      root, context(1000, 10, 1024 * 1024), backend);
  assert(result != nil);
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodeCount"] unsignedIntegerValue] == 0);
}

static void test_retention_observer_sees_exact_added_nodes(void) {
  FixtureNode *root = node(@"AXWindow", @"Документ");
  FixtureNode *button = node(@"AXButton", @"Кнопка");
  [root.children addObject:button];
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSMutableDictionary<NSString *, id> *retained = [NSMutableDictionary dictionary];
  NSDictionary *result = meta_ax_inspect_with_backend_and_observer(
      root, context(1000, 10, 1024 * 1024), backend,
      ^BOOL(NSString *elementRef,
            id borrowedElement,
            NSArray<NSString *> *advertisedActions) {
        assert([advertisedActions isEqual:@[@"AXPress"]]);
        retained[elementRef] = borrowedElement;
        return YES;
      });
  assert([result[@"complete"] boolValue]);
  assert(retained.count == 2);
  assert(retained[@"ax-node:1"] == root);
  assert(retained[@"ax-node:2"] == button);
}

static void test_rejected_retention_removes_actionability(void) {
  FixtureNode *root = node(@"AXButton", @"Кнопка");
  FixtureBackend *backend = [[FixtureBackend alloc] init];
  NSDictionary *result = meta_ax_inspect_with_backend_and_observer(
      root, context(1000, 10, 1024 * 1024), backend,
      ^BOOL(__unused NSString *elementRef,
            __unused id borrowedElement,
            __unused NSArray<NSString *> *advertisedActions) {
        return NO;
      });
  assert(![result[@"complete"] boolValue]);
  assert([result[@"nodes"][0][@"actions"] count] == 0);
  assert([result[@"errors"] containsObject:
                                @"AX node retention observer rejected element"]);
}

int main(void) {
  @autoreleasepool {
    test_bounded_tree();
    test_cycle_is_incomplete();
    test_node_limit_is_incomplete();
    test_depth_limit_is_incomplete();
    test_deadline_is_incomplete();
    test_byte_budget_is_hard();
    test_single_oversized_grapheme_never_crosses_string_limit();
    test_owner_mismatch_fails_closed();
    test_retention_observer_sees_exact_added_nodes();
    test_rejected_retention_removes_actionability();
    puts("AX inspector tests passed");
  }
  return 0;
}
