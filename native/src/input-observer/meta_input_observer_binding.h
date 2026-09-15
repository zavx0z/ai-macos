#ifndef META_INPUT_OBSERVER_BINDING_H
#define META_INPUT_OBSERVER_BINDING_H

#import <Foundation/Foundation.h>

#include "../observer-command/meta_observer_command.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSUInteger, MetaInputObserverPollResult) {
  MetaInputObserverPollContinue = 0,
  MetaInputObserverPollForeignEvent,
  MetaInputObserverPollUnavailable,
};

// Binding не управляет executor: он только связывает один synthetic tag с
// непрерывной observer history и возвращает fail-closed результат проверки.
@interface MetaInputObserverBinding : NSObject
- (nullable instancetype)initWithObserver:(MetaObserverCommandBinder *)observer
                      observerInstanceRef:(NSString *)observerInstanceRef
                               operationId:(NSString *)operationId
                                    target:(NSDictionary *)target
                             interactionId:(nullable NSString *)interactionId;
- (nullable NSDictionary *)currentCoverage;
// Связывает созданный binding с exact атомарным head admission, до tag/post.
- (BOOL)useAdmissionHead:(NSDictionary *)head;
- (BOOL)registerTag:(uint64_t)tag;
- (MetaInputObserverPollResult)poll;
- (void)stop;
@end

NS_ASSUME_NONNULL_END

#endif
