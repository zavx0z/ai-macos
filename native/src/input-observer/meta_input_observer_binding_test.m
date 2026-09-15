#include "meta_input_observer_binding.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

@interface MetaInputObserverFixtureObserver : MetaNativeObserver
@property(nonatomic) BOOL stopped;
@property(nonatomic) BOOL recordForeignDuringRegistration;
@property(nonatomic) NSUInteger unregisterCalls;
@property(nonatomic) uint64_t lastUnregisteredTag;
@end

@implementation MetaInputObserverFixtureObserver
- (BOOL)start {
  [self recordCoverageKind:@"input" available:YES reason:nil];
  [self recordCoverageKind:@"focus" available:YES reason:nil];
  [self recordCoverageKind:@"window-structure" available:YES reason:nil];
  [self recordCoverageKind:@"lifecycle" available:YES reason:nil];
  return YES;
}
- (void)stop {
  self.stopped = YES;
  [self markUnavailable:@"Fixture observer остановлен"];
}
- (void)unregisterSyntheticTag:(uint64_t)tag {
  self.unregisterCalls += 1;
  self.lastUnregisteredTag = tag;
  [super unregisterSyntheticTag:tag];
}
- (BOOL)registerSyntheticTag:(uint64_t)tag
                 operationId:(NSString *)operationId
               interactionId:(NSString *)interactionId
                      target:(NSDictionary *)target {
  BOOL accepted = [super registerSyntheticTag:tag
                                  operationId:operationId
                                interactionId:interactionId
                                       target:target];
  if (accepted && self.recordForeignDuringRegistration) {
    [self recordInputFromPid:getpid() + 1 syntheticTag:tag];
  }
  return accepted;
}
@end

typedef struct {
  __unsafe_unretained MetaInputObserverFixtureObserver *observer;
  size_t instanceIndex;
} MetaInputObserverFixture;

static NSDictionary *fixture_generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *fixture_target(void) {
  return @{
    @"kind" : @"window",
    @"ref" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"applicationRef" : @"application-1",
      @"windowRef" : @"window-1",
    },
  };
}

static NSDictionary *fixture_readiness(void) {
  return @{
    @"state" : @"active-console",
    @"lockState" : @"unknown",
    @"userId" : @501,
    @"onConsole" : @YES,
    @"loginDone" : @YES,
    @"auditSessionId" : @42,
    @"secureInput" : @"off",
    @"evidence" : @"Fixture public session facts",
    @"observedAt" : @"2026-09-15T10:00:00.000Z",
  };
}

static NSDictionary *fixture_request(NSString *command, NSString *instance,
                                     NSString *previous) {
  NSMutableDictionary *request = [@{
    @"kind" : @"observer",
    @"protocolVersion" : @"1",
    @"requestId" : [NSString stringWithFormat:@"request-%@-%@", command,
                                               NSUUID.UUID.UUIDString],
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"command" : command,
    @"deadlineAt" : @"2099-09-15T10:00:00.000Z",
  } mutableCopy];
  if (instance != nil) request[@"observerInstanceRef"] = instance;
  if (previous != nil) request[@"previousObserverInstanceRef"] = previous;
  return request;
}

static MetaObserverCommandBinder *fixture_binder(
    MetaInputObserverFixture *fixture) {
  return [[MetaObserverCommandBinder alloc]
      initWithGeneration:fixture_generation()
           nativeBuildId:@"native-build-1"
             indexBuilder:^MetaObserverPreparedIndex * {
               return meta_observer_prepared_index_create(
                   [[MetaObserverTargetIndex alloc] init], @"inventory-1", 1,
                   1);
             }
             mainExecutor:^BOOL(BOOL (^work)(void)) {
               return work();
             }
                  factory:^MetaNativeObserver *(
                      NSDictionary *generation,
                      __unused MetaObserverTargetIndex *index) {
                    MetaInputObserverFixtureObserver *observer =
                        [[MetaInputObserverFixtureObserver alloc]
                            initWithGeneration:generation];
                    fixture->observer = observer;
                    return observer;
                  }
        readinessProvider:^NSDictionary * {
          return fixture_readiness();
        }
       instanceIdProvider:^NSString * {
         fixture->instanceIndex += 1;
         return [NSString stringWithFormat:@"observer-%zu",
                                           fixture->instanceIndex];
       }];
}

static MetaInputObserverBinding *fixture_binding(
    MetaObserverCommandBinder *binder, NSString *instance) {
  return [[MetaInputObserverBinding alloc]
      initWithObserver:binder
      observerInstanceRef:instance
               operationId:@"operation-1"
                    target:fixture_target()
             interactionId:@"interaction-1"];
}

static NSDictionary *fixture_admission_head(NSDictionary *coverage,
                                             NSString *instance) {
  return @{
    @"observerInstanceRef" : instance,
    @"coverageStartCursor" : coverage[@"coverageStartCursor"],
    @"cursor" : coverage[@"cursor"],
    @"nextSequence" : coverage[@"nextSequence"],
  };
}

