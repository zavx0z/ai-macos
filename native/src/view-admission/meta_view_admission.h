#ifndef META_VIEW_ADMISSION_H
#define META_VIEW_ADMISSION_H

#import <Foundation/Foundation.h>

#include "../observer-command/meta_observer_command.h"

NS_ASSUME_NONNULL_BEGIN

typedef NSDate *_Nullable (^MetaViewAdmissionNow)(void);

@interface MetaViewAdmissionController : NSObject
- (nullable instancetype)initWithObserver:(MetaObserverCommandBinder *)observer
                                      now:(MetaViewAdmissionNow)now
                       tombstoneTtlMillis:(NSUInteger)tombstoneTtlMillis
                           maximumRecords:(NSUInteger)maximumRecords;

// Возвращает exact observer head, который parent использует для per-action
// binding. Проверка выполняется без ожидания и без потребления PUSH.
- (nullable NSDictionary *)admitRequest:(NSDictionary *)request
                                  proof:(NSDictionary *)proof
                                  error:(NSString *_Nullable *_Nullable)error;

// Вызывается executor непосредственно перед первым реальным post.
- (BOOL)recheckOperationId:(NSString *)operationId;

// Удаляет завершённый или отменённый pending admission. Operation tombstone
// остаётся до bounded TTL и не допускает replay того же proof.
- (void)finishOperationId:(NSString *)operationId;
@end

NS_ASSUME_NONNULL_END

#endif
