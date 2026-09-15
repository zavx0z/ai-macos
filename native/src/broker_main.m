#include "meta_command_loop.h"
#include "meta_broker_core.h"
#include "meta_macos.h"
#include "meta_ledger.h"
#include "meta_serialization.h"
#include "meta_input_executor.h"
#include "meta_macos_input.h"
#include "meta_session_identity.h"
#include "clipboard/meta_clipboard.h"
#include "accessibility/meta_ax_inspector.h"
#include "meta_ax_request.h"
#include <time.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

#ifndef META_NATIVE_BUILD_ID
#error META_NATIVE_BUILD_ID must identify the compiled artifact
#endif
#ifndef META_NATIVE_INSTALL_ROOT
#error META_NATIVE_INSTALL_ROOT must identify the canonical installation
#endif

@interface MetaSystemCommandBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithGeneration:(NSString *)generation;
@end

@interface MetaInspectionBorrowContext : NSObject
@property(nonatomic, strong) NSDictionary *request;
@property(nonatomic, strong) NSDictionary *result;
@property(nonatomic, strong) NSString *snapshotId;
@end
@implementation MetaInspectionBorrowContext
@end

static bool inspect_borrowed(void *context, const MetaAXTargetBorrow *borrow) {
  MetaInspectionBorrowContext *binding = (__bridge MetaInspectionBorrowContext *)context;
  MetaAXInspectionContext request = {0};
  if (!meta_ax_build_request(borrow, binding.request, binding.snapshotId, &request)) return false;
  binding.result = meta_ax_inspect_borrowed_element(borrow->element, request);
  return binding.result != nil;
}

@implementation MetaSystemCommandBackend {
  MetaMacOSBackend *_windows;
  MetaCaptureRouter *_captures;
  MetaMacOSInput *_input;
  MetaInputExecutor *_inputExecutor;
  BOOL _sealed;
}

- (instancetype)initWithGeneration:(NSString *)generation {
  self = [super init];
  if (self) {
    _windows = meta_macos_backend_create(generation.UTF8String);
    _captures = meta_capture_router_create(generation.UTF8String, meta_capture_router_default_backend());
    _input = meta_macos_input_create();
    MetaExecutorBackend sink = {.context = _input, .post_held_event = meta_macos_input_post_held,
      .post_text_cluster = meta_macos_input_post_text, .set_event_flags = meta_macos_input_set_flags};
    MetaMacOSBackend *windows = _windows;
    _inputExecutor = [[MetaInputExecutor alloc] initWithGeneration:generation sink:sink verify:^BOOL(NSString *target) {
      return meta_macos_input_preflight() && meta_macos_target_is_focused(windows, target.UTF8String);
    }];
    if (_windows == NULL || _captures == NULL) return nil;
  }
  return self;
}

- (void)dealloc {
  _inputExecutor = nil;
  meta_macos_input_destroy(_input);
  meta_macos_backend_destroy(_windows);
  meta_capture_router_destroy(_captures);
}

- (NSDictionary *)permissions {
  return @{@"accessibility": @(AXIsProcessTrusted()), @"postEvents": @(CGPreflightPostEventAccess()),
           @"screenRecording": @(meta_capture_preflight_screen_recording())};
}

- (NSDictionary *)sessionIdentity {
  MetaSessionIdentity session = meta_session_identity_read();
  NSMutableDictionary *value = [@{@"source": @"darwin-audit", @"uid": @(session.uid),
    @"effectiveUid": @(session.effective_uid), @"verified": session.verified ? @YES : @NO} mutableCopy];
  if (session.verified) {
    value[@"auditUserId"] = @(session.audit_user_id);
    value[@"auditSessionId"] = @(session.audit_session_id);
  } else value[@"reason"] = [NSString stringWithFormat:@"Darwin audit identity недоступна: errno=%d", session.error_number];
  return value;
}

- (NSDictionary *)inventory {
  if (_sealed || !meta_macos_refresh_inventory(_windows, 5000)) return nil;
  NSString *source = [@"native-response-" stringByAppendingString:NSUUID.UUID.UUIDString];
  CFDataRef data = meta_inventory_copy_json(meta_macos_backend_snapshot(_windows), source.UTF8String);
  if (data == NULL) return nil;
  NSDictionary *result = [NSJSONSerialization JSONObjectWithData:(__bridge NSData *)data options:0 error:NULL];
  CFRelease(data);
  return result;
}

