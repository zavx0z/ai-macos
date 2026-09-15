#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include <unistd.h>

@interface FixtureCommandBackend : NSObject <MetaCommandBackend>
@end
static BOOL focusedSheet = NO;
static BOOL eventLog = NO;
static bool fixturePost(void *context, MetaHeldEventKind kind, uint32_t code, bool down, uint64_t tag) {
  (void)context; (void)kind; (void)tag;
  if (eventLog) fprintf(stderr, "held:%u:%s\n", code, down ? "down" : "up");
  return true;
}
static bool fixtureText(void *context, const uint16_t *text, size_t length, uint64_t tag) {
  (void)context; (void)text; (void)length; (void)tag; return true;
}
static bool fixtureFlags(void *context, uint64_t flags) { (void)context; (void)flags; return true; }
static bool fixtureCleanup(void *context, MetaHeldEventKind kind, uint32_t code, uint64_t tag) { return fixturePost(context, kind, code, false, tag); }
static bool fixturePointer(void *context, const MetaPointerEvent *event, uint64_t tag) { (void)context; (void)event; (void)tag; return true; }
static bool fixtureScroll(void *context, const MetaScrollEvent *event, uint64_t tag) { (void)context; (void)event; (void)tag; return true; }
@implementation FixtureCommandBackend {
  MetaInputExecutor *_input;
  NSString *_clipboardValue;
  NSUInteger _clipboardVersion;
}
- (NSDictionary *)sessionIdentity {
  return @{@"verified": @NO, @"source": @"darwin-audit", @"uid": @501, @"effectiveUid": @501,
    @"reason": @"Injected fixture не вызывает системный audit syscall"};
}
- (instancetype)init {
  self = [super init];
  if (self) {
    _clipboardValue = @"";
    _clipboardVersion = 7;
    MetaExecutorBackend sink = {.post_held_event = fixturePost, .post_text_cluster = fixtureText, .set_event_flags = fixtureFlags,
      .post_pointer_event = fixturePointer, .post_scroll_event = fixtureScroll, .post_cleanup_up = fixtureCleanup};
    _input = [[MetaInputExecutor alloc] initWithGeneration:@"native-command-fixture" sink:sink verify:^BOOL(NSString *target) {
      return [target isEqual:focusedSheet ? @"sheet-fixture" : @"window-fixture"];
    }];
    [_input setScopedPointVerifier:^BOOL(NSDictionary *target, double x, double y) {
      if (x < 0 || x > 100 || y < 0 || y > 100) return NO;
      if ([target[@"kind"] isEqual:@"display"]) return [target[@"ref"][@"displayRef"] isEqual:@"display-fixture"];
      if ([target[@"kind"] isEqual:@"desktop-layout"]) return [target[@"ref"][@"layoutRef"] isEqual:@"layout-fixture"];
      NSString *ref = target[@"ref"][@"windowRef"] ?: target[@"ref"][@"surfaceRef"];
      return [ref isEqual:focusedSheet ? @"sheet-fixture" : @"window-fixture"];
    }];
  }
  return self;
}
- (NSDictionary *)permissions {
  return @{@"accessibility": @1, @"postEvents": @0, @"screenRecording": @0,
    @"codeIdentity": @{@"helperPath": @"/tmp/command-fixture", @"cdhash": @"1111111111111111111111111111111111111111"}};
}
- (NSDictionary *)inventory {
  usleep(500000);
  return nil;
}
- (NSDictionary *)inspect:(NSDictionary *)request {
  (void)request;
  return @{@"snapshotId": @"ax-fixture", @"complete": @YES, @"nodeCount": @1, @"encodedBytes": @100,
    @"nodes": @[@{@"elementRef": @"element-fixture", @"role": @"AXButton", @"subrole": @"", @"title": @"Fixture button", @"actions": @[@"AXPress"]}], @"errors": @[]};
}
- (NSDictionary *)resolveApplication:(NSDictionary *)request {
  return @{@"requestedPath": request[@"payload"][@"path"], @"sourceResponseRef": @"bundle-source", @"inventoryId": @"inventory", @"inventoryRevision": @1,
    @"observedAt": @"2026-09-15T00:00:00.000Z", @"target": @{@"kind": @"application-bundle", @"ref": @{
      @"runtimeEpoch": request[@"runtimeEpoch"], @"loginSessionId": request[@"loginSessionId"], @"nativeGeneration": request[@"nativeGeneration"],
      @"bundleRef": @"bundle-fixture", @"bundleId": request[@"payload"][@"bundleId"], @"path": request[@"payload"][@"path"], @"device": @"1", @"inode": @"2", @"modifiedAtNs": @"3"}}};
}
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return @{@"status": @"observation-stale", @"reason": @"Fixture не хранит capture frame"}; }
- (NSDictionary *)clipboard:(NSDictionary *)command {
  if ([command[@"method"] isEqual:@"clipboard.version"]) {
    return @{@"method": @"clipboard.version", @"value": @{@"status": @"ok", @"changeCount": @(_clipboardVersion)}};
  }
  if ([command[@"method"] isEqual:@"clipboard.write"]) {
    NSUInteger before = _clipboardVersion;
    _clipboardValue = command[@"payload"][@"text"];
    _clipboardVersion += 1;
    return @{@"method": @"clipboard.write", @"value": @{@"status": @"written", @"beforeChangeCount": @(before),
      @"declaredChangeCount": @(_clipboardVersion), @"afterChangeCount": @(_clipboardVersion), @"mutationAttempted": @YES,
      @"setStringSucceeded": @YES, @"ownershipStableAfterWrite": @YES, @"atomicPrecondition": @NO,
      @"utf8Bytes": @([_clipboardValue lengthOfBytesUsingEncoding:NSUTF8StringEncoding])}};
  }
  if ([command[@"method"] isEqual:@"clipboard.read"]) {
    return @{@"method": @"clipboard.read", @"value": @{@"status": @"ok", @"beforeChangeCount": @(_clipboardVersion),
      @"afterChangeCount": @(_clipboardVersion), @"text": _clipboardValue,
      @"utf8Bytes": @([_clipboardValue lengthOfBytesUsingEncoding:NSUTF8StringEncoding])}};
  }
  return nil;
}
- (NSDictionary *)status:(NSString *)operation requestId:(NSString *)request {
  (void)operation;
  (void)request;
  return nil;
}
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (BOOL)beginRotation { return [_input sealForRotation]; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job {
  NSDictionary *result = [_input execute:request job:job];
  if (eventLog) fprintf(stderr, "terminal:%s:%s\n", [result[@"status"][@"execution"] UTF8String], [result[@"status"][@"cleanup"] UTF8String]);
  return result;
}
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job {
  NSString *target = request[@"payload"][@"target"][@"windowRef"];
  NSDictionary *execution = [_input executeExternal:request job:job targetRef:target verify:^BOOL(NSString *value) {
    return [value isEqual:@"window-fixture"];
  } action:^NSDictionary * { return @{@"changed": @YES}; }];
  if (execution == nil) return nil;
  NSDictionary *actual = @{@"kind": @"ax-window", @"windowRef": target, @"applicationRef": @"application-fixture", @"ownerPid": @42,
    @"title": @"Fixture", @"role": @"AXWindow", @"subrole": @"AXStandardWindow", @"frame": @{@"x": @0, @"y": @0, @"width": @100, @"height": @100},
    @"applicationHidden": @"false", @"minimized": @"false", @"onScreen": @"true", @"spaceVisibility": @"current",
    @"fullscreen": @"false", @"focused": @"true", @"main": @"true", @"mapping": @"unavailable", @"mappingReason": @"Injected AX-only fixture",
    @"actionability": @"ax", @"advertisedActions": @[@"raise"], @"surfaces": @[]};
  return @{@"sourceResponseRef": @"response-window-fixture", @"inventoryId": @"inventory-next", @"inventoryRevision": @2,
    @"displayLayoutRevision": @0, @"observedAt": @"2026-09-15T00:00:00.000Z", @"displays": @[], @"targetRef": target,
    @"actual": actual, @"changed": @YES, @"partial": @NO, @"errors": @[], @"status": execution[@"status"]};
}
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    focusedSheet = argc == 2 && strcmp(argv[1], "--focused-sheet") == 0;
    eventLog = argc == 2 && strcmp(argv[1], "--event-log") == 0;
    return meta_command_loop_run([[FixtureCommandBackend alloc] init], @"command-fixture-build",
                                  @"/tmp/command-fixture", @"native-command-fixture", STDIN_FILENO, STDOUT_FILENO);
  }
}
