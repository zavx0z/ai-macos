#include "meta_command_loop.h"
#include "domain-recovery/meta_domain_recovery.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  NSUInteger mode;
  size_t readiness_calls;
  size_t key_calls;
  size_t button_calls;
} DomainRecoveryFixtureState;

static NSDate *fixture_now(void *context) {
  (void)context;
  return NSDate.date;
}

static bool fixture_readiness(void *context,
                              MetaRecoveryReadiness *readiness) {
  DomainRecoveryFixtureState *state = context;
  state->readiness_calls += 1;
  *readiness = (MetaRecoveryReadiness){
      .input_monitoring = true,
      .session_state = MetaRecoverySessionStateActiveConsole,
      .lock_state = MetaRecoveryLockStateUnknown,
      .secure_input = state->mode == 2 && state->readiness_calls > 1
                          ? MetaRecoverySecureInputStateOn
                          : MetaRecoverySecureInputStateOff,
      .observer_ready = true,
  };
  return true;
}

static MetaRecoveryObservedState fixture_key(void *context, uint32_t code) {
  DomainRecoveryFixtureState *state = context;
  (void)code;
  state->key_calls += 1;
  return state->mode == 1 ? MetaRecoveryObservedStateHeld
                          : MetaRecoveryObservedStateUp;
}

static MetaRecoveryObservedState fixture_button(void *context,
                                                 uint32_t code) {
  DomainRecoveryFixtureState *state = context;
  (void)code;
  state->button_calls += 1;
  return state->mode == 1 ? MetaRecoveryObservedStateHeld
                          : MetaRecoveryObservedStateUp;
}

@interface DomainRecoveryCommandBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithMode:(NSString *)mode;
@end

@implementation DomainRecoveryCommandBackend {
  DomainRecoveryFixtureState _state;
}

- (instancetype)initWithMode:(NSString *)mode {
  self = [super init];
  if (self) {
    _state.mode = [mode isEqual:@"held"] ? 1 : [mode isEqual:@"revoke"] ? 2 : 0;
  }
  return self;
}

- (NSDictionary *)sessionIdentity {
  return @{
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"verified" : @NO,
    @"reason" : @"Тестовый command loop не вызывает audit syscall",
  };
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)resolveApplication:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)hitTest:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)cleanupCapture:(NSDictionary *)request
                       emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary {
  (void)request;
  (void)emitBinary;
  return nil;
}
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command {
  (void)command;
  return nil;
}
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId {
  (void)operationId;
  (void)requestId;
  return nil;
}
- (NSDictionary *)cancel:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)executeApplication:(NSDictionary *)request
                                  job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (BOOL)beginRotation { return YES; }
- (NSString *)recoveryDomainVersion { return @"1"; }
- (BOOL)validateRecoveryRequest:(NSDictionary *)request {
  (void)request;
  return NO;
}

- (NSDictionary *)domainRecovery:(NSDictionary *)request
                            owner:(NSDictionary *)owner {
  size_t keysBefore = _state.key_calls;
  size_t buttonsBefore = _state.button_calls;
  NSDictionary *result = meta_domain_recovery_receive(
      owner, request,
      (MetaRecoveryProbeBackend){
          .context = &_state,
          .now = fixture_now,
          .readiness = fixture_readiness,
          .sample_key = fixture_key,
          .sample_button = fixture_button,
      });
  if (result != nil) {
    NSUInteger expectedKeys = 0;
    NSUInteger expectedButtons = 0;
    for (NSDictionary *hold in request[@"grant"][@"descriptor"][@"possibleHolds"]) {
      if ([hold[@"kind"] isEqual:@"key"]) expectedKeys += 1;
      else expectedButtons += 1;
    }
    assert(_state.key_calls - keysBefore == expectedKeys);
    assert(_state.button_calls - buttonsBefore == expectedButtons);
  }
  return result;
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *mode = argc == 2 ? @(argv[1]) : @"up";
    return meta_command_loop_run(
        [[DomainRecoveryCommandBackend alloc] initWithMode:mode],
        @"domain-recovery-fixture-build", @"/tmp/domain-recovery-fixture",
        @"native-current", STDIN_FILENO, STDOUT_FILENO);
  }
}
