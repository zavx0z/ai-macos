#ifndef META_AX_PRESS_H
#define META_AX_PRESS_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MetaAXPressReadStatus) {
  META_AX_PRESS_READ_OK,
  META_AX_PRESS_READ_ABSENT,
  META_AX_PRESS_READ_FAILED,
  META_AX_PRESS_READ_TIMED_OUT,
};

typedef NS_ENUM(NSInteger, MetaAXPressStatus) {
  META_AX_PRESS_SUCCEEDED,
  META_AX_PRESS_INVALID_REQUEST,
  META_AX_PRESS_TARGET_STALE,
  META_AX_PRESS_ACTION_UNAVAILABLE,
  META_AX_PRESS_TIMED_OUT,
  META_AX_PRESS_GATE_REJECTED,
  META_AX_PRESS_DISPATCH_FAILED,
  META_AX_PRESS_DISPATCH_UNKNOWN,
};

typedef struct {
  pid_t owner_pid;
  NSUInteger max_ancestry_depth;
  uint64_t deadline_millis;
  uint64_t per_call_timeout_millis;
} MetaAXPressContext;

typedef struct {
  MetaAXPressStatus status;
  BOOL dispatch_attempted;
  NSUInteger ancestry_depth;
  int32_t ax_error;
} MetaAXPressOutcome;

typedef BOOL (^MetaAXPressDispatchGate)(BOOL (^perform)(void));

@protocol MetaAXPressBackend <NSObject>
- (uint64_t)monotonicMillis;
- (BOOL)sameElement:(id)left other:(id)right;
- (MetaAXPressReadStatus)ownerPidForElement:(id)element value:(pid_t *)value;
- (MetaAXPressReadStatus)parentForElement:(id)element value:(id *)value;
- (MetaAXPressReadStatus)actionsForElement:(id)element
                                     value:(NSArray<NSString *> **)value;
// Метод вызывается ровно один раз после всех fresh checks. Возвращаемый
// AXError описывает принятый вызов, но не подтверждает semantic effect.
- (AXError)performPressForElement:(id)element;
@end

// retainedElement получен из latest retained snapshot registry, borrowedParent
// — из fresh exact parent target borrow на том же action worker. Функция не
// владеет executor/fence, не делает focus/pointer и не восстанавливает
// elementRef новым tree traversal; bounded AXParent chain обязателен.
MetaAXPressOutcome meta_ax_press_with_backend(
    id retainedElement,
    id borrowedParent,
    MetaAXPressContext context,
    id<MetaAXPressBackend> backend,
    MetaAXPressDispatchGate dispatchGate);

MetaAXPressOutcome meta_ax_press_borrowed_elements(
    AXUIElementRef retainedElement,
    AXUIElementRef borrowedParent,
    MetaAXPressContext context,
    MetaAXPressDispatchGate dispatchGate);

#endif
