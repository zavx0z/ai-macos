#include "meta_input_job.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  @autoreleasepool {
    NSDictionary *generation = @{@"runtimeEpoch": @"runtime", @"loginSessionId": @"login", @"nativeGeneration": @"native"};
    NSMutableDictionary *operation = [generation mutableCopy];
    operation[@"operationId"] = @"operation";
    MetaInputJob *job = [[MetaInputJob alloc] initWithRequest:@{@"requestId": @"request", @"operation": operation}
        emitter:^BOOL(NSDictionary *frame) { (void)frame; return YES; }];
    MetaExecutorStatus status = {.has_accepted_fence = true, .has_high_water_fence = true,
      .execution = META_EXECUTOR_FAILED, .dispatch = META_DISPATCH_NONE, .cleanup = META_CLEANUP_COMPLETE,
      .observer_state = META_OBSERVER_READY, .user_interference = META_INTERFERENCE_NONE_OBSERVED, .restoration_allowed = true};
    snprintf(status.accepted_fence.runtime_epoch, META_NATIVE_REF_CAPACITY, "runtime");
    snprintf(status.accepted_fence.login_session_id, META_NATIVE_REF_CAPACITY, "login");
    snprintf(status.accepted_fence.native_generation, META_NATIVE_REF_CAPACITY, "native");
    status.accepted_fence.counter = 1;
    status.high_water_fence = status.accepted_fence;
    NSMutableArray *reports = [NSMutableArray array];
    [job publishStatus:status];
    [reports addObject:[job statusForRequest:@"request"]];
    NSString *now = @"2026-09-15T00:00:00.000Z";
    NSMutableDictionary *ready = [generation mutableCopy];
    [ready addEntriesFromDictionary:@{@"state": @"ready", @"coverageStartCursor": @"start", @"cursor": @"current", @"nextSequence": @2,
      @"startedAt": now, @"coveredFrom": now, @"coveredThrough": now, @"heartbeatAt": now,
      @"coveredKinds": @[@"input", @"focus", @"window-structure", @"lifecycle"], @"droppedEvents": @0, @"gapDetected": @NO}];
    __block NSDictionary *provided = ready;
    [job setObserverCoverageProvider:^NSDictionary * { return provided; }];
    [job publishStatus:status];
    [reports addObject:[job statusForRequest:@"request"]];
    NSMutableDictionary *foreign = [ready mutableCopy];
    foreign[@"nativeGeneration"] = @"foreign";
    provided = foreign;
    [job publishStatus:status];
    [reports addObject:[job statusForRequest:@"request"]];
    NSMutableDictionary *revoked = [ready mutableCopy];
    revoked[@"state"] = @"revoked";
    revoked[@"reason"] = @"Fixture coverage revoked";
    revoked[@"gapDetected"] = @YES;
    provided = revoked;
    [job publishStatus:status];
    [reports addObject:[job statusForRequest:@"request"]];
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:reports options:0 error:NULL];
    assert(encoded != nil);
    fwrite(encoded.bytes, 1, encoded.length, stdout);
  }
  return 0;
}
