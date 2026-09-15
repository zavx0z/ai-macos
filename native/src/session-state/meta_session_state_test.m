#include "meta_session_state.h"

#import <CoreGraphics/CGSession.h>

#include <assert.h>
#include <stdio.h>

typedef struct {
  CFTypeRef current;
  MetaSessionIdentity audit;
  bool secure_known;
  bool secure_enabled;
  CFTypeRef observed_at;
  size_t dictionary_calls;
  size_t audit_calls;
  size_t secure_calls;
  size_t clock_calls;
} Fixture;

static NSDictionary *current_dictionary(void *context) {
  Fixture *fixture = context;
  fixture->dictionary_calls += 1;
  return (__bridge NSDictionary *)fixture->current;
}

static MetaSessionIdentity audit_identity(void *context) {
  Fixture *fixture = context;
  fixture->audit_calls += 1;
  return fixture->audit;
}

static bool secure_input(void *context, bool *enabled) {
  Fixture *fixture = context;
  fixture->secure_calls += 1;
  if (!fixture->secure_known) return false;
  *enabled = fixture->secure_enabled;
  return true;
}

static NSDate *current_time(void *context) {
  Fixture *fixture = context;
  fixture->clock_calls += 1;
  return (__bridge NSDate *)fixture->observed_at;
}

static MetaSessionStateBackend backend(Fixture *fixture) {
  return (MetaSessionStateBackend){
      .context = fixture,
      .current_dictionary = current_dictionary,
      .audit_identity = audit_identity,
      .secure_input = secure_input,
      .now = current_time,
  };
}

static NSDictionary *active_dictionary(void) {
  return @{
    (__bridge NSString *)kCGSessionUserIDKey : @501,
    (__bridge NSString *)kCGSessionOnConsoleKey : @YES,
    (__bridge NSString *)kCGSessionLoginDoneKey : @YES,
    @"CGSSessionScreenIsLocked" : @YES,
  };
}

static Fixture fixture(void) {
  return (Fixture){
      .current = CFBridgingRetain(active_dictionary()),
      .audit = {
          .uid = 501,
          .effective_uid = 501,
          .audit_user_id = 501,
          .audit_session_id = 100,
          .verified = true,
      },
      .secure_known = true,
      .observed_at = CFBridgingRetain(
          [NSDate dateWithTimeIntervalSince1970:1789455600]),
  };
}

static void set_current(Fixture *fixture, NSDictionary *value) {
  if (fixture->current != NULL) CFRelease(fixture->current);
  fixture->current = value == nil ? NULL : CFBridgingRetain(value);
}

static void release_fixture(Fixture *fixture) {
  if (fixture->current != NULL) CFRelease(fixture->current);
  if (fixture->observed_at != NULL) CFRelease(fixture->observed_at);
  fixture->current = NULL;
  fixture->observed_at = NULL;
}

static NSDictionary *read_result(Fixture *fixture) {
  return meta_current_session_readiness_with_backend(
      @"audit:501:100", backend(fixture));
}

static void test_active_console_keeps_lock_unknown(void) {
  Fixture value = fixture();
  NSDictionary *result = read_result(&value);
  assert([result[@"state"] isEqual:@"active-console"]);
  assert([result[@"userId"] isEqual:@501]);
  assert([result[@"onConsole"] isEqual:@YES]);
  assert([result[@"loginDone"] isEqual:@YES]);
  assert([result[@"auditSessionId"] isEqual:@100]);
  assert([result[@"lockState"] isEqual:@"unknown"]);
  assert([result[@"secureInput"] isEqual:@"off"]);
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSDate *parsed = [formatter dateFromString:result[@"observedAt"]];
  assert(parsed != nil);
  assert([parsed isEqual:(__bridge NSDate *)value.observed_at]);
  assert(value.dictionary_calls == 1);
  assert(value.audit_calls == 1);
  assert(value.secure_calls == 1);
  assert(value.clock_calls == 1);
  release_fixture(&value);
}

