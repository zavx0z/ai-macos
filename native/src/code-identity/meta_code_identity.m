#include "meta_code_identity.h"

#include <mach-o/dyld.h>

static void set_failure(MetaCodeIdentityFailure *failure,
                        MetaCodeIdentityFailure value) {
  if (failure != NULL) *failure = value;
}

static BOOL absolute_path(NSString *path) {
  return path.length > 1 && [path hasPrefix:@"/"] &&
         [path rangeOfString:@"\0"].location == NSNotFound;
}

static NSString *path_from_signing_information(CFDictionaryRef information) {
  CFTypeRef value = CFDictionaryGetValue(information,
                                         kSecCodeInfoMainExecutable);
  if (value == NULL || CFGetTypeID(value) != CFURLGetTypeID()) return nil;
  NSURL *url = (__bridge NSURL *)value;
  if (!url.fileURL) return nil;
  NSString *path = url.path.stringByStandardizingPath;
  return absolute_path(path) ? path : nil;
}

static NSString *fallback_executable_path(
    MetaCodeIdentityBackend backend) {
  uint32_t size = 0;
  const int sizing = backend.executable_path(backend.context, NULL, &size);
  if (sizing != -1 || size == 0 || size > 1024 * 1024) return nil;
  NSMutableData *storage = [NSMutableData dataWithLength:size];
  uint32_t actual_size = size;
  if (backend.executable_path(backend.context, storage.mutableBytes,
                              &actual_size) != 0 ||
      actual_size == 0 || actual_size > size) {
    return nil;
  }
  const char *bytes = storage.bytes;
  if (memchr(bytes, '\0', actual_size) == NULL) return nil;
  NSString *path = [NSString stringWithUTF8String:bytes];
  if (path == nil) return nil;
  path = path.stringByStandardizingPath;
  return absolute_path(path) ? path : nil;
}

static NSString *hex_cdhash(CFDictionaryRef information,
                            MetaCodeIdentityFailure *failure) {
  CFTypeRef value = CFDictionaryGetValue(information, kSecCodeInfoUnique);
  if (value == NULL || CFGetTypeID(value) != CFDataGetTypeID()) {
    set_failure(failure, MetaCodeIdentityFailureMalformedCDHash);
    return nil;
  }
  CFDataRef data = (CFDataRef)value;
  const CFIndex length = CFDataGetLength(data);
  if (length < 20 || length > 32) {
    set_failure(failure, MetaCodeIdentityFailureMalformedCDHash);
    return nil;
  }
  const UInt8 *bytes = CFDataGetBytePtr(data);
  if (bytes == NULL) {
    set_failure(failure, MetaCodeIdentityFailureMalformedCDHash);
    return nil;
  }
  NSMutableString *hex = [NSMutableString stringWithCapacity:(NSUInteger)length * 2];
  for (CFIndex index = 0; index < length; index += 1) {
    [hex appendFormat:@"%02x", bytes[index]];
  }
  return hex;
}

NSDictionary<NSString *, NSString *> *meta_code_identity_read_with_backend(
    MetaCodeIdentityBackend backend, MetaCodeIdentityFailure *failure) {
  set_failure(failure, MetaCodeIdentityFailureNone);
  if (backend.copy_self == NULL ||
      backend.copy_signing_information == NULL ||
      backend.executable_path == NULL) {
    set_failure(failure, MetaCodeIdentityFailureInvalidBackend);
    return nil;
  }

  SecCodeRef code = NULL;
  const OSStatus self_status = backend.copy_self(backend.context, &code);
  if (self_status != errSecSuccess || code == NULL) {
    if (code != NULL) CFRelease(code);
    set_failure(failure, self_status == errSecCSUnsigned
                             ? MetaCodeIdentityFailureUnsigned
                             : MetaCodeIdentityFailureSelfUnavailable);
    return nil;
  }

  CFDictionaryRef information = NULL;
  const OSStatus signing_status = backend.copy_signing_information(
      backend.context, code, kSecCSSigningInformation, &information);
  CFRelease(code);
  if (signing_status != errSecSuccess) {
    if (information != NULL) CFRelease(information);
    set_failure(failure, signing_status == errSecCSUnsigned
                             ? MetaCodeIdentityFailureUnsigned
                             : MetaCodeIdentityFailureSigningInformationUnavailable);
    return nil;
  }
  if (information == NULL ||
      CFGetTypeID(information) != CFDictionaryGetTypeID()) {
    if (information != NULL) CFRelease(information);
    set_failure(failure,
                MetaCodeIdentityFailureMalformedSigningInformation);
    return nil;
  }

  NSString *cdhash = hex_cdhash(information, failure);
  if (cdhash == nil) {
    CFRelease(information);
    return nil;
  }
  NSString *helper_path = path_from_signing_information(information);
  CFRelease(information);
  if (helper_path == nil) helper_path = fallback_executable_path(backend);
  if (helper_path == nil) {
    set_failure(failure, MetaCodeIdentityFailureExecutablePathUnavailable);
    return nil;
  }
  return @{ @"helperPath" : helper_path, @"cdhash" : cdhash };
}

static OSStatus copy_self(void *context, SecCodeRef *code) {
  (void)context;
  return SecCodeCopySelf(kSecCSDefaultFlags, code);
}

static OSStatus copy_signing_information(void *context, SecCodeRef code,
                                         SecCSFlags flags,
                                         CFDictionaryRef *information) {
  (void)context;
  return SecCodeCopySigningInformation(code, flags, information);
}

static int executable_path(void *context, char *buffer, uint32_t *size) {
  (void)context;
  return _NSGetExecutablePath(buffer, size);
}

NSDictionary<NSString *, NSString *> *meta_code_identity_read(
    MetaCodeIdentityFailure *failure) {
  return meta_code_identity_read_with_backend((MetaCodeIdentityBackend){
      .copy_self = copy_self,
      .copy_signing_information = copy_signing_information,
      .executable_path = executable_path,
  }, failure);
}
