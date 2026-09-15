#include "meta_domain_recovery.h"

#include "../recovery-domain/meta_recovery_domain.h"

#include <math.h>

#define META_DOMAIN_RECOVERY_MAX_HOLDS 512
#define META_DOMAIN_RECOVERY_MAX_SAFE_INTEGER 9007199254740991ULL

typedef struct {
  NSString *__unsafe_unretained kind;
  uint32_t code;
} MetaDomainRecoveryHold;

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

static BOOL sha256_value(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static BOOL boolean_value(id value, BOOL expected) {
  return value != nil &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() &&
         [value boolValue] == expected;
}

static BOOL unsigned_integer(id value, uint64_t minimum, uint64_t maximum,
                             uint64_t *result) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number ||
      number < (double)minimum || number > (double)maximum) return NO;
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

static BOOL valid_owner(NSDictionary *owner) {
  NSArray *keys = @[@"protocolVersion", @"runtimeEpoch", @"loginSessionId",
                    @"nativeGeneration", @"nativeBuildId"];
  return exact_keys(owner, keys, @[]) &&
         [owner[@"protocolVersion"] isEqual:@"1"] &&
         identifier(owner[@"runtimeEpoch"], 64) &&
         identifier(owner[@"loginSessionId"], 64) &&
         identifier(owner[@"nativeGeneration"], 64) &&
         identifier(owner[@"nativeBuildId"], 127);
}

static BOOL valid_request(NSDictionary *request) {
  NSArray *required = @[@"protocolVersion", @"requestId", @"runtimeEpoch",
                        @"loginSessionId", @"nativeGeneration", @"kind",
                        @"deadlineAt", @"grant"];
  return exact_keys(request, required, @[@"ledger", @"ack"]) &&
         [request[@"protocolVersion"] isEqual:@"1"] &&
         [request[@"kind"] isEqual:@"domain-recovery"] &&
         identifier(request[@"requestId"], 127) &&
         identifier(request[@"runtimeEpoch"], 64) &&
         identifier(request[@"loginSessionId"], 64) &&
         identifier(request[@"nativeGeneration"], 64) &&
         timestamp(request[@"deadlineAt"]) != nil;
}

static BOOL valid_descriptor(NSDictionary *descriptor,
                             MetaDomainRecoveryHold holds[512],
                             size_t *holdCount) {
  NSArray *keys = @[@"policyVersion", @"nativeBuildId", @"method", @"domain",
                    @"possibleHolds"];
  if (![descriptor isKindOfClass:NSDictionary.class]) return NO;
  NSArray *source = descriptor[@"possibleHolds"];
  if (!exact_keys(descriptor, keys, @[]) ||
      ![descriptor[@"policyVersion"] isEqual:@"1"] ||
      !identifier(descriptor[@"nativeBuildId"], 127) ||
      ![descriptor[@"method"] isKindOfClass:NSString.class] ||
      [descriptor[@"method"] length] == 0 ||
      [descriptor[@"method"] length] > 128 ||
      ![descriptor[@"domain"] isEqual:@"possible-held-input"] ||
      ![source isKindOfClass:NSArray.class] || source.count == 0 ||
      source.count > META_DOMAIN_RECOVERY_MAX_HOLDS) return NO;
  NSString *previous = nil;
  for (NSUInteger index = 0; index < source.count; index += 1) {
    NSDictionary *entry = source[index];
    uint64_t code = 0;
    if (!exact_keys(entry, @[@"kind", @"code"], @[]) ||
        !unsigned_integer(entry[@"code"], 0, UINT16_MAX, &code) ||
        ![@[@"key", @"button"] containsObject:entry[@"kind"]] ||
        ([entry[@"kind"] isEqual:@"button"] && code > 2)) return NO;
    NSString *sortKey = [NSString stringWithFormat:@"%@:%05llu", entry[@"kind"],
                                                   (unsigned long long)code];
    if (previous != nil && [sortKey compare:previous] != NSOrderedDescending) {
      return NO;
    }
    previous = sortKey;
    holds[index] = (MetaDomainRecoveryHold){entry[@"kind"], (uint32_t)code};
  }
  *holdCount = source.count;
  return YES;
}

