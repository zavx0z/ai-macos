#include "meta_application_bundles.h"
#include <assert.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

static void create_bundle(NSString *path, NSString *bundleId) {
  NSString *contents = [path stringByAppendingPathComponent:@"Contents"];
  assert([NSFileManager.defaultManager createDirectoryAtPath:contents withIntermediateDirectories:YES attributes:nil error:NULL]);
  NSDictionary *info = @{@"CFBundleIdentifier": bundleId, @"CFBundlePackageType": @"APPL"};
  assert([info writeToFile:[contents stringByAppendingPathComponent:@"Info.plist"] atomically:YES]);
}

int main(void) {
  @autoreleasepool {
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"meta-bundles-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSString *path = [directory stringByAppendingPathComponent:@"Fixture.app"];
    create_bundle(path, @"dev.meta.fixture");
    NSDictionary *generation = @{@"runtimeEpoch": @"runtime", @"loginSessionId": @"login", @"nativeGeneration": @"native"};
    MetaApplicationBundles *registry = [[MetaApplicationBundles alloc] initWithGeneration:generation];
    NSDictionary *reference = [registry resolvePath:path bundleId:@"dev.meta.fixture"];
    assert(reference != nil && [reference[@"bundleRef"] hasPrefix:@"bundle-"]);
    assert([reference[@"bundleId"] isEqual:@"dev.meta.fixture"] && [reference[@"device"] isKindOfClass:NSString.class]);
    assert([registry validateReference:reference]);
    assert([[registry resolvePath:path bundleId:@"dev.meta.fixture"] isEqual:reference]);
    assert([registry resolvePath:path bundleId:@"foreign"] == nil);
    assert([registry resolvePath:@"relative.app" bundleId:@"dev.meta.fixture"] == nil);
    NSMutableDictionary *forged = [reference mutableCopy];
    forged[@"inode"] = @"0";
    assert(![registry validateReference:forged]);
    forged = [reference mutableCopy]; forged[@"nativeGeneration"] = @"new-native";
    assert(![registry validateReference:forged]);
    MetaApplicationBundles *other = [[MetaApplicationBundles alloc] initWithGeneration:generation];
    assert(![other validateReference:reference]);
    struct stat status = {0};
    assert(stat(path.fileSystemRepresentation, &status) == 0);
    struct timespec times[] = {status.st_atimespec, status.st_mtimespec};
    times[1].tv_sec += 1;
    assert(utimensat(AT_FDCWD, path.fileSystemRepresentation, times, 0) == 0);
    assert(![registry validateReference:reference]);
    NSDictionary *newReference = [registry resolvePath:path bundleId:@"dev.meta.fixture"];
    assert(newReference != nil && ![newReference[@"bundleRef"] isEqual:reference[@"bundleRef"]]);
    assert([registry validateReference:newReference]);
    NSString *moved = [directory stringByAppendingPathComponent:@"Old.app"];
    assert([NSFileManager.defaultManager moveItemAtPath:path toPath:moved error:NULL]);
    create_bundle(path, @"dev.meta.fixture");
    assert(![registry validateReference:newReference]);
    assert([NSFileManager.defaultManager removeItemAtPath:directory error:NULL]);
    puts("application bundle fixture: ok");
  }
  return 0;
}
