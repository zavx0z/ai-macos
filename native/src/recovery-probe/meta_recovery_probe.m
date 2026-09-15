#include "meta_recovery_probe.h"

#include <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "meta_ledger.h"

#define META_RECOVERY_MAX_ENTRIES 512
#define META_JAVASCRIPT_MAX_SAFE_INTEGER 9007199254740991ULL

static BOOL exact_keys(NSDictionary *value, NSArray<NSString *> *allowed,
                       NSArray<NSString *> *required) {
  if (![value isKindOfClass:NSDictionary.class] ||
      value.count > allowed.count) {
    return NO;
  }
  NSSet *allowed_set = [NSSet setWithArray:allowed];
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] ||
        ![allowed_set containsObject:key]) {
      return NO;
    }
  }
  for (NSString *key in required) {
    if (value[key] == nil) return NO;
  }
  return YES;
}

static BOOL valid_identifier(id value, NSUInteger maximum_length) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *text = value;
  if (text.length == 0 || text.length > maximum_length) return NO;
  unichar first = [text characterAtIndex:0];
  const BOOL valid_first =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  if (!valid_first) return NO;
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return [text rangeOfCharacterFromSet:allowed.invertedSet].location ==
         NSNotFound;
}

static BOOL valid_sha256(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static BOOL unsigned_integer(id value, uint64_t minimum, uint64_t maximum,
                             uint64_t *result) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  const double number = [value doubleValue];
  if (!isfinite(number) || number < (double)minimum ||
      number > (double)maximum || floor(number) != number) {
    return NO;
  }
  *result = [value unsignedLongLongValue];
  return *result >= minimum && *result <= maximum;
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

static NSString *timestamp_value(NSDate *value) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:value];
}

static BOOL copy_identifier(NSString *value,
                            char output[META_NATIVE_REF_CAPACITY]) {
  return [value getCString:output
                 maxLength:META_NATIVE_REF_CAPACITY
                  encoding:NSUTF8StringEncoding];
}

static BOOL ledger_state(NSString *value, MetaLedgerState *state) {
  if ([value isEqual:@"pending-down"]) *state = META_LEDGER_PENDING_DOWN;
  else if ([value isEqual:@"confirmed-down"]) {
    *state = META_LEDGER_CONFIRMED_DOWN;
  } else if ([value isEqual:@"pending-up"]) {
    *state = META_LEDGER_PENDING_UP;
  } else if ([value isEqual:@"released"]) {
    *state = META_LEDGER_RELEASED;
  } else if ([value isEqual:@"uncertain"]) {
    *state = META_LEDGER_UNCERTAIN;
  } else {
    return NO;
  }
  return YES;
}

