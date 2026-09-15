#ifndef META_CAPTURE_COMMAND_H
#define META_CAPTURE_COMMAND_H

#import <Foundation/Foundation.h>

#include "../../include/meta_capture_router.h"
#include "../../include/meta_native.h"

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const MetaCaptureCommandErrorDomain;

typedef NS_ERROR_ENUM(MetaCaptureCommandErrorDomain, MetaCaptureCommandError) {
  MetaCaptureCommandInvalidRequest = 1,
  MetaCaptureCommandStaleAuthority = 2,
  MetaCaptureCommandUnsupportedTarget = 3,
  MetaCaptureCommandRouterFailure = 4,
  MetaCaptureCommandBinaryFailure = 5,
};

// Provider возвращает текущий immutable snapshot только на время вызова.
// Binder немедленно копирует необходимые факты и не удерживает указатель.
typedef const MetaInventorySnapshot *_Nullable (^MetaCaptureInventoryProvider)(void);

// Проверяет полноту текущей display topology независимо от unrelated AX
// incompleteness общего inventory snapshot.
typedef BOOL (^MetaCaptureTopologyValidator)(const MetaInventorySnapshot *snapshot);

// Emitter передаёт существующий binary header и raw PNG как одну атомарную
// операцию transport owner. NO означает, что bytes не были приняты полностью.
typedef BOOL (^MetaCaptureBinaryEmitter)(NSDictionary *header, NSData *bytes);

@interface MetaCaptureCommandBinder : NSObject

- (nullable instancetype)initWithRouter:(MetaCaptureRouter *)router
                       inventoryProvider:(MetaCaptureInventoryProvider)inventoryProvider
                       topologyValidator:(MetaCaptureTopologyValidator)topologyValidator
                        nativeGeneration:(NSString *)nativeGeneration
                           nativeBuildId:(NSString *)nativeBuildId;

// Read-only pre-dispatch validation. Не создаёт SCStream/task и не резервирует
// lifecycle metadata; startRequest повторяет те же проверки перед dispatch.
- (BOOL)validateStartRequest:(NSDictionary *)request
                       error:(NSError * _Nullable * _Nullable)error;

// Принимает payload существующего nativeCaptureStartRequestSchema после общей
// wire validation/action admission и возвращает только start-result DTO.
- (nullable NSDictionary *)startRequest:(NSDictionary *)request
                                   error:(NSError * _Nullable * _Nullable)error;

// Принимает существующий nativeCaptureCleanupRequestSchema и возвращает один
// variant nativeCaptureCleanupResponseSchema. Для completed frame вызывает
// emitter с `{channel:"binary",payload:{binaryToken,byteLength}}` и raw PNG.
- (nullable NSDictionary *)cleanupRequest:(NSDictionary *)request
                                emitBinary:(MetaCaptureBinaryEmitter)emitBinary
                                     error:(NSError * _Nullable * _Nullable)error;

// Возвращает immutable metadata-only геометрию произведённого frame до
// publication expiry. PNG bytes и lifecycle capture task здесь не хранятся.
- (nullable NSDictionary *)lookupFrameGeometry:(NSString *)frameRef;

@end

NS_ASSUME_NONNULL_END

#endif
