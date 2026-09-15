#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "recovery-domain/meta_recovery_domain.h"

#include <unistd.h>

@interface RecoveryDomainFixtureBackend : NSObject <MetaCommandBackend>
@end

static bool fixture_text(void *context,
                         const uint16_t *text,
                         size_t length,
                         uint64_t tag) {
  NSUInteger *posts = context;
  if (text == NULL || length == 0 || tag == 0) return false;
  *posts += 1;
  return true;
}

@implementation RecoveryDomainFixtureBackend {
  MetaInputExecutor *_input;
  NSUInteger _textPosts;
  NSString *_clipboard;
  NSUInteger _clipboardVersion;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _clipboard = @"";
    _clipboardVersion = 1;
    MetaExecutorBackend sink = {
      .context = &_textPosts,
      .post_text_cluster = fixture_text,
    };
    _input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-domain-fixture"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"window-1"];
                    }];
  }
  return self;
}

- (NSString *)recoveryDomainVersion { return @"1"; }

- (BOOL)validateRecoveryRequest:(NSDictionary *)request {
  return meta_recovery_domain_validate_request(
      request, @"domain-fixture-build", NULL, NULL);
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

- (NSArray<NSDictionary *> *)capabilityCatalog {
  return @[
    @{@"id" : @"runtime.identity", @"state" : @"ready"},
    @{@"id" : @"input.keyboard", @"state" : @"ready"},
    @{@"id" : @"input.clipboard", @"state" : @"ready"},
  ];
}

- (NSDictionary *)executeInput:(NSDictionary *)request
                            job:(MetaInputJob *)job {
  return [_input execute:request job:job];
}

- (NSDictionary *)clipboard:(NSDictionary *)command {
  if ([command[@"method"] isEqual:@"clipboard.write"]) {
    NSUInteger before = _clipboardVersion;
    _clipboard = command[@"payload"][@"text"];
    _clipboardVersion += 1;
    return @{
      @"method" : @"clipboard.write",
      @"value" : @{
        @"status" : @"written",
        @"beforeChangeCount" : @(before),
        @"declaredChangeCount" : @(_clipboardVersion),
        @"afterChangeCount" : @(_clipboardVersion),
        @"mutationAttempted" : @YES,
        @"setStringSucceeded" : @YES,
        @"ownershipStableAfterWrite" : @YES,
        @"atomicPrecondition" : @NO,
        @"utf8Bytes" : @([_clipboard
            lengthOfBytesUsingEncoding:NSUTF8StringEncoding]),
      },
    };
  }
  if ([command[@"method"] isEqual:@"clipboard.version"]) {
    return @{
      @"method" : @"clipboard.version",
      @"value" : @{
        @"status" : @"ok",
        @"changeCount" : @(_clipboardVersion),
      },
    };
  }
  return nil;
}

- (NSDictionary *)cursorDisplay:(NSDictionary *)request {
  return @{
    @"status" : @"resolved",
    @"runtimeEpoch" : request[@"runtimeEpoch"],
    @"loginSessionId" : request[@"loginSessionId"],
    @"nativeGeneration" : request[@"nativeGeneration"],
    @"sourceResponseRef" : @"cursor-source-1",
    @"inventoryId" : request[@"payload"][@"inventoryId"],
    @"inventoryRevision" : request[@"payload"][@"inventoryRevision"],
    @"displayLayoutRevision" : request[@"payload"][@"displayLayoutRevision"],
    @"cursor" : @{@"x" : @10, @"y" : @20},
    @"displayRef" : @{
      @"runtimeEpoch" : request[@"runtimeEpoch"],
      @"loginSessionId" : request[@"loginSessionId"],
      @"nativeGeneration" : request[@"nativeGeneration"],
      @"displayRef" : @"display-1",
      @"displayLayoutRevision" : request[@"payload"][@"displayLayoutRevision"],
    },
    @"observedAt" : @"2026-09-15T10:00:00.000Z",
  };
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request {
  (void)request;
  return @{
    @"status" : @"observation-stale",
    @"reason" : @"Injected read-only handler reached without recovery grant",
  };
}
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation { return [_input sealForRotation]; }

@end

int main(void) {
  @autoreleasepool {
    return meta_command_loop_run(
        [RecoveryDomainFixtureBackend new],
        @"domain-fixture-build",
        @"/tmp/domain-fixture",
        @"native-domain-fixture",
        STDIN_FILENO,
        STDOUT_FILENO);
  }
}
