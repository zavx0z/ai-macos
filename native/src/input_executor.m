#include "meta_input_executor.h"
#include "meta_input_bridge.h"
#include <time.h>
#include <unistd.h>
#include <math.h>

@interface MetaInputExecutor ()
- (BOOL)verify:(const char *)target;
- (BOOL)cancelled;
- (BOOL)persist:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack;
- (MetaExecutorBackend)sink;
- (BOOL)postPointer:(const MetaPointerEvent *)event tag:(uint64_t)tag;
- (BOOL)postScroll:(const MetaScrollEvent *)event tag:(uint64_t)tag;
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
static bool cleanup_up(void *context, MetaHeldEventKind kind, uint32_t code, uint64_t tag) {
  MetaExecutorBackend sink = [(__bridge MetaInputExecutor *)context sink];
  return sink.post_cleanup_up != NULL && sink.post_cleanup_up(sink.context, kind, code, tag);
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
static bool pointer(void *context, const MetaPointerEvent *event, uint64_t tag) { return [(__bridge MetaInputExecutor *)context postPointer:event tag:tag]; }
static bool scroll(void *context, const MetaScrollEvent *event, uint64_t tag) { return [(__bridge MetaInputExecutor *)context postScroll:event tag:tag]; }
static bool number(id value) { return [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]); }
static bool point_value(id value, double *x, double *y) {
  if (![value isKindOfClass:NSDictionary.class] || !number(value[@"x"]) || !number(value[@"y"])) return false;
  *x = [value[@"x"] doubleValue]; *y = [value[@"y"] doubleValue];
  return true;
}
static bool dispatch_external(void *context) {
  BOOL (^action)(void) = (__bridge BOOL (^)(void))context;
  return action();
}

