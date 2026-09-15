#ifndef META_APPLICATION_BUNDLES_H
#define META_APPLICATION_BUNDLES_H
#import <Foundation/Foundation.h>

// Registry принадлежит одному native generation и вызывается на action worker.
// Bundle identity не заменяет process/application reference после запуска.
@interface MetaApplicationBundles : NSObject
- (instancetype)initWithGeneration:(NSDictionary *)generation;
- (NSDictionary *)resolvePath:(NSString *)path bundleId:(NSString *)bundleId;
- (BOOL)validateReference:(NSDictionary *)reference;
@end
#endif
