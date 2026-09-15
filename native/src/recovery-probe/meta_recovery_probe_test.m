#include "meta_recovery_probe.h"

#include <assert.h>
#include <stdio.h>

#include "meta_ledger.h"

typedef struct {
  NSDate *now;
  NSDate *sampled_at;
  MetaRecoveryReadiness readiness;
  MetaRecoveryReadiness after_readiness;
  bool readiness_available;
  bool after_readiness_available;
  MetaRecoveryObservedState key_state;
  MetaRecoveryObservedState button_state;
  size_t readiness_calls;
  size_t key_calls;
  size_t button_calls;
  size_t now_calls;
} Fixture;

static NSDate *now(void *context) {
  Fixture *fixture = context;
  fixture->now_calls += 1;
  return fixture->now_calls == 1 ? fixture->now : fixture->sampled_at;
}

static bool readiness(void *context, MetaRecoveryReadiness *result) {
  Fixture *fixture = context;
  fixture->readiness_calls += 1;
  if (fixture->readiness_calls == 1) {
    *result = fixture->readiness;
    return fixture->readiness_available;
  }
  *result = fixture->after_readiness;
  return fixture->after_readiness_available;
}

static MetaRecoveryObservedState sample_key(void *context, uint32_t code) {
  Fixture *fixture = context;
  fixture->key_calls += 1;
  assert(code == 12);
  return fixture->key_state;
}

static MetaRecoveryObservedState sample_button(void *context, uint32_t code) {
  Fixture *fixture = context;
  fixture->button_calls += 1;
  assert(code == 1);
  return fixture->button_state;
}

static MetaRecoveryProbeBackend backend(Fixture *fixture) {
  return (MetaRecoveryProbeBackend){
      .context = fixture,
      .now = now,
      .readiness = readiness,
      .sample_key = sample_key,
      .sample_button = sample_button,
  };
}

static NSDictionary *owner(void) {
  return @{
    @"protocolVersion" : @"1",
    @"runtimeEpoch" : @"runtime-current",
    @"loginSessionId" : @"audit:501:100",
    @"nativeGeneration" : @"native-current",
    @"nativeBuildId" : @"build-current",
  };
}

static NSString *ledger_digest(void) {
  MetaLedgerEntry entries[] = {
      {.sequence = 1,
       .kind = META_EVENT_KEY,
       .code = 12,
       .state = META_LEDGER_CONFIRMED_DOWN},
      {.sequence = 2,
       .kind = META_EVENT_BUTTON,
       .code = 1,
       .state = META_LEDGER_UNCERTAIN},
      {.sequence = 3,
       .kind = META_EVENT_KEY,
       .code = 99,
       .state = META_LEDGER_RELEASED},
  };
  MetaHeldInputLedgerSnapshot snapshot = {
      .revision = 7,
      .entries = entries,
      .entry_count = 3,
  };
  snprintf(snapshot.operation_id, sizeof(snapshot.operation_id), "%s",
           "operation-old");
  snprintf(snapshot.runtime_epoch, sizeof(snapshot.runtime_epoch), "%s",
           "runtime-old");
  snprintf(snapshot.login_session_id, sizeof(snapshot.login_session_id), "%s",
           "audit:501:100");
  snprintf(snapshot.native_generation, sizeof(snapshot.native_generation), "%s",
           "native-old");
  char digest[65] = {0};
  assert(meta_ledger_snapshot_sha256(&snapshot, digest));
  return @(digest);
}

static NSDictionary *ledger(void) {
  return @{
    @"canonicalVersion" : @"1",
    @"operationId" : @"operation-old",
    @"runtimeEpoch" : @"runtime-old",
    @"loginSessionId" : @"audit:501:100",
    @"nativeGeneration" : @"native-old",
    @"revision" : @7,
    @"entries" : @[
      @{@"sequence" : @1,
        @"kind" : @"key",
        @"code" : @12,
        @"state" : @"confirmed-down"},
      @{@"sequence" : @2,
        @"kind" : @"button",
        @"code" : @1,
        @"state" : @"uncertain"},
      @{@"sequence" : @3,
        @"kind" : @"key",
        @"code" : @99,
        @"state" : @"released"},
    ],
  };
}

