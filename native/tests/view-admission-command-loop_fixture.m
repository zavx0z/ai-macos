#include "meta_command_loop.h"
#include "meta_input_executor.h"
#include "input-observer/meta_input_observer_binding.h"
#include "observer-command/meta_observer_command.h"
#include "recovery-domain/meta_recovery_domain.h"
#include "view-admission/meta_view_admission.h"

#include <string.h>
#include <unistd.h>

typedef NS_ENUM(NSInteger, FixtureMode) {
  FixtureModeNormal,
  FixtureModeEventBeforeAdmit,
  FixtureModeEventDuringVerify,
  FixtureModeGapBeforeAdmit,
  FixtureModeDragForeignSecondPoint,
  FixtureModeRelatedFocusAfterMove,
  FixtureModeRelatedFocusAfterDown,
};

@interface AdmissionFixtureObserver : MetaNativeObserver
@end
@implementation AdmissionFixtureObserver
- (BOOL)start {
  [self recordCoverageKind:@"input" available:YES reason:nil];
  [self recordCoverageKind:@"focus" available:YES reason:nil];
  [self recordCoverageKind:@"window-structure" available:YES reason:nil];
  [self recordCoverageKind:@"lifecycle" available:YES reason:nil];
  return YES;
}
- (void)stop { [self markUnavailable:@"Fixture observer stopped"]; }
@end

@interface ViewAdmissionFixtureBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithMode:(FixtureMode)mode reportPath:(NSString *)reportPath;
- (BOOL)postSyntheticTag:(uint64_t)tag;
- (BOOL)postHeldKind:(MetaHeldEventKind)kind
                 code:(uint32_t)code
                 down:(BOOL)down
                  tag:(uint64_t)tag
              cleanup:(BOOL)cleanup;
- (BOOL)postPointer:(const MetaPointerEvent *)event tag:(uint64_t)tag;
@end

static bool fixture_physical_event(void *context,
                                   MetaHeldEventKind kind,
                                   uint32_t code,
                                   bool down,
                                   uint64_t tag) {
  ViewAdmissionFixtureBackend *owner = (__bridge id)context;
  return [owner postHeldKind:kind code:code down:down tag:tag cleanup:NO];
}

static bool fixture_cleanup_event(void *context,
                                  MetaHeldEventKind kind,
                                  uint32_t code,
                                  uint64_t tag) {
  ViewAdmissionFixtureBackend *owner = (__bridge id)context;
  return [owner postHeldKind:kind code:code down:NO tag:tag cleanup:YES];
}

static bool fixture_pointer(void *context,
                            const MetaPointerEvent *event,
                            uint64_t tag) {
  return [(__bridge ViewAdmissionFixtureBackend *)context
      postPointer:event
              tag:tag];
}

static bool fixture_scroll(void *context,
                           const MetaScrollEvent *event,
                           uint64_t tag) {
  (void)event;
  return [(__bridge ViewAdmissionFixtureBackend *)context postSyntheticTag:tag];
}

static bool fixture_text(void *context,
                         const uint16_t *text,
                         size_t length,
                         uint64_t tag) {
  return text != NULL && length > 0 &&
         [(__bridge ViewAdmissionFixtureBackend *)context postSyntheticTag:tag];
}

static bool fixture_flags(void *context, uint64_t flags) {
  (void)context;
  (void)flags;
  return true;
}

@implementation ViewAdmissionFixtureBackend {
  FixtureMode _mode;
  AdmissionFixtureObserver *_observer;
  MetaObserverCommandBinder *_observerCommands;
  MetaViewAdmissionController *_viewAdmissions;
  NSString *_observerInstance;
  MetaInputExecutor *_input;
  NSUInteger _pointerPosts;
  NSUInteger _heldDowns;
  NSUInteger _heldUps;
  NSUInteger _cleanupUps;
  BOOL _verifyEventInjected;
  BOOL _dragForeignInjected;
  NSString *_reportPath;
}

