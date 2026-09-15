#include "meta_readiness_system.h"
#include "../input-target/meta_geometry_probe.h"
#include "meta_session_identity.h"
#include <math.h>
#include <stdio.h>

@interface MetaReadinessSystemContext ()
@property(nonatomic) MetaMacOSBackend *windows;
@property(nonatomic, copy) NSDictionary *expected;
@property(nonatomic, strong) MetaObserverCommandBinder *observer;
@property(nonatomic, copy) NSString *instance;
@property(nonatomic, copy) NSDictionary *(^sessionProvider)(void);
@end

static bool copy_cursor(NSString *value, char *destination, size_t capacity) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 ||
      [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= capacity) return false;
  snprintf(destination, capacity, "%s", value.UTF8String);
  return true;
}

static bool read_session(void *context, MetaReadinessSessionFacts *facts) {
  MetaReadinessSystemContext *owner = (__bridge MetaReadinessSystemContext *)context;
  NSDictionary *session = owner.sessionProvider();
  if (![session isKindOfClass:NSDictionary.class]) return false;
  MetaSessionIdentity audit = meta_session_identity_read();
  NSString *login = audit.verified ? [NSString stringWithFormat:@"audit:%u:%u", audit.uid, audit.audit_session_id] : nil;
  *facts = (MetaReadinessSessionFacts){
    .audit_identity_verified = audit.verified,
    .audit_session_matches = [login isEqual:owner.expected[@"loginSessionId"]],
    .real_uid = audit.uid, .effective_uid = audit.effective_uid, .audit_uid = audit.audit_user_id,
    .session_uid = [session[@"userId"] isKindOfClass:NSNumber.class] ? [session[@"userId"] unsignedIntValue] : UINT32_MAX,
    .active_console = [session[@"state"] isEqual:@"active-console"],
    .on_console = [session[@"onConsole"] isEqual:@YES], .login_done = [session[@"loginDone"] isEqual:@YES],
    .lock_state = [session[@"lockState"] isEqual:@"locked"] ? META_READINESS_LOCK_LOCKED : META_READINESS_LOCK_UNKNOWN,
    .secure_input = [session[@"secureInput"] isEqual:@"off"] ? META_READINESS_SECURE_INPUT_OFF :
        [session[@"secureInput"] isEqual:@"on"] ? META_READINESS_SECURE_INPUT_ON : META_READINESS_SECURE_INPUT_UNKNOWN,
  };
  return true;
}

static bool read_permissions(void *context, MetaReadinessPermissions *permissions) {
  (void)context;
  *permissions = (MetaReadinessPermissions){.accessibility = AXIsProcessTrusted(),
    .post_events = CGPreflightPostEventAccess(), .listen_events = CGPreflightListenEventAccess()};
  return true;
}

static bool read_observer(void *context, MetaReadinessObserverSnapshot *snapshot) {
  NSDictionary *coverage = [(__bridge MetaReadinessSystemContext *)context coverage];
  if (coverage == nil || !copy_cursor(coverage[@"cursor"], snapshot->cursor, sizeof(snapshot->cursor))) return false;
  NSSet *kinds = [coverage[@"coveredKinds"] isKindOfClass:NSArray.class] ? [NSSet setWithArray:coverage[@"coveredKinds"]] : nil;
  snapshot->ready = [coverage[@"state"] isEqual:@"ready"] &&
      [kinds isEqualToSet:[NSSet setWithArray:@[@"input", @"focus", @"window-structure", @"lifecycle"]]];
  snapshot->gap_detected = [coverage[@"gapDetected"] boolValue] || [coverage[@"droppedEvents"] unsignedLongLongValue] != 0;
  snapshot->continuous = snapshot->ready && !snapshot->gap_detected;
  return true;
}

static bool read_cursor(void *context, MetaReadinessPoint *point) {
  (void)context;
  CGEventRef event = CGEventCreate(NULL);
  if (event == NULL) return false;
  CGPoint location = CGEventGetLocation(event);
  CFRelease(event);
  if (!isfinite(location.x) || !isfinite(location.y)) return false;
  *point = (MetaReadinessPoint){.x = location.x, .y = location.y};
  return true;
}

