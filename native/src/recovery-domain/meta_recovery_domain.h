#ifndef META_RECOVERY_DOMAIN_H
#define META_RECOVERY_DOMAIN_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Классификатор независимо выводит descriptor из полного native request.
NSDictionary *_Nullable meta_recovery_domain_classify_request(
    NSDictionary *request,
    NSString *loadedNativeBuildId,
    NSString *_Nullable *_Nullable reason);

// Валидатор требует exact durable grant для независимо вычисленного descriptor
// и canonical operation context. При успехе возвращает тот же descriptor.
BOOL meta_recovery_domain_validate_request(
    NSDictionary *request,
    NSString *loadedNativeBuildId,
    NSDictionary *_Nullable *_Nullable descriptor,
    NSString *_Nullable *_Nullable reason);

// Эти helpers соответствуют shared canonicalRecoveryJson и SHA-256 над его
// UTF-8 bytes; unsupported JSON value возвращает nil.
NSString *_Nullable meta_recovery_domain_canonical_json(id value);
NSString *_Nullable meta_recovery_domain_sha256(id value);

NS_ASSUME_NONNULL_END

#endif
