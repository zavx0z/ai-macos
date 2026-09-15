#include "meta_observer_command.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

@interface FixtureObserver : MetaNativeObserver
@property(nonatomic) BOOL stopped;
@property(nonatomic) NSDictionary *target;
@end

@implementation FixtureObserver
- (BOOL)start {
  [self recordCoverageKind:@"input" available:YES reason:nil];
  [self recordCoverageKind:@"focus" available:YES reason:nil];
  [self recordCoverageKind:@"window-structure" available:YES reason:nil];
  [self recordCoverageKind:@"lifecycle" available:YES reason:nil];
  [self recordFocusTarget:self.target syntheticTag:0];
  return YES;
}
- (void)stop {
  self.stopped = YES;
  [self markUnavailable:@"Fixture observer stopped"];
}
@end

typedef struct {
  __unsafe_unretained FixtureObserver *observer;
  size_t indexCalls;
  size_t mainCalls;
  size_t factoryCalls;
  size_t readinessCalls;
  size_t idCalls;
  BOOL mainSucceeds;
  BOOL deferMain;
  BOOL failAfterMain;
  __unsafe_unretained NSMutableArray *deferredMain;
  __unsafe_unretained NSMutableArray *retainedObservers;
  useconds_t indexDelayMicros;
  size_t validatorCalls;
  size_t invalidateValidatorCall;
} Fixture;

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *target(void) {
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

static NSDictionary *readiness(void) {
  return @{
    @"state" : @"active-console",
    @"lockState" : @"unknown",
    @"userId" : @501,
    @"onConsole" : @YES,
    @"loginDone" : @YES,
    @"auditSessionId" : @42,
    @"secureInput" : @"off",
    @"evidence" : @"fixture public session facts",
    @"observedAt" : @"2026-09-15T10:00:00.000Z",
  };
}

static NSDictionary *request(NSString *command, NSString *instance,
                             NSString *previous, NSString *after) {
  NSMutableDictionary *value = [@{
    @"kind" : @"observer",
    @"protocolVersion" : @"1",
    @"requestId" : [@"request-" stringByAppendingString:command],
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"command" : command,
    @"deadlineAt" : @"2099-09-15T10:00:00.000Z",
  } mutableCopy];
  if (instance != nil) value[@"observerInstanceRef"] = instance;
  if (previous != nil) value[@"previousObserverInstanceRef"] = previous;
  if (after != nil) value[@"afterCursor"] = after;
  return value;
}

static MetaObserverCommandBinder *binder(Fixture *fixture) {
  return [[MetaObserverCommandBinder alloc]
      initWithGeneration:generation()
           nativeBuildId:@"native-build-1"
             indexBuilder:^MetaObserverPreparedIndex * {
               fixture->indexCalls += 1;
               if (fixture->indexDelayMicros > 0) {
                 usleep(fixture->indexDelayMicros);
               }
               MetaObserverTargetIndex *index =
                   [[MetaObserverTargetIndex alloc] init];
               return meta_observer_prepared_index_create(
                   index, @"inventory-1", 1, fixture->indexCalls);
             }
             mainExecutor:^BOOL(BOOL (^work)(void)) {
               fixture->mainCalls += 1;
               if (fixture->deferMain) {
                 [fixture->deferredMain addObject:[work copy]];
                 return NO;
               }
               if (!fixture->mainSucceeds) return NO;
               BOOL result = work();
               return fixture->failAfterMain ? NO : result;
             }
                  factory:^MetaNativeObserver *(
                      NSDictionary *generationValue,
                      __unused MetaObserverTargetIndex *index) {
                    fixture->factoryCalls += 1;
                    FixtureObserver *observer = [[FixtureObserver alloc]
                        initWithGeneration:generationValue];
                    observer.target = target();
                    fixture->observer = observer;
                    [fixture->retainedObservers addObject:observer];
                    return observer;
                  }
        readinessProvider:^NSDictionary * {
          fixture->readinessCalls += 1;
          return readiness();
        }
       instanceIdProvider:^NSString * {
         fixture->idCalls += 1;
         return [NSString stringWithFormat:@"observer-%zu", fixture->idCalls];
       }];
}

static void test_prepare_baseline_push_backfill_and_stop(void) {
  Fixture fixture = {.mainSucceeds = YES};
  MetaObserverCommandBinder *value = binder(&fixture);
  NSDictionary *prepared =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  NSDictionary *snapshot = prepared[@"snapshot"];
  assert([snapshot[@"observerInstanceRef"] isEqual:@"observer-1"]);
  assert([snapshot[@"coverage"][@"state"] isEqual:@"ready"]);
  assert([snapshot[@"coverage"][@"nextSequence"] isEqual:@2]);
  assert([snapshot[@"sessionReadiness"][@"lockState"] isEqual:@"unknown"]);
  assert([snapshot[@"secureInput"] isEqual:@"off"]);
  NSString *baseline = snapshot[@"coverage"][@"cursor"];

  [fixture.observer recordFocusTarget:target() syntheticTag:0];
  assert([[value takePushEnvelopes:10][@"events"] count] == 0);
  assert([value activatePushForObserverInstance:@"observer-1"]);
  NSDictionary *push = [value takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  NSDictionary *envelope = [push[@"events"] firstObject];
  assert([envelope[@"observerInstanceRef"] isEqual:@"observer-1"]);
  assert([envelope[@"event"][@"sequence"] isEqual:@2]);

  NSDictionary *backfill = [value
      handleRequest:request(@"events", @"observer-1", nil, baseline)];
  assert([backfill[@"ok"] isEqual:@YES]);
  assert([backfill[@"events"] count] == 1);
  assert([backfill[@"fromCursor"] isEqual:baseline]);

  NSDictionary *coverage = [value
      handleRequest:request(@"coverage", @"observer-1", nil, nil)];
  assert([coverage[@"ok"] isEqual:@YES]);
  assert([coverage[@"snapshot"][@"coverage"][@"nextSequence"]
      isEqual:@3]);

  FixtureObserver *currentObserver = fixture.observer;
  NSDictionary *stopped =
      [value handleRequest:request(@"stop", @"observer-1", nil, nil)];
  assert([stopped[@"ok"] isEqual:@YES]);
  assert(currentObserver.stopped);
  assert([[value handleRequest:request(@"coverage", @"observer-1", nil, nil)][@"ok"]
      isEqual:@NO]);
}

static void test_restart_requires_exact_previous_instance(void) {
  Fixture fixture = {.mainSucceeds = YES};
  MetaObserverCommandBinder *value = binder(&fixture);
  assert([[[value handleRequest:request(@"prepare", nil, nil, nil)]
      objectForKey:@"ok"] boolValue]);
  NSDictionary *wrong =
      [value handleRequest:request(@"prepare", nil, @"observer-foreign", nil)];
  assert([wrong[@"ok"] isEqual:@NO]);
  assert(fixture.idCalls == 1);

  FixtureObserver *first = fixture.observer;
  NSDictionary *restarted =
      [value handleRequest:request(@"prepare", nil, @"observer-1", nil)];
  assert([restarted[@"ok"] isEqual:@YES]);
  assert([restarted[@"snapshot"][@"observerInstanceRef"]
      isEqual:@"observer-2"]);
  assert(first.stopped);
  assert(fixture.indexCalls == 2);
}

static void test_main_failure_and_gap_are_explicit(void) {
  Fixture failed = {.mainSucceeds = NO};
  MetaObserverCommandBinder *unavailable = binder(&failed);
  NSDictionary *response =
      [unavailable handleRequest:request(@"prepare", nil, nil, nil)];
  assert([response[@"ok"] isEqual:@NO]);
  assert([response[@"error"][@"code"] isEqual:@"capability-unavailable"]);

  Fixture overflowFixture = {.mainSucceeds = YES};
  MetaObserverCommandBinder *overflow = binder(&overflowFixture);
  assert([[[overflow handleRequest:request(@"prepare", nil, nil, nil)]
      objectForKey:@"ok"] boolValue]);
  assert([overflow activatePushForObserverInstance:@"observer-1"]);
  for (size_t index = 0; index < 1001; index += 1) {
    [overflowFixture.observer recordFocusTarget:target() syntheticTag:0];
  }
  NSDictionary *push = [overflow takePushEnvelopes:1000];
  assert([push[@"events"] count] == 1000);
  assert([push[@"gapReason"] isKindOfClass:NSString.class]);
  NSDictionary *coverage = [overflow
      handleRequest:request(@"coverage", @"observer-1", nil, nil)];
  assert([coverage[@"snapshot"][@"coverage"][@"gapDetected"] boolValue]);
}

static void test_delivered_history_rolls_without_gap(void) {
  Fixture fixture = {.mainSucceeds = YES};
  MetaObserverCommandBinder *value = binder(&fixture);
  NSDictionary *prepared =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  assert([value activatePushForObserverInstance:@"observer-1"]);

  NSString *evictedCursor = nil;
  for (size_t index = 0; index < 2500; index += 1) {
    [fixture.observer recordFocusTarget:target() syntheticTag:0];
    if ((index + 1) % 25 != 0) continue;
    NSDictionary *push = [value takePushEnvelopes:25];
    assert([push[@"events"] count] == 25);
    assert(push[@"gapReason"] == nil);
    if (evictedCursor == nil) {
      evictedCursor = push[@"events"][0][@"event"][@"cursor"];
    }
  }

  NSDictionary *coverage = [value
      handleRequest:request(@"coverage", @"observer-1", nil, nil)];
  assert([coverage[@"ok"] isEqual:@YES]);
  assert([coverage[@"snapshot"][@"coverage"][@"state"] isEqual:@"ready"]);
  assert(![coverage[@"snapshot"][@"coverage"][@"gapDetected"] boolValue]);
  assert([[value takePushEnvelopes:1][@"events"] count] == 0);

  NSDictionary *stale = [value
      handleRequest:request(@"events", @"observer-1", nil, evictedCursor)];
  assert([stale[@"ok"] isEqual:@NO]);
  assert([stale[@"error"][@"code"] isEqual:@"receipt-expired"]);
  assert([value scanEventsAfterCursor:evictedCursor
                 expectedSyntheticTag:42
                      requireOwnEvent:NO
                        timeoutMillis:10
                  observerInstanceRef:@"observer-1"] == nil);
}

static void test_late_prepare_cannot_create_or_replace_observer(void) {
  Fixture fixture = {
    .mainSucceeds = YES,
    .deferMain = YES,
  };
  NSMutableArray *deferredMain = [NSMutableArray array];
  NSMutableArray *retainedObservers = [NSMutableArray array];
  fixture.deferredMain = deferredMain;
  fixture.retainedObservers = retainedObservers;
  MetaObserverCommandBinder *value = binder(&fixture);
  NSDictionary *failed =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([failed[@"ok"] isEqual:@NO]);
  assert(fixture.factoryCalls == 0);
  assert(fixture.deferredMain.count == 1);

  fixture.deferMain = NO;
  NSDictionary *prepared =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  FixtureObserver *current = fixture.observer;
  BOOL (^late)(void) = fixture.deferredMain.firstObject;
  assert(!late());
  assert(fixture.factoryCalls == 1);
  assert(!current.stopped);
  assert([value activatePushForObserverInstance:@"observer-2"]);
}

static void test_started_candidate_is_stopped_after_failed_handoff(void) {
  Fixture fixture = {
    .mainSucceeds = YES,
    .failAfterMain = YES,
  };
  NSMutableArray *deferredMain = [NSMutableArray array];
  NSMutableArray *retainedObservers = [NSMutableArray array];
  fixture.deferredMain = deferredMain;
  fixture.retainedObservers = retainedObservers;
  MetaObserverCommandBinder *value = binder(&fixture);
  NSDictionary *failed =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([failed[@"ok"] isEqual:@NO]);
  FixtureObserver *candidate = retainedObservers.lastObject;
  assert(candidate != nil);
  assert(candidate.stopped);
  assert(![value activatePushForObserverInstance:@"observer-1"]);
  [candidate recordFocusTarget:target() syntheticTag:0];
  assert([[value takePushEnvelopes:1][@"events"] count] == 0);
}

static void test_expired_prepare_stops_before_main_start(void) {
  Fixture fixture = {
    .mainSucceeds = YES,
    .indexDelayMicros = 100000,
  };
  MetaObserverCommandBinder *value = binder(&fixture);
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSMutableDictionary *expiring =
      [request(@"prepare", nil, nil, nil) mutableCopy];
  expiring[@"deadlineAt"] = [formatter
      stringFromDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  NSDictionary *failed = [value handleRequest:expiring];
  assert([failed[@"ok"] isEqual:@NO]);
  assert(fixture.indexCalls == 1);
  assert(fixture.mainCalls == 0);
  assert(fixture.factoryCalls == 0);
}

static void test_foreground_receipt_change_stops_started_candidate(void) {
  Fixture fixture = {
    .mainSucceeds = YES,
    .invalidateValidatorCall = 5,
  };
  NSMutableArray *retainedObservers = [NSMutableArray array];
  fixture.retainedObservers = retainedObservers;
  MetaObserverCommandBinder *value = binder(&fixture);
  Fixture *binding = &fixture;
  [value setPreparedValidator:^BOOL(__unused MetaObserverPreparedIndex *prepared) {
    binding->validatorCalls += 1;
    return binding->validatorCalls != binding->invalidateValidatorCall;
  }];
  NSDictionary *failed =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([failed[@"ok"] isEqual:@NO]);
  assert(fixture.validatorCalls == 5);
  assert(fixture.factoryCalls == 1);
  FixtureObserver *candidate = retainedObservers.lastObject;
  assert(candidate != nil && candidate.stopped);
  assert(![value activatePushForObserverInstance:@"observer-1"]);
}

static void test_readiness_scan_is_exact_and_nondestructive(void) {
  Fixture fixture = {.mainSucceeds = YES};
  MetaObserverCommandBinder *value = binder(&fixture);
  NSDictionary *prepared =
      [value handleRequest:request(@"prepare", nil, nil, nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  assert([value activatePushForObserverInstance:@"observer-1"]);
  NSString *baseline = prepared[@"snapshot"][@"coverage"][@"cursor"];
  assert([[value currentCoverageForObserverInstance:@"observer-1"][@"state"]
      isEqual:@"ready"]);
  assert([value currentCoverageForObserverInstance:@"observer-foreign"] == nil);
  assert([value registerSyntheticTag:42
                         operationId:@"operation-readiness"
                       interactionId:nil
                              target:target()
                 observerInstanceRef:@"observer-1"]);
  assert(![value registerSyntheticTag:43
                          operationId:@"operation-readiness"
                        interactionId:nil
                               target:target()
                  observerInstanceRef:@"observer-foreign"]);

  [fixture.observer recordInputFromPid:getpid() syntheticTag:42];
  NSDictionary *own = [value
      scanEventsAfterCursor:baseline
       expectedSyntheticTag:42
            requireOwnEvent:YES
              timeoutMillis:10
        observerInstanceRef:@"observer-1"];
  assert([own[@"state"] isEqual:@"own-event-only"]);
  assert([own[@"syntheticTag"] isEqual:@"event-000000000000002a"]);
  NSDictionary *history = [value
      historySnapshotForObserverInstance:@"observer-1"
                            maximumEvents:1000];
  assert([history[@"observerInstanceRef"] isEqual:@"observer-1"]);
  assert([history[@"baselineCursor"] isEqual:baseline]);
  assert([history[@"baselineAvailable"] isEqual:@YES]);
  assert([history[@"coverage"][@"cursor"] isEqual:own[@"cursor"]]);
  assert([history[@"events"] count] == 1);
  NSDictionary *push = [value takePushEnvelopes:10];
  assert([push[@"events"] count] == 1);
  assert([push[@"events"][0][@"event"][@"cursor"] isEqual:own[@"cursor"]]);

  NSDictionary *quiet = [value
      scanEventsAfterCursor:own[@"cursor"]
       expectedSyntheticTag:42
            requireOwnEvent:NO
              timeoutMillis:1
        observerInstanceRef:@"observer-1"];
  assert([quiet[@"state"] isEqual:@"no-events"]);
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:42];
  NSDictionary *takeover = [value
      scanEventsAfterCursor:quiet[@"cursor"]
       expectedSyntheticTag:42
            requireOwnEvent:NO
              timeoutMillis:10
        observerInstanceRef:@"observer-1"];
  assert([takeover[@"state"] isEqual:@"user-takeover"]);
  assert(takeover[@"syntheticTag"] == nil);
  assert([value scanEventsAfterCursor:takeover[@"cursor"]
                 expectedSyntheticTag:42
                      requireOwnEvent:NO
                        timeoutMillis:10
                  observerInstanceRef:@"observer-foreign"] == nil);
  assert([value historySnapshotForObserverInstance:@"observer-foreign"
                                      maximumEvents:1000] == nil);
  assert([value historySnapshotForObserverInstance:@"observer-1"
                                      maximumEvents:1] == nil);
  [value unregisterSyntheticTag:42 observerInstanceRef:@"observer-1"];
}

int main(void) {
  @autoreleasepool {
    test_prepare_baseline_push_backfill_and_stop();
    test_restart_requires_exact_previous_instance();
    test_main_failure_and_gap_are_explicit();
    test_delivered_history_rolls_without_gap();
    test_late_prepare_cannot_create_or_replace_observer();
    test_started_candidate_is_stopped_after_failed_handoff();
    test_expired_prepare_stops_before_main_start();
    test_foreground_receipt_change_stops_started_candidate();
    test_readiness_scan_is_exact_and_nondestructive();
  }
  puts("observer command tests passed");
  return 0;
}
