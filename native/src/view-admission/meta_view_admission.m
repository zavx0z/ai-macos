#include "meta_view_admission.h"

#include "../recovery-domain/meta_recovery_domain.h"

#include <math.h>

#define META_VIEW_ADMISSION_MAX_HISTORY 1000
#define META_VIEW_ADMISSION_MAX_TTL_MILLIS 120000
#define META_VIEW_ADMISSION_MAX_RECORDS 4096

static void admission_error(NSString **error, NSString *value) {
  if (error != NULL) *error = value;
}

static BOOL exact_keys(NSDictionary *value, NSArray<NSString *> *required,
                       NSArray<NSString *> *optional) {
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  NSMutableSet *allowed = [NSMutableSet setWithArray:required];
  [allowed addObjectsFromArray:optional];
  for (NSString *key in required) if (value[key] == nil) return NO;
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) return NO;
  NSString *text = value;
  unichar first = [text characterAtIndex:0];
  BOOL validFirst =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return validFirst &&
         [text rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static BOOL safe_sequence(id value, uint64_t *result) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number || number < 1 ||
      number > 9007199254740991.0) return NO;
  *result = [value unsignedLongLongValue];
  return *result >= 1 && *result <= 9007199254740991ULL;
}

static BOOL safe_revision(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= 0 &&
         number <= 9007199254740991.0;
}

static BOOL sha256_value(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static NSDate *timestamp(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:value];
}

static id immutable_json_copy(id value) {
  NSData *data = value == nil
                     ? nil
                     : [NSJSONSerialization dataWithJSONObject:value
                                                       options:0
                                                         error:NULL];
  return data == nil
             ? nil
             : [NSJSONSerialization JSONObjectWithData:data
                                                options:0
                                                  error:NULL];
}

