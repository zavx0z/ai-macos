#ifndef META_OBSERVER_H
#define META_OBSERVER_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NSDictionary *_Nullable (^MetaObserverFocusResolver)(
    pid_t pid, AXUIElementRef element, NSString *notification);
typedef void (^MetaObserverEventSink)(NSDictionary *event);

#define META_OBSERVER_SUBSCRIPTION_BUDGET_MILLIS 1000
#define META_OBSERVER_MAX_APPLICATIONS 64
#define META_OBSERVER_MAX_WINDOWS_PER_APPLICATION 256
#define META_OBSERVER_MAX_WINDOWS 512

typedef struct {
  uint64_t deadline_millis;
  NSUInteger remaining_windows;
} MetaObserverSubscriptionBudget;

BOOL meta_observer_subscription_budget_init(
    MetaObserverSubscriptionBudget *budget,
    uint64_t now_millis,
    NSUInteger existing_windows);
BOOL meta_observer_subscription_budget_admit_windows(
    MetaObserverSubscriptionBudget *budget,
    uint64_t now_millis,
    NSUInteger count);
NSTimeInterval meta_observer_subscription_timeout_seconds(
    MetaObserverSubscriptionBudget budget,
    uint64_t now_millis);

@interface MetaNativeObserver : NSObject
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation;
- (void)setFocusResolver:(MetaObserverFocusResolver)resolver;
- (void)setEventSink:(nullable MetaObserverEventSink)sink;
- (void)setChangeSink:(nullable dispatch_block_t)sink;
- (BOOL)refreshForegroundSubscription;
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
// Отсутствующий target означает консервативную глобальную invalidation:
// callback получен из нашей raw subscription, но immutable index не дал hint.
- (void)recordGlobalFocus;
- (void)recordUnresolvedFocus:(NSString *)reason;
- (void)recordWindowStructureTarget:(NSDictionary *)target;
- (void)recordGlobalWindowStructure;
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
