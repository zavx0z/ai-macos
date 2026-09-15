#include "meta_ax_press.h"

#include <time.h>

static MetaAXPressOutcome outcome(MetaAXPressStatus status,
                                  BOOL attempted,
                                  NSUInteger depth,
                                  AXError error) {
  return (MetaAXPressOutcome){
    .status = status,
    .dispatch_attempted = attempted,
    .ancestry_depth = depth,
    .ax_error = error,
  };
}

static BOOL timed_out(id<MetaAXPressBackend> backend,
                      MetaAXPressContext context) {
  return [backend monotonicMillis] >= context.deadline_millis;
}

static MetaAXPressStatus read_failure(MetaAXPressReadStatus status,
                                      MetaAXPressStatus absent) {
  if (status == META_AX_PRESS_READ_TIMED_OUT) return META_AX_PRESS_TIMED_OUT;
  if (status == META_AX_PRESS_READ_ABSENT) return absent;
  return META_AX_PRESS_TARGET_STALE;
}

MetaAXPressOutcome meta_ax_press_with_backend(
    id retainedElement,
    id borrowedParent,
    MetaAXPressContext context,
    id<MetaAXPressBackend> backend,
    MetaAXPressDispatchGate dispatchGate) {
  if (retainedElement == nil || borrowedParent == nil || backend == nil ||
      dispatchGate == nil || context.owner_pid <= 0 ||
      context.max_ancestry_depth == 0 ||
      context.max_ancestry_depth > 64 || context.deadline_millis == 0 ||
      context.per_call_timeout_millis == 0 ||
      context.per_call_timeout_millis > 500) {
    return outcome(META_AX_PRESS_INVALID_REQUEST, NO, 0,
                   kAXErrorIllegalArgument);
  }
  if (timed_out(backend, context)) {
    return outcome(META_AX_PRESS_TIMED_OUT, NO, 0, kAXErrorCannotComplete);
  }
  pid_t elementPid = 0;
  MetaAXPressReadStatus read =
      [backend ownerPidForElement:retainedElement value:&elementPid];
  if (read != META_AX_PRESS_READ_OK || elementPid != context.owner_pid ||
      timed_out(backend, context)) {
    MetaAXPressStatus status = timed_out(backend, context)
                                   ? META_AX_PRESS_TIMED_OUT
                                   : read_failure(read,
                                                  META_AX_PRESS_TARGET_STALE);
    return outcome(status, NO, 0,
                   kAXErrorInvalidUIElement);
  }
  pid_t parentPid = 0;
  read = [backend ownerPidForElement:borrowedParent value:&parentPid];
  if (read != META_AX_PRESS_READ_OK || parentPid != context.owner_pid ||
      timed_out(backend, context)) {
    MetaAXPressStatus status = timed_out(backend, context)
                                   ? META_AX_PRESS_TIMED_OUT
                                   : read_failure(read,
                                                  META_AX_PRESS_TARGET_STALE);
    return outcome(status, NO, 0,
                   kAXErrorInvalidUIElement);
  }

  NSMutableArray *visited = [NSMutableArray array];
  id current = retainedElement;
  NSUInteger depth = 0;
  while (![backend sameElement:current other:borrowedParent]) {
    if (depth >= context.max_ancestry_depth || timed_out(backend, context)) {
      return outcome(timed_out(backend, context) ? META_AX_PRESS_TIMED_OUT
                                                  : META_AX_PRESS_TARGET_STALE,
                     NO, depth, kAXErrorInvalidUIElement);
    }
    for (id previous in visited) {
      if ([backend sameElement:current other:previous]) {
        return outcome(META_AX_PRESS_TARGET_STALE, NO, depth,
                       kAXErrorInvalidUIElement);
      }
    }
    [visited addObject:current];
    id parent = nil;
    read = [backend parentForElement:current value:&parent];
    if (read != META_AX_PRESS_READ_OK || parent == nil ||
        timed_out(backend, context)) {
      MetaAXPressStatus status = timed_out(backend, context)
                                     ? META_AX_PRESS_TIMED_OUT
                                     : read_failure(
                                           read,
                                           META_AX_PRESS_TARGET_STALE);
      return outcome(status, NO,
                     depth, kAXErrorInvalidUIElement);
    }
    pid_t currentPid = 0;
    read = [backend ownerPidForElement:parent value:&currentPid];
    if (read != META_AX_PRESS_READ_OK || currentPid != context.owner_pid ||
        timed_out(backend, context)) {
      MetaAXPressStatus status = timed_out(backend, context)
                                     ? META_AX_PRESS_TIMED_OUT
                                     : read_failure(
                                           read,
                                           META_AX_PRESS_TARGET_STALE);
      return outcome(status, NO,
                     depth, kAXErrorInvalidUIElement);
    }
    current = parent;
    depth += 1;
  }

  NSArray<NSString *> *actions = nil;
  read = [backend actionsForElement:retainedElement value:&actions];
  if (read != META_AX_PRESS_READ_OK ||
      ![actions isKindOfClass:NSArray.class] ||
      ![actions containsObject:@"AXPress"] || timed_out(backend, context)) {
    MetaAXPressStatus status = read == META_AX_PRESS_READ_OK
                                   ? META_AX_PRESS_ACTION_UNAVAILABLE
                                   : read_failure(
                                         read,
                                         META_AX_PRESS_ACTION_UNAVAILABLE);
    if (timed_out(backend, context)) status = META_AX_PRESS_TIMED_OUT;
    return outcome(status, NO, depth, kAXErrorActionUnsupported);
  }

  __block BOOL attempted = NO;
  __block AXError error = kAXErrorFailure;
  BOOL admitted = dispatchGate(^BOOL {
    attempted = YES;
    error = [backend performPressForElement:retainedElement];
    return YES;
  });
  if (!attempted) {
    return outcome(META_AX_PRESS_GATE_REJECTED, NO, depth,
                   kAXErrorCannotComplete);
  }
  if (!admitted || timed_out(backend, context)) {
    return outcome(META_AX_PRESS_DISPATCH_UNKNOWN, YES, depth, error);
  }
  return outcome(error == kAXErrorSuccess ? META_AX_PRESS_SUCCEEDED
                                          : META_AX_PRESS_DISPATCH_FAILED,
                 YES, depth, error);
}