static void test_secure_input_is_separate_from_session_state(void) {
  Fixture value = fixture();
  value.secure_enabled = true;
  NSDictionary *result = read_result(&value);
  assert([result[@"state"] isEqual:@"active-console"]);
  assert([result[@"secureInput"] isEqual:@"on"]);
  assert([result[@"lockState"] isEqual:@"unknown"]);
  release_fixture(&value);
}

static void test_inactive_console_and_login(void) {
  Fixture value = fixture();
  set_current(&value, @{
    (__bridge NSString *)kCGSessionUserIDKey : @501,
    (__bridge NSString *)kCGSessionOnConsoleKey : @NO,
    (__bridge NSString *)kCGSessionLoginDoneKey : @YES,
  });
  NSDictionary *result = read_result(&value);
  assert([result[@"state"] isEqual:@"inactive"]);
  assert([result[@"onConsole"] isEqual:@NO]);

  set_current(&value, @{
    (__bridge NSString *)kCGSessionUserIDKey : @501,
    (__bridge NSString *)kCGSessionOnConsoleKey : @YES,
    (__bridge NSString *)kCGSessionLoginDoneKey : @NO,
  });
  result = read_result(&value);
  assert([result[@"state"] isEqual:@"inactive"]);
  assert([result[@"loginDone"] isEqual:@NO]);
  release_fixture(&value);
}

static void test_foreign_user_and_audit_are_not_active(void) {
  Fixture foreign_user = fixture();
  set_current(&foreign_user, @{
    (__bridge NSString *)kCGSessionUserIDKey : @502,
    (__bridge NSString *)kCGSessionOnConsoleKey : @YES,
    (__bridge NSString *)kCGSessionLoginDoneKey : @YES,
  });
  assert([[read_result(&foreign_user) objectForKey:@"state"] isEqual:@"inactive"]);
  release_fixture(&foreign_user);

  Fixture foreign_audit = fixture();
  foreign_audit.audit.audit_session_id = 101;
  NSDictionary *result = read_result(&foreign_audit);
  assert([result[@"state"] isEqual:@"unknown"]);
  assert([result[@"auditSessionId"] isEqual:@101]);
  release_fixture(&foreign_audit);

  Fixture mismatched_audit_user = fixture();
  mismatched_audit_user.audit.audit_user_id = 502;
  assert([[read_result(&mismatched_audit_user) objectForKey:@"state"]
      isEqual:@"unknown"]);
  release_fixture(&mismatched_audit_user);
}

static void test_missing_dictionary_and_unknown_flags(void) {
  Fixture missing = fixture();
  set_current(&missing, nil);
  missing.secure_known = false;
  NSDictionary *result = read_result(&missing);
  assert([result[@"state"] isEqual:@"unknown"]);
  assert(result[@"userId"] == nil);
  assert(result[@"onConsole"] == nil);
  assert(result[@"loginDone"] == nil);
  assert([result[@"secureInput"] isEqual:@"unknown"]);
  assert([result[@"lockState"] isEqual:@"unknown"]);
  release_fixture(&missing);

  Fixture unknown_flags = fixture();
  set_current(&unknown_flags, @{
    (__bridge NSString *)kCGSessionUserIDKey : @501,
    (__bridge NSString *)kCGSessionOnConsoleKey : @1,
    (__bridge NSString *)kCGSessionLoginDoneKey : @YES,
  });
  result = read_result(&unknown_flags);
  assert([result[@"state"] isEqual:@"unknown"]);
  assert(result[@"onConsole"] == nil);
  assert([result[@"loginDone"] isEqual:@YES]);
  release_fixture(&unknown_flags);

  Fixture unknown_audit = fixture();
  unknown_audit.audit.verified = false;
  result = read_result(&unknown_audit);
  assert([result[@"state"] isEqual:@"unknown"]);
  assert(result[@"auditSessionId"] == nil);
  release_fixture(&unknown_audit);
}

int main(void) {
  @autoreleasepool {
    test_active_console_keeps_lock_unknown();
    test_secure_input_is_separate_from_session_state();
    test_inactive_console_and_login();
    test_foreign_user_and_audit_are_not_active();
    test_missing_dictionary_and_unknown_flags();
    puts("session state fixture: ok");
  }
  return 0;
}
