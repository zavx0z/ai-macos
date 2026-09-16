#include "meta_observer.h"

#import <AppKit/AppKit.h>

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

@interface MetaNativeObserver (CallbackTests)
- (void)handleAXElement:(AXUIElementRef)element
                    pid:(pid_t)pid
           notification:(NSString *)notification
          sourceObserver:(nullable AXObserverRef)sourceObserver;
- (void)handleActivatedApplication:(NSRunningApplication *)application;
- (void)handleTerminatedApplication:(NSRunningApplication *)application;
- (BOOL)subscribeApplication:(NSRunningApplication *)application;
- (BOOL)subscribeWindow:(AXUIElementRef)window
                observer:(AXObserverRef)observer
                     pid:(pid_t)pid;
- (uint64_t)processBirthForPid:(pid_t)pid;
@end

@interface MetaObserverCallbackFixture : MetaNativeObserver
@property(nonatomic) BOOL applicationSubscriptionReady;
@property(nonatomic) BOOL windowSubscriptionReady;
@property(nonatomic) uint64_t processBirth;
@property(nonatomic) NSMutableArray<NSString *> *trace;
@end

@implementation MetaObserverCallbackFixture
- (BOOL)subscribeApplication:(__unused NSRunningApplication *)application {
  [self.trace addObject:@"subscribe-application"];
  return self.applicationSubscriptionReady;
}
- (BOOL)subscribeWindow:(__unused AXUIElementRef)window
                observer:(__unused AXObserverRef)observer
                     pid:(__unused pid_t)pid {
  [self.trace addObject:@"subscribe-window"];
  return self.windowSubscriptionReady;
}
- (uint64_t)processBirthForPid:(__unused pid_t)pid {
  return self.processBirth;
}
@end

@interface MetaRunningApplicationFixture : NSObject
@property(nonatomic) pid_t processIdentifier;
@end

@implementation MetaRunningApplicationFixture
@end

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
  [observer recordCoverageKind:@"lifecycle" available:YES reason:nil];
  [observer recordCurrentSessionReadiness:@{
    @"state" : @"active-console",
    @"lockState" : @"unknown",
    @"userId" : @501,
    @"onConsole" : @YES,
    @"loginDone" : @YES,
    @"auditSessionId" : @42,
    @"evidence" : @"fixture-session-probe",
  }];
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
  [sessionUnknown recordCoverageKind:@"lifecycle" available:YES reason:nil];
  assert([sessionUnknown.coverage[@"state"] isEqual:@"ready"]);
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
  [locked recordCurrentSessionReadiness:@{
    @"state" : @"unknown",
    @"lockState" : @"locked",
    @"evidence" : @"fixture-lock-event",
  }];
  assert([locked.coverage[@"state"] isEqual:@"ready"]);
  assert([locked.currentSessionReadiness[@"lockState"] isEqual:@"locked"]);

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

static void test_subscription_budget_is_bounded(void) {
  MetaObserverSubscriptionBudget budget = {0};
  assert(meta_observer_subscription_budget_init(&budget, 100, 10));
  assert(budget.deadline_millis ==
         100 + META_OBSERVER_SUBSCRIPTION_BUDGET_MILLIS);
  assert(budget.remaining_windows == META_OBSERVER_MAX_WINDOWS - 10);
  assert(meta_observer_subscription_timeout_seconds(budget, 100) == 0.5);
  assert(meta_observer_subscription_budget_admit_windows(
      &budget, 101, META_OBSERVER_MAX_WINDOWS_PER_APPLICATION));
  assert(!meta_observer_subscription_budget_admit_windows(
      &budget, 102, META_OBSERVER_MAX_WINDOWS_PER_APPLICATION + 1));
  assert(!meta_observer_subscription_budget_admit_windows(
      &budget, budget.deadline_millis, 1));
  assert(meta_observer_subscription_timeout_seconds(
             budget, budget.deadline_millis) == 0);
  assert(!meta_observer_subscription_budget_init(
      &budget, 100, META_OBSERVER_MAX_WINDOWS + 1));
}

