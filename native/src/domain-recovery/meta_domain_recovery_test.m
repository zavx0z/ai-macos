#include "meta_domain_recovery.h"

#include "../recovery-domain/meta_recovery_domain.h"
#include "meta_ledger.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  __unsafe_unretained NSDate *times[3];
  size_t nowCalls;
  MetaRecoveryReadiness readinessValues[2];
  bool readinessAvailable[2];
  size_t readinessCalls;
  size_t keyCalls;
  size_t buttonCalls;
  uint32_t sampledCodes[4];
  MetaRecoveryObservedState keyStates[2];
  MetaRecoveryObservedState buttonState;
} Fixture;

static NSDate *fixture_now(void *context) {
  Fixture *fixture = context;
  size_t index = fixture->nowCalls < 3 ? fixture->nowCalls : 2;
  fixture->nowCalls += 1;
  return fixture->times[index];
}

static bool fixture_readiness(void *context,
                              MetaRecoveryReadiness *readiness) {
  Fixture *fixture = context;
  size_t index = fixture->readinessCalls < 2 ? fixture->readinessCalls : 1;
  fixture->readinessCalls += 1;
  if (!fixture->readinessAvailable[index]) return false;
  *readiness = fixture->readinessValues[index];
  return true;
}

static MetaRecoveryObservedState fixture_key(void *context, uint32_t code) {
  Fixture *fixture = context;
  fixture->sampledCodes[fixture->keyCalls + fixture->buttonCalls] = code;
  MetaRecoveryObservedState state = fixture->keyStates[fixture->keyCalls];
  fixture->keyCalls += 1;
  return state;
}

static MetaRecoveryObservedState fixture_button(void *context, uint32_t code) {
  Fixture *fixture = context;
  fixture->sampledCodes[fixture->keyCalls + fixture->buttonCalls] = code;
  fixture->buttonCalls += 1;
  return fixture->buttonState;
}

static MetaRecoveryProbeBackend fixture_backend(Fixture *fixture) {
  return (MetaRecoveryProbeBackend){
      .context = fixture,
      .now = fixture_now,
      .readiness = fixture_readiness,
      .sample_key = fixture_key,
      .sample_button = fixture_button,
  };
}

static MetaRecoveryReadiness ready(void) {
  return (MetaRecoveryReadiness){
      .input_monitoring = true,
      .session_state = MetaRecoverySessionStateActiveConsole,
      .lock_state = MetaRecoveryLockStateUnknown,
      .secure_input = MetaRecoverySecureInputStateOff,
      .observer_ready = true,
  };
}

static NSString *fixture_timestamp(NSDate *value) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:value];
}

static Fixture fixture(void) {
  NSDate *started = [NSDate dateWithTimeIntervalSince1970:1789455600];
  return (Fixture){
      .times = {started, [started dateByAddingTimeInterval:0.1],
                [started dateByAddingTimeInterval:0.1]},
      .readinessValues = {ready(), ready()},
      .readinessAvailable = {true, true},
      .keyStates = {MetaRecoveryObservedStateUp,
                    MetaRecoveryObservedStateUp},
      .buttonState = MetaRecoveryObservedStateUp,
  };
}

static NSDictionary *owner(void) {
  return @{
    @"protocolVersion" : @"1",
    @"runtimeEpoch" : @"runtime-current",
    @"loginSessionId" : @"login-same",
    @"nativeGeneration" : @"native-current",
    @"nativeBuildId" : @"build-current",
  };
}

static NSDictionary *descriptor(NSArray *holds) {
  return @{
    @"policyVersion" : @"1",
    @"nativeBuildId" : @"build-old",
    @"method" : @"input.execute",
    @"domain" : @"possible-held-input",
    @"possibleHolds" : holds,
  };
}

static NSDictionary *grant(NSArray *holds) {
  NSDictionary *risk = descriptor(holds);
  return @{
    @"policyVersion" : @"1",
    @"runtimeEpoch" : @"runtime-old",
    @"loginSessionId" : @"login-same",
    @"nativeGeneration" : @"native-old",
    @"operationId" : @"operation-old",
    @"contextSha256" : @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"descriptor" : risk,
    @"descriptorSha256" : meta_recovery_domain_sha256(risk),
    @"journalRevision" : @3,
    @"durable" : @YES,
  };
}

static NSDictionary *request(NSArray *holds, NSDictionary *ledger,
                             NSDictionary *ack) {
  NSMutableDictionary *value = [@{
    @"protocolVersion" : @"1",
    @"requestId" : @"domain-recovery-1",
    @"runtimeEpoch" : @"runtime-current",
    @"loginSessionId" : @"login-same",
    @"nativeGeneration" : @"native-current",
    @"kind" : @"domain-recovery",
    @"deadlineAt" : @"2026-09-15T10:00:02.000Z",
    @"grant" : grant(holds),
  } mutableCopy];
  if (ledger != nil) value[@"ledger"] = ledger;
  if (ack != nil) value[@"ack"] = ack;
  return value;
}

