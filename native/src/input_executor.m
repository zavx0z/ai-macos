#include "meta_input_executor.h"
#include "meta_input_bridge.h"
#include <time.h>
#include <unistd.h>

@interface MetaInputExecutor ()
- (BOOL)verify:(const char *)target;
- (BOOL)cancelled;
- (BOOL)persist:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack;
- (MetaExecutorBackend)sink;
@end

static uint64_t clock_now(void *context) {
  (void)context;
  struct timespec time = {0};
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static BOOL wait_until(void *context, uint64_t until) {
  MetaInputExecutor *owner = (__bridge MetaInputExecutor *)context;
  while (clock_now(NULL) < until) {
    if ([owner cancelled]) return NO;
    usleep(1000);
  }
  return ![owner cancelled];
}
static bool verify(void *context, const char *target) { return [(__bridge MetaInputExecutor *)context verify:target]; }
static bool cancelled(void *context) { return [(__bridge MetaInputExecutor *)context cancelled]; }
static bool persist(void *context, const MetaLedgerPersistenceRequest *request, MetaLedgerPersistenceAck *ack) {
  return [(__bridge MetaInputExecutor *)context persist:request ack:ack];
}
static bool post(void *context, MetaHeldEventKind kind, uint32_t code, bool down, uint64_t tag) {
  MetaExecutorBackend sink = [(__bridge MetaInputExecutor *)context sink];
  return sink.post_held_event != NULL && sink.post_held_event(sink.context, kind, code, down, tag);
}
static bool text(void *context, const uint16_t *units, size_t length, uint64_t tag) {
  MetaExecutorBackend sink = [(__bridge MetaInputExecutor *)context sink];
  return sink.post_text_cluster != NULL && sink.post_text_cluster(sink.context, units, length, tag);
}
static bool flags(void *context, uint64_t value) {
  MetaExecutorBackend sink = [(__bridge MetaInputExecutor *)context sink];
  return sink.set_event_flags != NULL && sink.set_event_flags(sink.context, value);
}
static bool wait_bool(void *context, uint64_t until) { return wait_until(context, until); }

@implementation MetaInputExecutor {
  MetaExecutor *_executor;
  MetaExecutorBackend _sink;
  BOOL (^_verify)(NSString *);
  MetaInputJob *_job;
}
- (instancetype)initWithGeneration:(NSString *)generation sink:(MetaExecutorBackend)sink verify:(BOOL (^)(NSString *))targetVerify {
  self = [super init];
  if (self) {
    _sink = sink;
    _verify = [targetVerify copy];
    MetaExecutorBackend backend = {.context = (__bridge void *)self, .monotonic_millis = clock_now, .verify_target = verify,
      .persist_ledger = persist, .post_held_event = post, .post_text_cluster = text, .set_event_flags = flags, .should_cancel = cancelled};
    _executor = meta_executor_create(generation.UTF8String, 1000, backend);
    if (_executor == NULL) return nil;
  }
  return self;
}
- (void)dealloc { meta_executor_destroy(_executor); }
- (MetaExecutorBackend)sink { return _sink; }
- (BOOL)cancelled { return [_job cancelRequested]; }
- (BOOL)verify:(const char *)target {
  [_job publishStatus:meta_executor_status(_executor)];
  return _verify(@(target));
}
- (BOOL)persist:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack {
  [_job publishStatus:meta_executor_status(_executor)];
  return [_job persistLedger:request ack:ack];
}
- (BOOL)sealForRotation { return meta_executor_seal_for_rotation(_executor); }

- (NSDictionary *)execute:(NSDictionary *)request job:(MetaInputJob *)job {
  _job = job;
  NSDictionary *operation = job.operation;
  NSDictionary *fence = operation[@"fence"];
  NSDictionary *action = request[@"payload"][@"action"];
  NSDictionary *ref = operation[@"target"][@"ref"];
  NSString *target = ref[@"windowRef"] ?: ref[@"surfaceRef"];
  MetaFence token = {0};
  NSString *names[] = {@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"};
  char *destinations[] = {token.runtime_epoch, token.login_session_id, token.native_generation};
  BOOL valid = [fence isKindOfClass:NSDictionary.class] && [action isKindOfClass:NSDictionary.class] && [target isKindOfClass:NSString.class];
  valid = valid && [@[@"window", @"surface"] containsObject:operation[@"target"][@"kind"]] &&
      [ref[@"runtimeEpoch"] isEqual:operation[@"runtimeEpoch"]] &&
      [ref[@"loginSessionId"] isEqual:operation[@"loginSessionId"]] &&
      [ref[@"nativeGeneration"] isEqual:operation[@"nativeGeneration"]];
  for (size_t i = 0; valid && i < 3; i += 1) {
    NSString *value = fence[names[i]];
    valid = [value isKindOfClass:NSString.class] && [value isEqual:operation[names[i]]] && value.length <= 64;
    if (valid) snprintf(destinations[i], META_NATIVE_REF_CAPACITY, "%s", value.UTF8String);
  }
  token.counter = [fence[@"counter"] unsignedLongLongValue];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *actionDeadline = [formatter dateFromString:request[@"payload"][@"actionDeadlineAt"]];
  NSDate *outerDeadline = [formatter dateFromString:operation[@"deadlineAt"]];
  BOOL isText = [action[@"kind"] isEqual:@"text"];
  NSTimeInterval remaining = actionDeadline.timeIntervalSinceNow * 1000;
  valid = valid && actionDeadline != nil && outerDeadline != nil && [actionDeadline compare:outerDeadline] != NSOrderedDescending && remaining > 0;
  uint64_t deadline = clock_now(NULL) + (uint64_t)MAX(0, MIN(remaining, isText ? 30000 : 5000));
  BOOL began = valid && meta_executor_open_runtime_epoch(_executor, token.runtime_epoch, token.login_session_id) &&
    meta_executor_begin(_executor, [operation[@"operationId"] UTF8String], target.UTF8String, token, deadline);
  if (!began) {
    MetaExecutorStatus rejected = meta_executor_status(_executor);
    if (!rejected.has_accepted_fence || strcmp(rejected.operation_id, [operation[@"operationId"] UTF8String]) != 0 ||
        rejected.accepted_fence.counter != token.counter) { _job = nil; return nil; }
    [job publishStatus:rejected];
    NSDictionary *report = @{@"finished": @NO, @"completedSteps": @0, @"totalSteps": @1,
      @"dispatchAttempts": @(rejected.dispatch_attempts), @"ledgerRevision": @(rejected.ledger_revision),
      @"status": [job statusForRequest:job.requestId]};
    _job = nil;
    return report;
  }
  [job publishStatus:meta_executor_status(_executor)];
  BOOL finished = NO;
  size_t total = 1, completed = 0;
  if (began && [action[@"kind"] isEqual:@"key"]) {
    NSNumber *code = action[@"stroke"][@"keyCode"];
    NSNumber *modifiers = action[@"stroke"][@"flags"];
    if ([code isKindOfClass:NSNumber.class] && code.longLongValue >= 0 && code.longLongValue <= UINT16_MAX && [modifiers isKindOfClass:NSNumber.class]) {
      finished = meta_input_execute_key(_executor, code.unsignedIntValue, modifiers.unsignedLongLongValue);
      completed = finished ? 1 : 0;
    }
  } else if (began && isText) {
    NSArray *clusters = action[@"clusters"];
    if ([clusters isKindOfClass:NSArray.class] && clusters.count > 0 && clusters.count <= 10000) {
      total = clusters.count;
      MetaTextCluster *schedule = calloc(total, sizeof(*schedule));
      uint16_t **storage = calloc(total, sizeof(*storage));
      BOOL parsed = schedule != NULL && storage != NULL;
      for (size_t i = 0; parsed && i < total; i += 1) {
        NSDictionary *cluster = clusters[i];
        NSString *value = [cluster isKindOfClass:NSDictionary.class] ? cluster[@"text"] : nil;
        if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 10000 || value.length != [cluster[@"utf16Units"] unsignedLongLongValue]) { parsed = NO; break; }
        storage[i] = calloc(value.length, sizeof(uint16_t));
        if (storage[i] == NULL) { parsed = NO; break; }
        [value getCharacters:storage[i] range:NSMakeRange(0, value.length)];
        schedule[i] = (MetaTextCluster){.utf16_units = storage[i], .utf16_count = value.length, .offset_millis = [cluster[@"atMs"] unsignedLongLongValue]};
      }
      MetaTextExecutionReport report = {0};
      MetaInputBridgeClock clock = {.context = (__bridge void *)self, .monotonic_millis = clock_now, .wait_until = wait_bool};
      if (parsed) finished = meta_input_execute_text_schedule(_executor, schedule, total, deadline, clock, &report);
      completed = report.completed_clusters;
      for (size_t i = 0; i < total; i += 1) free(storage == NULL ? NULL : storage[i]);
      free(storage); free(schedule);
    }
  }
  if (began && !finished) meta_executor_cancel(_executor);
  MetaExecutorStatus status = meta_executor_status(_executor);
  [job publishStatus:status];
  NSDictionary *result = @{@"finished": finished ? @YES : @NO, @"completedSteps": @(completed), @"totalSteps": @(total),
    @"dispatchAttempts": @(status.dispatch_attempts), @"ledgerRevision": @(status.ledger_revision), @"status": [job statusForRequest:job.requestId]};
  _job = nil;
  return result;
}
@end