@implementation MetaInputExecutor {
  MetaExecutor *_executor;
  MetaExecutorBackend _sink;
  BOOL (^_verify)(NSString *);
  BOOL (^_externalVerify)(NSString *);
  BOOL (^_pointVerify)(NSString *, double, double);
  BOOL (^_scopedPointVerify)(NSDictionary *, double, double);
  BOOL _hasPoint;
  double _pointX;
  double _pointY;
  uint64_t _actionDeadline;
  MetaInputJob *_job;
}
- (instancetype)initWithGeneration:(NSString *)generation sink:(MetaExecutorBackend)sink verify:(BOOL (^)(NSString *))targetVerify {
  self = [super init];
  if (self) {
    _sink = sink;
    _verify = [targetVerify copy];
    MetaExecutorBackend backend = {.context = (__bridge void *)self, .monotonic_millis = clock_now, .verify_target = verify,
      .persist_ledger = persist, .post_held_event = post, .post_text_cluster = text, .set_event_flags = flags,
      .post_pointer_event = pointer, .post_scroll_event = scroll, .post_cleanup_up = cleanup_up, .should_cancel = cancelled};
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
  if (_externalVerify != nil) return _externalVerify(@(target));
  NSDictionary *scope = _job.operation[@"target"];
  BOOL broad = [scope[@"kind"] isEqual:@"display"] || [scope[@"kind"] isEqual:@"desktop-layout"];
  if (broad) return _hasPoint && _scopedPointVerify != nil && _scopedPointVerify(scope, _pointX, _pointY);
  BOOL pointVerified = !_hasPoint || (_scopedPointVerify != nil ? _scopedPointVerify(scope, _pointX, _pointY) :
      (_pointVerify != nil && _pointVerify(@(target), _pointX, _pointY)));
  return _verify(@(target)) && pointVerified;
}
- (void)setPointVerifier:(BOOL (^)(NSString *, double, double))verify { _pointVerify = [verify copy]; }
- (void)setScopedPointVerifier:(BOOL (^)(NSDictionary *, double, double))verify { _scopedPointVerify = [verify copy]; }
- (BOOL)postPointer:(const MetaPointerEvent *)event tag:(uint64_t)tag {
  NSDictionary *scope = _job.operation[@"target"];
  NSString *target = scope[@"ref"][@"windowRef"] ?: scope[@"ref"][@"surfaceRef"];
  if (event == NULL) return NO;
  BOOL verified = _scopedPointVerify != nil ? _scopedPointVerify(scope, event->x, event->y) :
      _pointVerify != nil && target != nil && _pointVerify(target, event->x, event->y);
  if (!verified || [self cancelled] || clock_now(NULL) >= _actionDeadline || _sink.post_pointer_event == NULL) return NO;
  _hasPoint = YES; _pointX = event->x; _pointY = event->y;
  return _sink.post_pointer_event(_sink.context, event, tag);
}
- (BOOL)postScroll:(const MetaScrollEvent *)event tag:(uint64_t)tag {
  NSDictionary *scope = _job.operation[@"target"];
  NSString *target = scope[@"ref"][@"windowRef"] ?: scope[@"ref"][@"surfaceRef"];
  if (event == NULL) return NO;
  BOOL verified = _scopedPointVerify != nil ? _scopedPointVerify(scope, event->x, event->y) :
      _pointVerify != nil && target != nil && _pointVerify(target, event->x, event->y);
  if (!verified || [self cancelled] || clock_now(NULL) >= _actionDeadline || _sink.post_scroll_event == NULL) return NO;
  return _sink.post_scroll_event(_sink.context, event, tag);
}
- (BOOL)persist:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack {
  [_job publishStatus:meta_executor_status(_executor)];
  return [_job persistLedger:request ack:ack];
}
- (BOOL)sealForRotation { return meta_executor_seal_for_rotation(_executor); }
- (MetaExecutor *)executorOnActionWorker { return _executor; }

- (NSDictionary *)executeExternal:(NSDictionary *)request job:(MetaInputJob *)job targetRef:(NSString *)targetRef
                            verify:(BOOL (^)(NSString *))targetVerify action:(NSDictionary *(^)(void))action {
  if (job == nil || targetVerify == nil || action == nil || ![targetRef isKindOfClass:NSString.class]) return nil;
  NSDictionary *operation = job.operation;
  NSDictionary *fence = operation[@"fence"];
  MetaFence token = {0};
  NSString *names[] = {@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"};
  char *destinations[] = {token.runtime_epoch, token.login_session_id, token.native_generation};
  for (size_t index = 0; index < 3; index += 1) {
    NSString *value = fence[names[index]];
    if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 64 ||
        ![value isEqual:operation[names[index]]] || ![value isEqual:request[names[index]]]) return nil;
    snprintf(destinations[index], META_NATIVE_REF_CAPACITY, "%s", value.UTF8String);
  }
  NSNumber *counter = fence[@"counter"];
  if (![counter isKindOfClass:NSNumber.class] || counter.doubleValue != counter.longLongValue || counter.longLongValue < 1) return nil;
  token.counter = counter.unsignedLongLongValue;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *deadlineDate = [formatter dateFromString:operation[@"deadlineAt"]];
  double remaining = deadlineDate.timeIntervalSinceNow * 1000;
  if (deadlineDate == nil || remaining <= 0 || ![operation[@"deadlineAt"] isEqual:request[@"deadlineAt"]]) return nil;
  _job = job;
  _externalVerify = [targetVerify copy];
  __block NSDictionary *value = nil;
  BOOL began = meta_executor_open_runtime_epoch(_executor, token.runtime_epoch, token.login_session_id) &&
      meta_executor_begin(_executor, [operation[@"operationId"] UTF8String], targetRef.UTF8String,
                           token, clock_now(NULL) + (uint64_t)MIN(remaining, 30000));
  BOOL (^dispatch)(void) = ^BOOL { value = action(); return value != nil; };
  BOOL finished = began && meta_executor_dispatch_action(_executor, dispatch_external, (__bridge void *)dispatch, "native-action") &&
      meta_executor_finish(_executor);
  if (began && !finished) meta_executor_cancel(_executor);
  MetaExecutorStatus status = meta_executor_status(_executor);
  NSDictionary *result = nil;
  if (status.has_accepted_fence && strcmp(status.operation_id, [operation[@"operationId"] UTF8String]) == 0 && status.accepted_fence.counter == token.counter) {
    [job publishStatus:status];
    NSMutableDictionary *report = [@{@"finished": @(finished), @"status": [job statusForRequest:job.requestId]} mutableCopy];
    if (value != nil) report[@"value"] = value;
    result = report;
  }
  _job = nil;
  _externalVerify = nil;
  return result;
}

- (NSDictionary *)execute:(NSDictionary *)request job:(MetaInputJob *)job {
  _job = job;
  _hasPoint = NO;
  NSDictionary *operation = job.operation;
  NSDictionary *fence = operation[@"fence"];
  NSDictionary *action = request[@"payload"][@"action"];
  NSDictionary *ref = operation[@"target"][@"ref"];
  NSString *target = ref[@"windowRef"] ?: ref[@"surfaceRef"] ?: ref[@"displayRef"] ?: ref[@"layoutRef"];
  MetaFence token = {0};
  NSString *names[] = {@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"};
  char *destinations[] = {token.runtime_epoch, token.login_session_id, token.native_generation};
  BOOL valid = [fence isKindOfClass:NSDictionary.class] && [action isKindOfClass:NSDictionary.class] && [target isKindOfClass:NSString.class];
  BOOL pointerAction = [@[@"hover", @"click", @"scroll", @"drag"] containsObject:action[@"kind"]];
  if (pointerAction) {
    NSDictionary *observation = operation[@"observationRef"];
    valid = valid && [observation isKindOfClass:NSDictionary.class] &&
        [observation[@"inventoryRevision"] isEqual:operation[@"inventoryRevision"]] &&
        [observation[@"observationId"] isKindOfClass:NSString.class] && [observation[@"observationId"] length] > 0 &&
        [observation[@"proofRef"] isKindOfClass:NSString.class] && [observation[@"proofRef"] length] > 0;
    id initialPoint = [action[@"kind"] isEqual:@"scroll"] ? action[@"anchor"] : action[@"point"];
    if ([action[@"kind"] isEqual:@"drag"]) {
      NSArray *trajectory = action[@"trajectory"];
      initialPoint = [trajectory isKindOfClass:NSArray.class] && trajectory.count > 0 && [trajectory[0] isKindOfClass:NSDictionary.class] ? trajectory[0][@"point"] : nil;
    }
    valid = valid && point_value(initialPoint, &_pointX, &_pointY);
    _hasPoint = valid;
  }
  BOOL windowScope = [@[@"window", @"surface"] containsObject:operation[@"target"][@"kind"]];
  BOOL displayScope = [@[@"display", @"desktop-layout"] containsObject:operation[@"target"][@"kind"]];
  valid = valid && (windowScope || (pointerAction && displayScope)) &&
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
  _actionDeadline = deadline;
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
  } else if (began && pointerAction) {
    NSDictionary *modifiers = action[@"modifiers"];
    NSNumber *modifierFlags = [modifiers isKindOfClass:NSDictionary.class] ? modifiers[@"flags"] : nil;
    BOOL parsed = number(modifierFlags) && modifierFlags.doubleValue == modifierFlags.longLongValue && modifierFlags.longLongValue >= 0;
    uint64_t pointerFlags = modifierFlags.unsignedLongLongValue;
    MetaPointerButton button = META_POINTER_LEFT;
    if ([action[@"button"] isEqual:@"right"]) button = META_POINTER_RIGHT;
    else if ([action[@"button"] isEqual:@"middle"]) button = META_POINTER_MIDDLE;
    else if (action[@"button"] != nil && ![action[@"button"] isEqual:@"left"]) parsed = NO;
    if (parsed && [action[@"kind"] isEqual:@"hover"]) {
      finished = meta_input_execute_hover(_executor, _pointX, _pointY, pointerFlags);
      completed = finished ? 1 : 0;
    } else if (parsed && [action[@"kind"] isEqual:@"click"]) {
      NSNumber *count = action[@"count"];
      if (number(count) && count.doubleValue == count.longLongValue && count.longLongValue >= 1 && count.longLongValue <= 3) {
        finished = meta_input_execute_click(_executor, _pointX, _pointY, button, count.unsignedIntValue, pointerFlags);
        completed = finished ? 1 : 0;
      }
    } else if (parsed && [action[@"kind"] isEqual:@"scroll"]) {
      if (number(action[@"dx"]) && number(action[@"dy"]) && [@[@"line", @"pixel"] containsObject:action[@"unit"]]) {
        MetaScrollEvent event = {_pointX, _pointY, [action[@"dx"] doubleValue], [action[@"dy"] doubleValue],
          [action[@"unit"] isEqual:@"pixel"] ? META_SCROLL_PIXEL : META_SCROLL_LINE, pointerFlags};
        finished = meta_input_execute_scroll(_executor, event);
        completed = finished ? 1 : 0;
      }
    } else if (parsed && [action[@"kind"] isEqual:@"drag"]) {
      NSArray *points = action[@"trajectory"];
      if ([points isKindOfClass:NSArray.class] && points.count >= 2 && points.count <= 512) {
        total = points.count;
        MetaTimedPointerPoint trajectory[512] = {0};
        for (size_t index = 0; parsed && index < total; index += 1) {
          NSDictionary *entry = points[index];
          if (![entry isKindOfClass:NSDictionary.class] || !point_value(entry[@"point"], &trajectory[index].x, &trajectory[index].y) ||
              !number(entry[@"atMs"]) || [entry[@"atMs"] doubleValue] != [entry[@"atMs"] longLongValue] ||
              [entry[@"atMs"] longLongValue] < 0 || [entry[@"atMs"] longLongValue] > 5000) { parsed = NO; break; }
          trajectory[index].offset_millis = [entry[@"atMs"] unsignedLongLongValue];
        }
        NSNumber *duration = action[@"durationMs"];
        parsed = parsed && number(duration) && duration.doubleValue == duration.longLongValue && duration.longLongValue > 0 && duration.longLongValue <= 5000 &&
            trajectory[total - 1].offset_millis == duration.unsignedLongLongValue;
        MetaInputBridgeClock clock = {.context = (__bridge void *)self, .monotonic_millis = clock_now, .wait_until = wait_bool};
        if (parsed) finished = meta_input_execute_drag(_executor, trajectory, total, button, pointerFlags, deadline, clock, &completed);
      }
    }
  } else if (began && [action[@"kind"] isEqual:@"shortcut"]) {
    NSArray *strokes = action[@"strokes"];
    NSNumber *delay = action[@"delayMs"];
    if ([strokes isKindOfClass:NSArray.class] && strokes.count > 0 && strokes.count <= 64 &&
        [delay isKindOfClass:NSNumber.class] && delay.doubleValue == delay.longLongValue && delay.longLongValue >= 0 && delay.longLongValue <= 5000) {
      total = strokes.count;
      MetaTimedKeyStroke schedule[64] = {0};
      BOOL parsed = YES;
      for (size_t index = 0; parsed && index < total; index += 1) {
        NSDictionary *stroke = strokes[index];
        if (![stroke isKindOfClass:NSDictionary.class]) { parsed = NO; break; }
        NSNumber *code = stroke[@"keyCode"], *modifiers = stroke[@"flags"];
        if (![code isKindOfClass:NSNumber.class] || code.doubleValue != code.longLongValue || code.longLongValue < 0 || code.longLongValue > UINT16_MAX ||
            ![modifiers isKindOfClass:NSNumber.class] || modifiers.doubleValue != modifiers.longLongValue || modifiers.longLongValue < 0) { parsed = NO; break; }
        schedule[index] = (MetaTimedKeyStroke){code.unsignedIntValue, modifiers.unsignedLongLongValue, index * delay.unsignedLongLongValue};
      }
      MetaInputBridgeClock clock = {.context = (__bridge void *)self, .monotonic_millis = clock_now, .wait_until = wait_bool};
      if (parsed) finished = meta_input_execute_shortcut(_executor, schedule, total, deadline, clock, &completed);
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
