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
    MetaExecutorBackend sink = {.post_held_event = fixturePost, .post_text_cluster = fixtureText, .set_event_flags = fixtureFlags};
    _input = [[MetaInputExecutor alloc] initWithGeneration:@"native-command-fixture" sink:sink verify:^BOOL(NSString *target) {
      return [target isEqual:focusedSheet ? @"sheet-fixture" : @"window-fixture"];
    }];
  }
  return self;
}
- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory {
  usleep(500000);
  return nil;
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
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    focusedSheet = argc == 2 && strcmp(argv[1], "--focused-sheet") == 0;
    return meta_command_loop_run([[FixtureCommandBackend alloc] init], @"command-fixture-build",
                                  @"/tmp/command-fixture", @"native-command-fixture", STDIN_FILENO, STDOUT_FILENO);
  }
}
