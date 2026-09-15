#include "meta_observer.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime",
    @"loginSessionId" : @"login",
    @"nativeGeneration" : @"native",
  };
}

static NSDictionary *window_target(NSString *windowRef) {
  return @{
    @"kind" : @"window",
    @"ref" : @{
      @"runtimeEpoch" : @"runtime",
      @"loginSessionId" : @"login",
      @"nativeGeneration" : @"native",
      @"applicationRef" : @"application-1",
      @"windowRef" : windowRef,
    },
  };
}

static void mark_all_coverage_ready(MetaNativeObserver *observer) {
  [observer recordCoverageKind:@"input" available:YES reason:nil];
  [observer recordCoverageKind:@"focus" available:YES reason:nil];
  [observer recordCoverageKind:@"window-structure"
                     available:YES
                        reason:nil];
  [observer recordCurrentSessionReadiness:@"active-unlocked"
                                  evidence:@"fixture-session-probe"];
}

static void test_exact_synthetic_ownership_and_focus(void) {
  MetaNativeObserver *observer =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  assert([observer.coverage[@"state"] isEqual:@"unavailable"]);
  mark_all_coverage_ready(observer);
  assert([observer.coverage[@"state"] isEqual:@"ready"]);
  assert(([observer.coverage[@"coveredKinds"] isEqual:@[
    @"input", @"focus", @"window-structure", @"lifecycle"
  ]]));

  NSDictionary *target = window_target(@"window-1");
  assert([observer registerSyntheticTag:42
                             operationId:@"operation-1"
                           interactionId:@"interaction-1"
                                  target:target]);
  NSDictionary *owner =
      [observer syntheticOwnerForEventTag:@"event-000000000000002a"];
  assert([owner[@"operationId"] isEqual:@"operation-1"]);
  assert([owner[@"interactionId"] isEqual:@"interaction-1"]);
  assert([owner[@"target"] isEqual:target]);
  NSMutableDictionary *mutableTarget = [target mutableCopy];
  NSMutableDictionary *mutableReference = [mutableTarget[@"ref"] mutableCopy];
  mutableReference[@"windowRef"] = @"window-mutated";
  mutableTarget[@"ref"] = mutableReference;
  assert([observer registerSyntheticTag:43
                             operationId:@"operation-immutable"
                           interactionId:@"interaction-immutable"
                                  target:mutableTarget]);
  mutableReference[@"windowRef"] = @"window-after-registration";
  NSDictionary *immutableOwner =
      [observer syntheticOwnerForEventTag:@"event-000000000000002b"];
  assert([immutableOwner[@"target"][@"ref"][@"windowRef"]
      isEqual:@"window-mutated"]);

  [observer recordInputFromPid:getpid() syntheticTag:42];
  [observer recordInputFromPid:getpid() + 1 syntheticTag:42];
  [observer recordFocusTarget:target syntheticTag:42];
  [observer recordFocusTarget:target syntheticTag:99];
  [observer recordWindowStructureTarget:target];
  [observer recordLifecycle:@"login-session-change"
         nextLoginSessionId:@"login-next"];
  NSArray *events = [observer takeEvents];
  assert(events.count == 6);
  assert([events[0][@"source"] isEqual:@"synthetic"]);
  assert([events[0][@"target"] isEqual:target]);
  assert([events[1][@"source"] isEqual:@"unknown"]);
  assert(events[1][@"syntheticTag"] == nil);
  assert([events[2][@"source"] isEqual:@"synthetic"]);
  assert([events[3][@"source"] isEqual:@"unknown"]);
  assert([events[4][@"kind"] isEqual:@"window-structure"]);
  assert([events[5][@"lifecycle"] isEqual:@"login-session-change"]);
  assert([events[5][@"nextLoginSessionId"] isEqual:@"login-next"]);

  [observer unregisterSyntheticTag:42];
  assert([observer syntheticOwnerForEventTag:@"event-000000000000002a"] ==
         nil);
  [observer recordInputFromPid:getpid() syntheticTag:42];
  assert([[[observer takeEvents] firstObject][@"source"] isEqual:@"unknown"]);
}

