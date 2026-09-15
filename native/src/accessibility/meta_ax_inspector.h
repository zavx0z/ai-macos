#ifndef META_AX_INSPECTOR_H
#define META_AX_INSPECTOR_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MetaAXReadStatus) {
  META_AX_READ_OK,
  META_AX_READ_ABSENT,
  META_AX_READ_FAILED,
  META_AX_READ_TIMED_OUT,
};

typedef struct {
  const char *runtime_epoch;
  const char *login_session_id;
  const char *native_generation;
  const char *application_ref;
  const char *inventory_id;
  uint64_t inventory_revision;
  const char *snapshot_id;
  const char *target_ref;
  int32_t owner_pid;
  NSUInteger depth;
  NSUInteger max_nodes;
  NSUInteger max_bytes;
  uint64_t deadline_millis;
  uint64_t per_call_timeout_millis;
} MetaAXInspectionContext;

@protocol MetaAXInspectionBackend <NSObject>
- (uint64_t)monotonicMillis;
- (MetaAXReadStatus)ownerPidForElement:(id)element value:(pid_t *)value;
- (MetaAXReadStatus)stringAttribute:(NSString *)attribute
                         forElement:(id)element
                              value:(NSString **)value;
- (MetaAXReadStatus)valueForElement:(id)element value:(id *)value;
- (MetaAXReadStatus)frameForElement:(id)element value:(CGRect *)value;
- (MetaAXReadStatus)actionsForElement:(id)element value:(NSArray<NSString *> **)value;
- (MetaAXReadStatus)childCountForElement:(id)element value:(NSUInteger *)value;
- (MetaAXReadStatus)childrenForElement:(id)element
                                  from:(NSUInteger)index
                                 count:(NSUInteger)count
                                 value:(NSArray **)value;
@end

typedef BOOL (^MetaAXInspectionNodeObserver)(
    NSString *elementRef,
    id borrowedElement,
    NSArray<NSString *> *advertisedActions);

NSDictionary *meta_ax_inspect_with_backend(
    id borrowedRoot,
    MetaAXInspectionContext context,
    id<MetaAXInspectionBackend> backend);

NSDictionary *meta_ax_inspect_with_backend_and_observer(
    id borrowedRoot,
    MetaAXInspectionContext context,
    id<MetaAXInspectionBackend> backend,
    MetaAXInspectionNodeObserver observer);

NSDictionary *meta_ax_inspect_borrowed_element(
    AXUIElementRef borrowedRoot,
    MetaAXInspectionContext context);

NSDictionary *meta_ax_inspect_borrowed_element_and_observer(
    AXUIElementRef borrowedRoot,
    MetaAXInspectionContext context,
    MetaAXInspectionNodeObserver observer);

#endif
