#ifndef META_OBSERVER_H
#define META_OBSERVER_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NSDictionary *_Nullable (^MetaObserverFocusResolver)(
    pid_t pid, AXUIElementRef element, NSString *notification);

@interface MetaNativeObserver : NSObject
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation;
- (void)setFocusResolver:(MetaObserverFocusResolver)resolver;
// Resolver читает только immutable native registry snapshot и не синхронизирует
// main runloop с action worker.
// start/stop выполняются на main runloop helper и никогда не открывают TCC UI.
- (BOOL)start;
- (void)stop;
- (BOOL)registerSyntheticTag:(uint64_t)tag
                 operationId:(NSString *)operationId
               interactionId:(nullable NSString *)interactionId
                      target:(NSDictionary *)target;
- (void)unregisterSyntheticTag:(uint64_t)tag;
- (nullable NSDictionary *)syntheticOwnerForEventTag:(NSString *)eventTag;
- (NSDictionary *)coverage;
- (NSArray<NSDictionary *> *)takeEvents;
// Эти методы являются единым ingestion path для platform callbacks и fixtures.
- (void)recordInputFromPid:(pid_t)pid syntheticTag:(uint64_t)tag;
- (void)recordFocusTarget:(NSDictionary *)target syntheticTag:(uint64_t)tag;
- (void)recordUnresolvedFocus:(NSString *)reason;
- (void)recordWindowStructureTarget:(NSDictionary *)target;
- (void)recordLifecycle:(NSString *)lifecycle
      nextLoginSessionId:(nullable NSString *)nextLoginSessionId;
- (void)recordCurrentSessionReadiness:(NSDictionary *)readiness;
- (NSDictionary *)currentSessionReadiness;
- (void)recordCoverageKind:(NSString *)kind
                 available:(BOOL)available
                    reason:(nullable NSString *)reason;
- (void)recordHeartbeat;
- (void)markUnavailable:(NSString *)reason;
@end

NS_ASSUME_NONNULL_END

#endif
