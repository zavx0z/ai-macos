#include "meta_command_loop.h"
#include <unistd.h>

@interface FixtureCommandBackend : NSObject <MetaCommandBackend>
@end
@implementation FixtureCommandBackend
- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)clipboard:(NSDictionary *)command {
  if ([command[@"method"] isEqual:@"clipboard.version"]) {
    return @{@"method": @"clipboard.version", @"value": @{@"status": @"ok", @"changeCount": @7}};
  }
  return nil;
}
- (NSDictionary *)status:(NSString *)operation requestId:(NSString *)request {
  (void)operation;
  (void)request;
  return nil;
}
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (BOOL)beginRotation { return YES; }
@end

int main(void) {
  @autoreleasepool {
    return meta_command_loop_run([[FixtureCommandBackend alloc] init], @"command-fixture-build",
                                  @"/tmp/command-fixture", @"native-command-fixture", STDIN_FILENO, STDOUT_FILENO);
  }
}
