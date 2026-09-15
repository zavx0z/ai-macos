#include "meta_readiness_command.h"

#include <math.h>
#include <string.h>

static BOOL dictionary(id value) {
  return [value isKindOfClass:NSDictionary.class];
}

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  NSCharacterSet *first = [NSCharacterSet alphanumericCharacterSet];
  return [first characterIsMember:[value characterAtIndex:0]] &&
      [value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

static BOOL integer(id value, uint64_t minimum, uint64_t *output) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number ||
      number < minimum || number > 9007199254740991.0) return NO;
  *output = [value unsignedLongLongValue];
  return YES;
}

static BOOL same_generation(NSDictionary *value, NSDictionary *generation) {
  if (!dictionary(value)) return NO;
  for (NSString *key in @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (![value[key] isEqual:generation[key]]) return NO;
  }
  return YES;
}

static BOOL matches_fence(NSDictionary *wire, MetaFence fence) {
  uint64_t counter = 0;
  return dictionary(wire) && wire.count == 4 &&
      integer(wire[@"counter"], 1, &counter) && counter == fence.counter &&
      [wire[@"runtimeEpoch"] isEqual:@(fence.runtime_epoch)] &&
      [wire[@"loginSessionId"] isEqual:@(fence.login_session_id)] &&
      [wire[@"nativeGeneration"] isEqual:@(fence.native_generation)];
}

static NSDate *date_from_iso(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:value];
}

static NSString *dispatch_name(MetaDispatchState state) {
  switch (state) {
    case META_DISPATCH_NONE: return @"none";
    case META_DISPATCH_ATTEMPTED: return @"attempted";
    case META_DISPATCH_PARTIAL: return @"partial";
    case META_DISPATCH_FINISHED: return @"finished";
    default: return @"unknown";
  }
}

static NSString *cleanup_name(MetaCleanupState state) {
  switch (state) {
    case META_CLEANUP_COMPLETE: return @"complete";
    case META_CLEANUP_INCOMPLETE: return @"incomplete";
    default: return @"unknown";
  }
}

static NSString *interference_name(MetaInterferenceState state) {
  switch (state) {
    case META_INTERFERENCE_NONE_OBSERVED: return @"none-observed";
    case META_INTERFERENCE_OBSERVED: return @"observed";
    default: return @"unknown";
  }
}

static NSString *restoration_name(MetaReadinessRestorationState state) {
  switch (state) {
    case META_READINESS_RESTORE_NOT_ATTEMPTED: return @"not-attempted";
    case META_READINESS_RESTORE_RESTORED: return @"restored";
    case META_READINESS_RESTORE_SKIPPED_USER_TAKEOVER: return @"skipped-user-takeover";
    case META_READINESS_RESTORE_FAILED: return @"failed";
    default: return @"unknown";
  }
}

@interface MetaReadinessCommandOutcome ()
@property(nonatomic, readwrite, copy) NSDictionary *result;
@property(nonatomic, readwrite) MetaExecutorStatus executorStatus;
@property(nonatomic, readwrite) BOOL probeCompleted;
@end
@implementation MetaReadinessCommandOutcome
@end

@interface MetaReadinessCommandBinder ()
@property(nonatomic, copy) NSDictionary *generation;
@property(nonatomic) MetaInputReadinessBackend backend;
@property(nonatomic, copy) NSDate *(^now)(void);
@end

@implementation MetaReadinessCommandBinder
- (instancetype)initWithGeneration:(NSDictionary *)generation
                            backend:(MetaInputReadinessBackend)backend
                                now:(NSDate *(^)(void))now {
  if (!dictionary(generation) || now == nil ||
      backend.read_session == NULL || backend.read_permissions == NULL ||
      backend.read_observer == NULL || backend.read_cursor == NULL ||
      backend.resolve_display == NULL || backend.scan_events == NULL) return nil;
  for (NSString *key in @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (!identifier(generation[key], 64)) return nil;
  }
  self = [super init];
  if (self) {
    _generation = [generation copy];
    _backend = backend;
    _now = [now copy];
  }
  return self;
}

