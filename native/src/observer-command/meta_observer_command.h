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
typedef BOOL (^MetaObserverPreparedValidator)(MetaObserverPreparedIndex *prepared);
// `{reason,stage,transient}`; stage только inventory|index.
typedef NSDictionary *_Nullable (^MetaObserverIndexFailureProvider)(void);

@interface MetaObserverCommandBinder : NSObject
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation
                              nativeBuildId:(NSString *)nativeBuildId
                                indexBuilder:(MetaObserverIndexBuilder)indexBuilder
                                mainExecutor:(MetaObserverMainExecutor)mainExecutor
                                     factory:(MetaObserverFactory)factory
                           readinessProvider:(MetaObserverReadinessProvider)readinessProvider
                          instanceIdProvider:(MetaObserverInstanceIdProvider)instanceIdProvider;
// Не выполняет refresh: повторно связывает prepared index с exact current
// foreground receipt непосредственно вокруг main-thread observer start.
- (void)setPreparedValidator:(nullable MetaObserverPreparedValidator)validator;
- (void)setIndexFailureProvider:(nullable MetaObserverIndexFailureProvider)provider;
- (BOOL)mergeTargetRecords:(NSArray<MetaObserverTargetRecord *> *)records
                inventoryId:(NSString *)inventoryId
          inventoryRevision:(uint64_t)inventoryRevision;
- (NSDictionary *)handleRequest:(NSDictionary *)request;
// Вызывается command loop только после успешной отправки prepare ACK.
- (BOOL)activatePushForObserverInstance:(NSString *)observerInstanceRef;
// Возвращает primary PUSH envelopes и terminal gapReason, если он появился.
- (NSDictionary *)takePushEnvelopes:(NSUInteger)maximum;
- (nullable NSDictionary *)currentCoverageForObserverInstance:
    (NSString *)observerInstanceRef;
- (BOOL)registerSyntheticTag:(uint64_t)tag
                 operationId:(NSString *)operationId
               interactionId:(nullable NSString *)interactionId
                      target:(NSDictionary *)target
         observerInstanceRef:(NSString *)observerInstanceRef;
- (void)unregisterSyntheticTag:(uint64_t)tag
           observerInstanceRef:(NSString *)observerInstanceRef;
// Scan читает rolling history и не извлекает события из primary PUSH queue.
- (nullable NSDictionary *)scanEventsAfterCursor:(NSString *)cursor
                            expectedSyntheticTag:(uint64_t)tag
                                 requireOwnEvent:(BOOL)requireOwnEvent
                                   timeoutMillis:(NSUInteger)timeoutMillis
                             observerInstanceRef:(NSString *)observerInstanceRef;
- (nullable NSDictionary *)scanInputEventsAfterCursor:(NSString *)cursor
                                  expectedSyntheticTag:(uint64_t)tag
                                        expectedTarget:(nullable NSDictionary *)target
                                     allowRelatedFocus:(BOOL)allowRelatedFocus
                                         ownInputArmed:(BOOL)ownInputArmed
                                         timeoutMillis:(NSUInteger)timeoutMillis
                                   observerInstanceRef:(NSString *)observerInstanceRef;
// Возвращает один атомарный bounded снимок history и current head, не ожидая
// новых событий и не извлекая envelopes из primary PUSH queue.
- (nullable NSDictionary *)historySnapshotForObserverInstance:
    (NSString *)observerInstanceRef
                                              maximumEvents:
    (NSUInteger)maximumEvents;
@end

NS_ASSUME_NONNULL_END

#endif