static NSDictionary *request(void) {
  return @{
    @"protocolVersion" : @"1",
    @"requestId" : @"recovery-request:1",
    @"runtimeEpoch" : @"runtime-current",
    @"loginSessionId" : @"audit:501:100",
    @"nativeGeneration" : @"native-current",
    @"kind" : @"held-recovery",
    @"deadlineAt" : @"2026-09-15T10:00:10.000Z",
    @"ledger" : ledger(),
    @"ack" : @{
      @"requestId" : @"ledger-request:7",
      @"operationId" : @"operation-old",
      @"runtimeEpoch" : @"runtime-old",
      @"loginSessionId" : @"audit:501:100",
      @"nativeGeneration" : @"native-old",
      @"revision" : @7,
      @"snapshotSha256" : ledger_digest(),
      @"persistedAt" : @"2026-09-15T09:59:00.000Z",
      @"durable" : @YES,
    },
  };
}

static Fixture fixture(void) {
  return (Fixture){
      .now = [NSDate dateWithTimeIntervalSince1970:1789455600],
      .sampled_at = [NSDate dateWithTimeIntervalSince1970:1789455600.1],
      .readiness = {
          .input_monitoring = true,
          .session_state = MetaRecoverySessionStateActiveConsole,
          .lock_state = MetaRecoveryLockStateUnknown,
          .secure_input = MetaRecoverySecureInputStateOff,
          .observer_ready = true,
      },
      .after_readiness = {
          .input_monitoring = true,
          .session_state = MetaRecoverySessionStateActiveConsole,
          .lock_state = MetaRecoveryLockStateUnknown,
          .secure_input = MetaRecoverySecureInputStateOff,
          .observer_ready = true,
      },
      .readiness_available = true,
      .after_readiness_available = true,
      .key_state = MetaRecoveryObservedStateUp,
      .button_state = MetaRecoveryObservedStateUp,
  };
}

static void assert_no_sampling(Fixture fixture) {
  assert(fixture.key_calls == 0);
  assert(fixture.button_calls == 0);
}

static void test_all_up_exact_response(void) {
  Fixture value = fixture();
  NSDictionary *response = meta_recovery_probe_receive(
      owner(), request(), backend(&value));
  assert(response != nil);
  assert([response[@"kind"] isEqual:@"held-recovery-response"]);
  assert([response[@"runtimeEpoch"] isEqual:@"runtime-current"]);
  assert([response[@"nativeGeneration"] isEqual:@"native-current"]);
  assert([response[@"nativeBuildId"] isEqual:@"build-current"]);
  assert([response[@"sessionState"] isEqual:@"active-console"]);
  assert([response[@"lockState"] isEqual:@"unknown"]);
  assert([response[@"secureInput"] isEqual:@"off"]);
  assert([response[@"oldOperationId"] isEqual:@"operation-old"]);
  assert([response[@"oldRuntimeEpoch"] isEqual:@"runtime-old"]);
  assert([response[@"oldNativeGeneration"] isEqual:@"native-old"]);
  assert([response[@"ledgerRevision"] isEqual:@7]);
  assert([response[@"ledgerSha256"] isEqual:ledger_digest()]);
  NSArray *entries = response[@"entries"];
  assert(entries.count == 2);
  assert([entries[0][@"sequence"] isEqual:@1]);
  assert([entries[0][@"kind"] isEqual:@"key"]);
  assert([entries[0][@"observed"] isEqual:@"up"]);
  assert([entries[1][@"sequence"] isEqual:@2]);
  assert([entries[1][@"kind"] isEqual:@"button"]);
  assert([entries[1][@"observed"] isEqual:@"up"]);
  assert(response[@"reason"] == nil);
  assert(value.key_calls == 1);
  assert(value.button_calls == 1);
  assert(value.readiness_calls == 2);
}

