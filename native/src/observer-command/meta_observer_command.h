#ifndef META_OBSERVER_COMMAND_H
#define META_OBSERVER_COMMAND_H

#import <Foundation/Foundation.h>

#include "meta_observer.h"
#include "meta_observer_target_index.h"

NS_ASSUME_NONNULL_BEGIN

@interface MetaObserverPreparedIndex : NSObject
- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;
@property(nonatomic, readonly) MetaObserverTargetIndex *index;
@property(nonatomic, readonly) NSString *inventoryId;
@property(nonatomic, readonly) uint64_t inventoryRevision;
@property(nonatomic, readonly) uint64_t indexRevision;
@end

MetaObserverPreparedIndex *_Nullable meta_observer_prepared_index_create(
    MetaObserverTargetIndex *index,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t indexRevision);

typedef MetaObserverPreparedIndex *_Nullable (^MetaObserverIndexBuilder)(void);
typedef BOOL (^MetaObserverMainExecutor)(BOOL (^work)(void));
typedef MetaNativeObserver *_Nullable (^MetaObserverFactory)(
    NSDictionary *generation, MetaObserverTargetIndex *index);
typedef NSDictionary *_Nullable (^MetaObserverReadinessProvider)(void);
typedef NSString *_Nullable (^MetaObserverInstanceIdProvider)(void);

@interface MetaObserverCommandBinder : NSObject
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation
                              nativeBuildId:(NSString *)nativeBuildId
                                indexBuilder:(MetaObserverIndexBuilder)indexBuilder
                                mainExecutor:(MetaObserverMainExecutor)mainExecutor
                                     factory:(MetaObserverFactory)factory
                           readinessProvider:(MetaObserverReadinessProvider)readinessProvider
                          instanceIdProvider:(MetaObserverInstanceIdProvider)instanceIdProvider;
- (NSDictionary *)handleRequest:(NSDictionary *)request;
// Вызывается command loop только после успешной отправки prepare ACK.
- (BOOL)activatePushForObserverInstance:(NSString *)observerInstanceRef;
// Возвращает primary PUSH envelopes и terminal gapReason, если он появился.
- (NSDictionary *)takePushEnvelopes:(NSUInteger)maximum;
@end

NS_ASSUME_NONNULL_END

#endif
