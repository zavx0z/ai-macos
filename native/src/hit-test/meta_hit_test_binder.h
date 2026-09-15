#ifndef META_HIT_TEST_BINDER_H
#define META_HIT_TEST_BINDER_H

#import <Foundation/Foundation.h>

#include "meta_native.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, MetaHitTestWindowRelation) {
  MetaHitTestWindowRelationUnavailable = -1,
  MetaHitTestWindowRelationNone = 0,
  MetaHitTestWindowRelationExact = 1,
  MetaHitTestWindowRelationOwnedDescendant = 2,
};

// Snapshot действует только внутри синхронного callback и не сохраняется.
typedef const MetaInventorySnapshot *_Nullable (^MetaHitTestSnapshotProvider)(void);
typedef NSDictionary *_Nullable (^MetaHitTestFrameGeometryLookup)(NSString *frameRef);
typedef BOOL (^MetaHitTestPendingFenceValidator)(NSDictionary *operation);
typedef MetaHitTestWindowRelation (^MetaHitTestWindowProbe)(
    NSDictionary *target,
    NSDictionary *destinationPoint,
    const MetaInventorySnapshot *snapshot);
typedef BOOL (^MetaHitTestTopologyProbe)(const MetaInventorySnapshot *snapshot);
typedef NSDictionary *_Nullable (^MetaHitTestSessionReadinessProvider)(void);

@interface MetaHitTestCommandBinder : NSObject

- (nullable instancetype)initWithGeneration:(NSDictionary *)generation
                           snapshotProvider:(MetaHitTestSnapshotProvider)snapshotProvider
                         frameGeometryLookup:(MetaHitTestFrameGeometryLookup)frameGeometryLookup
                       pendingFenceValidator:(MetaHitTestPendingFenceValidator)pendingFenceValidator
                                windowProbe:(MetaHitTestWindowProbe)windowProbe
                              topologyProbe:(MetaHitTestTopologyProbe)topologyProbe
                    sessionReadinessProvider:(MetaHitTestSessionReadinessProvider)sessionReadinessProvider;

// Возвращает только NativeHitTestResult: confirmed либо typed failure без
// sourceResponseRef. Executor, fence и capture cache не изменяются.
- (NSDictionary *)handleRequest:(NSDictionary *)request;

@end

NS_ASSUME_NONNULL_END

#endif