static void test_held_and_unknown_are_retained(void) {
  Fixture held = fixture();
  held.key_state = MetaRecoveryObservedStateHeld;
  NSDictionary *held_response = meta_recovery_probe_receive(
      owner(), request(), backend(&held));
  assert([held_response[@"entries"][0][@"observed"] isEqual:@"held"]);
  assert([held_response[@"reason"]
      isEqual:@"Состояние input остаётся нажатым; принадлежность неизвестна"]);

  Fixture unknown = fixture();
  unknown.button_state = MetaRecoveryObservedStateUnknown;
  NSDictionary *unknown_response = meta_recovery_probe_receive(
      owner(), request(), backend(&unknown));
  assert([unknown_response[@"entries"][1][@"observed"]
      isEqual:@"unknown"]);
  assert([unknown_response[@"reason"] isEqual:@"Состояние ввода неизвестно"]);
}

static void test_unready_sources_never_sample_cg(void) {
  Fixture permission = fixture();
  permission.readiness.input_monitoring = false;
  NSDictionary *permission_response = meta_recovery_probe_receive(
      owner(), request(), backend(&permission));
  assert([permission_response[@"inputMonitoring"] isEqual:@NO]);
  assert([permission_response[@"entries"][0][@"observed"]
      isEqual:@"unknown"]);
  assert_no_sampling(permission);

  Fixture secure = fixture();
  secure.readiness.secure_input = MetaRecoverySecureInputStateOn;
  NSDictionary *secure_response = meta_recovery_probe_receive(
      owner(), request(), backend(&secure));
  assert([secure_response[@"sessionState"] isEqual:@"active-console"]);
  assert([secure_response[@"secureInput"] isEqual:@"on"]);
  assert_no_sampling(secure);

  Fixture locked = fixture();
  locked.readiness.lock_state = MetaRecoveryLockStateLocked;
  NSDictionary *locked_response = meta_recovery_probe_receive(
      owner(), request(), backend(&locked));
  assert([locked_response[@"sessionState"] isEqual:@"active-console"]);
  assert([locked_response[@"lockState"] isEqual:@"locked"]);
  assert_no_sampling(locked);

  Fixture inactive = fixture();
  inactive.readiness.session_state = MetaRecoverySessionStateInactive;
  NSDictionary *inactive_response = meta_recovery_probe_receive(
      owner(), request(), backend(&inactive));
  assert([inactive_response[@"sessionState"] isEqual:@"inactive"]);
  assert_no_sampling(inactive);

  Fixture observer = fixture();
  observer.readiness.observer_ready = false;
  NSDictionary *observer_response = meta_recovery_probe_receive(
      owner(), request(), backend(&observer));
  assert([observer_response[@"observerReady"] isEqual:@NO]);
  assert_no_sampling(observer);

  Fixture absent = fixture();
  MetaRecoveryProbeBackend absent_backend = backend(&absent);
  absent_backend.readiness = NULL;
  NSDictionary *absent_response = meta_recovery_probe_receive(
      owner(), request(), absent_backend);
  assert([absent_response[@"sessionState"] isEqual:@"unknown"]);
  assert([absent_response[@"lockState"] isEqual:@"unknown"]);
  assert([absent_response[@"secureInput"] isEqual:@"unknown"]);
  assert([absent_response[@"inputMonitoring"] isEqual:@NO]);
  assert([absent_response[@"observerReady"] isEqual:@NO]);
  assert_no_sampling(absent);
}

static void test_readiness_revoked_during_batch_makes_all_unknown(void) {
  Fixture value = fixture();
  value.after_readiness.lock_state = MetaRecoveryLockStateLocked;
  value.after_readiness.observer_ready = false;
  NSDictionary *response = meta_recovery_probe_receive(
      owner(), request(), backend(&value));
  assert(response != nil);
  assert(value.key_calls == 1);
  assert(value.button_calls == 1);
  assert(value.readiness_calls == 2);
  assert([response[@"sessionState"] isEqual:@"active-console"]);
  assert([response[@"lockState"] isEqual:@"locked"]);
  assert([response[@"observerReady"] isEqual:@NO]);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }
  assert([response[@"reason"]
      isEqual:@"Пользовательская сессия подтверждённо заблокирована"]);
}