static BOOL parse_ledger(NSDictionary *value,
                         MetaHeldInputLedgerSnapshot *snapshot,
                         MetaLedgerEntry entries[META_RECOVERY_MAX_ENTRIES]) {
  NSArray *allowed = @[@"canonicalVersion", @"operationId", @"runtimeEpoch",
                       @"loginSessionId", @"nativeGeneration", @"revision",
                       @"previousSnapshotSha256", @"entries"];
  NSArray *required = @[@"canonicalVersion", @"operationId", @"runtimeEpoch",
                        @"loginSessionId", @"nativeGeneration", @"revision",
                        @"entries"];
  if (!exact_keys(value, allowed, required) ||
      ![value[@"canonicalVersion"] isEqual:@"1"] ||
      !valid_identifier(value[@"operationId"], 127) ||
      !valid_identifier(value[@"runtimeEpoch"], 64) ||
      !valid_identifier(value[@"loginSessionId"], 64) ||
      !valid_identifier(value[@"nativeGeneration"], 64) ||
      ![value[@"entries"] isKindOfClass:NSArray.class]) {
    return NO;
  }
  uint64_t revision = 0;
  if (!unsigned_integer(value[@"revision"], 1,
                        META_JAVASCRIPT_MAX_SAFE_INTEGER, &revision)) {
    return NO;
  }
  NSString *previous = value[@"previousSnapshotSha256"];
  if (previous != nil && !valid_sha256(previous)) return NO;
  NSArray *source_entries = value[@"entries"];
  if (source_entries.count > META_RECOVERY_MAX_ENTRIES) return NO;

  *snapshot = (MetaHeldInputLedgerSnapshot){
      .revision = revision,
      .has_previous_snapshot_sha256 = previous != nil,
      .entries = entries,
      .entry_count = source_entries.count,
  };
  if (!copy_identifier(value[@"operationId"], snapshot->operation_id) ||
      !copy_identifier(value[@"runtimeEpoch"], snapshot->runtime_epoch) ||
      !copy_identifier(value[@"loginSessionId"], snapshot->login_session_id) ||
      !copy_identifier(value[@"nativeGeneration"],
                       snapshot->native_generation)) {
    return NO;
  }
  if (previous != nil) {
    snprintf(snapshot->previous_snapshot_sha256,
             sizeof(snapshot->previous_snapshot_sha256), "%s",
             previous.UTF8String);
  }

  uint64_t last_sequence = 0;
  NSMutableSet<NSString *> *held_keys = [NSMutableSet set];
  NSArray *entry_keys = @[@"sequence", @"kind", @"code", @"state"];
  for (NSUInteger index = 0; index < source_entries.count; index += 1) {
    NSDictionary *source = source_entries[index];
    if (!exact_keys(source, entry_keys, entry_keys)) return NO;
    uint64_t sequence = 0;
    uint64_t code = 0;
    if (!unsigned_integer(source[@"sequence"], 1,
                          META_JAVASCRIPT_MAX_SAFE_INTEGER, &sequence) ||
        sequence <= last_sequence ||
        !unsigned_integer(source[@"code"], 0, UINT32_MAX, &code)) {
      return NO;
    }
    MetaHeldEventKind kind;
    if ([source[@"kind"] isEqual:@"key"]) kind = META_EVENT_KEY;
    else if ([source[@"kind"] isEqual:@"button"]) kind = META_EVENT_BUTTON;
    else return NO;
    MetaLedgerState state;
    if (![source[@"state"] isKindOfClass:NSString.class] ||
        !ledger_state(source[@"state"], &state)) {
      return NO;
    }
    if (state != META_LEDGER_RELEASED) {
      NSString *held_key = [NSString stringWithFormat:@"%lu:%llu",
                            (unsigned long)kind,
                            (unsigned long long)code];
      if ([held_keys containsObject:held_key]) return NO;
      [held_keys addObject:held_key];
    }
    entries[index] = (MetaLedgerEntry){
        .sequence = sequence,
        .kind = kind,
        .code = (uint32_t)code,
        .state = state,
    };
    last_sequence = sequence;
  }
  return YES;
}

static BOOL valid_owner(NSDictionary *owner) {
  NSArray *keys = @[@"protocolVersion", @"runtimeEpoch", @"loginSessionId",
                    @"nativeGeneration", @"nativeBuildId"];
  return exact_keys(owner, keys, keys) &&
         [owner[@"protocolVersion"] isEqual:@"1"] &&
         valid_identifier(owner[@"runtimeEpoch"], 64) &&
         valid_identifier(owner[@"loginSessionId"], 64) &&
         valid_identifier(owner[@"nativeGeneration"], 64) &&
         valid_identifier(owner[@"nativeBuildId"], 127);
}

static BOOL valid_request_shape(NSDictionary *request) {
  NSArray *keys = @[@"protocolVersion", @"requestId", @"runtimeEpoch",
                    @"loginSessionId", @"nativeGeneration", @"kind",
                    @"deadlineAt", @"ledger", @"ack"];
  return exact_keys(request, keys, keys) &&
         [request[@"protocolVersion"] isEqual:@"1"] &&
         [request[@"kind"] isEqual:@"held-recovery"] &&
         valid_identifier(request[@"requestId"], 127) &&
         valid_identifier(request[@"runtimeEpoch"], 64) &&
         valid_identifier(request[@"loginSessionId"], 64) &&
         valid_identifier(request[@"nativeGeneration"], 64) &&
         timestamp(request[@"deadlineAt"]) != nil &&
         [request[@"ledger"] isKindOfClass:NSDictionary.class] &&
         [request[@"ack"] isKindOfClass:NSDictionary.class];
}