static BOOL valid_grant(NSDictionary *grant,
                        MetaDomainRecoveryHold holds[512],
                        size_t *holdCount) {
  NSArray *keys = @[@"policyVersion", @"runtimeEpoch", @"loginSessionId",
                    @"nativeGeneration", @"operationId", @"contextSha256",
                    @"descriptor", @"descriptorSha256", @"journalRevision",
                    @"durable"];
  uint64_t revision = 0;
  if (!exact_keys(grant, keys, @[]) ||
      ![grant[@"policyVersion"] isEqual:@"1"] ||
      !identifier(grant[@"runtimeEpoch"], 64) ||
      !identifier(grant[@"loginSessionId"], 64) ||
      !identifier(grant[@"nativeGeneration"], 64) ||
      !identifier(grant[@"operationId"], 127) ||
      !sha256_value(grant[@"contextSha256"]) ||
      !sha256_value(grant[@"descriptorSha256"]) ||
      !unsigned_integer(grant[@"journalRevision"], 1,
                        META_DOMAIN_RECOVERY_MAX_SAFE_INTEGER, &revision) ||
      !boolean_value(grant[@"durable"], YES) ||
      !valid_descriptor(grant[@"descriptor"], holds, holdCount)) return NO;
  NSString *descriptorDigest =
      meta_recovery_domain_sha256(grant[@"descriptor"]);
  return [grant[@"descriptorSha256"] isEqual:descriptorDigest];
}

static BOOL hold_matches(NSString *kind, uint32_t code,
                         const MetaDomainRecoveryHold holds[512],
                         size_t holdCount) {
  for (size_t index = 0; index < holdCount; index += 1) {
    if ([kind isEqual:holds[index].kind] && code == holds[index].code) {
      return YES;
    }
  }
  return NO;
}

static BOOL ledger_subset_matches(NSDictionary *ledger, NSDictionary *grant,
                                  const MetaDomainRecoveryHold holds[512],
                                  size_t holdCount) {
  if (![ledger[@"operationId"] isEqual:grant[@"operationId"]] ||
      ![ledger[@"runtimeEpoch"] isEqual:grant[@"runtimeEpoch"]] ||
      ![ledger[@"loginSessionId"] isEqual:grant[@"loginSessionId"]] ||
      ![ledger[@"nativeGeneration"] isEqual:grant[@"nativeGeneration"]] ||
      ![ledger[@"entries"] isKindOfClass:NSArray.class]) return NO;
  for (NSDictionary *entry in ledger[@"entries"]) {
    if ([entry[@"state"] isEqual:@"released"]) continue;
    uint64_t code = 0;
    if (!unsigned_integer(entry[@"code"], 0, UINT16_MAX, &code) ||
        !hold_matches(entry[@"kind"], (uint32_t)code, holds, holdCount)) {
      return NO;
    }
  }
  return YES;
}

static BOOL readiness_ready(MetaRecoveryReadiness value) {
  return value.input_monitoring && value.observer_ready &&
         value.session_state == MetaRecoverySessionStateActiveConsole &&
         value.lock_state == MetaRecoveryLockStateUnknown &&
         value.secure_input == MetaRecoverySecureInputStateOff;
}

static BOOL same_readiness(MetaRecoveryReadiness left,
                           MetaRecoveryReadiness right) {
  return left.input_monitoring == right.input_monitoring &&
         left.observer_ready == right.observer_ready &&
         left.session_state == right.session_state &&
         left.lock_state == right.lock_state &&
         left.secure_input == right.secure_input;
}

static NSString *session_state(MetaRecoverySessionState state) {
  if (state == MetaRecoverySessionStateActiveConsole) return @"active-console";
  if (state == MetaRecoverySessionStateInactive) return @"inactive";
  return @"unknown";
}

static NSString *lock_state(MetaRecoveryLockState state) {
  return state == MetaRecoveryLockStateLocked ? @"locked" : @"unknown";
}

static NSString *secure_input(MetaRecoverySecureInputState state) {
  if (state == MetaRecoverySecureInputStateOff) return @"off";
  if (state == MetaRecoverySecureInputStateOn) return @"on";
  return @"unknown";
}

static NSString *observed_state(MetaRecoveryObservedState state) {
  if (state == MetaRecoveryObservedStateUp) return @"up";
  if (state == MetaRecoveryObservedStateHeld) return @"held";
  return @"unknown";
}

