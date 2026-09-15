#ifndef META_CODE_IDENTITY_H
#define META_CODE_IDENTITY_H

#import <Foundation/Foundation.h>
#import <Security/Security.h>

typedef NS_ENUM(NSInteger, MetaCodeIdentityFailure) {
  MetaCodeIdentityFailureNone,
  MetaCodeIdentityFailureInvalidBackend,
  MetaCodeIdentityFailureSelfUnavailable,
  MetaCodeIdentityFailureUnsigned,
  MetaCodeIdentityFailureSigningInformationUnavailable,
  MetaCodeIdentityFailureMalformedSigningInformation,
  MetaCodeIdentityFailureMalformedCDHash,
  MetaCodeIdentityFailureExecutablePathUnavailable,
};

typedef OSStatus (*MetaCodeIdentityCopySelfFunction)(void *context,
                                                     SecCodeRef *code);
typedef OSStatus (*MetaCodeIdentityCopySigningInformationFunction)(
    void *context, SecCodeRef code, SecCSFlags flags,
    CFDictionaryRef *information);
typedef int (*MetaCodeIdentityExecutablePathFunction)(void *context,
                                                      char *buffer,
                                                      uint32_t *size);

typedef struct {
  void *context;
  MetaCodeIdentityCopySelfFunction copy_self;
  MetaCodeIdentityCopySigningInformationFunction copy_signing_information;
  MetaCodeIdentityExecutablePathFunction executable_path;
} MetaCodeIdentityBackend;

// Читает identity загруженного процесса. Backend не получает candidate path
// или ожидаемый digest и не проверяет файл вместо self code.
NSDictionary<NSString *, NSString *> *meta_code_identity_read_with_backend(
    MetaCodeIdentityBackend backend, MetaCodeIdentityFailure *failure);

// Production backend использует SecCodeCopySelf и не запускает внешний tool.
NSDictionary<NSString *, NSString *> *meta_code_identity_read(
    MetaCodeIdentityFailure *failure);

#endif
