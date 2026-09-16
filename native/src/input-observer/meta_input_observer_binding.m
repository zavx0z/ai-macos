#include "meta_input_observer_binding.h"

#include <stdio.h>

static BOOL meta_input_observer_identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) {
    return NO;
  }
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

static id meta_input_observer_json_copy(id value) {
  NSData *encoded = value == nil
                        ? nil
                        : [NSJSONSerialization dataWithJSONObject:value
                                                          options:0
                                                            error:NULL];
  return encoded == nil
             ? nil
             : [NSJSONSerialization JSONObjectWithData:encoded
                                                options:0
                                                  error:NULL];
}

static NSDictionary *meta_input_observer_generation(NSDictionary *target) {
  if (![target isKindOfClass:NSDictionary.class] ||
      ![@[
        @"application", @"window", @"surface", @"element", @"display",
        @"desktop-layout"
      ] containsObject:target[@"kind"]]) {
    return nil;
  }
  NSDictionary *reference = target[@"ref"];
  if (![reference isKindOfClass:NSDictionary.class]) return nil;
  NSMutableDictionary *generation = [NSMutableDictionary dictionary];
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (!meta_input_observer_identifier(reference[key], 64)) return nil;
    generation[key] = reference[key];
  }
  NSDictionary<NSString *, NSString *> *identityKeys = @{
    @"application" : @"applicationRef",
    @"window" : @"windowRef",
    @"surface" : @"surfaceRef",
    @"element" : @"elementRef",
    @"display" : @"displayRef",
    @"desktop-layout" : @"layoutRef",
  };
  if (!meta_input_observer_identifier(
          reference[identityKeys[target[@"kind"]]], 127)) {
    return nil;
  }
  NSData *encoded =
      [NSJSONSerialization dataWithJSONObject:target options:0 error:NULL];
  return encoded != nil && encoded.length <= 16 * 1024
             ? [generation copy]
             : nil;
}

static BOOL meta_input_observer_safe_integer(id value) {
  if (![value isKindOfClass:NSNumber.class]) return NO;
  double number = [value doubleValue];
  return number >= 0 && number <= 9007199254740991.0 &&
         number == [value unsignedLongLongValue];
}

static BOOL meta_input_observer_coverage_valid(NSDictionary *coverage,
                                               NSDictionary *generation) {
  if (![coverage isKindOfClass:NSDictionary.class] ||
      ![coverage[@"state"] isEqual:@"ready"] ||
      ![coverage[@"gapDetected"] isEqual:@NO] ||
      ![coverage[@"droppedEvents"] isEqual:@0] ||
      !meta_input_observer_identifier(coverage[@"coverageStartCursor"], 127) ||
      !meta_input_observer_identifier(coverage[@"cursor"], 127) ||
      !meta_input_observer_safe_integer(coverage[@"nextSequence"]) ||
      [coverage[@"nextSequence"] unsignedLongLongValue] == 0 ||
      !meta_input_observer_identifier(coverage[@"startedAt"], 64)) {
    return NO;
  }
  for (NSString *key in generation) {
    if (![coverage[key] isEqual:generation[key]]) return NO;
  }
  NSArray *coveredKinds = coverage[@"coveredKinds"];
  if (![coveredKinds isKindOfClass:NSArray.class] || coveredKinds.count != 4) {
    return NO;
  }
  NSSet *actual = [NSSet setWithArray:coveredKinds];
  NSSet *expected = [NSSet setWithArray:@[
    @"input", @"focus", @"window-structure", @"lifecycle"
  ]];
  return actual.count == coveredKinds.count && [actual isEqual:expected];
}

static BOOL meta_input_observer_same_continuity(NSDictionary *baseline,
                                                 NSDictionary *current) {
  return [baseline[@"coverageStartCursor"]
             isEqual:current[@"coverageStartCursor"]] &&
         [baseline[@"startedAt"] isEqual:current[@"startedAt"]] &&
         [current[@"nextSequence"] unsignedLongLongValue] >=
             [baseline[@"nextSequence"] unsignedLongLongValue];
}

@implementation MetaInputObserverBinding {
  MetaObserverCommandBinder *_observer;
  NSString *_observerInstanceRef;
  NSString *_operationId;
  NSDictionary *_target;
  NSString *_interactionId;
  NSDictionary *_generation;
  NSDictionary *_baselineCoverage;
  NSString *_cursor;
  uint64_t _tag;
  BOOL _stopped;
  BOOL _allowRelatedClickFocus;
  BOOL _ownInputArmed;
  BOOL _diagnosticEmitted;
  NSUInteger (^_phaseProvider)(void);
  NSLock *_lock;
}

