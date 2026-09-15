#ifndef META_PERMISSIONS_REQUEST_H
#define META_PERMISSIONS_REQUEST_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSUInteger, MetaPermissionGroup) {
  MetaPermissionAccessibility,
  MetaPermissionScreenRecording,
  MetaPermissionPostEvents,
  MetaPermissionInputMonitoring,
  MetaPermissionGroupCount,
};

@protocol MetaPermissionsRequestBackend <NSObject>
- (BOOL)supportsPermission:(MetaPermissionGroup)permission;
- (BOOL)currentGrantForPermission:(MetaPermissionGroup)permission;
// Возвращает YES, если официальный вызов завершился и заполнил returnedGranted.
// NO означает ошибку вызова, а не отказ пользователя.
- (BOOL)requestPermission:(MetaPermissionGroup)permission
          returnedGranted:(BOOL *)returnedGranted
                     error:(NSString *_Nullable *_Nullable)error;
@end

@interface MetaPermissionsRequestController : NSObject
- (nullable instancetype)initWithBackend:(id<MetaPermissionsRequestBackend>)backend;
// request-missing ставит отсутствующие группы в private serial queue и
// немедленно возвращает. status выполняет только passive preflight.
- (nullable NSDictionary *)handleCommand:(NSString *)command;
// Отменяет только queued official requests. Уже выполняющийся SDK call не
// прерывается; NO означает, что drain пока нельзя считать завершённым.
- (BOOL)seal;
@end

// Production backend вызывает только официальные AX/CG permission APIs.
id<MetaPermissionsRequestBackend> meta_permissions_system_backend(void);

NS_ASSUME_NONNULL_END

#endif