static void test_subscription_gap_and_target_generation(void) {
  MetaNativeObserver *sessionUnknown =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  [sessionUnknown recordCoverageKind:@"input" available:YES reason:nil];
  [sessionUnknown recordCoverageKind:@"focus" available:YES reason:nil];
  [sessionUnknown recordCoverageKind:@"window-structure"
                           available:YES
                              reason:nil];
  [sessionUnknown recordCoverageKind:@"lifecycle"
                           available:YES
                              reason:nil];
  assert([sessionUnknown.coverage[@"state"] isEqual:@"unavailable"]);
  assert([sessionUnknown.currentSessionReadiness[@"state"]
      isEqual:@"unknown"]);

  MetaNativeObserver *observer =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(observer);
  [observer recordCoverageKind:@"focus"
                     available:NO
                        reason:@"AX subscribe failed"];
  assert([observer.coverage[@"state"] isEqual:@"unavailable"]);
  assert([observer.coverage[@"gapDetected"] boolValue]);
  assert([observer.coverage[@"reason"] isEqual:@"AX subscribe failed"]);

  MetaNativeObserver *locked =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(locked);
  [locked recordCurrentSessionReadiness:@"locked"
                                evidence:@"fixture-lock-event"];
  assert([locked.coverage[@"state"] isEqual:@"unavailable"]);
  assert([locked.currentSessionReadiness[@"state"] isEqual:@"locked"]);

  MetaNativeObserver *foreign =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(foreign);
  NSMutableDictionary *target = [window_target(@"window-foreign") mutableCopy];
  NSMutableDictionary *reference = [target[@"ref"] mutableCopy];
  reference[@"nativeGeneration"] = @"foreign";
  target[@"ref"] = reference;
  [foreign recordFocusTarget:target syntheticTag:0];
  assert([foreign.coverage[@"state"] isEqual:@"unavailable"]);
  assert([foreign.coverage[@"gapDetected"] boolValue]);
  assert([foreign takeEvents].count == 0);

  MetaNativeObserver *unresolved =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(unresolved);
  [unresolved recordUnresolvedFocus:@"AX resolver failed"];
  NSArray *events = [unresolved takeEvents];
  assert(events.count == 1);
  assert([events[0][@"kind"] isEqual:@"focus"]);
  assert([events[0][@"source"] isEqual:@"unknown"]);
  assert([unresolved.coverage[@"state"] isEqual:@"unavailable"]);

  MetaNativeObserver *stopped =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(stopped);
  [stopped stop];
  assert([stopped.coverage[@"coveredKinds"] count] == 0);
}

static void test_synthetic_identity_conflict_and_buffer_gap(void) {
  MetaNativeObserver *observer =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(observer);
  NSDictionary *target = window_target(@"window-1");
  assert([observer registerSyntheticTag:7
                             operationId:@"operation-1"
                           interactionId:nil
                                  target:target]);
  assert(![observer registerSyntheticTag:8
                              operationId:@"bad operation id"
                            interactionId:nil
                                   target:target]);
  assert(![observer registerSyntheticTag:7
                              operationId:@"operation-2"
                            interactionId:nil
                                   target:target]);
  assert([observer.coverage[@"state"] isEqual:@"unavailable"]);

  MetaNativeObserver *overflow =
      [[MetaNativeObserver alloc] initWithGeneration:generation()];
  mark_all_coverage_ready(overflow);
  for (size_t index = 0; index < 1001; index += 1) {
    [overflow recordWindowStructureTarget:target];
  }
  assert([overflow.coverage[@"state"] isEqual:@"unavailable"]);
  assert([overflow.coverage[@"gapDetected"] boolValue]);
  assert([overflow.coverage[@"droppedEvents"] unsignedIntegerValue] == 1);
  assert([overflow takeEvents].count == 1000);
}

int main(void) {
  @autoreleasepool {
    test_exact_synthetic_ownership_and_focus();
    test_subscription_gap_and_target_generation();
    test_synthetic_identity_conflict_and_buffer_gap();
  }
  puts("observer ingestion tests passed");
  return 0;
}
