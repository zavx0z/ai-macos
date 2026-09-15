#include "meta_owned_sheet_discovery.h"

#include <time.h>

#define META_OWNED_SHEET_MAX_CHILDREN 256
#define META_OWNED_SHEET_CHILD_BATCH 32
#define META_OWNED_SHEET_CALL_TIMEOUT_MILLIS 100

static BOOL remaining(id<MetaOwnedSheetDiscoveryBackend> backend,
                      uint64_t deadline,
                      uint64_t *value) {
  const uint64_t now = [backend monotonicMillis];
  if (now >= deadline) return NO;
  *value = deadline - now;
  return YES;
}

static BOOL prepare(id<MetaOwnedSheetDiscoveryBackend> backend,
                    id element,
                    uint64_t deadline) {
  uint64_t rest = 0;
  if (element == nil || !remaining(backend, deadline, &rest)) return NO;
  return [backend prepareElement:element
                   timeoutMillis:MIN(rest,
                                     META_OWNED_SHEET_CALL_TIMEOUT_MILLIS)];
}

MetaOwnedSheetDiscoveryStatus meta_discover_direct_owned_sheets(
    id borrowedOwner,
    pid_t ownerPid,
    uint64_t deadlineMillis,
    id<MetaOwnedSheetDiscoveryBackend> backend,
    MetaOwnedSheetConsumer consumer) {
  if (borrowedOwner == nil || ownerPid <= 0 || deadlineMillis == 0 ||
      backend == nil || consumer == nil ||
      !prepare(backend, borrowedOwner, deadlineMillis)) {
    return [backend monotonicMillis] >= deadlineMillis
               ? MetaOwnedSheetDiscoveryTimedOut
               : MetaOwnedSheetDiscoveryFailed;
  }
  NSUInteger childCount = 0;
  AXError error = [backend childCountForElement:borrowedOwner count:&childCount];
  if (error != kAXErrorSuccess) {
    return error == kAXErrorCannotComplete
               ? MetaOwnedSheetDiscoveryTimedOut
               : MetaOwnedSheetDiscoveryFailed;
  }
  if (childCount > META_OWNED_SHEET_MAX_CHILDREN) {
    return MetaOwnedSheetDiscoveryFailed;
  }
  for (NSUInteger offset = 0; offset < childCount;) {
    if (!prepare(backend, borrowedOwner, deadlineMillis)) {
      return MetaOwnedSheetDiscoveryTimedOut;
    }
    const NSUInteger batch = MIN(META_OWNED_SHEET_CHILD_BATCH,
                                 childCount - offset);
    NSArray *children = nil;
    error = [backend childrenForElement:borrowedOwner
                                   from:offset
                                  count:batch
                                  value:&children];
    if (error != kAXErrorSuccess || ![children isKindOfClass:NSArray.class] ||
        children.count == 0 || children.count > batch) {
      return error == kAXErrorCannotComplete
                 ? MetaOwnedSheetDiscoveryTimedOut
                 : MetaOwnedSheetDiscoveryFailed;
    }
    for (id child in children) {
      if (!prepare(backend, child, deadlineMillis)) {
        return MetaOwnedSheetDiscoveryTimedOut;
      }
      NSString *role = nil;
      error = [backend roleForElement:child value:&role];
      if (error != kAXErrorSuccess || ![role isKindOfClass:NSString.class]) {
        return error == kAXErrorCannotComplete
                   ? MetaOwnedSheetDiscoveryTimedOut
                   : MetaOwnedSheetDiscoveryFailed;
      }
      if (![role isEqual:(__bridge NSString *)kAXSheetRole]) continue;
      pid_t childPid = 0;
      if (!prepare(backend, child, deadlineMillis) ||
          [backend pidForElement:child value:&childPid] != kAXErrorSuccess ||
          childPid != ownerPid) {
        return MetaOwnedSheetDiscoveryFailed;
      }
      id parent = nil;
      if (!prepare(backend, child, deadlineMillis) ||
          [backend parentForElement:child value:&parent] != kAXErrorSuccess ||
          parent == nil || ![backend element:parent equals:borrowedOwner]) {
        return MetaOwnedSheetDiscoveryFailed;
      }
      if (!consumer(child)) return MetaOwnedSheetDiscoveryFailed;
    }
    offset += children.count;
    if (children.count < batch && offset < childCount) {
      return MetaOwnedSheetDiscoveryFailed;
    }
  }
  return [backend monotonicMillis] >= deadlineMillis
             ? MetaOwnedSheetDiscoveryTimedOut
             : MetaOwnedSheetDiscoveryComplete;
}

