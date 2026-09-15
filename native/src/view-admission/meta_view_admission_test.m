#include "meta_view_admission.h"

#include "../recovery-domain/meta_recovery_domain.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

@interface ViewAdmissionFixtureObserver : MetaNativeObserver
@property(nonatomic) BOOL forceIncoherentCoverage;
@end

@implementation ViewAdmissionFixtureObserver
- (BOOL)start {
  [self recordCoverageKind:@"input" available:YES reason:nil];
  [self recordCoverageKind:@"focus" available:YES reason:nil];
  [self recordCoverageKind:@"window-structure" available:YES reason:nil];
  [self recordCoverageKind:@"lifecycle" available:YES reason:nil];
  return YES;
}
- (NSDictionary *)coverage {
  NSMutableDictionary *value = [[super coverage] mutableCopy];
  if (self.forceIncoherentCoverage) value[@"cursor"] = @"cursor-incoherent";
  return value;
}
@end

typedef struct {
  __unsafe_unretained ViewAdmissionFixtureObserver *observer;
  __unsafe_unretained NSDate *now;
  size_t instanceIndex;
} Fixture;

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *target(NSString *windowRef) {
  NSMutableDictionary *reference = [generation() mutableCopy];
  reference[@"applicationRef"] = @"application-1";
  reference[@"windowRef"] = windowRef;
  return @{@"kind" : @"window", @"ref" : reference};
}

static NSDictionary *broad_target(NSString *kind, NSString *identity,
                                  NSNumber *layoutRevision) {
  NSMutableDictionary *reference = [generation() mutableCopy];
  reference[[kind isEqual:@"display"] ? @"displayRef" : @"layoutRef"] =
      identity;
  reference[@"displayLayoutRevision"] = layoutRevision;
  return @{@"kind" : kind, @"ref" : reference};
}

static NSDictionary *readiness(void) {
  return @{
    @"state" : @"active-console",
    @"lockState" : @"unknown",
    @"secureInput" : @"off",
    @"evidence" : @"Тестовая готовность",
    @"observedAt" : @"2026-09-15T10:00:00.000Z",
  };
}

static NSDictionary *observer_request(NSString *command, NSString *previous) {
  NSMutableDictionary *request = [generation() mutableCopy];
  [request addEntriesFromDictionary:@{
    @"kind" : @"observer",
    @"protocolVersion" : @"1",
    @"requestId" : [NSString stringWithFormat:@"observer-%@-%@", command,
                                               NSUUID.UUID.UUIDString],
    @"command" : command,
    @"deadlineAt" : @"2099-09-15T10:00:00.000Z",
  }];
  if (previous != nil) request[@"previousObserverInstanceRef"] = previous;
  return request;
}

static MetaObserverCommandBinder *observer_binder(Fixture *fixture) {
  return [[MetaObserverCommandBinder alloc]
      initWithGeneration:generation()
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
                      NSDictionary *identity,
                      __unused MetaObserverTargetIndex *index) {
                    ViewAdmissionFixtureObserver *observer =
                        [[ViewAdmissionFixtureObserver alloc]
                            initWithGeneration:identity];
                    fixture->observer = observer;
                    return observer;
                  }
        readinessProvider:^NSDictionary * {
          return readiness();
        }
       instanceIdProvider:^NSString * {
         fixture->instanceIndex += 1;
         return [NSString stringWithFormat:@"observer-%zu",
                                           fixture->instanceIndex];
       }];
}

static NSDictionary *prepare_observer(MetaObserverCommandBinder *observer) {
  NSDictionary *prepared =
      [observer handleRequest:observer_request(@"prepare", nil)];
  assert([prepared[@"ok"] isEqual:@YES]);
  assert([observer activatePushForObserverInstance:
                       prepared[@"snapshot"][@"observerInstanceRef"]]);
  return prepared[@"snapshot"];
}