static BOOL request_identity(NSDictionary *request, NSDictionary **operation,
                             NSDictionary **target) {
  if (![request isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *candidate = request[@"operation"];
  if (![candidate isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *candidateTarget = candidate[@"target"];
  if (![candidateTarget isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *reference = candidateTarget[@"ref"];
  if (![reference isKindOfClass:NSDictionary.class]) return NO;
  NSString *method = request[@"method"];
  NSString *actionKind = nil;
  if ([method isEqual:@"input.execute"]) {
    NSDictionary *payload = request[@"payload"];
    if (![payload isKindOfClass:NSDictionary.class]) return NO;
    NSDictionary *action = payload[@"action"];
    if (![action isKindOfClass:NSDictionary.class] ||
        ![action[@"kind"] isKindOfClass:NSString.class]) return NO;
    actionKind = action[@"kind"];
  }
  BOOL pointer = [@[@"hover", @"click", @"scroll", @"drag"]
      containsObject:actionKind];
  BOOL keyboard = [@[@"text", @"key", @"shortcut"]
      containsObject:actionKind];
  BOOL windowOrSurface =
      [@[@"window", @"surface"] containsObject:candidateTarget[@"kind"]];
  BOOL broadDisplay = [@[@"display", @"desktop-layout"]
      containsObject:candidateTarget[@"kind"]];
  BOOL targetAllowed = [method isEqual:@"ax.press"]
      ? windowOrSurface
      : (keyboard ? windowOrSurface : pointer &&
          (windowOrSurface || broadDisplay));
  if (![@[@"input.execute", @"ax.press"] containsObject:method] ||
      !identifier(request[@"requestId"], 127) ||
      !identifier(request[@"runtimeEpoch"], 64) ||
      !identifier(request[@"loginSessionId"], 64) ||
      !identifier(request[@"nativeGeneration"], 64) ||
      ![candidate[@"kind"] isEqual:@"native"] ||
      !identifier(candidate[@"operationId"], 127) ||
      ![candidate[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![candidate[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![candidate[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] ||
      ![candidate[@"deadlineAt"] isEqual:request[@"deadlineAt"]] ||
      !targetAllowed ||
      ![reference[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![reference[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![reference[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]]) {
    return NO;
  }
  NSString *identity = nil;
  if (windowOrSurface) {
    if (!identifier(reference[@"applicationRef"], 127)) return NO;
    identity = [candidateTarget[@"kind"] isEqual:@"window"]
                   ? reference[@"windowRef"]
                   : reference[@"surfaceRef"];
  } else {
    identity = [candidateTarget[@"kind"] isEqual:@"display"]
                   ? reference[@"displayRef"]
                   : reference[@"layoutRef"];
    if (!safe_revision(reference[@"displayLayoutRevision"])) return NO;
  }
  if (!identifier(identity, 127) ||
      meta_recovery_domain_canonical_json(candidate) == nil) return NO;
  *operation = candidate;
  *target = candidateTarget;
  return YES;
}

static BOOL valid_proof(NSDictionary *proof, NSDictionary *request,
                        NSDictionary *operation, NSDate *now,
                        NSUInteger maximumTtlMillis) {
  NSArray *required = @[@"version", @"contextSha256", @"viewNonce",
                        @"observerInstanceRef", @"coverageStartCursor",
                        @"baselineCursor", @"baselineNextSequence",
                        @"observedCursor", @"observedNextSequence",
                        @"admissionCursor", @"admissionNextSequence",
                        @"expiresAt"];
  uint64_t baseline = 0;
  uint64_t observed = 0;
  uint64_t admission = 0;
  if (![proof isKindOfClass:NSDictionary.class]) return NO;
  NSDate *expires = timestamp(proof[@"expiresAt"]);
  NSDate *operationDeadline = timestamp(operation[@"deadlineAt"]);
  if (!exact_keys(proof, required, @[]) ||
      ![proof[@"version"] isEqual:@"1"] ||
      !sha256_value(proof[@"contextSha256"]) ||
      !identifier(proof[@"viewNonce"], 127) ||
      !identifier(proof[@"observerInstanceRef"], 127) ||
      !identifier(proof[@"coverageStartCursor"], 127) ||
      !identifier(proof[@"baselineCursor"], 127) ||
      !identifier(proof[@"observedCursor"], 127) ||
      !identifier(proof[@"admissionCursor"], 127) ||
      !safe_sequence(proof[@"baselineNextSequence"], &baseline) ||
      !safe_sequence(proof[@"observedNextSequence"], &observed) ||
      !safe_sequence(proof[@"admissionNextSequence"], &admission) ||
      baseline > observed || observed > admission ||
      ![request[@"viewAdmission"] isEqual:proof] ||
      expires == nil || operationDeadline == nil ||
      [now compare:expires] != NSOrderedAscending ||
      [expires compare:operationDeadline] == NSOrderedDescending ||
      [expires timeIntervalSinceDate:now] * 1000.0 > maximumTtlMillis) {
    return NO;
  }
  NSString *contextDigest = meta_recovery_domain_sha256(operation);
  return [proof[@"contextSha256"] isEqual:contextDigest];
}

static BOOL coverage_valid(NSDictionary *coverage, NSDictionary *request,
                           NSDictionary *proof) {
  uint64_t nextSequence = 0;
  NSArray *kinds = coverage[@"coveredKinds"];
  NSSet *expected = [NSSet setWithArray:@[
    @"input", @"focus", @"window-structure", @"lifecycle"
  ]];
  return [coverage isKindOfClass:NSDictionary.class] &&
         [coverage[@"state"] isEqual:@"ready"] &&
         ![coverage[@"gapDetected"] boolValue] &&
         [coverage[@"droppedEvents"] unsignedLongLongValue] == 0 &&
         [coverage[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] &&
         [coverage[@"loginSessionId"] isEqual:request[@"loginSessionId"]] &&
         [coverage[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] &&
         [coverage[@"coverageStartCursor"]
             isEqual:proof[@"coverageStartCursor"]] &&
         identifier(coverage[@"cursor"], 127) &&
         safe_sequence(coverage[@"nextSequence"], &nextSequence) &&
         [kinds isKindOfClass:NSArray.class] && kinds.count == expected.count &&
         [[NSSet setWithArray:kinds] isEqual:expected];
}

static BOOL event_valid(NSDictionary *event, NSDictionary *request,
                        uint64_t expectedSequence) {
  uint64_t sequence = 0;
  return [event isKindOfClass:NSDictionary.class] &&
         safe_sequence(event[@"sequence"], &sequence) &&
         sequence == expectedSequence && identifier(event[@"cursor"], 127) &&
         [event[@"eventId"] isEqual:event[@"cursor"]] &&
         [event[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] &&
         [event[@"loginSessionId"] isEqual:request[@"loginSessionId"]] &&
         [event[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]];
}

static BOOL history_position(NSDictionary *snapshot, NSString *cursor,
                             uint64_t nextSequence, NSUInteger *position) {
  NSArray *events = snapshot[@"events"];
  if ([snapshot[@"baselineAvailable"] boolValue] &&
      [cursor isEqual:snapshot[@"baselineCursor"]]) {
    uint64_t baselineNext = 0;
    NSDictionary *first = events.firstObject;
    if (first == nil) {
      if (!safe_sequence(snapshot[@"coverage"][@"nextSequence"],
                         &baselineNext)) return NO;
    } else if (!safe_sequence(first[@"sequence"], &baselineNext)) {
      return NO;
    }
    if (nextSequence != baselineNext) return NO;
    *position = 0;
    return YES;
  }
  for (NSUInteger index = 0; index < events.count; index += 1) {
    NSDictionary *event = events[index];
    uint64_t sequence = 0;
    if ([event[@"cursor"] isEqual:cursor] &&
        safe_sequence(event[@"sequence"], &sequence) &&
        sequence < UINT64_MAX && nextSequence == sequence + 1) {
      *position = index + 1;
      return YES;
    }
  }
  return NO;
}

static BOOL snapshot_valid(NSDictionary *snapshot, NSDictionary *request,
                           NSDictionary *proof) {
  if (![snapshot isKindOfClass:NSDictionary.class] ||
      ![snapshot[@"observerInstanceRef"]
          isEqual:proof[@"observerInstanceRef"]] ||
      !identifier(snapshot[@"baselineCursor"], 127) ||
      ![snapshot[@"baselineAvailable"] isKindOfClass:NSNumber.class] ||
      ![snapshot[@"events"] isKindOfClass:NSArray.class] ||
      [snapshot[@"events"] count] > META_VIEW_ADMISSION_MAX_HISTORY ||
      !coverage_valid(snapshot[@"coverage"], request, proof)) return NO;
  NSArray *events = snapshot[@"events"];
  uint64_t previous = 0;
  NSMutableSet *cursors = [NSMutableSet set];
  for (NSUInteger index = 0; index < events.count; index += 1) {
    NSDictionary *event = events[index];
    uint64_t sequence = 0;
    if (!safe_sequence(event[@"sequence"], &sequence) ||
        (index > 0 && sequence != previous + 1) ||
        !event_valid(event, request, sequence) ||
        [cursors containsObject:event[@"cursor"]]) return NO;
    [cursors addObject:event[@"cursor"]];
    previous = sequence;
  }
  NSDictionary *last = events.lastObject;
  NSDictionary *coverage = snapshot[@"coverage"];
  uint64_t currentNext = 0;
  if (!safe_sequence(coverage[@"nextSequence"], &currentNext)) return NO;
  if (last == nil) {
    if (![coverage[@"cursor"] isEqual:snapshot[@"baselineCursor"]]) return NO;
  } else {
    uint64_t lastSequence = 0;
    if (![coverage[@"cursor"] isEqual:last[@"cursor"]] ||
        !safe_sequence(last[@"sequence"], &lastSequence) ||
        lastSequence == UINT64_MAX || currentNext != lastSequence + 1) return NO;
  }
  uint64_t proofSequences[3] = {0};
  NSString *proofCursors[3] = {
    proof[@"baselineCursor"], proof[@"observedCursor"],
    proof[@"admissionCursor"]
  };
  NSString *sequenceKeys[3] = {
    @"baselineNextSequence", @"observedNextSequence",
    @"admissionNextSequence"
  };
  NSUInteger positions[3] = {0};
  for (size_t index = 0; index < 3; index += 1) {
    if (!safe_sequence(proof[sequenceKeys[index]], &proofSequences[index]) ||
        !history_position(snapshot, proofCursors[index],
                          proofSequences[index], &positions[index])) return NO;
  }
  return positions[0] <= positions[1] && positions[1] <= positions[2] &&
         proofSequences[2] <= currentNext;
}

static NSDictionary *head_value(NSDictionary *snapshot) {
  NSDictionary *coverage = snapshot[@"coverage"];
  return @{
    @"observerInstanceRef" : snapshot[@"observerInstanceRef"],
    @"coverageStartCursor" : coverage[@"coverageStartCursor"],
    @"cursor" : coverage[@"cursor"],
    @"nextSequence" : coverage[@"nextSequence"],
  };
}

@implementation MetaViewAdmissionController {
  MetaObserverCommandBinder *_observer;
  MetaViewAdmissionNow _now;
  NSUInteger _tombstoneTtlMillis;
  NSUInteger _maximumRecords;
  NSMutableDictionary<NSString *, NSDictionary *> *_pending;
  NSMutableDictionary<NSString *, NSDate *> *_used;
  NSMutableDictionary<NSString *, NSDate *> *_usedViews;
}

- (instancetype)initWithObserver:(MetaObserverCommandBinder *)observer
                              now:(MetaViewAdmissionNow)now
               tombstoneTtlMillis:(NSUInteger)tombstoneTtlMillis
                   maximumRecords:(NSUInteger)maximumRecords {
  if (![observer isKindOfClass:MetaObserverCommandBinder.class] || now == nil ||
      tombstoneTtlMillis == 0 ||
      tombstoneTtlMillis > META_VIEW_ADMISSION_MAX_TTL_MILLIS ||
      maximumRecords == 0 || maximumRecords > META_VIEW_ADMISSION_MAX_RECORDS) {
    return nil;
  }
  self = [super init];
  if (self) {
    _observer = observer;
    _now = [now copy];
    _tombstoneTtlMillis = tombstoneTtlMillis;
    _maximumRecords = maximumRecords;
    _pending = [NSMutableDictionary dictionary];
    _used = [NSMutableDictionary dictionary];
    _usedViews = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)pruneAt:(NSDate *)now {
  for (NSString *operationId in [_used.allKeys copy]) {
    if ([now compare:_used[operationId]] != NSOrderedAscending) {
      [_used removeObjectForKey:operationId];
      [_pending removeObjectForKey:operationId];
    }
  }
  for (NSString *viewNonce in [_usedViews.allKeys copy]) {
    if ([now compare:_usedViews[viewNonce]] != NSOrderedAscending) {
      [_usedViews removeObjectForKey:viewNonce];
    }
  }
}

- (NSDictionary *)snapshotForRequest:(NSDictionary *)request
                                 proof:(NSDictionary *)proof {
  NSDictionary *snapshot = [_observer
      historySnapshotForObserverInstance:proof[@"observerInstanceRef"]
                            maximumEvents:META_VIEW_ADMISSION_MAX_HISTORY];
  return snapshot_valid(snapshot, request, proof) ? snapshot : nil;
}

- (NSDictionary *)admitRequest:(NSDictionary *)request
                          proof:(NSDictionary *)proof
                          error:(NSString **)error {
  admission_error(error, nil);
  NSDate *now = _now();
  NSDictionary *operation = nil;
  NSDictionary *target = nil;
  if (![now isKindOfClass:NSDate.class] ||
      !request_identity(request, &operation, &target) ||
      !valid_proof(proof, request, operation, now,
                   META_VIEW_ADMISSION_MAX_TTL_MILLIS)) {
    admission_error(error, @"View admission request, proof или expiry malformed");
    return nil;
  }
  [self pruneAt:now];
  NSString *operationId = operation[@"operationId"];
  if (_used[operationId] != nil || _usedViews[proof[@"viewNonce"]] != nil ||
      _used.count >= _maximumRecords) {
    admission_error(error, @"View или operation уже использованы либо capacity исчерпана");
    return nil;
  }
  NSDictionary *snapshot = [self snapshotForRequest:request proof:proof];
  if (snapshot == nil) {
    admission_error(error, @"Observer history/head не подтверждают view proof");
    return nil;
  }
  uint64_t baselineSequence = [proof[@"baselineNextSequence"] unsignedLongLongValue];
  NSUInteger baselinePosition = 0;
  if (!history_position(snapshot, proof[@"baselineCursor"], baselineSequence,
                        &baselinePosition)) {
    admission_error(error, @"View baseline отсутствует в bounded history");
    return nil;
  }
  if (baselinePosition != [snapshot[@"events"] count]) {
    admission_error(error, @"View admission обнаружила событие после baseline");
    return nil;
  }
  NSDictionary *head = head_value(snapshot);
  NSDate *proofExpiry = timestamp(proof[@"expiresAt"]);
  NSDate *usedExpiry = [now dateByAddingTimeInterval:
                              (NSTimeInterval)_tombstoneTtlMillis / 1000.0];
  if ([proofExpiry compare:usedExpiry] == NSOrderedAscending) {
    usedExpiry = proofExpiry;
  }
  NSDictionary *stored = @{
    @"requestId" : request[@"requestId"],
    @"operationId" : operationId,
    @"identity" : immutable_json_copy(@{
      @"runtimeEpoch" : request[@"runtimeEpoch"],
      @"loginSessionId" : request[@"loginSessionId"],
      @"nativeGeneration" : request[@"nativeGeneration"],
    }),
    @"target" : immutable_json_copy(target),
    @"proof" : immutable_json_copy(proof),
    @"head" : head,
    @"expiresAt" : proofExpiry,
  };
  _used[operationId] = usedExpiry;
  _usedViews[proof[@"viewNonce"]] = usedExpiry;
  _pending[operationId] = stored;
  return immutable_json_copy(head);
}

- (BOOL)recheckOperationId:(NSString *)operationId {
  if (!identifier(operationId, 127)) return NO;
  NSDate *now = _now();
  if (![now isKindOfClass:NSDate.class]) return NO;
  [self pruneAt:now];
  NSDictionary *pending = _pending[operationId];
  if (pending == nil || [now compare:pending[@"expiresAt"]] != NSOrderedAscending) {
    return NO;
  }
  NSDictionary *proof = pending[@"proof"];
  NSDictionary *identity = pending[@"identity"];
  NSDictionary *snapshot = [self snapshotForRequest:identity proof:proof];
  NSDictionary *coverage = snapshot[@"coverage"];
  return snapshot != nil &&
         [snapshot[@"observerInstanceRef"]
             isEqual:pending[@"head"][@"observerInstanceRef"]] &&
         [coverage[@"coverageStartCursor"]
             isEqual:pending[@"head"][@"coverageStartCursor"]] &&
         [coverage[@"cursor"] isEqual:pending[@"head"][@"cursor"]] &&
         [coverage[@"nextSequence"]
             isEqual:pending[@"head"][@"nextSequence"]] &&
         [coverage[@"state"] isEqual:@"ready"] &&
         ![coverage[@"gapDetected"] boolValue] &&
         [coverage[@"droppedEvents"] unsignedLongLongValue] == 0;
}

- (void)finishOperationId:(NSString *)operationId {
  if (!identifier(operationId, 127)) return;
  [_pending removeObjectForKey:operationId];
}

@end