@interface MetaOwnedSheetSystemBackend : NSObject <MetaOwnedSheetDiscoveryBackend>
@end

@implementation MetaOwnedSheetSystemBackend
- (uint64_t)monotonicMillis {
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000 +
         (uint64_t)value.tv_nsec / 1000000;
}
- (BOOL)prepareElement:(id)element timeoutMillis:(uint64_t)timeoutMillis {
  if (element == nil || timeoutMillis == 0 || timeoutMillis > 100 ||
      CFGetTypeID((__bridge CFTypeRef)element) != AXUIElementGetTypeID()) {
    return NO;
  }
  return AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)element,
      (float)timeoutMillis / 1000.0f) == kAXErrorSuccess;
}
- (AXError)childCountForElement:(id)element count:(NSUInteger *)count {
  CFIndex value = 0;
  AXError error = AXUIElementGetAttributeValueCount(
      (__bridge AXUIElementRef)element, kAXChildrenAttribute, &value);
  if (error == kAXErrorSuccess && value >= 0) *count = (NSUInteger)value;
  return value < 0 ? kAXErrorIllegalArgument : error;
}
- (AXError)childrenForElement:(id)element from:(NSUInteger)index
                        count:(NSUInteger)count value:(NSArray **)value {
  CFArrayRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValues(
      (__bridge AXUIElementRef)element, kAXChildrenAttribute,
      (CFIndex)index, (CFIndex)count, &copied);
  if (error == kAXErrorSuccess && copied != NULL) {
    NSArray *children = (__bridge NSArray *)copied;
    for (id child in children) {
      if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) {
        error = kAXErrorIllegalArgument;
        break;
      }
    }
    if (error == kAXErrorSuccess) *value = [children copy];
  } else if (error == kAXErrorSuccess) {
    error = kAXErrorIllegalArgument;
  }
  if (copied != NULL) CFRelease(copied);
  return error;
}
- (AXError)roleForElement:(id)element value:(NSString **)value {
  CFTypeRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValue(
      (__bridge AXUIElementRef)element, kAXRoleAttribute, &copied);
  if (error == kAXErrorSuccess && copied != NULL &&
      CFGetTypeID(copied) == CFStringGetTypeID()) {
    *value = [(__bridge NSString *)copied copy];
  } else if (error == kAXErrorSuccess) {
    error = kAXErrorIllegalArgument;
  }
  if (copied != NULL) CFRelease(copied);
  return error;
}
- (AXError)pidForElement:(id)element value:(pid_t *)value {
  return AXUIElementGetPid((__bridge AXUIElementRef)element, value);
}
- (AXError)parentForElement:(id)element value:(id *)value {
  CFTypeRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValue(
      (__bridge AXUIElementRef)element, kAXParentAttribute, &copied);
  if (error == kAXErrorSuccess && copied != NULL &&
      CFGetTypeID(copied) == AXUIElementGetTypeID()) {
    *value = CFBridgingRelease(copied);
    copied = NULL;
  } else if (error == kAXErrorSuccess) {
    error = kAXErrorIllegalArgument;
  }
  if (copied != NULL) CFRelease(copied);
  return error;
}
- (BOOL)element:(id)left equals:(id)right {
  return left != nil && right != nil &&
         CFEqual((__bridge CFTypeRef)left, (__bridge CFTypeRef)right);
}
@end

id<MetaOwnedSheetDiscoveryBackend> meta_owned_sheet_system_backend(void) {
  return [[MetaOwnedSheetSystemBackend alloc] init];
}
