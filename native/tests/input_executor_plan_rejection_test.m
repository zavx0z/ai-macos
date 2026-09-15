#include "meta_input_executor.h"

#include <assert.h>
#include <stdio.h>

typedef struct {
  NSUInteger physical_posts;
} Fixture;

static bool unexpected_held(void *context,
                            MetaHeldEventKind kind,
                            uint32_t code,
                            bool down,
                            uint64_t tag) {
  (void)kind;
  (void)code;
  (void)down;
  (void)tag;
  ((Fixture *)context)->physical_posts += 1;
  return true;
}

static bool unexpected_cleanup(void *context,
                               MetaHeldEventKind kind,
                               uint32_t code,
                               uint64_t tag) {
  return unexpected_held(context, kind, code, false, tag);
}

static bool unexpected_text(void *context,
                            const uint16_t *text,
                            size_t length,
                            uint64_t tag) {
  (void)text;
  (void)length;
  (void)tag;
  ((Fixture *)context)->physical_posts += 1;
  return true;
}

static bool unexpected_pointer(void *context,
                               const MetaPointerEvent *event,
                               uint64_t tag) {
  (void)event;
  (void)tag;
  ((Fixture *)context)->physical_posts += 1;
  return true;
}

static bool unexpected_scroll(void *context,
                              const MetaScrollEvent *event,
                              uint64_t tag) {
  (void)event;
  (void)tag;
  ((Fixture *)context)->physical_posts += 1;
  return true;
}

static bool set_flags(void *context, uint64_t flags) {
  (void)context;
  (void)flags;
  return true;
}

static NSString *deadline(void) {
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:
                        [NSDate dateWithTimeIntervalSinceNow:10]];
}

int main(void) {
  @autoreleasepool {
    Fixture fixture = {0};
    MetaExecutorBackend sink = {
      .context = &fixture,
      .post_held_event = unexpected_held,
      .post_cleanup_up = unexpected_cleanup,
      .post_text_cluster = unexpected_text,
      .post_pointer_event = unexpected_pointer,
      .post_scroll_event = unexpected_scroll,
      .set_event_flags = set_flags,
    };
    MetaInputExecutor *input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-1"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"window-1"];
                    }];
    NSString *expires = deadline();
    NSDictionary *generation = @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
    };
    NSMutableDictionary *operation = [generation mutableCopy];
    [operation addEntriesFromDictionary:@{
      @"kind" : @"native",
      @"operationId" : @"operation-plan-rejection",
      @"deadlineAt" : expires,
      @"target" : @{
        @"kind" : @"window",
        @"ref" : @{
          @"runtimeEpoch" : @"runtime-1",
          @"loginSessionId" : @"login-1",
          @"nativeGeneration" : @"native-1",
          @"applicationRef" : @"application-1",
          @"windowRef" : @"window-1",
        },
      },
      @"fence" : @{
        @"runtimeEpoch" : @"runtime-1",
        @"loginSessionId" : @"login-1",
        @"nativeGeneration" : @"native-1",
        @"counter" : @1,
      },
      @"observationRef" : @{
        @"observationId" : @"observation-1",
        @"inventoryRevision" : @YES,
        @"displayLayoutRevision" : @1,
        @"proofRef" : @"proof-1",
      },
    }];
    NSMutableDictionary *request = [generation mutableCopy];
    [request addEntriesFromDictionary:@{
      @"requestId" : @"request-plan-rejection",
      @"deadlineAt" : expires,
      @"operation" : operation,
      @"payload" : @{
        @"actionDeadlineAt" : expires,
        @"action" : @{
          @"kind" : @"click",
          @"button" : @"left",
          @"point" : @{@"x" : @10, @"y" : @20},
          @"count" : @1,
          @"modifiers" : @{@"names" : @[], @"flags" : @0},
        },
      },
    }];
    MetaInputJob *job = [[MetaInputJob alloc]
        initWithRequest:request
                 emitter:^BOOL(__unused NSDictionary *frame) { return YES; }];
    NSDictionary *result = [input execute:request job:job];
    assert(result != nil);
    assert([result[@"finished"] isEqual:@NO]);
    assert([result[@"completedSteps"] isEqual:@0]);
    NSDictionary *status = result[@"status"];
    assert([status[@"operationId"]
        isEqual:@"operation-plan-rejection"]);
    assert([status[@"execution"] isEqual:@"failed"]);
    assert([status[@"dispatch"] isEqual:@"none"]);
    assert([status[@"cleanup"] isEqual:@"complete"]);
    assert([status[@"dispatchAttempts"] isEqual:@0]);
    assert([status[@"acceptedFence"][@"counter"] isEqual:@1]);
    assert(fixture.physical_posts == 0);

    MetaInputExecutor *invalidActionDeadline = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-1"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"window-1"];
                    }];
    NSMutableDictionary *deadlineRequest = [request mutableCopy];
    deadlineRequest[@"requestId"] = @"request-invalid-action-deadline";
    NSMutableDictionary *deadlinePayload =
        [deadlineRequest[@"payload"] mutableCopy];
    deadlinePayload[@"actionDeadlineAt"] = @42;
    deadlineRequest[@"payload"] = deadlinePayload;
    NSMutableDictionary *deadlineOperation = [operation mutableCopy];
    NSMutableDictionary *deadlineObservation =
        [deadlineOperation[@"observationRef"] mutableCopy];
    deadlineObservation[@"inventoryRevision"] = @1;
    deadlineOperation[@"observationRef"] = deadlineObservation;
    deadlineRequest[@"operation"] = deadlineOperation;
    MetaInputJob *deadlineJob = [[MetaInputJob alloc]
        initWithRequest:deadlineRequest
                 emitter:^BOOL(__unused NSDictionary *frame) { return YES; }];
    NSDictionary *deadlineResult =
        [invalidActionDeadline execute:deadlineRequest job:deadlineJob];
    assert([deadlineResult[@"status"][@"execution"] isEqual:@"failed"]);
    assert([deadlineResult[@"status"][@"dispatchAttempts"] isEqual:@0]);

    MetaInputExecutor *invalidOuterDeadline = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-1"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      return [target isEqual:@"window-1"];
                    }];
    NSMutableDictionary *outerRequest = [request mutableCopy];
    outerRequest[@"requestId"] = @"request-invalid-outer-deadline";
    outerRequest[@"deadlineAt"] = @42;
    NSMutableDictionary *outerOperation = [operation mutableCopy];
    outerOperation[@"deadlineAt"] = @42;
    outerRequest[@"operation"] = outerOperation;
    MetaInputJob *outerJob = [[MetaInputJob alloc]
        initWithRequest:outerRequest
                 emitter:^BOOL(__unused NSDictionary *frame) { return YES; }];
    assert([invalidOuterDeadline execute:outerRequest job:outerJob] == nil);
    assert(fixture.physical_posts == 0);
  }
  puts("input executor plan rejection tests passed");
  return 0;
}