- (instancetype)initWithMode:(FixtureMode)mode reportPath:(NSString *)reportPath {
  self = [super init];
  if (self) {
    _mode = mode;
    _reportPath = [reportPath copy];
    NSDictionary *generation = @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-view-fixture",
    };
    __weak ViewAdmissionFixtureBackend *weakSelf = self;
    _observerCommands = [[MetaObserverCommandBinder alloc]
        initWithGeneration:generation
             nativeBuildId:@"view-fixture-build"
               indexBuilder:^MetaObserverPreparedIndex * {
                 return meta_observer_prepared_index_create(
                     [MetaObserverTargetIndex new], @"inventory-1", 1, 1);
               }
               mainExecutor:^BOOL(BOOL (^work)(void)) { return work(); }
                    factory:^MetaNativeObserver *(
                        NSDictionary *identity,
                        __unused MetaObserverTargetIndex *index) {
                      ViewAdmissionFixtureBackend *owner = weakSelf;
                      AdmissionFixtureObserver *observer =
                          [[AdmissionFixtureObserver alloc]
                              initWithGeneration:identity];
                      owner->_observer = observer;
                      return observer;
                    }
          readinessProvider:^NSDictionary * {
            return @{
              @"state" : @"active-console",
              @"lockState" : @"unknown",
              @"secureInput" : @"off",
              @"userId" : @501,
              @"onConsole" : @YES,
              @"loginDone" : @YES,
              @"auditSessionId" : @42,
              @"evidence" : @"Injected fixture readiness",
              @"observedAt" : @"2026-09-15T10:00:00.000Z",
            };
          }
         instanceIdProvider:^NSString * { return @"observer-1"; }];
    _viewAdmissions = [[MetaViewAdmissionController alloc]
        initWithObserver:_observerCommands
                     now:^NSDate * { return NSDate.date; }
      tombstoneTtlMillis:120000
          maximumRecords:128];
    MetaExecutorBackend sink = {
      .context = (__bridge void *)self,
      .post_held_event = fixture_physical_event,
      .post_cleanup_up = fixture_cleanup_event,
      .post_text_cluster = fixture_text,
      .post_pointer_event = fixture_pointer,
      .post_scroll_event = fixture_scroll,
      .set_event_flags = fixture_flags,
    };
    _input = [[MetaInputExecutor alloc]
        initWithGeneration:@"native-view-fixture"
                      sink:sink
                    verify:^BOOL(NSString *target) {
                      ViewAdmissionFixtureBackend *owner = weakSelf;
                      if (owner->_mode == FixtureModeEventDuringVerify &&
                          !owner->_verifyEventInjected) {
                        owner->_verifyEventInjected = YES;
                        [owner recordForeignEvent];
                      }
                      return [@[@"window-1", @"display-1"]
                          containsObject:target];
                    }];
    [_input setScopedPointVerifier:^BOOL(
        NSDictionary *target, double x, double y) {
      ViewAdmissionFixtureBackend *owner = weakSelf;
      if (owner->_mode == FixtureModeDragForeignSecondPoint &&
          owner->_heldDowns == 1 && x == 20 && y == 20 &&
          !owner->_dragForeignInjected) {
        owner->_dragForeignInjected = YES;
        [owner recordForeignEvent];
      }
      BOOL exact = ([target[@"kind"] isEqual:@"window"] &&
                    [target[@"ref"][@"windowRef"] isEqual:@"window-1"]) ||
                   ([target[@"kind"] isEqual:@"display"] &&
                    [target[@"ref"][@"displayRef"] isEqual:@"display-1"]);
      return exact &&
             x >= 0 && x <= 200 && y >= 0 && y <= 200;
    }];
  }
  return self;
}

- (BOOL)postSyntheticTag:(uint64_t)tag {
  if (tag == 0 || _observer == nil) return NO;
  [_observer recordInputFromPid:getpid() syntheticTag:tag];
  return YES;
}

- (BOOL)postHeldKind:(MetaHeldEventKind)kind
                 code:(uint32_t)code
                 down:(BOOL)down
                  tag:(uint64_t)tag
              cleanup:(BOOL)cleanup {
  if (kind == META_EVENT_KEY && code != 37) return NO;
  if (kind == META_EVENT_BUTTON && code != META_POINTER_LEFT) return NO;
  if (cleanup) _cleanupUps += 1;
  else if (down) _heldDowns += 1;
  else _heldUps += 1;
  BOOL posted = [self postSyntheticTag:tag];
  if (posted && down && _mode == FixtureModeRelatedFocusAfterDown) {
    [_observer recordFocusTarget:@{
      @"kind" : @"window",
      @"ref" : @{
        @"runtimeEpoch" : @"runtime-1",
        @"loginSessionId" : @"login-1",
        @"nativeGeneration" : @"native-view-fixture",
        @"applicationRef" : @"application-1",
        @"windowRef" : @"window-1",
      },
    } syntheticTag:0];
  }
  return posted;
}

