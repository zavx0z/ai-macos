#include "meta_session_state.h"

#import <Carbon/Carbon.h>
#import <CoreGraphics/CGSession.h>

#include <math.h>

static BOOL valid_identifier(NSString *value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 ||
      value.length > maximum) {
    return NO;
  }
  unichar first = [value characterAtIndex:0];
  const BOOL valid_first =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return valid_first &&
         [value rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static BOOL unsigned_user_id(id value, uint32_t *user_id) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  const double number = [value doubleValue];
  if (!isfinite(number) || number < 0 || number > UINT32_MAX ||
      floor(number) != number) {
    return NO;
  }
  *user_id = [value unsignedIntValue];
  return true;
}

static BOOL boolean_fact(id value, bool *result) {
  if (value == nil ||
      CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()) {
    return NO;
  }
  *result = [value boolValue];
  return YES;
}

static NSString *timestamp(NSDate *value) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:value];
}

NSDictionary *meta_current_session_readiness_with_backend(
    NSString *expected_admitted_login_session_id,
    MetaSessionStateBackend backend) {
  if (!valid_identifier(expected_admitted_login_session_id, 64) ||
      backend.audit_identity == NULL || backend.now == NULL) {
    return nil;
  }
  NSDate *observed_at = backend.now(backend.context);
  if (![observed_at isKindOfClass:NSDate.class]) return nil;

  NSDictionary *current =
      backend.current_dictionary == NULL
          ? nil
          : backend.current_dictionary(backend.context);
  if (current != nil && ![current isKindOfClass:NSDictionary.class]) {
    current = nil;
  }
  MetaSessionIdentity audit = backend.audit_identity(backend.context);
  const BOOL audit_known =
      audit.verified && audit.audit_session_id != 0 &&
      audit.audit_session_id != UINT32_MAX &&
      audit.audit_user_id != UINT32_MAX;
  NSString *actual_login = audit_known
                               ? [NSString stringWithFormat:@"audit:%u:%u",
                                    audit.uid, audit.audit_session_id]
                               : nil;
  const BOOL admitted_matches =
      audit_known &&
      [expected_admitted_login_session_id isEqual:actual_login];
  const BOOL audit_user_matches =
      audit_known && audit.uid == audit.effective_uid &&
      audit.audit_user_id == audit.uid;

  uint32_t user_id = 0;
  bool on_console = false;
  bool login_done = false;
  const BOOL user_known =
      current != nil &&
      unsigned_user_id(current[(__bridge NSString *)kCGSessionUserIDKey],
                       &user_id);
  const BOOL console_known =
      current != nil &&
      boolean_fact(current[(__bridge NSString *)kCGSessionOnConsoleKey],
                   &on_console);
  const BOOL login_known =
      current != nil &&
      boolean_fact(current[(__bridge NSString *)kCGSessionLoginDoneKey],
                   &login_done);

  NSString *state = @"unknown";
  NSString *evidence =
      @"CGSession или Darwin audit не дают достаточных фактов о текущей сессии";
  if (admitted_matches && audit_user_matches && user_known &&
      user_id == audit.uid && console_known && login_known && on_console &&
      login_done) {
    state = @"active-console";
    evidence = @"CGSession и Darwin audit подтверждают активную console-сессию; lock state не наблюдается";
  } else if (admitted_matches && audit_user_matches && user_known &&
             console_known && login_known &&
             (user_id != audit.uid || !on_console || !login_done)) {
    state = @"inactive";
    evidence = @"CGSession подтверждает, что принятая audit-сессия сейчас не является активной console-сессией";
  } else if (!admitted_matches) {
    evidence = @"Текущая Darwin audit identity не совпадает с принятой login session";
  } else if (!audit_user_matches) {
    evidence = @"Darwin audit user, real uid и effective uid не совпадают";
  }

  NSString *secure_input = @"unknown";
  bool secure_enabled = false;
  if (backend.secure_input != NULL &&
      backend.secure_input(backend.context, &secure_enabled)) {
    secure_input = secure_enabled ? @"on" : @"off";
  }

  NSMutableDictionary *result = [@{
    @"state" : state,
    @"lockState" : @"unknown",
    @"secureInput" : secure_input,
    @"evidence" : evidence,
    @"observedAt" : timestamp(observed_at),
  } mutableCopy];
  if (user_known) result[@"userId"] = @(user_id);
  if (console_known) result[@"onConsole"] = @(on_console);
  if (login_known) result[@"loginDone"] = @(login_done);
  if (audit_known) result[@"auditSessionId"] = @(audit.audit_session_id);
  return result;
}

static NSDictionary *current_dictionary(void *context) {
  (void)context;
  CFDictionaryRef value = CGSessionCopyCurrentDictionary();
  return value == NULL ? nil : CFBridgingRelease(value);
}

static MetaSessionIdentity audit_identity(void *context) {
  (void)context;
  return meta_session_identity_read();
}

static bool secure_input(void *context, bool *enabled) {
  (void)context;
  if (enabled == NULL) return false;
  *enabled = IsSecureEventInputEnabled();
  return true;
}

static NSDate *current_time(void *context) {
  (void)context;
  return NSDate.date;
}

NSDictionary *meta_current_session_readiness(
    NSString *expected_admitted_login_session_id) {
  return meta_current_session_readiness_with_backend(
      expected_admitted_login_session_id,
      (MetaSessionStateBackend){
          .current_dictionary = current_dictionary,
          .audit_identity = audit_identity,
          .secure_input = secure_input,
          .now = current_time,
      });
}
