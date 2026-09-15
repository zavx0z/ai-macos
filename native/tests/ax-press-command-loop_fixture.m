#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "accessibility/meta_ax_inspector.h"
#include "ax-actions/meta_ax_press.h"
#include "ax-actions/meta_ax_retained_snapshot.h"

#include <string.h>
#include <unistd.h>

@interface FixtureAXNode : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, copy) NSString *role;
@property(nonatomic, copy) NSArray<NSString *> *actions;
@property(nonatomic, strong) FixtureAXNode *parent;
@property(nonatomic, copy) NSArray<FixtureAXNode *> *children;
@end
@implementation FixtureAXNode
@end

@interface FixtureInspectorBackend : NSObject <MetaAXInspectionBackend>
@end
@implementation FixtureInspectorBackend
- (uint64_t)monotonicMillis { return 100; }
- (MetaAXReadStatus)ownerPidForElement:(FixtureAXNode *)element
                                 value:(pid_t *)value {
  *value = element.pid;
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)stringAttribute:(NSString *)attribute
                         forElement:(FixtureAXNode *)element
                              value:(NSString **)value {
  if ([attribute isEqual:@"role"]) *value = element.role;
  else if ([attribute isEqual:@"subrole"] || [attribute isEqual:@"title"])
    *value = @"";
  else return META_AX_READ_FAILED;
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)frameForElement:(__unused id)element
                              value:(CGRect *)value {
  *value = CGRectMake(10, 20, 100, 40);
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)actionsForElement:(FixtureAXNode *)element
                                value:(NSArray<NSString *> **)value {
  *value = element.actions;
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)childCountForElement:(FixtureAXNode *)element
                                   value:(NSUInteger *)value {
  *value = element.children.count;
  return META_AX_READ_OK;
}
- (MetaAXReadStatus)childrenForElement:(FixtureAXNode *)element
                                  from:(NSUInteger)index
                                 count:(NSUInteger)count
                                 value:(NSArray **)value {
  if (index > element.children.count) return META_AX_READ_FAILED;
  NSUInteger length = MIN(count, element.children.count - index);
  *value = [element.children subarrayWithRange:NSMakeRange(index, length)];
  return META_AX_READ_OK;
}
@end

@interface FixturePressBackend : NSObject <MetaAXPressBackend>
@property(nonatomic) AXError performError;
@property(nonatomic) NSUInteger performCalls;
@end
@implementation FixturePressBackend
- (uint64_t)monotonicMillis { return 100; }
- (BOOL)sameElement:(id)left other:(id)right { return left == right; }
- (MetaAXPressReadStatus)ownerPidForElement:(FixtureAXNode *)element
                                     value:(pid_t *)value {
  *value = element.pid;
  return META_AX_PRESS_READ_OK;
}
- (MetaAXPressReadStatus)parentForElement:(FixtureAXNode *)element
                                    value:(id *)value {
  *value = element.parent;
  return element.parent == nil ? META_AX_PRESS_READ_ABSENT
                               : META_AX_PRESS_READ_OK;
}
- (MetaAXPressReadStatus)actionsForElement:(FixtureAXNode *)element
                                     value:(NSArray<NSString *> **)value {
  *value = element.actions;
  return META_AX_PRESS_READ_OK;
}
- (AXError)performPressForElement:(__unused id)element {
  _performCalls += 1;
  return _performError;
}
@end

typedef NS_ENUM(NSInteger, FixtureMode) {
  FixtureModeSuccess,
  FixtureModeStaleSnapshot,
  FixtureModeForeignParent,
  FixtureModeAXError,
};

static bool fixture_dispatch_block(void *context) {
  BOOL (^perform)(void) = (__bridge BOOL (^)(void))context;
  return perform();
}

@interface AXPressFixtureBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithMode:(FixtureMode)mode;
@end