static void test_activation_is_event_without_idle_subscription(void) {
  MetaRunningApplicationFixture *applicationFixture =
      [[MetaRunningApplicationFixture alloc] init];
  applicationFixture.processIdentifier = getpid();
  NSRunningApplication *application =
      (NSRunningApplication *)(id)applicationFixture;
  MetaObserverCallbackFixture *observer =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  observer.trace = [NSMutableArray array];
  observer.applicationSubscriptionReady = YES;
  observer.processBirth = 42;
  mark_all_coverage_ready(observer);
  [observer setValue:[@{@(application.processIdentifier) : @42} mutableCopy]
              forKey:@"axProcessBirths"];
  [observer setValue:[@{
              @(application.processIdentifier) : [[NSObject alloc] init]
            } mutableCopy]
              forKey:@"axObservers"];
  NSMutableArray<NSString *> *trace = observer.trace;
  [observer setFocusResolver:^NSDictionary *(
                __unused pid_t pid, __unused AXUIElementRef element,
                __unused NSString *notification) {
    [trace addObject:@"resolve"];
    return nil;
  }];
  [observer handleActivatedApplication:application];
  // Смена focus не выполняет подписки или AX resolve в простое.
  assert(observer.trace.count == 0);
  NSArray *events = [observer takeEvents];
  assert(events.count == 1);
  assert([events[0][@"kind"] isEqual:@"focus"]);
  assert([events[0][@"source"] isEqual:@"unknown"]);
  assert(events[0][@"target"] == nil);
  assert([observer.coverage[@"state"] isEqual:@"ready"]);
  assert(![observer.coverage[@"gapDetected"] boolValue]);

  MetaObserverCallbackFixture *failed =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  failed.trace = [NSMutableArray array];
  mark_all_coverage_ready(failed);
  [failed handleActivatedApplication:application];
  assert(failed.trace.count == 0);
  assert([failed.coverage[@"state"] isEqual:@"ready"]);
  assert(![failed.coverage[@"gapDetected"] boolValue]);
  assert([failed takeEvents].count == 1);
}

static void test_new_window_subscribes_before_mapping(void) {
  const pid_t pid = getpid();
  AXUIElementRef element = AXUIElementCreateSystemWide();
  assert(element != NULL);
  MetaObserverCallbackFixture *observer =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  observer.trace = [NSMutableArray array];
  observer.windowSubscriptionReady = YES;
  observer.processBirth = 42;
  mark_all_coverage_ready(observer);
  [observer setValue:[@{@(pid) : [[NSObject alloc] init]} mutableCopy]
              forKey:@"axObservers"];
  [observer setValue:[@{@(pid) : @42} mutableCopy]
              forKey:@"axProcessBirths"];
  NSMutableArray<NSString *> *trace = observer.trace;
  [observer setFocusResolver:^NSDictionary *(
                __unused pid_t callbackPid, __unused AXUIElementRef callbackElement,
                __unused NSString *notification) {
    [trace addObject:@"resolve"];
    return nil;
  }];
  [observer handleAXElement:element
                        pid:pid
               notification:(__bridge NSString *)kAXWindowCreatedNotification
              sourceObserver:NULL];
  assert(([observer.trace isEqual:@[@"subscribe-window", @"resolve"]]));
  NSArray *events = [observer takeEvents];
  assert(events.count == 1);
  assert([events[0][@"kind"] isEqual:@"window-structure"]);
  assert([events[0][@"source"] isEqual:@"unknown"]);
  assert(events[0][@"target"] == nil);
  assert([observer.coverage[@"state"] isEqual:@"ready"]);
  assert(![observer.coverage[@"gapDetected"] boolValue]);

  MetaObserverCallbackFixture *failed =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  failed.trace = [NSMutableArray array];
  failed.processBirth = 42;
  mark_all_coverage_ready(failed);
  [failed setValue:[@{@(pid) : [[NSObject alloc] init]} mutableCopy]
            forKey:@"axObservers"];
  [failed setValue:[@{@(pid) : @42} mutableCopy]
            forKey:@"axProcessBirths"];
  NSMutableArray<NSString *> *failedTrace = failed.trace;
  [failed setFocusResolver:^NSDictionary *(
              __unused pid_t callbackPid, __unused AXUIElementRef callbackElement,
              __unused NSString *notification) {
    [failedTrace addObject:@"resolve"];
    return nil;
  }];
  [failed handleAXElement:element
                      pid:pid
             notification:(__bridge NSString *)kAXWindowCreatedNotification
            sourceObserver:NULL];
  assert([failed.trace isEqual:@[@"subscribe-window"]]);
  assert([failed takeEvents].count == 0);
  assert([failed.coverage[@"state"] isEqual:@"unavailable"]);
  assert([failed.coverage[@"gapDetected"] boolValue]);

  MetaObserverCallbackFixture *reused =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  reused.trace = [NSMutableArray array];
  reused.processBirth = 43;
  reused.windowSubscriptionReady = YES;
  mark_all_coverage_ready(reused);
  [reused setValue:[@{@(pid) : [[NSObject alloc] init]} mutableCopy]
            forKey:@"axObservers"];
  [reused setValue:[@{@(pid) : @42} mutableCopy]
            forKey:@"axProcessBirths"];
  NSMutableArray<NSString *> *reusedTrace = reused.trace;
  [reused setFocusResolver:^NSDictionary *(
              __unused pid_t callbackPid, __unused AXUIElementRef callbackElement,
              __unused NSString *notification) {
    [reusedTrace addObject:@"resolve"];
    return nil;
  }];
  [reused handleAXElement:element
                      pid:pid
             notification:(__bridge NSString *)kAXWindowCreatedNotification
            sourceObserver:NULL];
  assert(reused.trace.count == 0);
  assert([reused takeEvents].count == 0);
  assert([reused.coverage[@"state"] isEqual:@"unavailable"]);
  assert([reused.coverage[@"gapDetected"] boolValue]);

  MetaObserverCallbackFixture *foreignSource =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  foreignSource.trace = [NSMutableArray array];
  foreignSource.processBirth = 42;
  foreignSource.windowSubscriptionReady = YES;
  mark_all_coverage_ready(foreignSource);
  NSObject *currentSource = [[NSObject alloc] init];
  NSObject *staleSource = [[NSObject alloc] init];
  [foreignSource setValue:[@{@(pid) : currentSource} mutableCopy]
                   forKey:@"axObservers"];
  [foreignSource setValue:[@{@(pid) : @42} mutableCopy]
                   forKey:@"axProcessBirths"];
  [foreignSource handleAXElement:element
                             pid:pid
                    notification:(__bridge NSString *)kAXWindowCreatedNotification
                   sourceObserver:(__bridge AXObserverRef)staleSource];
  assert(foreignSource.trace.count == 0);
  assert([foreignSource takeEvents].count == 0);
  assert([foreignSource.coverage[@"state"] isEqual:@"unavailable"]);
  assert([foreignSource.coverage[@"gapDetected"] boolValue]);

  MetaObserverCallbackFixture *unknownNotification =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  unknownNotification.trace = [NSMutableArray array];
  unknownNotification.processBirth = 42;
  mark_all_coverage_ready(unknownNotification);
  [unknownNotification setValue:[@{@(pid) : currentSource} mutableCopy]
                         forKey:@"axObservers"];
  [unknownNotification setValue:[@{@(pid) : @42} mutableCopy]
                         forKey:@"axProcessBirths"];
  [unknownNotification handleAXElement:element
                                   pid:pid
                          notification:@"fixture-unsubscribed-notification"
                         sourceObserver:NULL];
  assert([unknownNotification takeEvents].count == 0);
  assert([unknownNotification.coverage[@"state"] isEqual:@"unavailable"]);
  assert([unknownNotification.coverage[@"gapDetected"] boolValue]);
  CFRelease(element);
}