static BOOL ack_matches(NSDictionary *ack,
                        const MetaHeldInputLedgerSnapshot *ledger,
                        const char digest[65]) {
  NSArray *keys = @[@"requestId", @"operationId", @"runtimeEpoch",
                    @"loginSessionId", @"nativeGeneration", @"revision",
                    @"snapshotSha256", @"persistedAt", @"durable"];
  if (!exact_keys(ack, keys, keys) ||
      !valid_identifier(ack[@"requestId"], 127) ||
      !valid_identifier(ack[@"operationId"], 127) ||
      !valid_identifier(ack[@"runtimeEpoch"], 64) ||
      !valid_identifier(ack[@"loginSessionId"], 64) ||
      !valid_identifier(ack[@"nativeGeneration"], 64) ||
      !valid_sha256(ack[@"snapshotSha256"]) ||
      timestamp(ack[@"persistedAt"]) == nil ||
      CFGetTypeID((__bridge CFTypeRef)ack[@"durable"]) !=
          CFBooleanGetTypeID() ||
      ![ack[@"durable"] boolValue]) {
    return NO;
  }
  uint64_t revision = 0;
  return unsigned_integer(ack[@"revision"], 1,
                          META_JAVASCRIPT_MAX_SAFE_INTEGER, &revision) &&
         revision == ledger->revision &&
         [ack[@"operationId"] isEqual:@(ledger->operation_id)] &&
         [ack[@"runtimeEpoch"] isEqual:@(ledger->runtime_epoch)] &&
         [ack[@"loginSessionId"] isEqual:@(ledger->login_session_id)] &&
         [ack[@"nativeGeneration"] isEqual:@(ledger->native_generation)] &&
         [ack[@"snapshotSha256"] isEqual:@(digest)];
}

static NSString *session_state(MetaRecoverySessionState state) {
  switch (state) {
    case MetaRecoverySessionStateActiveConsole:
      return @"active-console";
    case MetaRecoverySessionStateInactive:
      return @"inactive";
    case MetaRecoverySessionStateUnknown:
      return @"unknown";
  }
  return @"unknown";
}

static NSString *lock_state(MetaRecoveryLockState state) {
  return state == MetaRecoveryLockStateLocked ? @"locked" : @"unknown";
}

static NSString *secure_input_state(MetaRecoverySecureInputState state) {
  if (state == MetaRecoverySecureInputStateOff) return @"off";
  if (state == MetaRecoverySecureInputStateOn) return @"on";
  return @"unknown";
}

static NSString *observed_state(MetaRecoveryObservedState state) {
  if (state == MetaRecoveryObservedStateUp) return @"up";
  if (state == MetaRecoveryObservedStateHeld) return @"held";
  return @"unknown";
}

