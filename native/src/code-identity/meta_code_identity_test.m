#include "meta_code_identity.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  OSStatus self_status;
  OSStatus signing_status;
  CFTypeRef signing_information;
  const char *fallback_path;
  size_t self_calls;
  size_t signing_calls;
  size_t path_calls;
  SecCSFlags observed_flags;
} Fixture;

static OSStatus copy_self(void *context, SecCodeRef *code) {
  Fixture *fixture = context;
  fixture->self_calls += 1;
  if (fixture->self_status != errSecSuccess) return fixture->self_status;
  *code = (SecCodeRef)CFRetain(CFSTR("fake-self-code"));
  return errSecSuccess;
}

static OSStatus copy_signing_information(void *context, SecCodeRef code,
                                         SecCSFlags flags,
                                         CFDictionaryRef *information) {
  Fixture *fixture = context;
  fixture->signing_calls += 1;
  fixture->observed_flags = flags;
  assert(code != NULL);
  if (fixture->signing_status != errSecSuccess) {
    return fixture->signing_status;
  }
  if (fixture->signing_information != NULL) {
    *information = (CFDictionaryRef)CFRetain(fixture->signing_information);
  }
  return errSecSuccess;
}

static int executable_path(void *context, char *buffer, uint32_t *size) {
  Fixture *fixture = context;
  fixture->path_calls += 1;
  if (fixture->fallback_path == NULL || size == NULL) return -1;
  const size_t required = strlen(fixture->fallback_path) + 1;
  if (required > UINT32_MAX) return -1;
  if (buffer == NULL || *size < required) {
    *size = (uint32_t)required;
    return -1;
  }
  memcpy(buffer, fixture->fallback_path, required);
  *size = (uint32_t)required;
  return 0;
}

static MetaCodeIdentityBackend backend(Fixture *fixture) {
  return (MetaCodeIdentityBackend){
      .context = fixture,
      .copy_self = copy_self,
      .copy_signing_information = copy_signing_information,
      .executable_path = executable_path,
  };
}

static NSData *valid_cdhash(void) {
  uint8_t bytes[20];
  for (size_t index = 0; index < sizeof(bytes); index += 1) {
    bytes[index] = (uint8_t)index;
  }
  return [NSData dataWithBytes:bytes length:sizeof(bytes)];
}

static void test_valid_signed_self(void) {
  NSDictionary *information = @{
    (__bridge NSString *)kSecCodeInfoUnique : valid_cdhash(),
    (__bridge NSString *)kSecCodeInfoMainExecutable :
        [NSURL fileURLWithPath:@"/Applications/Meta Native.app/Contents/MacOS/meta-native"],
  };
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecSuccess,
      .signing_information = (__bridge CFTypeRef)information,
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureSelfUnavailable;
  NSDictionary *identity = meta_code_identity_read_with_backend(
      backend(&fixture), &failure);
  assert(identity != nil);
  assert(failure == MetaCodeIdentityFailureNone);
  assert([identity[@"helperPath"] isEqual:
      @"/Applications/Meta Native.app/Contents/MacOS/meta-native"]);
  assert([identity[@"cdhash"] isEqual:
      @"000102030405060708090a0b0c0d0e0f10111213"]);
  assert(fixture.self_calls == 1);
  assert(fixture.signing_calls == 1);
  assert(fixture.path_calls == 0);
  assert(fixture.observed_flags == kSecCSSigningInformation);
}

static void test_unsigned_self(void) {
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecCSUnsigned,
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureUnsigned);
  assert(fixture.path_calls == 0);
}

static void test_unsigned_self_lookup(void) {
  Fixture fixture = {
      .self_status = errSecCSUnsigned,
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureUnsigned);
  assert(fixture.signing_calls == 0);
  assert(fixture.path_calls == 0);
}

static void test_failed_self_lookup(void) {
  Fixture fixture = {
      .self_status = errSecInternalComponent,
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureSelfUnavailable);
  assert(fixture.signing_calls == 0);
  assert(fixture.path_calls == 0);
}

static void test_malformed_signing_information(void) {
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecSuccess,
      .signing_information = CFSTR("not-a-dictionary"),
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureMalformedSigningInformation);
}

static void test_malformed_cdhash(void) {
  NSDictionary *information = @{
    (__bridge NSString *)kSecCodeInfoUnique : @"caller-supplied-digest",
    (__bridge NSString *)kSecCodeInfoMainExecutable :
        [NSURL fileURLWithPath:@"/tmp/candidate"],
  };
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecSuccess,
      .signing_information = (__bridge CFTypeRef)information,
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureMalformedCDHash);
  assert(fixture.path_calls == 0);
}

static void test_path_only_fallback(void) {
  NSDictionary *information = @{
    (__bridge NSString *)kSecCodeInfoUnique : valid_cdhash(),
  };
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecSuccess,
      .signing_information = (__bridge CFTypeRef)information,
      .fallback_path = "/private/tmp/meta-native-loaded",
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  NSDictionary *identity = meta_code_identity_read_with_backend(
      backend(&fixture), &failure);
  assert(identity != nil);
  assert([identity[@"helperPath"] isEqual:@"/private/tmp/meta-native-loaded"]);
  assert(fixture.path_calls == 2);
}

static void test_malformed_fallback_path(void) {
  NSDictionary *information = @{
    (__bridge NSString *)kSecCodeInfoUnique : valid_cdhash(),
  };
  Fixture fixture = {
      .self_status = errSecSuccess,
      .signing_status = errSecSuccess,
      .signing_information = (__bridge CFTypeRef)information,
      .fallback_path = "relative/candidate",
  };
  MetaCodeIdentityFailure failure = MetaCodeIdentityFailureNone;
  assert(meta_code_identity_read_with_backend(backend(&fixture), &failure) ==
         nil);
  assert(failure == MetaCodeIdentityFailureExecutablePathUnavailable);
}

int main(void) {
  @autoreleasepool {
    test_valid_signed_self();
    test_unsigned_self();
    test_unsigned_self_lookup();
    test_failed_self_lookup();
    test_malformed_signing_information();
    test_malformed_cdhash();
    test_path_only_fallback();
    test_malformed_fallback_path();
    puts("code identity fixture: ok");
  }
  return 0;
}