- (BOOL)postPointer:(const MetaPointerEvent *)event tag:(uint64_t)tag {
  if (event == NULL) return NO;
  _pointerPosts += 1;
  if (_mode == FixtureModeDragForeignSecondPoint && _pointerPosts > 1)
    return NO;
  BOOL posted = [self postSyntheticTag:tag];
  if (posted && _mode == FixtureModeRelatedFocusAfterMove) {
    [_observer recordFocusTarget:@{
      @"kind" : @"window",
      @"ref" : @{
        @"runtimeEpoch" : @"runtime-1",
        @"loginSessionId" : @"login-1",
        @"nativeGeneration" : @"native-view-fixture",
        @"applicationRef" : @"application-1",
        @"windowRef" : @"window-1",
      },
    } syntheticTag:0];
  }
  return posted;
}

- (void)recordForeignEvent {
  [_observer recordInputFromPid:getpid() + 1 syntheticTag:0];
}

- (NSString *)recoveryDomainVersion { return @"1"; }
- (NSString *)viewAdmissionVersion { return @"1"; }
- (BOOL)validateRecoveryRequest:(NSDictionary *)request {
  return meta_recovery_domain_validate_request(
      request, @"view-fixture-build", NULL, NULL);
}
- (NSDictionary *)sessionIdentity {
  return @{
    @"verified" : @NO,
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"reason" : @"Injected fixture не вызывает audit syscall",
  };
}
- (NSArray<NSDictionary *> *)capabilityCatalog {
  return @[
    @{@"id" : @"runtime.identity", @"state" : @"ready"},
    @{@"id" : @"input.keyboard", @"state" : @"ready"},
    @{@"id" : @"input.pointer", @"state" : @"ready"},
    @{@"id" : @"input.drag", @"state" : @"ready"},
  ];
}

- (NSDictionary *)observer:(NSDictionary *)request {
  NSDictionary *result = [_observerCommands handleRequest:request];
  if ([result[@"ok"] isEqual:@YES]) {
    _observerInstance = [result[@"command"] isEqual:@"stop"]
                            ? nil
                            : result[@"snapshot"][@"observerInstanceRef"];
  }
  return result;
}
- (BOOL)activateObserverPush:(NSString *)instanceRef {
  return [_observerCommands activatePushForObserverInstance:instanceRef];
}
- (NSDictionary *)takeObserverPush:(NSUInteger)maximum {
  return [_observerCommands takePushEnvelopes:maximum];
}
- (void)stopObserver {
  if (_observerInstance != nil) [_observer stop];
  if (_reportPath != nil) {
    NSDictionary *report = @{
      @"pointerPosts" : @(_pointerPosts),
      @"heldDowns" : @(_heldDowns),
      @"heldUps" : @(_heldUps),
      @"cleanupUps" : @(_cleanupUps),
    };
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:report
                                                     options:0
                                                       error:NULL];
    [bytes writeToFile:_reportPath atomically:YES];
  }
}

