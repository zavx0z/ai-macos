#include "meta_application_bundles.h"
#include <sys/stat.h>
#include <stdlib.h>
#include <limits.h>

static NSDictionary *bundle_facts(NSString *path, NSString *bundleId) {
  if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath || path.length == 0 || path.length > 4096 ||
      ![bundleId isKindOfClass:NSString.class] || bundleId.length == 0 || bundleId.length > 255 ||
      [path rangeOfString:@"\0"].location != NSNotFound || [bundleId rangeOfString:@"\0"].location != NSNotFound) return nil;
  char resolved[PATH_MAX] = {0};
  if (realpath(path.fileSystemRepresentation, resolved) == NULL) return nil;
  NSString *canonical = [NSFileManager.defaultManager stringWithFileSystemRepresentation:resolved length:strlen(resolved)];
  if (canonical == nil || ![canonical.pathExtension isEqual:@"app"]) return nil;
  struct stat status = {0};
  if (stat(resolved, &status) != 0 || !S_ISDIR(status.st_mode) || status.st_mtimespec.tv_sec < 0) return nil;
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[canonical stringByAppendingPathComponent:@"Contents/Info.plist"]];
  if (![info[@"CFBundleIdentifier"] isEqual:bundleId]) return nil;
  unsigned long long modified = (unsigned long long)status.st_mtimespec.tv_sec * 1000000000ULL + (unsigned long long)status.st_mtimespec.tv_nsec;
  return @{@"path": canonical, @"bundleId": bundleId,
    @"device": [NSString stringWithFormat:@"%llu", (unsigned long long)status.st_dev],
    @"inode": [NSString stringWithFormat:@"%llu", (unsigned long long)status.st_ino],
    @"modifiedAtNs": [NSString stringWithFormat:@"%llu", modified]};
}

@implementation MetaApplicationBundles {
  NSDictionary *_generation;
  NSMutableDictionary<NSString *, NSDictionary *> *_references;
}
- (instancetype)initWithGeneration:(NSDictionary *)generation {
  self = [super init];
  if (self) {
    if (![generation isKindOfClass:NSDictionary.class]) return nil;
    for (NSString *key in @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
      if (![generation[key] isKindOfClass:NSString.class] || [generation[key] length] == 0 || [generation[key] length] > 64) return nil;
    }
    _generation = @{@"runtimeEpoch": generation[@"runtimeEpoch"], @"loginSessionId": generation[@"loginSessionId"], @"nativeGeneration": generation[@"nativeGeneration"]};
    _references = [NSMutableDictionary dictionary];
  }
  return self;
}
- (NSDictionary *)resolvePath:(NSString *)path bundleId:(NSString *)bundleId {
  NSDictionary *facts = bundle_facts(path, bundleId);
  if (facts == nil) return nil;
  for (NSDictionary *reference in _references.allValues) {
    NSMutableDictionary *existingFacts = [reference mutableCopy];
    [existingFacts removeObjectsForKeys:@[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"bundleRef"]];
    if ([existingFacts isEqual:facts]) return reference;
  }
  if (_references.count >= 4096) return nil;
  NSMutableDictionary *reference = [_generation mutableCopy];
  [reference addEntriesFromDictionary:facts];
  NSString *bundleRef = [@"bundle-" stringByAppendingString:NSUUID.UUID.UUIDString];
  reference[@"bundleRef"] = bundleRef;
  NSDictionary *retained = [reference copy];
  _references[bundleRef] = retained;
  return retained;
}
- (BOOL)validateReference:(NSDictionary *)reference {
  if (![reference isKindOfClass:NSDictionary.class] || ![reference[@"bundleRef"] isKindOfClass:NSString.class]) return NO;
  NSDictionary *retained = _references[reference[@"bundleRef"]];
  if (retained == nil || ![reference isEqual:retained]) return NO;
  NSDictionary *fresh = bundle_facts(retained[@"path"], retained[@"bundleId"]);
  if (fresh == nil) return NO;
  for (NSString *key in fresh) if (![fresh[key] isEqual:retained[key]]) return NO;
  return YES;
}
@end