- (void)setRelatedClickFocusPolicy:(BOOL)allowed
                     phaseProvider:(NSUInteger (^)(void))phaseProvider {
  [_lock lock];
  if (!_stopped && _tag == 0) {
    BOOL narrowScope = [_target[@"kind"] isEqual:@"window"] ||
                       [_target[@"kind"] isEqual:@"surface"];
    _allowRelatedClickFocus = allowed && narrowScope && phaseProvider != nil;
    _phaseProvider = _allowRelatedClickFocus ? [phaseProvider copy] : nil;
  }
  [_lock unlock];
}

- (void)emitDecision:(NSDictionary *)scan phase:(NSUInteger)phase {
  [_lock lock];
  if (_diagnosticEmitted) { [_lock unlock]; return; }
  _diagnosticEmitted = YES;
  [_lock unlock];
  NSDictionary *decision = [scan[@"decision"] isKindOfClass:NSDictionary.class]
      ? scan[@"decision"] : @{};
  NSDictionary *record = @{
    @"kind" : @"input-observer-decision",
    @"operationId" : _operationId,
    @"runtimeEpoch" : _generation[@"runtimeEpoch"],
    @"state" : [scan[@"state"] isKindOfClass:NSString.class]
        ? scan[@"state"] : @"unavailable",
    @"eventKind" : decision[@"eventKind"] ?: @"unknown",
    @"source" : decision[@"source"] ?: @"unknown",
    @"tagRelation" : decision[@"tagRelation"] ?: @"missing",
    @"targetRelation" : decision[@"targetRelation"] ?: @"missing",
    @"ownInputArmed" : [decision[@"ownInputArmed"] boolValue] ? @YES : @NO,
    @"phase" : @(phase),
  };
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:record
                                                    options:0 error:NULL];
  if (encoded != nil) {
    fwrite(encoded.bytes, 1, encoded.length, stderr);
    fputc('\n', stderr);
    fflush(stderr);
  }
}

- (instancetype)initWithObserver:(MetaObserverCommandBinder *)observer
              observerInstanceRef:(NSString *)observerInstanceRef
                       operationId:(NSString *)operationId
                            target:(NSDictionary *)target
                     interactionId:(NSString *)interactionId {
  NSDictionary *generation = meta_input_observer_generation(target);
  NSDictionary *targetCopy = meta_input_observer_json_copy(target);
  if (![observer isKindOfClass:MetaObserverCommandBinder.class] ||
      !meta_input_observer_identifier(observerInstanceRef, 127) ||
      !meta_input_observer_identifier(operationId, 127) || generation == nil ||
      targetCopy == nil ||
      (interactionId != nil &&
       !meta_input_observer_identifier(interactionId, 127))) {
    return nil;
  }
  self = [super init];
  if (self) {
    _observer = observer;
    _observerInstanceRef = [observerInstanceRef copy];
    _operationId = [operationId copy];
    _target = targetCopy;
    _interactionId = [interactionId copy];
    _generation = generation;
    _lock = [[NSLock alloc] init];
    // Baseline фиксируется при создании binding до начала executor operation.
    // Отсутствующая coverage сохраняется как fail-closed состояние регистрации.
    _baselineCoverage = [self currentCoverage];
  }
  return self;
}

- (NSDictionary *)currentCoverage {
  [_lock lock];
  BOOL stopped = _stopped;
  [_lock unlock];
  if (stopped) return nil;
  NSDictionary *coverage =
      [_observer currentCoverageForObserverInstance:_observerInstanceRef];
  if (!meta_input_observer_coverage_valid(coverage, _generation)) return nil;
  [_lock lock];
  stopped = _stopped;
  [_lock unlock];
  return stopped ? nil : meta_input_observer_json_copy(coverage);
}

- (BOOL)useAdmissionHead:(NSDictionary *)head {
  [_lock lock];
  BOOL matching = !_stopped && _tag == 0 && [head isKindOfClass:NSDictionary.class] &&
      [head[@"observerInstanceRef"] isEqual:_observerInstanceRef] &&
      [head[@"coverageStartCursor"] isEqual:_baselineCoverage[@"coverageStartCursor"]] &&
      [head[@"cursor"] isEqual:_baselineCoverage[@"cursor"]] &&
      [head[@"nextSequence"] isEqual:_baselineCoverage[@"nextSequence"]];
  if (!matching) _baselineCoverage = nil;
  [_lock unlock];
  return matching;
}