- (NSDictionary *)executeInput:(NSDictionary *)request
                            job:(MetaInputJob *)job {
  NSDictionary *operation = job.operation;
  if (_mode == FixtureModeEventBeforeAdmit) [self recordForeignEvent];
  if (_mode == FixtureModeGapBeforeAdmit)
    [_observer markUnavailable:@"Injected observer gap before admission"];
  NSString *viewError = nil;
  NSDictionary *head = [_viewAdmissions
      admitRequest:request
             proof:request[@"viewAdmission"]
             error:&viewError];
  __block BOOL admissionRejected = head == nil;
  MetaInputObserverBinding *binding = [[MetaInputObserverBinding alloc]
      initWithObserver:_observerCommands
      observerInstanceRef:_observerInstance
      operationId:operation[@"operationId"]
      target:operation[@"target"]
      interactionId:nil];
  BOOL headInstalled = head != nil && [binding useAdmissionHead:head];
  if (!headInstalled) admissionRejected = YES;
  [job setObserverCoverageProvider:^NSDictionary * {
    return [binding currentCoverage];
  }];
  MetaExecutor *executor = [_input executorOnActionWorker];
  NSDictionary *inputAction = request[@"payload"][@"action"];
  BOOL allowRelatedClickFocus = [inputAction[@"kind"] isEqual:@"click"] &&
      [inputAction[@"count"] isEqual:@1] &&
      [operation[@"target"][@"kind"] isEqual:@"window"];
  [binding setRelatedClickFocusPolicy:allowRelatedClickFocus
                        phaseProvider:^NSUInteger {
    return (NSUInteger)meta_executor_status(executor).dispatch_attempts;
  }];
  meta_executor_set_observer_state(
      executor,
      [binding currentCoverage] == nil ? META_OBSERVER_UNAVAILABLE
                                       : META_OBSERVER_READY);
  [_input setInputObserverAfterBegin:^BOOL(
      MetaExecutor *accepted, MetaInputJob *current) {
    return headInstalled && accepted == executor && current == job &&
           [binding registerTag:meta_executor_synthetic_tag(accepted)];
  } poll:^MetaInputObserverDecision {
    MetaInputObserverPollResult value = [binding poll];
    if (value == MetaInputObserverPollContinue)
      return MetaInputObserverContinue;
    if (value == MetaInputObserverPollForeignEvent)
      return MetaInputObserverForeignEvent;
    return value == MetaInputObserverPollUIInvalidation
               ? MetaInputObserverUIInvalidation
               : MetaInputObserverUnavailable;
  }];
  [_input setFirstDispatchGuard:^BOOL {
    BOOL allowed = headInstalled &&
        [self->_viewAdmissions recheckOperationId:operation[@"operationId"]];
    if (!allowed) admissionRejected = YES;
    return allowed;
  }];
  NSDictionary *result = [_input execute:request job:job];
  [binding stop];
  [_input setInputObserverAfterBegin:nil poll:nil];
  [_input setFirstDispatchGuard:nil];
  [_viewAdmissions finishOperationId:operation[@"operationId"]];
  meta_executor_set_observer_state(executor, META_OBSERVER_UNAVAILABLE);
  if (!admissionRejected) return result;
  NSMutableDictionary *failure = [@{
    @"nativeError" : @{
      @"code" : @"observation-stale",
      @"message" : viewError ?: @"View admission changed before dispatch",
      @"stage" : @"view-admission-fixture",
      @"retryable" : @NO,
      @"replayAllowed" : @NO,
      @"recoveryAction" : @"capture-new-observation",
    },
  } mutableCopy];
  if (result[@"status"] != nil) failure[@"nativeStatus"] = result[@"status"];
  return failure;
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)resolveApplication:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)hitTest:(NSDictionary *)request { (void)request; return nil; }
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary { (void)request; (void)emitBinary; return nil; }
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command { (void)command; return nil; }
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId { (void)operationId; (void)requestId; return nil; }
- (NSDictionary *)cancel:(NSDictionary *)request { (void)request; return @{}; }
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job { (void)request; (void)job; return nil; }
- (BOOL)beginRotation { return [_input sealForRotation]; }

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    FixtureMode mode = FixtureModeNormal;
    if (argc >= 2 && strcmp(argv[1], "--event-before-admit") == 0)
      mode = FixtureModeEventBeforeAdmit;
    else if (argc >= 2 && strcmp(argv[1], "--event-during-verify") == 0)
      mode = FixtureModeEventDuringVerify;
    else if (argc >= 2 && strcmp(argv[1], "--gap-before-admit") == 0)
      mode = FixtureModeGapBeforeAdmit;
    else if (argc >= 2 && strcmp(argv[1], "--drag-foreign-second") == 0)
      mode = FixtureModeDragForeignSecondPoint;
    else if (argc >= 2 && strcmp(argv[1], "--focus-after-move") == 0)
      mode = FixtureModeRelatedFocusAfterMove;
    else if (argc >= 2 && strcmp(argv[1], "--focus-after-down") == 0)
      mode = FixtureModeRelatedFocusAfterDown;
    NSString *reportPath = argc >= 3 ? @(argv[2]) : nil;
    return meta_command_loop_run(
        [[ViewAdmissionFixtureBackend alloc] initWithMode:mode
                                               reportPath:reportPath],
        @"view-fixture-build",
        @"/tmp/view-fixture",
        @"native-view-fixture",
        STDIN_FILENO,
        STDOUT_FILENO);
  }
}