static void fixture_prepare(MetaObserverCommandBinder *binder) {
  NSDictionary *prepared =
      [binder handleRequest:fixture_request(@"prepare", nil, nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  assert([prepared[@"snapshot"][@"observerInstanceRef"]
      isEqual:@"observer-1"]);
  assert([binder activatePushForObserverInstance:@"observer-1"]);
}

static void test_own_events_continue_without_stealing_push(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  assert(binding != nil && [binding currentCoverage] != nil);
  assert([binding registerTag:42]);
  [fixture.observer recordInputFromPid:getpid() syntheticTag:42];
  assert([binding poll] == MetaInputObserverPollContinue);
  assert([binding poll] == MetaInputObserverPollContinue);
  NSDictionary *push = [binder takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  assert([push[@"events"][0][@"event"][@"syntheticTag"]
      isEqual:@"event-000000000000002a"]);
  [binding stop];
  [binding stop];
  assert(fixture.observer.unregisterCalls == 1);
  assert(fixture.observer.lastUnregisteredTag == 42);
  [fixture.observer recordInputFromPid:getpid() syntheticTag:42];
  assert([fixture.observer.coverage[@"cursor"]
      isEqual:push[@"events"][0][@"event"][@"cursor"]] == NO);
  assert([binding poll] == MetaInputObserverPollUnavailable);
}

static void test_exact_admission_head_binds_without_stealing_event(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  NSDictionary *coverage = [binding currentCoverage];
  assert([binding useAdmissionHead:
                      fixture_admission_head(coverage, @"observer-1")]);
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:0];
  assert([binding registerTag:41]);
  assert([binding poll] == MetaInputObserverPollForeignEvent);
  NSDictionary *push = [binder takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  assert([push[@"events"][0][@"event"][@"source"] isEqual:@"unknown"]);
  [binding stop];
}

static void test_stale_admission_head_clears_binding_fail_closed(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  NSMutableDictionary *stale = [fixture_admission_head(
      [binding currentCoverage], @"observer-1") mutableCopy];
  stale[@"cursor"] = @"cursor-stale";
  assert(![binding useAdmissionHead:stale]);
  assert(![binding registerTag:40]);
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:0];
  NSDictionary *push = [binder takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  assert([binding poll] == MetaInputObserverPollUnavailable);
  [binding stop];
}

static void test_foreign_input_and_lifecycle_stop_continuation(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  assert([binding registerTag:7]);
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:7];
  assert([binding poll] == MetaInputObserverPollForeignEvent);
  [binding stop];

  MetaInputObserverBinding *lifecycle =
      fixture_binding(binder, @"observer-1");
  assert([lifecycle registerTag:8]);
  [fixture.observer recordLifecycle:@"lock" nextLoginSessionId:nil];
  assert([lifecycle poll] == MetaInputObserverPollForeignEvent);
  [lifecycle stop];
}

static void test_registration_baseline_keeps_interleaved_foreign_event(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  fixture.observer.recordForeignDuringRegistration = YES;
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  assert([binding registerTag:9]);
  assert([binding poll] == MetaInputObserverPollForeignEvent);
  [binding stop];
}

static void test_construction_baseline_keeps_pre_registration_event(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *binding = fixture_binding(binder, @"observer-1");
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:10];
  assert([binding registerTag:10]);
  assert([binding poll] == MetaInputObserverPollForeignEvent);
  NSDictionary *push = [binder takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  assert([push[@"events"][0][@"event"][@"source"] isEqual:@"unknown"]);
  [binding stop];
}

static void test_instance_and_gap_invalidation_fail_closed(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  MetaInputObserverBinding *old = fixture_binding(binder, @"observer-1");
  assert([old registerTag:11]);
  NSDictionary *replaced = [binder
      handleRequest:fixture_request(@"prepare", nil, @"observer-1")];
  assert([replaced[@"ok"] isEqual:@YES]);
  assert([old poll] == MetaInputObserverPollUnavailable);
  [old stop];

  MetaInputObserverBinding *current = fixture_binding(binder, @"observer-2");
  assert([current registerTag:12]);
  [fixture.observer markUnavailable:@"Fixture continuity gap"];
  assert([current currentCoverage] == nil);
  assert([current poll] == MetaInputObserverPollUnavailable);
  [current stop];
}

static void test_invalid_generation_never_registers(void) {
  MetaInputObserverFixture fixture = {0};
  MetaObserverCommandBinder *binder = fixture_binder(&fixture);
  fixture_prepare(binder);
  NSMutableDictionary *foreignTarget =
      [fixture_target() mutableCopy];
  NSMutableDictionary *foreignRef =
      [foreignTarget[@"ref"] mutableCopy];
  foreignRef[@"nativeGeneration"] = @"native-foreign";
  foreignTarget[@"ref"] = foreignRef;
  MetaInputObserverBinding *binding = [[MetaInputObserverBinding alloc]
      initWithObserver:binder
      observerInstanceRef:@"observer-1"
               operationId:@"operation-1"
                    target:foreignTarget
             interactionId:nil];
  assert(binding != nil);
  assert([binding currentCoverage] == nil);
  assert(![binding registerTag:13]);
}

int main(void) {
  @autoreleasepool {
    test_own_events_continue_without_stealing_push();
    test_exact_admission_head_binds_without_stealing_event();
    test_stale_admission_head_clears_binding_fail_closed();
    test_foreign_input_and_lifecycle_stop_continuation();
    test_registration_baseline_keeps_interleaved_foreign_event();
    test_construction_baseline_keeps_pre_registration_event();
    test_instance_and_gap_invalidation_fail_closed();
    test_invalid_generation_never_registers();
  }
  puts("input observer binding tests passed");
}