static NSDictionary *operation(NSString *operationId, NSString *windowRef,
                               NSDate *deadline) {
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"kind" : @"native",
    @"operationId" : operationId,
    @"clientRequestId" : [@"client-" stringByAppendingString:operationId],
    @"clientSessionId" : @"client-session-1",
    @"principalId" : @"principal-1",
    @"inventoryId" : @"inventory-1",
    @"inventoryRevision" : @1,
    @"deadlineAt" : deadline.description,
    @"target" : target(windowRef),
    @"fence" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"counter" : @1,
    },
  }];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  value[@"deadlineAt"] = [formatter stringFromDate:deadline];
  return value;
}

static NSDictionary *operation_with_target(NSString *operationId,
                                            NSDictionary *targetValue,
                                            NSDate *deadline) {
  NSMutableDictionary *value =
      [operation(operationId, @"window-placeholder", deadline) mutableCopy];
  value[@"target"] = targetValue;
  return value;
}

static NSDictionary *proof(NSDictionary *operation,
                           NSDictionary *coverage,
                           NSString *viewNonce,
                           NSDate *expires) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return @{
    @"version" : @"1",
    @"contextSha256" : meta_recovery_domain_sha256(operation),
    @"viewNonce" : viewNonce,
    @"observerInstanceRef" : @"observer-1",
    @"coverageStartCursor" : coverage[@"coverageStartCursor"],
    @"baselineCursor" : coverage[@"cursor"],
    @"baselineNextSequence" : coverage[@"nextSequence"],
    @"observedCursor" : coverage[@"cursor"],
    @"observedNextSequence" : coverage[@"nextSequence"],
    @"admissionCursor" : coverage[@"cursor"],
    @"admissionNextSequence" : coverage[@"nextSequence"],
    @"expiresAt" : [formatter stringFromDate:expires],
  };
}

static NSDictionary *request(NSDictionary *operation,
                             NSDictionary *proof) {
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"kind" : @"request",
    @"protocolVersion" : @"1",
    @"requestId" : [@"request-"
        stringByAppendingString:operation[@"operationId"]],
    @"deadlineAt" : operation[@"deadlineAt"],
    @"intent" : @"mutation",
    @"method" : @"input.execute",
    @"operation" : operation,
    @"viewAdmission" : proof,
    @"payload" : @{
      @"actionDeadlineAt" : operation[@"deadlineAt"],
      @"action" : @{
        @"kind" : @"click",
        @"button" : @"left",
        @"point" : @{@"x" : @10, @"y" : @10},
        @"count" : @1,
        @"modifiers" : @{@"names" : @[], @"flags" : @0},
      },
    },
  }];
  return value;
}

static MetaViewAdmissionController *controller(
    Fixture *fixture, MetaObserverCommandBinder *observer,
    NSUInteger ttl, NSUInteger maximum) {
  return [[MetaViewAdmissionController alloc]
      initWithObserver:observer
                   now:^NSDate * { return fixture->now; }
    tombstoneTtlMillis:ttl
        maximumRecords:maximum];
}

static void test_zero_event_admission_head_recheck_and_replay_tombstone(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *snapshot = prepare_observer(observer);
  NSDictionary *coverage = snapshot[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  NSDictionary *operationValue = operation(@"operation-1", @"window-1",
                                            deadline);
  NSDictionary *proofValue = proof(
      operationValue, coverage, @"view-1",
      [fixture.now dateByAddingTimeInterval:30]);
  NSDictionary *requestValue = request(operationValue, proofValue);
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 4);
  NSString *error = nil;
  NSDictionary *head = [value admitRequest:requestValue
                                     proof:proofValue
                                     error:&error];
  assert(error == nil);
  assert(([head isEqual:@{
    @"observerInstanceRef" : @"observer-1",
    @"coverageStartCursor" : coverage[@"coverageStartCursor"],
    @"cursor" : coverage[@"cursor"],
    @"nextSequence" : coverage[@"nextSequence"],
  }]));
  assert([value recheckOperationId:@"operation-1"]);
  [value finishOperationId:@"operation-1"];
  assert(![value recheckOperationId:@"operation-1"]);
  assert([value admitRequest:requestValue proof:proofValue error:&error] == nil);
  assert([error containsString:@"использованы"]);

  NSDictionary *nextOperation = operation(@"operation-2", @"window-1",
                                           deadline);
  NSDictionary *sameView = proof(
      nextOperation, coverage, @"view-1",
      [fixture.now dateByAddingTimeInterval:30]);
  assert([value admitRequest:request(nextOperation, sameView)
                        proof:sameView error:&error] == nil);
}