- (MetaReadinessCommandOutcome *)handleRequest:(NSDictionary *)request
                              currentRequestId:(NSString *)currentRequestId
                              currentOperation:(NSDictionary *)currentOperation
                                      executor:(MetaExecutor *)executor
                                         error:(NSError **)error {
  if (error != NULL) *error = nil;
  NSString *failure = nil;
  NSDictionary *operation = dictionary(request) ? request[@"operation"] : nil;
  NSDictionary *payload = dictionary(request) ? request[@"payload"] : nil;
  NSDictionary *expected = dictionary(payload) ? payload[@"expectedDisplayRef"] : nil;
  NSDictionary *target = dictionary(operation) ? operation[@"target"] : nil;
  uint64_t revision = 0;
  if (!dictionary(request) || !dictionary(operation) || !dictionary(payload) ||
      !dictionary(expected) || !dictionary(target) || !dictionary(currentOperation) ||
      ![request[@"protocolVersion"] isEqual:@"1"] ||
      ![request[@"kind"] isEqual:@"request"] ||
      ![request[@"method"] isEqual:@"input.readiness"] ||
      ![request[@"intent"] isEqual:@"mutation"] ||
      !identifier(currentRequestId, 127) ||
      ![request[@"requestId"] isEqual:currentRequestId] ||
      ![operation isEqual:currentOperation] ||
      ![operation[@"kind"] isEqual:@"native"] ||
      !identifier(operation[@"operationId"], 127) ||
      !same_generation(request, self.generation) ||
      !same_generation(operation, self.generation) ||
      !same_generation(expected, self.generation) ||
      ![operation[@"deadlineAt"] isEqual:request[@"deadlineAt"]] ||
      payload.count != 1 || target.count != 2 || expected.count != 5 ||
      ![target[@"kind"] isEqual:@"display"] ||
      ![target[@"ref"] isEqual:expected] ||
      !identifier(expected[@"displayRef"], META_NATIVE_REF_CAPACITY - 1) ||
      !integer(expected[@"displayLayoutRevision"], 0, &revision)) {
    failure = @"Readiness request не совпадает с current job, generation или exact display";
  }
  NSDate *deadline = failure == nil ? date_from_iso(request[@"deadlineAt"]) : nil;
  NSDate *now = failure == nil ? self.now() : nil;
  if (failure == nil && (deadline == nil || now == nil ||
      [now compare:deadline] != NSOrderedAscending)) {
    failure = @"Readiness deadline не подтверждён или уже истёк";
  }
  MetaExecutorStatus status = meta_executor_status(executor);
  if (failure == nil && (executor == NULL ||
      status.execution != META_EXECUTOR_DISPATCHING || status.quarantined ||
      status.dispatch_attempts != 0 || status.held_count != 0 ||
      !status.has_accepted_fence || !status.has_high_water_fence ||
      ![operation[@"operationId"] isEqual:@(status.operation_id)] ||
      !matches_fence(operation[@"fence"], status.accepted_fence) ||
      !matches_fence(operation[@"fence"], status.high_water_fence))) {
    failure = @"Readiness требует существующий active parent executor и exact accepted fence";
  }
  if (failure != nil) {
    if (error != NULL) *error = [NSError errorWithDomain:@"MetaReadinessCommand"
        code:1 userInfo:@{NSLocalizedDescriptionKey : failure}];
    return nil;
  }

  MetaInputReadinessResult probe = {0};
  BOOL completed = meta_input_readiness_probe_active(executor,
      [expected[@"displayRef"] UTF8String], self.backend, &probe);
  // Пустой ref означает, что core отказал до exact display resolution.
  BOOL resolved = probe.display_ref[0] != '\0' &&
      memchr(probe.display_ref, '\0', sizeof(probe.display_ref)) != NULL &&
      [expected[@"displayRef"] isEqual:@(probe.display_ref)];
  NSMutableDictionary *result = [@{
    @"probe" : @"active-event", @"operationId" : operation[@"operationId"],
    @"expectedDisplayRef" : expected,
    @"inputReady" : probe.input_ready && completed && resolved ? @YES : @NO,
    @"quarantined" : probe.quarantined ? @YES : @NO,
    @"movePosted" : probe.move_posted ? @YES : @NO,
    @"moveObserved" : probe.move_observed ? @YES : @NO,
    @"moveReadbackConfirmed" : probe.move_readback_confirmed ? @YES : @NO,
    @"restorePosted" : probe.restore_posted ? @YES : @NO,
    @"restoreObserved" : probe.restore_observed ? @YES : @NO,
    @"restoreReadbackConfirmed" :
        probe.restore_readback_confirmed ? @YES : @NO,
    @"dispatch" : dispatch_name(probe.dispatch), @"cleanup" : cleanup_name(probe.cleanup),
    @"interference" : interference_name(probe.interference),
    @"restoration" : restoration_name(probe.restoration),
  } mutableCopy];
  if (resolved) {
    result[@"resolvedDisplayRef"] = expected;
    result[@"originalCursor"] = @{@"x" : @(probe.original_cursor.x), @"y" : @(probe.original_cursor.y)};
    result[@"probeCursor"] = @{@"x" : @(probe.probe_cursor.x), @"y" : @(probe.probe_cursor.y)};
  }
  if (![result[@"inputReady"] boolValue]) {
    result[@"reason"] = probe.reason[0] != '\0' ? @(probe.reason)
        : @"Readiness probe не подтвердил exact display и восстановление";
  }
  MetaReadinessCommandOutcome *outcome = [MetaReadinessCommandOutcome new];
  outcome.result = result;
  outcome.executorStatus = meta_executor_status(executor);
  outcome.probeCompleted = completed;
  return outcome;
}
@end