@implementation AXPressFixtureBackend {
  FixtureMode _mode;
  FixtureAXNode *_root;
  FixtureAXNode *_button;
  FixtureAXNode *_foreignRoot;
  FixtureInspectorBackend *_inspector;
  FixturePressBackend *_press;
  MetaAXRetainedSnapshotRegistry *_snapshots;
  MetaInputExecutor *_input;
  NSDictionary *_lastTarget;
  NSArray<NSDictionary *> *_lastNodes;
  NSDictionary *_lastBorrowed;
}

- (instancetype)initWithMode:(FixtureMode)mode {
  self = [super init];
  if (self) {
    _mode = mode;
    _root = [FixtureAXNode new];
    _root.pid = 501;
    _root.role = @"AXWindow";
    _root.actions = @[@"AXRaise"];
    _button = [FixtureAXNode new];
    _button.pid = 501;
    _button.role = @"AXButton";
    _button.actions = @[@"AXPress"];
    _button.parent = _root;
    _root.children = @[_button];
    _button.children = @[];
    _foreignRoot = [FixtureAXNode new];
    _foreignRoot.pid = 501;
    _foreignRoot.role = @"AXWindow";
    _foreignRoot.actions = @[@"AXRaise"];
    _foreignRoot.children = @[];
    _inspector = [FixtureInspectorBackend new];
    _press = [FixturePressBackend new];
    _press.performError = mode == FixtureModeAXError
                              ? kAXErrorActionUnsupported
                              : kAXErrorSuccess;
    _snapshots = [[MetaAXRetainedSnapshotRegistry alloc]
        initWithClock:^uint64_t { return 100; }
           ttlMillis:30000
        maxSnapshots:4
            maxNodes:32];
    _input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-ax-press-fixture"
                      sink:(MetaExecutorBackend){0}
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"window-1"];
                    }];
  }
  return self;
}

- (NSDictionary *)sessionIdentity {
  return @{
    @"verified" : @NO,
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"reason" : @"Injected fixture не вызывает audit syscall",
  };
}
- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation { return [_input sealForRotation]; }

- (NSDictionary *)inspect:(NSDictionary *)request {
  NSDictionary *target = request[@"payload"][@"target"];
  NSDictionary *ref = target[@"ref"];
  NSMutableDictionary<NSString *, id> *borrowed =
      [NSMutableDictionary dictionary];
  MetaAXInspectionContext context = {
    .runtime_epoch = [request[@"runtimeEpoch"] UTF8String],
    .login_session_id = [request[@"loginSessionId"] UTF8String],
    .native_generation = [request[@"nativeGeneration"] UTF8String],
    .application_ref = [ref[@"applicationRef"] UTF8String],
    .inventory_id = "inventory-1",
    .inventory_revision = 7,
    .snapshot_id = "snapshot-1",
    .target_ref = [ref[@"windowRef"] UTF8String],
    .owner_pid = 501,
    .depth = 12,
    .max_nodes = 32,
    .max_bytes = 1024 * 1024,
    .deadline_millis = 1000,
    .per_call_timeout_millis = 50,
  };
  NSDictionary *result = meta_ax_inspect_with_backend_and_observer(
      _root, context, _inspector,
      ^BOOL(NSString *elementRef,
            id borrowedElement,
            __unused NSArray<NSString *> *actions) {
        borrowed[elementRef] = borrowedElement;
        return YES;
      });
  if (result == nil || ![_snapshots publishTarget:target
                                          inventoryId:@"inventory-1"
                                    inventoryRevision:7
                                            snapshotId:result[@"snapshotId"]
                                                 nodes:result[@"nodes"]
                                      borrowedElements:borrowed]) {
    return nil;
  }
  _lastTarget = [target copy];
  _lastNodes = [result[@"nodes"] copy];
  _lastBorrowed = [borrowed copy];
  return result;
}