static void test_any_event_since_baseline_rejects_without_stealing_push(void) {
  for (NSNumber *ownValue in @[@NO, @YES]) {
    BOOL own = ownValue.boolValue;
    Fixture fixture = {.now =
        [NSDate dateWithTimeIntervalSince1970:1789466400]};
    MetaObserverCommandBinder *observer = observer_binder(&fixture);
    NSDictionary *snapshot = prepare_observer(observer);
    NSDictionary *coverage = snapshot[@"coverage"];
    NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
    NSDictionary *operationValue = operation(
        own ? @"operation-own" : @"operation-foreign", @"window-1",
        deadline);
    NSDictionary *proofValue = proof(
        operationValue, coverage, own ? @"view-own" : @"view-foreign",
        [fixture.now dateByAddingTimeInterval:30]);
    if (own) {
      assert([observer registerSyntheticTag:42
                               operationId:@"operation-prior"
                             interactionId:nil
                                    target:target(@"window-1")
                       observerInstanceRef:@"observer-1"]);
      [fixture.observer recordInputFromPid:getpid() syntheticTag:42];
    } else {
      [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:0];
    }
    MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 4);
    NSString *error = nil;
    assert([value admitRequest:request(operationValue, proofValue)
                          proof:proofValue error:&error] == nil);
    assert([error containsString:@"событие"]);
    NSDictionary *push = [observer takePushEnvelopes:10];
    assert([push[@"events"] count] == 1);
  }
}

static void test_recheck_fails_after_event_or_gap(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *coverage = prepare_observer(observer)[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  NSDictionary *operationValue = operation(@"operation-recheck", @"window-1",
                                            deadline);
  NSDictionary *proofValue = proof(
      operationValue, coverage, @"view-recheck",
      [fixture.now dateByAddingTimeInterval:30]);
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 4);
  assert([value admitRequest:request(operationValue, proofValue)
                        proof:proofValue error:NULL] != nil);
  [fixture.observer recordInputFromPid:getpid() + 1 syntheticTag:0];
  assert(![value recheckOperationId:@"operation-recheck"]);
  [fixture.observer markUnavailable:@"Тестовый gap"];
  assert(![value recheckOperationId:@"operation-recheck"]);
}

static void test_ax_press_uses_same_zero_event_gate(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *coverage = prepare_observer(observer)[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  NSDictionary *operationValue = operation(@"operation-ax", @"window-1",
                                            deadline);
  NSDictionary *proofValue = proof(
      operationValue, coverage, @"view-ax",
      [fixture.now dateByAddingTimeInterval:30]);
  NSMutableDictionary *ax = [request(operationValue, proofValue) mutableCopy];
  ax[@"method"] = @"ax.press";
  NSMutableDictionary *element = [generation() mutableCopy];
  [element addEntriesFromDictionary:@{
    @"applicationRef" : @"application-1",
    @"elementRef" : @"element-1",
    @"snapshotId" : @"snapshot-1",
  }];
  ax[@"payload"] = @{@"element" : element};
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 4);
  NSDictionary *head = [value admitRequest:ax proof:proofValue error:NULL];
  assert(head != nil && [value recheckOperationId:@"operation-ax"]);
}