static void test_secure_input_enabled_during_batch_makes_all_unknown(void) {
  Fixture value = fixture();
  value.after_readiness.secure_input = MetaRecoverySecureInputStateOn;
  NSDictionary *response = meta_recovery_probe_receive(
      owner(), request(), backend(&value));
  assert(response != nil);
  assert(value.key_calls == 1);
  assert(value.button_calls == 1);
  assert([response[@"secureInput"] isEqual:@"on"]);
  for (NSDictionary *entry in response[@"entries"]) {
    assert([entry[@"observed"] isEqual:@"unknown"]);
  }
  assert([response[@"reason"]
      isEqual:@"Secure Input не подтверждён как выключенный"]);
}

static void test_backward_and_slow_clock_are_rejected(void) {
  Fixture backward = fixture();
  backward.sampled_at = [backward.now dateByAddingTimeInterval:-0.001];
  assert(meta_recovery_probe_receive(
             owner(), request(), backend(&backward)) == nil);
  assert(backward.key_calls == 1);
  assert(backward.button_calls == 1);

  Fixture slow = fixture();
  slow.sampled_at = [slow.now dateByAddingTimeInterval:1.001];
  assert(meta_recovery_probe_receive(owner(), request(), backend(&slow)) ==
         nil);
  assert(slow.key_calls == 1);
  assert(slow.button_calls == 1);
}

static void test_ack_digest_mismatch_is_rejected(void) {
  NSMutableDictionary *invalid = [request() mutableCopy];
  NSMutableDictionary *ack = [invalid[@"ack"] mutableCopy];
  ack[@"snapshotSha256"] =
      @"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  invalid[@"ack"] = ack;
  Fixture value = fixture();
  assert(meta_recovery_probe_receive(owner(), invalid, backend(&value)) == nil);
  assert(value.readiness_calls == 0);
  assert_no_sampling(value);
}

static void test_wrong_login_is_rejected(void) {
  NSMutableDictionary *invalid = [request() mutableCopy];
  invalid[@"loginSessionId"] = @"audit:501:999";
  Fixture value = fixture();
  assert(meta_recovery_probe_receive(owner(), invalid, backend(&value)) == nil);
  assert(value.readiness_calls == 0);
  assert_no_sampling(value);
}

static void test_invalid_ledger_code_is_rejected(void) {
  NSMutableDictionary *invalid = [request() mutableCopy];
  NSMutableDictionary *invalid_ledger = [invalid[@"ledger"] mutableCopy];
  NSMutableArray *entries = [invalid_ledger[@"entries"] mutableCopy];
  NSMutableDictionary *entry = [entries[0] mutableCopy];
  entry[@"code"] = @4294967296ULL;
  entries[0] = entry;
  invalid_ledger[@"entries"] = entries;
  invalid[@"ledger"] = invalid_ledger;
  Fixture value = fixture();
  assert(meta_recovery_probe_receive(owner(), invalid, backend(&value)) == nil);
  assert(value.readiness_calls == 0);
  assert_no_sampling(value);
}

int main(void) {
  @autoreleasepool {
    test_all_up_exact_response();
    test_held_and_unknown_are_retained();
    test_unready_sources_never_sample_cg();
    test_readiness_revoked_during_batch_makes_all_unknown();
    test_secure_input_enabled_during_batch_makes_all_unknown();
    test_backward_and_slow_clock_are_rejected();
    test_ack_digest_mismatch_is_rejected();
    test_wrong_login_is_rejected();
    test_invalid_ledger_code_is_rejected();
    puts("recovery probe fixture: ok");
  }
  return 0;
}