static NSString *ledger_digest(NSArray *entries) {
  MetaLedgerEntry nativeEntries[4] = {0};
  for (NSUInteger index = 0; index < entries.count; index += 1) {
    NSDictionary *entry = entries[index];
    MetaLedgerState state = [entry[@"state"] isEqual:@"released"]
                                ? META_LEDGER_RELEASED
                                : META_LEDGER_CONFIRMED_DOWN;
    nativeEntries[index] = (MetaLedgerEntry){
        .sequence = [entry[@"sequence"] unsignedLongLongValue],
        .kind = [entry[@"kind"] isEqual:@"key"] ? META_EVENT_KEY
                                                  : META_EVENT_BUTTON,
        .code = [entry[@"code"] unsignedIntValue],
        .state = state,
    };
  }
  MetaHeldInputLedgerSnapshot snapshot = {
      .revision = 7,
      .entries = nativeEntries,
      .entry_count = entries.count,
  };
  snprintf(snapshot.operation_id, sizeof(snapshot.operation_id), "%s",
           "operation-old");
  snprintf(snapshot.runtime_epoch, sizeof(snapshot.runtime_epoch), "%s",
           "runtime-old");
  snprintf(snapshot.login_session_id, sizeof(snapshot.login_session_id), "%s",
           "login-same");
  snprintf(snapshot.native_generation, sizeof(snapshot.native_generation),
           "%s", "native-old");
  char digest[65] = {0};
  assert(meta_ledger_snapshot_sha256(&snapshot, digest));
  return @(digest);
}

static NSDictionary *ledger(NSArray *entries) {
  return @{
    @"canonicalVersion" : @"1",
    @"operationId" : @"operation-old",
    @"runtimeEpoch" : @"runtime-old",
    @"loginSessionId" : @"login-same",
    @"nativeGeneration" : @"native-old",
    @"revision" : @7,
    @"entries" : entries,
  };
}

static NSDictionary *ack(NSArray *entries) {
  return @{
    @"requestId" : @"ledger-request-7",
    @"operationId" : @"operation-old",
    @"runtimeEpoch" : @"runtime-old",
    @"loginSessionId" : @"login-same",
    @"nativeGeneration" : @"native-old",
    @"revision" : @7,
    @"snapshotSha256" : ledger_digest(entries),
    @"persistedAt" : @"2026-09-15T09:59:00.000Z",
    @"durable" : @YES,
  };
}

static void assert_response_identity(NSDictionary *response,
                                     NSDictionary *source) {
  assert([response[@"kind"] isEqual:@"domain-recovery-response"]);
  assert([response[@"requestId"] isEqual:source[@"requestId"]]);
  assert([response[@"runtimeEpoch"] isEqual:owner()[@"runtimeEpoch"]]);
  assert([response[@"nativeGeneration"]
      isEqual:owner()[@"nativeGeneration"]]);
  assert([response[@"nativeBuildId"] isEqual:@"build-current"]);
  assert([response[@"oldOperationId"] isEqual:@"operation-old"]);
  assert([response[@"oldRuntimeEpoch"] isEqual:@"runtime-old"]);
  assert([response[@"oldNativeGeneration"] isEqual:@"native-old"]);
  assert([response[@"grantSha256"]
      isEqual:meta_recovery_domain_sha256(source[@"grant"])]);
  assert([response[@"descriptorSha256"]
      isEqual:source[@"grant"][@"descriptorSha256"]]);
  assert([response[@"source"] isEqual:@"cg-combined-session-state"]);
}

static void test_unicode_text_key_zero_without_ledger(void) {
  NSArray *holds = @[@{@"kind" : @"key", @"code" : @0}];
  NSDictionary *source = request(holds, nil, nil);
  Fixture state = fixture();
  NSDictionary *response = meta_domain_recovery_receive(
      owner(), source, fixture_backend(&state));
  assert_response_identity(response, source);
  assert(([response[@"entries"] isEqual:@[
    @{@"kind" : @"key", @"code" : @0, @"observed" : @"up"}
  ]]));
  assert(response[@"reason"] == nil);
  assert(state.keyCalls == 1 && state.sampledCodes[0] == 0);
}

static void test_partial_shortcut_ledger_does_not_narrow_risk_set(void) {
  NSArray *holds = @[
    @{@"kind" : @"key", @"code" : @7},
    @{@"kind" : @"key", @"code" : @42},
  ];
  NSArray *entries = @[
    @{@"sequence" : @1, @"kind" : @"key", @"code" : @7,
      @"state" : @"confirmed-down"},
  ];
  NSDictionary *source = request(holds, ledger(entries), ack(entries));
  Fixture state = fixture();
  NSDictionary *response = meta_domain_recovery_receive(
      owner(), source, fixture_backend(&state));
  assert(response != nil && [response[@"entries"] count] == 2);
  assert(state.keyCalls == 2);
  assert(state.sampledCodes[0] == 7 && state.sampledCodes[1] == 42);
}