- (NSDictionary *)inspect:(NSDictionary *)request {
  NSDictionary *payload = request[@"payload"];
  NSDictionary *target = payload[@"target"];
  NSDictionary *ref = target[@"ref"];
  if (![ref isKindOfClass:NSDictionary.class] || payload[@"cursor"] != nil ||
      [payload[@"depth"] integerValue] < 0 || [payload[@"depth"] integerValue] > 12 ||
      [payload[@"maxNodes"] integerValue] < 1 || [payload[@"maxNodes"] integerValue] > 1500 ||
      [payload[@"maxBytes"] integerValue] < 1 || [payload[@"maxBytes"] integerValue] > 1024 * 1024) return nil;
  NSString *targetRef = [target[@"kind"] isEqual:@"surface"] ? ref[@"surfaceRef"] : ref[@"windowRef"];
  if (![targetRef isKindOfClass:NSString.class]) return nil;
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  if (snapshot == NULL) return nil;
  MetaInspectionBorrowContext *binding = [[MetaInspectionBorrowContext alloc] init];
  binding.request = request;
  binding.snapshotId = [@"ax-" stringByAppendingString:NSUUID.UUID.UUIDString];
  MetaAXBorrowStatus status = meta_macos_with_ax_target(_windows, targetRef.UTF8String,
      snapshot->inventory_id, snapshot->revision, [request[@"nativeGeneration"] UTF8String],
      inspect_borrowed, (__bridge void *)binding);
  if (status != META_AX_BORROW_OK) {
    NSString *code = status == META_AX_BORROW_PERMISSION_DENIED ? @"permission-denied" :
                     status == META_AX_BORROW_TARGET_STALE ? @"target-stale" : @"inventory-incomplete";
    return @{@"nativeError": @{@"code": code, @"message": @"AX inspector не получил подтверждённую live target reference",
      @"stage": @"ax-inspect-borrow", @"retryable": @NO, @"replayAllowed": @NO, @"recoveryAction": @"refresh-inventory"}};
  }
  return binding.result;
}

static NSString *clipboard_error(MetaClipboardStatus status) {
  switch (status) {
    case META_CLIPBOARD_PAYLOAD_TOO_LARGE: return @"payload-too-large";
    case META_CLIPBOARD_INVALID_UTF8: return @"invalid-utf8";
    case META_CLIPBOARD_INVALID_ARGUMENT: return @"invalid-argument";
    default: return @"backend-unavailable";
  }
}

