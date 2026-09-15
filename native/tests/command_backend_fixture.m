#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include <unistd.h>

@interface FixtureCommandBackend : NSObject <MetaCommandBackend>
@end
static BOOL focusedSheet = NO;
static bool fixturePost(void *context, MetaHeldEventKind kind, uint32_t code, bool down, uint64_t tag) {
  (void)context; (void)kind; (void)code; (void)down; (void)tag; return true;
}
static bool fixtureText(void *context, const uint16_t *text, size_t length, uint64_t tag) {
  (void)context; (void)text; (void)length; (void)tag; return true;
}
static bool fixtureFlags(void *context, uint64_t flags) { (void)context; (void)flags; return true; }
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
      .post_pointer_event = fixturePointer, .post_scroll_event = fixtureScroll};
    _input = [[MetaInputExecutor alloc] initWithGeneration:@"native-command-fixture" sink:sink verify:^BOOL(NSString *target) {
      return [target isEqual:focusedSheet ? @"sheet-fixture" : @"window-fixture"];
    }];
    [_input setPointVerifier:^BOOL(NSString *target, double x, double y) {
      return [target isEqual:focusedSheet ? @"sheet-fixture" : @"window-fixture"] && x >= 0 && x <= 100 && y >= 0 && y <= 100;
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
- (BOOL)beginRotation { return [_input sealForRotation]; }
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job { return [_input execute:request job:job]; }
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
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    focusedSheet = argc == 2 && strcmp(argv[1], "--focused-sheet") == 0;
    return meta_command_loop_run([[FixtureCommandBackend alloc] init], @"command-fixture-build",
                                  @"/tmp/command-fixture", @"native-command-fixture", STDIN_FILENO, STDOUT_FILENO);
  }
}