- (NSDictionary *)executeAxPress:(NSDictionary *)request
                              job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  NSDictionary *target = operation[@"target"];
  NSDictionary *element = request[@"payload"][@"element"];
  if (_lastTarget == nil || ![target isEqual:_lastTarget]) return nil;
  if (_mode == FixtureModeStaleSnapshot) {
    [_snapshots publishTarget:target
                  inventoryId:@"inventory-1"
            inventoryRevision:7
                    snapshotId:@"snapshot-2"
                         nodes:_lastNodes
              borrowedElements:_lastBorrowed];
  }
  MetaExecutor *executor = [_input executorOnActionWorker];
  FixtureAXNode *freshParent = _mode == FixtureModeForeignParent
                                   ? _foreignRoot
                                   : _root;
  __block MetaAXPressOutcome press = {
    .status = META_AX_PRESS_INVALID_REQUEST,
  };
  __block BOOL accepted = NO;
  NSDictionary *execution = [_input
      executePrimitive:request
                   job:job
             targetRef:target[@"ref"][@"windowRef"]
                verify:^BOOL(NSString *value) {
                  return [value isEqual:@"window-1"];
                }
                action:^NSDictionary * {
                  MetaAXRetainedBorrowStatus retained = [self->_snapshots
                      withPressElement:element
                                target:target
                           inventoryId:operation[@"inventoryId"]
                     inventoryRevision:[operation[@"inventoryRevision"]
                                           unsignedLongLongValue]
                               consume:^BOOL(id retainedElement) {
                    press = meta_ax_press_with_backend(
                        retainedElement,
                        freshParent,
                        (MetaAXPressContext){
                          .owner_pid = 501,
                          .max_ancestry_depth = 16,
                          .deadline_millis = 1000,
                          .per_call_timeout_millis = 50,
                        },
                        self->_press,
                        ^BOOL(BOOL (^perform)(void)) {
                          return meta_executor_dispatch_action(
                              executor,
                              fixture_dispatch_block,
                              (__bridge void *)perform,
                              "ax-press-fixture");
                        });
                    return press.status == META_AX_PRESS_SUCCEEDED;
                  }];
                  accepted = retained == META_AX_RETAINED_BORROW_OK &&
                             press.status == META_AX_PRESS_SUCCEEDED &&
                             press.dispatch_attempted;
                  if (!accepted)
                    meta_executor_fail(executor, "ax-press-not-confirmed");
                  return accepted
                             ? @{
                                 @"element" : element,
                                 @"action" : @"AXPress",
                                 @"performed" : @YES,
                               }
                             : @{};
                }];
  if (accepted && [execution[@"finished"] boolValue]) {
    return @{
      @"value" : execution[@"value"],
      @"status" : execution[@"status"],
    };
  }
  BOOL attempted = [execution[@"status"][@"dispatchAttempts"]
      unsignedLongLongValue] > 0;
  NSString *code = attempted ? @"operation-outcome-unknown"
                              : @"target-stale";
  NSString *recovery = attempted ? @"get-operation" : @"refresh-inventory";
  return @{
    @"nativeError" : @{
      @"code" : code,
      @"message" : [NSString
          stringWithFormat:@"Injected AXPress failed: retained/press=%ld/%ld",
                           (long)(accepted ? META_AX_RETAINED_BORROW_OK
                                          : META_AX_RETAINED_BORROW_SNAPSHOT_STALE),
                           (long)press.status],
      @"stage" : @"ax-press-fixture",
      @"retryable" : @NO,
      @"replayAllowed" : @NO,
      @"recoveryAction" : recovery,
    },
    @"nativeStatus" : execution[@"status"],
  };
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    FixtureMode mode = FixtureModeSuccess;
    if (argc == 2 && strcmp(argv[1], "--stale-snapshot") == 0)
      mode = FixtureModeStaleSnapshot;
    else if (argc == 2 && strcmp(argv[1], "--foreign-parent") == 0)
      mode = FixtureModeForeignParent;
    else if (argc == 2 && strcmp(argv[1], "--ax-error") == 0)
      mode = FixtureModeAXError;
    return meta_command_loop_run(
        [[AXPressFixtureBackend alloc] initWithMode:mode],
        @"ax-press-fixture-build",
        @"/tmp/ax-press-fixture",
        @"native-ax-press-fixture",
        STDIN_FILENO,
        STDOUT_FILENO);
  }
}