static NSString *readiness_reason(BOOL available,
                                  MetaRecoveryReadiness readiness) {
  if (!available) return @"Проверенная готовность domain recovery недоступна";
  if (!readiness.input_monitoring) return @"Input Monitoring не подтверждён";
  if (readiness.session_state != MetaRecoverySessionStateActiveConsole) {
    return @"Пользовательская сессия не является active-console";
  }
  if (readiness.lock_state == MetaRecoveryLockStateLocked) {
    return @"Пользовательская сессия подтверждённо заблокирована";
  }
  if (readiness.secure_input != MetaRecoverySecureInputStateOff) {
    return @"Secure Input не подтверждён как выключенный";
  }
  if (!readiness.observer_ready) return @"Observer readiness не подтверждена";
  return nil;
}

NSDictionary *meta_domain_recovery_receive(
    NSDictionary *owner, NSDictionary *request,
    MetaRecoveryProbeBackend backend) {
  MetaDomainRecoveryHold holds[META_DOMAIN_RECOVERY_MAX_HOLDS] = {0};
  size_t holdCount = 0;
  if (![request isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *grant = request[@"grant"];
  if (!valid_owner(owner) || !valid_request(request) || backend.now == NULL ||
      ![request[@"protocolVersion"] isEqual:owner[@"protocolVersion"]] ||
      ![request[@"runtimeEpoch"] isEqual:owner[@"runtimeEpoch"]] ||
      ![request[@"loginSessionId"] isEqual:owner[@"loginSessionId"]] ||
      ![request[@"nativeGeneration"] isEqual:owner[@"nativeGeneration"]] ||
      !valid_grant(grant, holds, &holdCount) ||
      ![grant[@"loginSessionId"] isEqual:owner[@"loginSessionId"]]) {
    return nil;
  }
  BOOL hasLedger = request[@"ledger"] != nil;
  BOOL hasAck = request[@"ack"] != nil;
  if (hasLedger != hasAck) return nil;
  if (hasLedger &&
      (!meta_recovery_ledger_ack_valid(request[@"ledger"], request[@"ack"]) ||
       !ledger_subset_matches(request[@"ledger"], grant, holds, holdCount))) {
    return nil;
  }
  NSString *grantDigest = meta_recovery_domain_sha256(grant);
  if (!sha256_value(grantDigest)) return nil;

  NSDate *startedAt = backend.now(backend.context);
  NSDate *deadline = timestamp(request[@"deadlineAt"]);
  if (![startedAt isKindOfClass:NSDate.class] || deadline == nil ||
      [startedAt compare:deadline] != NSOrderedAscending) return nil;
  MetaRecoveryReadiness before = {
      .session_state = MetaRecoverySessionStateUnknown,
      .lock_state = MetaRecoveryLockStateUnknown,
      .secure_input = MetaRecoverySecureInputStateUnknown,
  };
  BOOL readinessAvailable = backend.readiness != NULL &&
      backend.readiness(backend.context, &before);
  if (!readinessAvailable) {
    before = (MetaRecoveryReadiness){
        .session_state = MetaRecoverySessionStateUnknown,
        .lock_state = MetaRecoveryLockStateUnknown,
        .secure_input = MetaRecoverySecureInputStateUnknown,
    };
  }
  BOOL ready = readinessAvailable && readiness_ready(before);
  MetaRecoveryObservedState observations[META_DOMAIN_RECOVERY_MAX_HOLDS] = {0};
  for (size_t index = 0; index < holdCount; index += 1) {
    observations[index] = MetaRecoveryObservedStateUnknown;
    if (!ready) continue;
    if ([holds[index].kind isEqual:@"key"] && backend.sample_key != NULL) {
      observations[index] =
          backend.sample_key(backend.context, holds[index].code);
    } else if ([holds[index].kind isEqual:@"button"] &&
               backend.sample_button != NULL) {
      observations[index] =
          backend.sample_button(backend.context, holds[index].code);
    }
    if (observations[index] != MetaRecoveryObservedStateUp &&
        observations[index] != MetaRecoveryObservedStateHeld) {
      observations[index] = MetaRecoveryObservedStateUnknown;
    }
  }

  MetaRecoveryReadiness finalReadiness = before;
  BOOL readinessChanged = NO;
  if (ready) {
    MetaRecoveryReadiness after = {
        .session_state = MetaRecoverySessionStateUnknown,
        .lock_state = MetaRecoveryLockStateUnknown,
        .secure_input = MetaRecoverySecureInputStateUnknown,
    };
    BOOL afterAvailable = backend.readiness != NULL &&
        backend.readiness(backend.context, &after);
    readinessChanged = !afterAvailable || !readiness_ready(after) ||
                       !same_readiness(before, after);
    readinessAvailable = afterAvailable;
    finalReadiness = afterAvailable
        ? after
        : (MetaRecoveryReadiness){
              .session_state = MetaRecoverySessionStateUnknown,
              .lock_state = MetaRecoveryLockStateUnknown,
              .secure_input = MetaRecoverySecureInputStateUnknown,
          };
  }

  NSDate *finishedAt = backend.now(backend.context);
  BOOL timingInvalid = ![finishedAt isKindOfClass:NSDate.class] ||
      [finishedAt compare:startedAt] == NSOrderedAscending ||
      [finishedAt timeIntervalSinceDate:startedAt] > 1.0 ||
      [finishedAt compare:deadline] != NSOrderedAscending;
  if (readinessChanged || timingInvalid) {
    for (size_t index = 0; index < holdCount; index += 1) {
      observations[index] = MetaRecoveryObservedStateUnknown;
    }
  }
  NSDate *sampledAt = [finishedAt isKindOfClass:NSDate.class] &&
                              [finishedAt compare:startedAt] != NSOrderedAscending
                          ? finishedAt
                          : startedAt;
  NSMutableArray *entries = [NSMutableArray arrayWithCapacity:holdCount];
  BOOL held = NO;
  BOOL unknown = NO;
  for (size_t index = 0; index < holdCount; index += 1) {
    MetaRecoveryObservedState state = observations[index];
    held = held || state == MetaRecoveryObservedStateHeld;
    unknown = unknown || state == MetaRecoveryObservedStateUnknown;
    [entries addObject:@{
      @"kind" : holds[index].kind,
      @"code" : @(holds[index].code),
      @"observed" : observed_state(state),
    }];
  }
  NSString *reason = readiness_reason(readinessAvailable, finalReadiness);
  if (reason == nil && readinessChanged) {
    reason = @"Readiness изменилась во время passive sampling";
  } else if (reason == nil && timingInvalid) {
    reason = @"Passive sampling вышел за deadline, 1s budget или clock monotonicity";
  } else if (reason == nil && held) {
    reason = @"Состояние input остаётся нажатым; принадлежность неизвестна";
  } else if (reason == nil && unknown) {
    reason = @"Состояние declared input risk set неизвестно";
  }
  NSMutableDictionary *response = [@{
    @"protocolVersion" : owner[@"protocolVersion"],
    @"requestId" : request[@"requestId"],
    @"runtimeEpoch" : owner[@"runtimeEpoch"],
    @"loginSessionId" : owner[@"loginSessionId"],
    @"nativeGeneration" : owner[@"nativeGeneration"],
    @"kind" : @"domain-recovery-response",
    @"nativeBuildId" : owner[@"nativeBuildId"],
    @"oldOperationId" : grant[@"operationId"],
    @"oldRuntimeEpoch" : grant[@"runtimeEpoch"],
    @"oldNativeGeneration" : grant[@"nativeGeneration"],
    @"grantSha256" : grantDigest,
    @"descriptorSha256" : grant[@"descriptorSha256"],
    @"sampledAt" : timestamp_value(sampledAt),
    @"inputMonitoring" : finalReadiness.input_monitoring ? @YES : @NO,
    @"observerReady" : finalReadiness.observer_ready ? @YES : @NO,
    @"sessionState" : session_state(finalReadiness.session_state),
    @"lockState" : lock_state(finalReadiness.lock_state),
    @"secureInput" : secure_input(finalReadiness.secure_input),
    @"source" : @"cg-combined-session-state",
    @"entries" : entries,
  } mutableCopy];
  if (reason != nil) response[@"reason"] = reason;
  return response;
}