static bool resolve_display(void *context, MetaReadinessPoint point, MetaReadinessDisplay *display) {
  MetaReadinessSystemContext *owner = (__bridge MetaReadinessSystemContext *)context;
  if (![owner targetAvailable]) return false;
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(owner.windows);
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    const MetaDisplayRecord *candidate = &snapshot->displays[index];
    MetaRect bounds = candidate->bounds;
    if ([owner.expected[@"displayRef"] isEqual:@(candidate->display_ref)] &&
        isfinite(point.x) && isfinite(point.y) && point.x >= bounds.x && point.y >= bounds.y &&
        point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height) {
      if (!copy_cursor(@(candidate->display_ref), display->display_ref, sizeof(display->display_ref))) return false;
      display->bounds = bounds;
      return true;
    }
  }
  return false;
}

static bool scan_events(void *context, const char *after, uint64_t tag, bool requireOwn, uint64_t timeout, MetaReadinessEventScan *scan) {
  MetaReadinessSystemContext *owner = (__bridge MetaReadinessSystemContext *)context;
  NSDictionary *result = [owner.observer scanEventsAfterCursor:@(after) expectedSyntheticTag:tag
      requireOwnEvent:requireOwn timeoutMillis:timeout observerInstanceRef:owner.instance];
  if (result == nil || !copy_cursor(result[@"cursor"], scan->cursor, sizeof(scan->cursor))) return false;
  NSString *state = result[@"state"];
  scan->state = [state isEqual:@"own-event-only"] ? META_READINESS_SCAN_OWN_EVENT_ONLY :
      [state isEqual:@"no-events"] ? META_READINESS_SCAN_NO_EVENTS :
      [state isEqual:@"user-takeover"] ? META_READINESS_SCAN_USER_TAKEOVER : META_READINESS_SCAN_UNKNOWN;
  if (scan->state == META_READINESS_SCAN_OWN_EVENT_ONLY) {
    NSString *expected = [NSString stringWithFormat:@"event-%016llx", tag];
    if (![result[@"syntheticTag"] isEqual:expected]) return false;
    scan->synthetic_tag = tag;
  }
  return true;
}

@implementation MetaReadinessSystemContext
- (instancetype)initWithWindows:(MetaMacOSBackend *)windows expectedDisplay:(NSDictionary *)expectedDisplay
                         observer:(MetaObserverCommandBinder *)observer observerInstance:(NSString *)observerInstance
                  sessionProvider:(NSDictionary *(^)(void))sessionProvider {
  self = [super init];
  if (self) {
    _windows = windows;
    _expected = [expectedDisplay copy];
    _observer = observer;
    _instance = [observerInstance copy];
    _sessionProvider = [sessionProvider copy];
  }
  return self;
}
- (NSDictionary *)coverage { return [self.observer currentCoverageForObserverInstance:self.instance]; }
- (BOOL)targetAvailable {
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(self.windows);
  if (snapshot == NULL || ![self.expected[@"nativeGeneration"] isEqual:@(snapshot->native_generation)] ||
      ![self.expected[@"displayLayoutRevision"] isKindOfClass:NSNumber.class] ||
      [self.expected[@"displayLayoutRevision"] unsignedLongLongValue] != snapshot->display_layout_revision) return NO;
  MetaTopologyProbe topology = {0};
  if (!meta_macos_probe_topology(self.windows, snapshot, &topology) || !topology.topology_unchanged) return NO;
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    if ([self.expected[@"displayRef"] isEqual:@(snapshot->displays[index].display_ref)]) return YES;
  }
  return NO;
}
- (MetaInputReadinessBackend)backend {
  return (MetaInputReadinessBackend){.context = (__bridge void *)self,
    .read_session = read_session, .read_permissions = read_permissions, .read_observer = read_observer,
    .read_cursor = read_cursor, .resolve_display = resolve_display, .scan_events = scan_events};
}
@end
