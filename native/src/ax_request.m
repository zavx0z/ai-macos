#include "meta_ax_request.h"
#include <time.h>

static bool bounded_integer(id value, NSInteger minimum, NSInteger maximum) {
  return [value isKindOfClass:NSNumber.class] && [value doubleValue] == [value longLongValue] &&
         [value longLongValue] >= minimum && [value longLongValue] <= maximum;
}

bool meta_ax_build_request(const MetaAXTargetBorrow *borrow, NSDictionary *request,
                           NSString *snapshotId, MetaAXInspectionContext *output) {
  if (borrow == NULL || output == NULL || ![request isKindOfClass:NSDictionary.class] ||
      ![snapshotId isKindOfClass:NSString.class] || snapshotId.length == 0) return false;
  NSDictionary *payload = request[@"payload"];
  if (![payload isKindOfClass:NSDictionary.class]) return false;
  NSDictionary *target = payload[@"target"];
  if (![target isKindOfClass:NSDictionary.class]) return false;
  NSDictionary *ref = target[@"ref"];
  if (![ref isKindOfClass:NSDictionary.class] || ![ref[@"applicationRef"] isEqual:@(borrow->target.application_ref)] ||
      ![ref[@"nativeGeneration"] isEqual:@(borrow->native_generation)] ||
      ![request[@"nativeGeneration"] isEqual:@(borrow->native_generation)] ||
      ![request[@"runtimeEpoch"] isKindOfClass:NSString.class] || ![request[@"loginSessionId"] isKindOfClass:NSString.class] ||
      ![ref[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] || ![ref[@"loginSessionId"] isEqual:request[@"loginSessionId"]]) return false;
  if ([target[@"kind"] isEqual:@"window"]) {
    if (borrow->target.surface_kind != META_SURFACE_WINDOW || borrow->target.window_ref[0] == '\0' ||
        ![ref[@"windowRef"] isEqual:@(borrow->target.window_ref)]) return false;
  } else if ([target[@"kind"] isEqual:@"surface"]) {
    if (borrow->target.surface_kind == META_SURFACE_WINDOW || borrow->target.surface_ref[0] == '\0' ||
        ![ref[@"surfaceRef"] isEqual:@(borrow->target.surface_ref)] ||
        ![ref[@"ownerWindowRef"] isEqual:@(borrow->target.owner_window_ref)]) return false;
  } else return false;
  if (!bounded_integer(payload[@"depth"], 0, 12) || !bounded_integer(payload[@"maxNodes"], 1, 1500) ||
      !bounded_integer(payload[@"maxBytes"], 1, 1024 * 1024) || payload[@"cursor"] != nil) return false;
  if (![request[@"deadlineAt"] isKindOfClass:NSString.class]) return false;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *deadline = [formatter dateFromString:request[@"deadlineAt"]];
  double remaining = deadline.timeIntervalSinceNow * 1000;
  if (deadline == nil || remaining <= 0) return false;
  struct timespec now = {0};
  clock_gettime(CLOCK_MONOTONIC, &now);
  *output = (MetaAXInspectionContext){
    .runtime_epoch = [request[@"runtimeEpoch"] UTF8String], .login_session_id = [request[@"loginSessionId"] UTF8String],
    .native_generation = borrow->native_generation, .application_ref = borrow->target.application_ref,
    .inventory_id = borrow->inventory_id, .inventory_revision = borrow->inventory_revision,
    .snapshot_id = snapshotId.UTF8String, .target_ref = borrow->target.target_ref, .owner_pid = borrow->target.pid,
    .depth = [payload[@"depth"] unsignedIntegerValue], .max_nodes = [payload[@"maxNodes"] unsignedIntegerValue],
    .max_bytes = [payload[@"maxBytes"] unsignedIntegerValue],
    .deadline_millis = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000 + (uint64_t)MIN(remaining, 5000),
    .per_call_timeout_millis = 500,
  };
  return true;
}