static void test_pointer_display_and_layout_use_same_zero_event_gate(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *coverage = prepare_observer(observer)[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 8);
  for (NSDictionary *targetValue in @[
    broad_target(@"display", @"display-1", @3),
    broad_target(@"desktop-layout", @"layout-3", @3),
  ]) {
    NSString *kind = targetValue[@"kind"];
    NSDictionary *operationValue = operation_with_target(
        [@"operation-" stringByAppendingString:kind], targetValue, deadline);
    NSDictionary *proofValue = proof(
        operationValue, coverage,
        [@"view-" stringByAppendingString:kind],
        [fixture.now dateByAddingTimeInterval:30]);
    NSDictionary *head = [value
        admitRequest:request(operationValue, proofValue)
               proof:proofValue
               error:NULL];
    assert(head != nil);
    assert([value recheckOperationId:operationValue[@"operationId"]]);
    [value finishOperationId:operationValue[@"operationId"]];
  }
}

static void test_broad_target_rejects_ax_keyboard_and_context_mismatch(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *coverage = prepare_observer(observer)[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 8);
  NSDictionary *displayOperation = operation_with_target(
      @"operation-display-reject",
      broad_target(@"display", @"display-1", @3), deadline);
  NSDictionary *displayProof = proof(
      displayOperation, coverage, @"view-display-reject",
      [fixture.now dateByAddingTimeInterval:30]);
  NSMutableDictionary *ax = [request(displayOperation, displayProof) mutableCopy];
  ax[@"method"] = @"ax.press";
  ax[@"payload"] = @{};
  assert([value admitRequest:ax proof:displayProof error:NULL] == nil);

  NSMutableDictionary *keyboard =
      [request(displayOperation, displayProof) mutableCopy];
  keyboard[@"payload"] = @{
    @"actionDeadlineAt" : displayOperation[@"deadlineAt"],
    @"action" : @{
      @"kind" : @"key",
      @"stroke" : @{@"keyCode" : @12, @"flags" : @0},
    },
  };
  assert([value admitRequest:keyboard proof:displayProof error:NULL] == nil);

  NSDictionary *layoutOperation = operation_with_target(
      @"operation-layout-mismatch",
      broad_target(@"desktop-layout", @"layout-3", @3), deadline);
  NSDictionary *layoutProof = proof(
      layoutOperation, coverage, @"view-layout-mismatch",
      [fixture.now dateByAddingTimeInterval:30]);
  NSMutableDictionary *changedOperation = [layoutOperation mutableCopy];
  changedOperation[@"target"] =
      broad_target(@"desktop-layout", @"layout-3", @4);
  assert([value admitRequest:request(changedOperation, layoutProof)
                        proof:layoutProof error:NULL] == nil);
}

