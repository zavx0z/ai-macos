#ifndef META_APPLICATION_COMMAND_H
#define META_APPLICATION_COMMAND_H

#import <Foundation/Foundation.h>

#include "../applications/meta_application_controller.h"
#include "../application-bundles/meta_application_bundles.h"

NS_ASSUME_NONNULL_BEGIN

typedef NSDictionary * _Nullable (^MetaApplicationCandidateResolver)(
    const MetaApplicationProcess *process,
    NSDictionary *operation);

typedef NSDictionary * _Nullable (^MetaApplicationReferenceResolver)(
    NSDictionary *applicationReference);

@interface MetaApplicationCommandBinder : NSObject
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation
                            bundles:(MetaApplicationBundles *)bundles
                            backend:(MetaApplicationBackend)backend
                  candidateResolver:(MetaApplicationCandidateResolver)candidateResolver
                  referenceResolver:(MetaApplicationReferenceResolver)referenceResolver;
- (nullable NSDictionary *)resolve:(NSDictionary *)request
                 evidence:(NSDictionary *)evidence;
- (nullable NSDictionary *)startLaunch:(NSDictionary *)request
                     operation:(NSDictionary *)operation
                     requestId:(NSString *)requestId
                deadlineMillis:(uint64_t)deadlineMillis;
- (nullable NSDictionary *)launchStatus:(NSString *)launchTaskRef
                      requestId:(NSString *)requestId;
- (nullable NSDictionary *)finalizeLaunch:(NSString *)launchTaskRef
                        requestId:(NSString *)requestId;
- (nullable NSDictionary *)activateLaunch:(NSString *)launchTaskRef
                  deadlineMillis:(uint64_t)deadlineMillis;
- (nullable NSDictionary *)cancelLaunch:(NSString *)launchTaskRef
                      requestId:(NSString *)requestId;
- (NSDictionary *)drainLaunchesUntil:(uint64_t)deadlineMillis;
- (BOOL)releaseLaunch:(NSString *)launchTaskRef;
- (nullable NSDictionary *)quit:(NSDictionary *)request
              operation:(NSDictionary *)operation
         deadlineMillis:(uint64_t)deadlineMillis;
- (NSUInteger)activeLaunchCount;
@end

NS_ASSUME_NONNULL_END

#endif