- (NSDictionary *)clipboard:(NSDictionary *)command {
  if (_sealed) return nil;
  NSString *method = command[@"method"];
  NSDictionary *payload = command[@"payload"];
  if (![method isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) return nil;
  MetaClipboardBackend backend = meta_clipboard_system_backend();
  NSDictionary *value = nil;
  if ([method isEqual:@"clipboard.version"]) {
    MetaClipboardVersionResult result = meta_clipboard_read_version(backend);
    value = result.status == META_CLIPBOARD_OK
        ? @{@"status": @"ok", @"changeCount": @(result.change_count)}
        : @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
  } else if ([method isEqual:@"clipboard.read"]) {
    NSNumber *maximum = payload[@"maxBytes"];
    if (![maximum isKindOfClass:NSNumber.class] || maximum.doubleValue != maximum.longLongValue || maximum.longLongValue < 1 || maximum.longLongValue > META_CLIPBOARD_MAX_UTF8_BYTES) return nil;
    size_t capacity = (size_t)maximum.longLongValue;
    uint8_t *output = calloc(capacity, 1);
    if (output == NULL) return nil;
    MetaClipboardReadResult result = meta_clipboard_read_text(backend, output, capacity);
    if (result.status == META_CLIPBOARD_OK) {
      NSString *text = [[NSString alloc] initWithBytes:output length:result.utf8_bytes encoding:NSUTF8StringEncoding];
      value = @{@"status": @"ok", @"text": text ?: @"", @"utf8Bytes": @(result.utf8_bytes),
                @"beforeChangeCount": @(result.before_change_count), @"afterChangeCount": @(result.after_change_count)};
    } else if (result.status == META_CLIPBOARD_CHANGED_DURING_READ || result.status == META_CLIPBOARD_TEXT_UNAVAILABLE) {
      value = @{@"status": result.status == META_CLIPBOARD_CHANGED_DURING_READ ? @"changed-during-read" : @"text-unavailable",
                @"beforeChangeCount": @(result.before_change_count), @"afterChangeCount": @(result.after_change_count)};
    } else value = @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
    memset(output, 0, capacity);
    free(output);
  } else if ([method isEqual:@"clipboard.write"]) {
    NSString *text = payload[@"text"];
    if (![text isKindOfClass:NSString.class]) return nil;
    if ([text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > META_CLIPBOARD_MAX_UTF8_BYTES) {
      value = @{@"status": @"payload-too-large", @"mutationAttempted": @NO};
    } else {
      NSNumber *expected = payload[@"expectedChangeCount"];
      if (expected != nil && (![expected isKindOfClass:NSNumber.class] || expected.doubleValue != expected.longLongValue || expected.longLongValue < 0)) return nil;
      NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
      if (data == nil) return nil;
      MetaClipboardWriteRequest request = {.bytes = data.bytes, .length = data.length,
        .has_expected_change_count = expected != nil, .expected_change_count = expected.longLongValue};
      MetaClipboardWriteResult result = meta_clipboard_write_text(backend, request);
      if (result.status == META_CLIPBOARD_OK) {
        value = @{@"status": @"written", @"beforeChangeCount": @(result.before_change_count),
          @"declaredChangeCount": @(result.declared_change_count), @"afterChangeCount": @(result.after_change_count),
          @"mutationAttempted": @YES, @"setStringSucceeded": @(result.set_string_succeeded),
          @"ownershipStableAfterWrite": @(result.ownership_stable_after_write), @"atomicPrecondition": @NO,
          @"utf8Bytes": @(result.utf8_bytes)};
      } else if (result.status == META_CLIPBOARD_PRECONDITION_MISMATCH) {
        value = @{@"status": @"precondition-mismatch-no-dispatch", @"beforeChangeCount": @(result.before_change_count),
                  @"mutationAttempted": @NO, @"atomicPrecondition": @NO};
      } else if (result.mutation_attempted) {
        value = @{@"status": @"partial-or-unknown", @"beforeChangeCount": @(result.before_change_count),
          @"mutationAttempted": @YES, @"setStringSucceeded": @(result.set_string_succeeded),
          @"ownershipStableAfterWrite": @(result.ownership_stable_after_write), @"atomicPrecondition": @NO,
          @"utf8Bytes": @(result.utf8_bytes)};
      } else value = @{@"status": clipboard_error(result.status), @"mutationAttempted": @NO};
    }
  }
  return value == nil ? nil : @{@"method": method, @"value": value};
}

- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId {
  (void)operationId;
  (void)requestId;
  return nil;
}

- (NSDictionary *)cancel:(NSDictionary *)request {
  (void)request;
  return nil;
}

- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job {
  const MetaInventorySnapshot *snapshot = meta_macos_backend_snapshot(_windows);
  NSDictionary *operation = job.operation;
  if (snapshot == NULL || ![operation[@"inventoryId"] isEqual:@(snapshot->inventory_id)] ||
      [operation[@"inventoryRevision"] unsignedLongLongValue] != snapshot->revision) return nil;
  return [_inputExecutor execute:request job:job];
}

- (BOOL)beginRotation {
  _sealed = YES;
  BOOL inputReady = [_inputExecutor sealForRotation];
  BOOL captureReady = meta_capture_router_seal_for_rotation(_captures);
  return inputReady && captureReady;
}
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *generation = [@"native-" stringByAppendingString:NSUUID.UUID.UUIDString];
    MetaSystemCommandBackend *backend = [[MetaSystemCommandBackend alloc] initWithGeneration:generation];
    if (backend == nil) return 70;
    if (argc == 2 && (strcmp(argv[1], "--metadata") == 0 || strcmp(argv[1], "--doctor") == 0)) {
      NSMutableDictionary *metadata = [@{@"protocolVersion": @"1", @"nativeBuildId": @META_NATIVE_BUILD_ID,
        @"installRoot": @META_NATIVE_INSTALL_ROOT, @"nativeGeneration": generation,
        @"pid": @(getpid()), @"capabilitySchemaVersion": @"1"} mutableCopy];
      metadata[@"session"] = [backend sessionIdentity];
      if (strcmp(argv[1], "--doctor") == 0) metadata[@"permissions"] = [backend permissions];
      NSData *data = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:NULL];
      fwrite(data.bytes, 1, data.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc != 1) return 64;
    return meta_command_loop_run(backend, @META_NATIVE_BUILD_ID, @META_NATIVE_INSTALL_ROOT, generation,
                                  STDIN_FILENO, STDOUT_FILENO);
  }
}