NSDictionary *meta_recovery_probe_receive(NSDictionary *owner,
                                           NSDictionary *request,
                                           MetaRecoveryProbeBackend backend) {
  if (!valid_owner(owner) || !valid_request_shape(request) ||
      backend.now == NULL ||
      ![request[@"protocolVersion"] isEqual:owner[@"protocolVersion"]] ||
      ![request[@"runtimeEpoch"] isEqual:owner[@"runtimeEpoch"]] ||
      ![request[@"loginSessionId"] isEqual:owner[@"loginSessionId"]] ||
      ![request[@"nativeGeneration"] isEqual:owner[@"nativeGeneration"]]) {
    return nil;
  }

  MetaLedgerEntry ledger_entries[META_RECOVERY_MAX_ENTRIES] = {0};
  MetaHeldInputLedgerSnapshot ledger = {0};
  if (!parse_ledger(request[@"ledger"], &ledger, ledger_entries) ||
      ![request[@"loginSessionId"] isEqual:@(ledger.login_session_id)]) {
    return nil;
  }
  char digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(&ledger, digest) ||
      !ack_matches(request[@"ack"], &ledger, digest)) {
    return nil;
  }

  NSDate *started_at = backend.now(backend.context);
  NSDate *deadline = timestamp(request[@"deadlineAt"]);
  if (![started_at isKindOfClass:NSDate.class] || deadline == nil ||
      [started_at compare:deadline] != NSOrderedAscending) {
    return nil;
  }

  MetaRecoveryReadiness readiness = {
      .session_state = MetaRecoverySessionStateUnknown,
  };
  BOOL readiness_available =
      backend.readiness != NULL &&
      backend.readiness(backend.context, &readiness);
  if (!readiness_available) {
    readiness = (MetaRecoveryReadiness){
        .session_state = MetaRecoverySessionStateUnknown,
    };
  }
  BOOL ready = readiness.input_monitoring &&
               readiness.session_state ==
                   MetaRecoverySessionStateActiveConsole &&
               readiness.lock_state == MetaRecoveryLockStateUnknown &&
               readiness.secure_input == MetaRecoverySecureInputStateOff &&
               readiness.observer_ready;
  const MetaRecoverySessionState initial_session_state =
      readiness.session_state;
  const MetaLedgerEntry *unreleased[META_RECOVERY_MAX_ENTRIES] = {0};
  MetaRecoveryObservedState observations[META_RECOVERY_MAX_ENTRIES] = {0};
  size_t unreleased_count = 0;
  BOOL held = NO;
  BOOL unknown = !ready;
  for (size_t index = 0; index < ledger.entry_count; index += 1) {
    const MetaLedgerEntry *entry = &ledger.entries[index];
    if (entry->state == META_LEDGER_RELEASED) continue;
    MetaRecoveryObservedState observed = MetaRecoveryObservedStateUnknown;
    if (ready) {
      if (entry->kind == META_EVENT_KEY && backend.sample_key != NULL) {
        observed = backend.sample_key(backend.context, entry->code);
      } else if (entry->kind == META_EVENT_BUTTON &&
                 backend.sample_button != NULL) {
        observed = backend.sample_button(backend.context, entry->code);
      }
    }
    if (observed != MetaRecoveryObservedStateUp &&
        observed != MetaRecoveryObservedStateHeld) {
      observed = MetaRecoveryObservedStateUnknown;
    }
    if (observed == MetaRecoveryObservedStateHeld) held = YES;
    if (observed == MetaRecoveryObservedStateUnknown) unknown = YES;
    unreleased[unreleased_count] = entry;
    observations[unreleased_count] = observed;
    unreleased_count += 1;
  }

  if (ready) {
    MetaRecoveryReadiness after = {
        .session_state = MetaRecoverySessionStateUnknown,
    };
    const BOOL after_available =
        backend.readiness != NULL &&
        backend.readiness(backend.context, &after);
    const BOOL after_ready =
        after_available && after.input_monitoring &&
        after.session_state == MetaRecoverySessionStateActiveConsole &&
        after.lock_state == MetaRecoveryLockStateUnknown &&
        after.secure_input == MetaRecoverySecureInputStateOff &&
        after.observer_ready &&
        after.session_state == initial_session_state;
    readiness_available = after_available;
    readiness = after_available
                    ? after
                    : (MetaRecoveryReadiness){
                          .session_state = MetaRecoverySessionStateUnknown,
                      };
    if (!after_ready) {
      ready = NO;
      held = NO;
      unknown = YES;
      for (size_t index = 0; index < unreleased_count; index += 1) {
        observations[index] = MetaRecoveryObservedStateUnknown;
      }
    }
  }

  NSDate *sampled_at = backend.now(backend.context);
  if (![sampled_at isKindOfClass:NSDate.class] ||
      [sampled_at compare:started_at] == NSOrderedAscending ||
      [sampled_at timeIntervalSinceDate:started_at] > 1.0 ||
      [sampled_at compare:deadline] != NSOrderedAscending) {
    return nil;
  }
  NSMutableArray *entries = [NSMutableArray arrayWithCapacity:unreleased_count];
  for (size_t index = 0; index < unreleased_count; index += 1) {
    const MetaLedgerEntry *entry = unreleased[index];
    [entries addObject:@{
      @"sequence" : @(entry->sequence),
      @"kind" : entry->kind == META_EVENT_KEY ? @"key" : @"button",
      @"code" : @(entry->code),
      @"observed" : observed_state(observations[index]),
    }];
  }
  NSString *reason = nil;
  if (!readiness_available) reason = @"Проверенная готовность восстановления недоступна";
  else if (!readiness.input_monitoring) reason = @"Готовность Input Monitoring не подтверждена";
  else if (readiness.session_state != MetaRecoverySessionStateActiveConsole) reason = @"Пользовательская сессия не является активной console-сессией";
  else if (readiness.lock_state == MetaRecoveryLockStateLocked) reason = @"Пользовательская сессия подтверждённо заблокирована";
  else if (readiness.secure_input != MetaRecoverySecureInputStateOff) reason = @"Secure Input не подтверждён как выключенный";
  else if (!readiness.observer_ready) reason = @"Готовность наблюдателя ввода не подтверждена";
  else if (held) reason = @"Состояние input остаётся нажатым; принадлежность неизвестна";
  else if (unknown) reason = @"Состояние ввода неизвестно";

  NSMutableDictionary *response = [@{
    @"protocolVersion" : owner[@"protocolVersion"],
    @"requestId" : request[@"requestId"],
    @"runtimeEpoch" : owner[@"runtimeEpoch"],
    @"loginSessionId" : owner[@"loginSessionId"],
    @"nativeGeneration" : owner[@"nativeGeneration"],
    @"kind" : @"held-recovery-response",
    @"nativeBuildId" : owner[@"nativeBuildId"],
    @"oldOperationId" : @(ledger.operation_id),
    @"oldRuntimeEpoch" : @(ledger.runtime_epoch),
    @"oldNativeGeneration" : @(ledger.native_generation),
    @"ledgerRevision" : @(ledger.revision),
    @"ledgerSha256" : @(digest),
    @"sampledAt" : timestamp_value(sampled_at),
    @"inputMonitoring" : @(readiness.input_monitoring),
    @"sessionState" : session_state(readiness.session_state),
    @"lockState" : lock_state(readiness.lock_state),
    @"secureInput" : secure_input_state(readiness.secure_input),
    @"observerReady" : @(readiness.observer_ready),
    @"source" : @"cg-combined-session-state",
    @"entries" : entries,
  } mutableCopy];
  if (reason != nil) response[@"reason"] = reason;
  return response;
}

static NSDate *system_now(void *context) {
  (void)context;
  return NSDate.date;
}

static MetaRecoveryObservedState sample_key(void *context, uint32_t code) {
  (void)context;
  if (code > UINT16_MAX) return MetaRecoveryObservedStateUnknown;
  return CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,
                               (CGKeyCode)code)
             ? MetaRecoveryObservedStateHeld
             : MetaRecoveryObservedStateUp;
}

static MetaRecoveryObservedState sample_button(void *context, uint32_t code) {
  (void)context;
  if (code > 31) return MetaRecoveryObservedStateUnknown;
  return CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState,
                                  (CGMouseButton)code)
             ? MetaRecoveryObservedStateHeld
             : MetaRecoveryObservedStateUp;
}

MetaRecoveryProbeBackend meta_recovery_probe_system_backend(void) {
  return (MetaRecoveryProbeBackend){
      .now = system_now,
      .sample_key = sample_key,
      .sample_button = sample_button,
  };
}