static void test_changed_readiness_discards_every_sample(void) {
  NSArray *holds = @[
    @{@"kind" : @"button", @"code" : @1},
    @{@"kind" : @"key", @"code" : @12},
  ];
  Fixture state = fixture();
  state.readinessValues[1].secure_input = MetaRecoverySecureInputStateOn;
  NSDictionary *response = meta_domain_recovery_receive(
      owner(), request(holds, nil, nil), fixture_backend(&state));
  assert(state.buttonCalls == 1 && state.keyCalls == 1);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }
  assert([response[@"secureInput"] isEqual:@"on"]);
  assert(response[@"reason"] != nil);
}

static void test_invalid_grant_ack_and_subset_are_rejected(void) {
  NSArray *holds = @[@{@"kind" : @"key", @"code" : @7}];
  Fixture state = fixture();
  NSMutableDictionary *badGrant = [request(holds, nil, nil) mutableCopy];
  NSMutableDictionary *grantValue = [badGrant[@"grant"] mutableCopy];
  grantValue[@"descriptorSha256"] =
      @"0000000000000000000000000000000000000000000000000000000000000000";
  badGrant[@"grant"] = grantValue;
  assert(meta_domain_recovery_receive(
      owner(), badGrant, fixture_backend(&state)) == nil);

  NSMutableDictionary *malformed = [request(holds, nil, nil) mutableCopy];
  grantValue = [malformed[@"grant"] mutableCopy];
  grantValue[@"descriptor"] = NSNull.null;
  malformed[@"grant"] = grantValue;
  state = fixture();
  assert(meta_domain_recovery_receive(
      owner(), malformed, fixture_backend(&state)) == nil);
  assert(meta_domain_recovery_receive(
      owner(), (NSDictionary *)(id)@"not-a-request",
      fixture_backend(&state)) == nil);

  NSMutableDictionary *notDurable = [request(holds, nil, nil) mutableCopy];
  grantValue = [notDurable[@"grant"] mutableCopy];
  grantValue[@"durable"] = @NO;
  notDurable[@"grant"] = grantValue;
  state = fixture();
  assert(meta_domain_recovery_receive(
      owner(), notDurable, fixture_backend(&state)) == nil);

  NSArray *entries = @[
    @{@"sequence" : @1, @"kind" : @"key", @"code" : @7,
      @"state" : @"confirmed-down"},
  ];
  NSMutableDictionary *badAck = [ack(entries) mutableCopy];
  badAck[@"snapshotSha256"] =
      @"1111111111111111111111111111111111111111111111111111111111111111";
  state = fixture();
  assert(meta_domain_recovery_receive(
      owner(), request(holds, ledger(entries), badAck),
      fixture_backend(&state)) == nil);

  NSArray *outside = @[
    @{@"sequence" : @1, @"kind" : @"key", @"code" : @42,
      @"state" : @"confirmed-down"},
  ];
  state = fixture();
  assert(meta_domain_recovery_receive(
      owner(), request(holds, ledger(outside), ack(outside)),
      fixture_backend(&state)) == nil);
}

static void test_unready_and_invalid_timing_never_claim_samples(void) {
  NSArray *holds = @[
    @{@"kind" : @"key", @"code" : @7},
    @{@"kind" : @"key", @"code" : @42},
  ];
  Fixture state = fixture();
  state.readinessValues[0].input_monitoring = false;
  NSDictionary *response = meta_domain_recovery_receive(
      owner(), request(holds, nil, nil), fixture_backend(&state));
  assert(state.keyCalls == 0 && state.buttonCalls == 0);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }

  state = fixture();
  state.times[1] = [state.times[0] dateByAddingTimeInterval:-0.1];
  response = meta_domain_recovery_receive(
      owner(), request(holds, nil, nil), fixture_backend(&state));
  assert(response != nil);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }
  assert([response[@"sampledAt"]
      isEqual:fixture_timestamp(state.times[0])]);

  state = fixture();
  state.times[1] = [state.times[0] dateByAddingTimeInterval:1.1];
  response = meta_domain_recovery_receive(
      owner(), request(holds, nil, nil), fixture_backend(&state));
  assert(response != nil);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }
  assert(response[@"reason"] != nil);
}

int main(void) {
  @autoreleasepool {
    test_unicode_text_key_zero_without_ledger();
    test_partial_shortcut_ledger_does_not_narrow_risk_set();
    test_changed_readiness_discards_every_sample();
    test_invalid_grant_ack_and_subset_are_rejected();
    test_unready_and_invalid_timing_never_claim_samples();
  }
  puts("domain recovery tests passed");
}