@interface MetaAXPressSystemBackend : NSObject <MetaAXPressBackend>
- (instancetype)initWithContext:(MetaAXPressContext)context;
@end

@implementation MetaAXPressSystemBackend {
  MetaAXPressContext _context;
}

- (instancetype)initWithContext:(MetaAXPressContext)context {
  self = [super init];
  if (self) _context = context;
  return self;
}

- (uint64_t)monotonicMillis {
  struct timespec value = {0};
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 +
         (uint64_t)value.tv_nsec / 1000000;
}

- (MetaAXPressReadStatus)prepare:(id)element
                           value:(AXUIElementRef *)value {
  uint64_t now = [self monotonicMillis];
  if (now >= _context.deadline_millis) return META_AX_PRESS_READ_TIMED_OUT;
  uint64_t remaining = _context.deadline_millis - now;
  uint64_t timeout = MIN(_context.per_call_timeout_millis, remaining);
  *value = (__bridge AXUIElementRef)element;
  AXError error = AXUIElementSetMessagingTimeout(
      *value, (float)((NSTimeInterval)timeout / 1000.0));
  if (error == kAXErrorSuccess) return META_AX_PRESS_READ_OK;
  if (error == kAXErrorCannotComplete) return META_AX_PRESS_READ_TIMED_OUT;
  return META_AX_PRESS_READ_FAILED;
}

- (MetaAXPressReadStatus)status:(AXError)error {
  if (error == kAXErrorSuccess) return META_AX_PRESS_READ_OK;
  if (error == kAXErrorNoValue || error == kAXErrorAttributeUnsupported) {
    return META_AX_PRESS_READ_ABSENT;
  }
  if (error == kAXErrorCannotComplete) return META_AX_PRESS_READ_TIMED_OUT;
  return META_AX_PRESS_READ_FAILED;
}

- (BOOL)sameElement:(id)left other:(id)right {
  return left != nil && right != nil &&
         CFEqual((__bridge CFTypeRef)left, (__bridge CFTypeRef)right);
}

- (MetaAXPressReadStatus)ownerPidForElement:(id)element
                                     value:(pid_t *)value {
  AXUIElementRef prepared = NULL;
  MetaAXPressReadStatus status = [self prepare:element value:&prepared];
  return status == META_AX_PRESS_READ_OK
             ? [self status:AXUIElementGetPid(prepared, value)]
             : status;
}

- (MetaAXPressReadStatus)parentForElement:(id)element value:(id *)value {
  AXUIElementRef prepared = NULL;
  MetaAXPressReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_PRESS_READ_OK) return status;
  CFTypeRef copied = NULL;
  status = [self status:AXUIElementCopyAttributeValue(
                            prepared, kAXParentAttribute, &copied)];
  if (status == META_AX_PRESS_READ_OK && copied != NULL &&
      CFGetTypeID(copied) == AXUIElementGetTypeID()) {
    *value = CFBridgingRelease(copied);
    return META_AX_PRESS_READ_OK;
  }
  if (copied != NULL) CFRelease(copied);
  return status == META_AX_PRESS_READ_OK ? META_AX_PRESS_READ_FAILED : status;
}

- (MetaAXPressReadStatus)actionsForElement:(id)element
                                     value:(NSArray<NSString *> **)value {
  AXUIElementRef prepared = NULL;
  MetaAXPressReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_PRESS_READ_OK) return status;
  CFArrayRef copied = NULL;
  status = [self status:AXUIElementCopyActionNames(prepared, &copied)];
  if (status == META_AX_PRESS_READ_OK && copied != NULL) {
    *value = [(__bridge NSArray *)copied copy];
  } else if (status == META_AX_PRESS_READ_OK) {
    status = META_AX_PRESS_READ_FAILED;
  }
  if (copied != NULL) CFRelease(copied);
  return status;
}

- (AXError)performPressForElement:(id)element {
  AXUIElementRef prepared = NULL;
  MetaAXPressReadStatus status = [self prepare:element value:&prepared];
  if (status == META_AX_PRESS_READ_TIMED_OUT) return kAXErrorCannotComplete;
  if (status != META_AX_PRESS_READ_OK) return kAXErrorInvalidUIElement;
  return AXUIElementPerformAction(prepared, kAXPressAction);
}

@end

MetaAXPressOutcome meta_ax_press_borrowed_elements(
    AXUIElementRef retainedElement,
    AXUIElementRef borrowedParent,
    MetaAXPressContext context,
    MetaAXPressDispatchGate dispatchGate) {
  if (retainedElement == NULL || borrowedParent == NULL ||
      CFGetTypeID(retainedElement) != AXUIElementGetTypeID() ||
      CFGetTypeID(borrowedParent) != AXUIElementGetTypeID()) {
    return outcome(META_AX_PRESS_INVALID_REQUEST, NO, 0,
                   kAXErrorInvalidUIElement);
  }
  MetaAXPressSystemBackend *backend =
      [[MetaAXPressSystemBackend alloc] initWithContext:context];
  return meta_ax_press_with_backend((__bridge id)retainedElement,
                                    (__bridge id)borrowedParent,
                                    context, backend, dispatchGate);
}
