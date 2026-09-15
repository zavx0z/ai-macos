#ifndef META_OBSERVER_TARGET_INDEX_H
#define META_OBSERVER_TARGET_INDEX_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include "meta_macos.h"

#define META_OBSERVER_TARGET_INDEX_MAX_RECORDS 4096

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  void *_Nullable context;
  uint64_t (*monotonic_millis)(void *context);
  uint64_t (*process_start_micros)(void *context, pid_t pid);
  AXError (*copy_focused_window)(void *context, AXUIElementRef element,
                                 uint64_t timeout_millis,
                                 AXUIElementRef _Nullable * _Nonnull focused);
  AXError (*copy_focused_element)(void *context, AXUIElementRef element,
                                  uint64_t timeout_millis,
                                  AXUIElementRef _Nullable * _Nonnull focused);
  AXError (*copy_parent)(void *context, AXUIElementRef element,
                         uint64_t timeout_millis,
                         AXUIElementRef _Nullable * _Nonnull parent);
  AXError (*get_pid)(void *context, AXUIElementRef element, pid_t *pid);
  bool (*equal)(void *context, AXUIElementRef left, AXUIElementRef right);
  void (*release)(void *context, AXUIElementRef element);
} MetaObserverTargetBackend;

MetaObserverTargetBackend meta_observer_target_system_backend(void);

@interface MetaObserverTargetRecord : NSObject
- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;
@end

MetaObserverTargetRecord *_Nullable meta_observer_target_record_create(
    const MetaAXTargetBorrow *borrow,
    NSString *runtimeEpoch,
    NSString *loginSessionId,
    NSString *nativeGeneration);

@interface MetaObserverTargetIndex : NSObject
- (instancetype)init;
- (nullable instancetype)initWithBackend:(MetaObserverTargetBackend)backend;
- (BOOL)replaceRecords:(NSArray<MetaObserverTargetRecord *> *)records;
- (nullable NSDictionary *)resolveFocusForPid:(pid_t)pid
                                       element:(AXUIElementRef)element
                                  notification:(NSString *)notification;
@end

NS_ASSUME_NONNULL_END

#endif