static void test_termination_keeps_new_pid_incarnation(void) {
  const pid_t pid = getpid();
  MetaRunningApplicationFixture *applicationFixture =
      [[MetaRunningApplicationFixture alloc] init];
  applicationFixture.processIdentifier = pid;
  NSRunningApplication *application =
      (NSRunningApplication *)(id)applicationFixture;

  MetaObserverCallbackFixture *owned =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  owned.processBirth = 42;
  mark_all_coverage_ready(owned);
  [owned setValue:[@{@(pid) : application} mutableCopy]
            forKey:@"runningApplications"];
  [owned setValue:[@{@(pid) : @42} mutableCopy]
            forKey:@"axProcessBirths"];
  assert([[owned valueForKey:@"runningApplications"] objectForKey:@(pid)] ==
         application);
  assert([[[owned valueForKey:@"axProcessBirths"] objectForKey:@(pid)]
      unsignedLongLongValue] == 42);
  [owned handleTerminatedApplication:application];
  assert([owned.coverage[@"state"] isEqual:@"ready"]);
  NSArray *ownedEvents = [owned takeEvents];
  assert(ownedEvents.count == 1);
  assert([ownedEvents[0][@"kind"] isEqual:@"window-structure"]);
  assert(ownedEvents[0][@"target"] == nil);
  assert([[owned valueForKey:@"axProcessBirths"] count] == 0);

  MetaObserverCallbackFixture *reused =
      [[MetaObserverCallbackFixture alloc] initWithGeneration:generation()];
  reused.processBirth = 43;
  mark_all_coverage_ready(reused);
  NSObject *newIncarnation = [[NSObject alloc] init];
  [reused setValue:[@{@(pid) : newIncarnation} mutableCopy]
             forKey:@"runningApplications"];
  [reused setValue:[@{@(pid) : @43} mutableCopy]
             forKey:@"axProcessBirths"];
  [reused handleTerminatedApplication:application];
  assert([reused takeEvents].count == 0);
  assert([reused.coverage[@"state"] isEqual:@"ready"]);
  assert([[reused valueForKey:@"runningApplications"] objectForKey:@(pid)] ==
         newIncarnation);

  reused.processBirth = 44;
  [reused handleTerminatedApplication:application];
  assert([reused.coverage[@"state"] isEqual:@"unavailable"]);
  assert([reused.coverage[@"gapDetected"] boolValue]);
}

int main(void) {
  @autoreleasepool {
    test_exact_synthetic_ownership_and_focus();
    test_subscription_gap_and_target_generation();
    test_synthetic_identity_conflict_and_buffer_gap();
    test_subscription_budget_is_bounded();
    test_activation_is_event_without_idle_subscription();
    test_new_window_subscribes_before_mapping();
    test_termination_keeps_new_pid_incarnation();
  }
  puts("observer ingestion tests passed");
  return 0;
}