static void test_context_cursor_expiry_and_capacity_fail_closed(void) {
  Fixture fixture = {.now =
      [NSDate dateWithTimeIntervalSince1970:1789466400]};
  MetaObserverCommandBinder *observer = observer_binder(&fixture);
  NSDictionary *coverage = prepare_observer(observer)[@"coverage"];
  NSDate *deadline = [fixture.now dateByAddingTimeInterval:60];
  MetaViewAdmissionController *value = controller(&fixture, observer, 60000, 1);
  assert([value admitRequest:(NSDictionary *)(id)@"malformed"
                        proof:(NSDictionary *)(id)NSNull.null
                        error:NULL] == nil);
  NSMutableDictionary *malformedOperation = [generation() mutableCopy];
  malformedOperation[@"kind"] = @"request";
  malformedOperation[@"requestId"] = @"request-malformed-operation";
  malformedOperation[@"method"] = @"input.execute";
  malformedOperation[@"operation"] = NSNull.null;
  assert([value admitRequest:malformedOperation proof:@{} error:NULL] == nil);
  NSMutableDictionary *malformedTarget = [request(
      operation(@"operation-malformed-target", @"window-1", deadline),
      @{}) mutableCopy];
  NSMutableDictionary *nestedOperation =
      [malformedTarget[@"operation"] mutableCopy];
  nestedOperation[@"target"] = @"not-a-target";
  malformedTarget[@"operation"] = nestedOperation;
  assert([value admitRequest:malformedTarget proof:@{} error:NULL] == nil);
  NSDictionary *operationValue = operation(@"operation-first", @"window-1",
                                            deadline);
  NSMutableDictionary *badHash = [proof(
      operationValue, coverage, @"view-hash",
      [fixture.now dateByAddingTimeInterval:30]) mutableCopy];
  badHash[@"contextSha256"] =
      @"0000000000000000000000000000000000000000000000000000000000000000";
  assert([value admitRequest:request(operationValue, badHash)
                        proof:badHash error:NULL] == nil);

  NSMutableDictionary *badCursor = [proof(
      operationValue, coverage, @"view-cursor",
      [fixture.now dateByAddingTimeInterval:30]) mutableCopy];
  badCursor[@"admissionCursor"] = @"cursor-missing";
  assert([value admitRequest:request(operationValue, badCursor)
                        proof:badCursor error:NULL] == nil);

  NSDictionary *valid = proof(
      operationValue, coverage, @"view-first",
      [fixture.now dateByAddingTimeInterval:30]);
  assert([value admitRequest:request(operationValue, valid)
                        proof:valid error:NULL] != nil);
  [value finishOperationId:@"operation-first"];
  NSDictionary *secondOperation = operation(@"operation-second", @"window-2",
                                             deadline);
  NSDictionary *secondProof = proof(
      secondOperation, coverage, @"view-second",
      [fixture.now dateByAddingTimeInterval:30]);
  assert([value admitRequest:request(secondOperation, secondProof)
                        proof:secondProof error:NULL] == nil);

  MetaViewAdmissionController *expiry = controller(&fixture, observer, 60000, 4);
  NSDictionary *expired = proof(
      operationValue, coverage, @"view-expired",
      [fixture.now dateByAddingTimeInterval:-1]);
  assert([expiry admitRequest:request(operationValue, expired)
                         proof:expired error:NULL] == nil);
  NSDictionary *pastDeadline = proof(
      operationValue, coverage, @"view-after-deadline",
      [deadline dateByAddingTimeInterval:1]);
  assert([expiry admitRequest:request(operationValue, pastDeadline)
                         proof:pastDeadline error:NULL] == nil);

  NSMutableDictionary *wrongStart = [proof(
      operationValue, coverage, @"view-start",
      [fixture.now dateByAddingTimeInterval:30]) mutableCopy];
  wrongStart[@"coverageStartCursor"] = @"observer-foreign-start";
  assert([expiry admitRequest:request(operationValue, wrongStart)
                         proof:wrongStart error:NULL] == nil);

  fixture.observer.forceIncoherentCoverage = YES;
  NSDictionary *incoherent = proof(
      operationValue, coverage, @"view-incoherent",
      [fixture.now dateByAddingTimeInterval:30]);
  assert([expiry admitRequest:request(operationValue, incoherent)
                         proof:incoherent error:NULL] == nil);
  fixture.observer.forceIncoherentCoverage = NO;

  NSDictionary *restarted =
      [observer handleRequest:observer_request(@"prepare", @"observer-1")];
  assert([restarted[@"ok"] isEqual:@YES]);
  NSDictionary *oldInstance = proof(
      operationValue, coverage, @"view-old-instance",
      [fixture.now dateByAddingTimeInterval:30]);
  assert([expiry admitRequest:request(operationValue, oldInstance)
                         proof:oldInstance error:NULL] == nil);
}

int main(void) {
  @autoreleasepool {
    test_zero_event_admission_head_recheck_and_replay_tombstone();
    test_any_event_since_baseline_rejects_without_stealing_push();
    test_recheck_fails_after_event_or_gap();
    test_ax_press_uses_same_zero_event_gate();
    test_pointer_display_and_layout_use_same_zero_event_gate();
    test_broad_target_rejects_ax_keyboard_and_context_mismatch();
    test_context_cursor_expiry_and_capacity_fail_closed();
  }
  puts("view admission tests passed");
}
