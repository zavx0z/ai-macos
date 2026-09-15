#ifndef META_AX_RETAINED_SNAPSHOT_H
#define META_AX_RETAINED_SNAPSHOT_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, MetaAXRetainedBorrowStatus) {
  META_AX_RETAINED_BORROW_OK,
  META_AX_RETAINED_BORROW_INVALID_REQUEST,
  META_AX_RETAINED_BORROW_SNAPSHOT_STALE,
  META_AX_RETAINED_BORROW_ACTION_UNAVAILABLE,
  META_AX_RETAINED_BORROW_CONSUMER_FAILED,
};

typedef BOOL (^MetaAXRetainedElementConsumer)(id borrowedElement);

@interface MetaAXRetainedSnapshotRegistry : NSObject

// Registry хранит только последний опубликованный snapshot exact parent target.
// Все элементы должны быть получены одним authorized inspector traversal;
// повторный обход по строке ax-node:N запрещён.
- (nullable instancetype)initWithClock:(uint64_t (^)(void))clock
                             ttlMillis:(uint64_t)ttlMillis
                          maxSnapshots:(NSUInteger)maxSnapshots
                              maxNodes:(NSUInteger)maxNodes;

// nodes — финальные node DTO, возвращённые inspector. borrowedElements может
// содержать промежуточные узлы, но registry сохраняет только refs из nodes.
- (BOOL)publishTarget:(NSDictionary *)target
          inventoryId:(NSString *)inventoryId
    inventoryRevision:(uint64_t)inventoryRevision
            snapshotId:(NSString *)snapshotId
                 nodes:(NSArray<NSDictionary *> *)nodes
      borrowedElements:(NSDictionary<NSString *, id> *)borrowedElements;

// Consumer выполняется синхронно на action worker. Ссылка действительна только
// во время callback и не может сохраняться или передаваться другому executor.
- (MetaAXRetainedBorrowStatus)withPressElement:(NSDictionary *)elementRef
                                        target:(NSDictionary *)target
                                   inventoryId:(NSString *)inventoryId
                             inventoryRevision:(uint64_t)inventoryRevision
                                       consume:(MetaAXRetainedElementConsumer)consume;

- (void)invalidateTarget:(NSDictionary *)target;
- (void)invalidateAll;

@end

NS_ASSUME_NONNULL_END

#endif