- (BOOL)registerTag:(uint64_t)tag {
  if (tag == 0) return NO;
  [_lock lock];
  NSDictionary *baseline = _baselineCoverage;
  BOOL available = !_stopped && _tag == 0 && baseline != nil;
  [_lock unlock];
  if (!available) return NO;

  BOOL registered = [_observer registerSyntheticTag:tag
                                         operationId:_operationId
                                       interactionId:_interactionId
                                              target:_target
                                 observerInstanceRef:_observerInstanceRef];
  if (!registered) return NO;
  NSDictionary *current = [self currentCoverage];
  NSDictionary *scan = current == nil
                           ? nil
                           : [_observer
                                 scanEventsAfterCursor:baseline[@"cursor"]
                                  expectedSyntheticTag:tag
                                       requireOwnEvent:NO
                                         timeoutMillis:1
                                   observerInstanceRef:_observerInstanceRef];
  NSSet *scanStates = [NSSet setWithArray:@[
    @"own-event-only", @"user-takeover", @"no-events", @"unknown"
  ]];
  NSDictionary *after = scan == nil ? nil : [self currentCoverage];
  BOOL continuous =
      current != nil && after != nil &&
      meta_input_observer_same_continuity(baseline, current) &&
      meta_input_observer_same_continuity(baseline, after) &&
      [scanStates containsObject:scan[@"state"]] &&
      meta_input_observer_identifier(scan[@"cursor"], 127);
  [_lock lock];
  if (continuous && !_stopped && _tag == 0) {
    _tag = tag;
    _baselineCoverage = baseline;
    _cursor = [baseline[@"cursor"] copy];
  } else {
    continuous = NO;
  }
  [_lock unlock];
  if (!continuous) {
    [_observer unregisterSyntheticTag:tag
                  observerInstanceRef:_observerInstanceRef];
  }
  return continuous;
}

- (MetaInputObserverPollResult)poll {
  [_lock lock];
  uint64_t tag = _tag;
  NSString *cursor = [_cursor copy];
  NSDictionary *baseline = _baselineCoverage;
  BOOL stopped = _stopped;
  BOOL ownInputArmed = _ownInputArmed;
  BOOL allowRelatedClickFocus = _allowRelatedClickFocus;
  NSUInteger (^phaseProvider)(void) = _phaseProvider;
  [_lock unlock];
  if (stopped || tag == 0 || cursor == nil || baseline == nil) {
    return MetaInputObserverPollUnavailable;
  }
  NSDictionary *before = [self currentCoverage];
  if (before == nil ||
      !meta_input_observer_same_continuity(baseline, before)) {
    return MetaInputObserverPollUnavailable;
  }
  NSUInteger phase = phaseProvider == nil ? 0 : phaseProvider();
  NSDictionary *scan = [_observer
      scanInputEventsAfterCursor:cursor
            expectedSyntheticTag:tag
                  expectedTarget:_target
               allowRelatedFocus:allowRelatedClickFocus && phase >= 2
                   ownInputArmed:ownInputArmed
                   timeoutMillis:1
             observerInstanceRef:_observerInstanceRef];
  if (![scan isKindOfClass:NSDictionary.class]) {
    return MetaInputObserverPollUnavailable;
  }
  NSString *state = scan[@"state"];
  NSString *nextCursor = scan[@"cursor"];
  BOOL continuing = [state isEqual:@"own-event-only"] ||
                    [state isEqual:@"related-focus"] ||
                    [state isEqual:@"no-events"];
  if (continuing &&
      (!meta_input_observer_identifier(nextCursor, 127) ||
       (([state isEqual:@"own-event-only"] ||
         [state isEqual:@"related-focus"]) &&
        ![scan[@"syntheticTag"]
            isEqual:[NSString stringWithFormat:@"event-%016llx", tag]]))) {
    return MetaInputObserverPollUnavailable;
  }
  NSDictionary *after = [self currentCoverage];
  if (after == nil ||
      !meta_input_observer_same_continuity(baseline, after)) {
    return MetaInputObserverPollUnavailable;
  }
  if ([state isEqual:@"physical-interference"]) {
    [self emitDecision:scan phase:phase];
    return MetaInputObserverPollForeignEvent;
  }
  if ([state isEqual:@"ui-invalidation"]) {
    [self emitDecision:scan phase:phase];
    return MetaInputObserverPollUIInvalidation;
  }
  if ([state isEqual:@"lifecycle-change"] || [state isEqual:@"unknown"]) {
    [self emitDecision:scan phase:phase];
    return MetaInputObserverPollUnavailable;
  }
  if (!continuing) return MetaInputObserverPollUnavailable;
  [_lock lock];
  if (_stopped || _tag != tag || ![_cursor isEqual:cursor]) {
    [_lock unlock];
    return MetaInputObserverPollUnavailable;
  }
  _cursor = [nextCursor copy];
  _ownInputArmed = [scan[@"ownInputArmed"] boolValue];
  [_lock unlock];
  if ([state isEqual:@"related-focus"]) [self emitDecision:scan phase:phase];
  return MetaInputObserverPollContinue;
}

- (void)stop {
  [_lock lock];
  uint64_t tag = _tag;
  _tag = 0;
  _stopped = YES;
  _cursor = nil;
  _baselineCoverage = nil;
  _allowRelatedClickFocus = NO;
  _ownInputArmed = NO;
  _phaseProvider = nil;
  [_lock unlock];
  if (tag != 0) {
    [_observer unregisterSyntheticTag:tag
                  observerInstanceRef:_observerInstanceRef];
  }
}

@end
