#include "meta_command_loop.h"
#include "cursor-display/meta_cursor_display.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  MetaDisplayRecord displays[2];
  MetaInventorySnapshot snapshot;
  double cursor_x;
  double cursor_y;
  uint64_t topology_epoch;
  uint64_t observed_at;
  size_t snapshot_calls;
  size_t topology_calls;
  size_t cursor_calls;
} CursorDisplayFixtureState;

static MetaDisplayRecord fixture_display(uint32_t display_id,
                                         const char *display_ref,
                                         double x,
                                         double width,
                                         double scale,
                                         bool main) {
  MetaDisplayRecord display = {
      .display_id = display_id,
      .bounds = {.x = x, .y = 0, .width = width, .height = 1080},
      .usable_bounds = {.x = x, .y = 24, .width = width, .height = 1056},
      .scale = scale,
      .rotation_degrees = 0,
      .main = main,
  };
  snprintf(display.display_ref, sizeof(display.display_ref), "%s",
           display_ref);
  return display;
}

static const MetaInventorySnapshot *fixture_snapshot(void *context) {
  CursorDisplayFixtureState *state = context;
  state->snapshot_calls += 1;
  return &state->snapshot;
}

static bool fixture_probe_topology(void *context,
                                   const MetaInventorySnapshot *snapshot,
                                   MetaTopologyProbe *output) {
  CursorDisplayFixtureState *state = context;
  assert(snapshot == &state->snapshot);
  state->topology_calls += 1;
  state->observed_at += 1000;
  *output = (MetaTopologyProbe){
      .topology_unchanged = true,
      .observed_at_unix_micros = state->observed_at,
  };
  return true;
}

static bool fixture_topology_epoch(void *context, uint64_t *epoch) {
  *epoch = ((CursorDisplayFixtureState *)context)->topology_epoch;
  return true;
}

static bool fixture_cursor(void *context, double *x, double *y) {
  CursorDisplayFixtureState *state = context;
  state->cursor_calls += 1;
  *x = state->cursor_x;
  *y = state->cursor_y;
  return true;
}

@interface CursorDisplayCommandBackend : NSObject <MetaCommandBackend>
- (instancetype)initWithMode:(NSString *)mode;
@end

@implementation CursorDisplayCommandBackend {
  CursorDisplayFixtureState _state;
}

- (instancetype)initWithMode:(NSString *)mode {
  self = [super init];
  if (self) {
    _state.displays[0] =
        fixture_display(10, "display-left", -1280, 1280, 2, false);
    _state.displays[1] =
        fixture_display(20, "display-main", 0, 1920, 1, true);
    _state.snapshot = (MetaInventorySnapshot){
        .revision = 7,
        .display_layout_revision = 3,
        .display_topology_epoch = 5,
        .captured_at_micros = 1700000000000000ULL,
        .complete = true,
        .displays = _state.displays,
        .display_count = 2,
    };
    snprintf(_state.snapshot.inventory_id,
             sizeof(_state.snapshot.inventory_id), "%s", "inventory-7");
    snprintf(_state.snapshot.layout_ref, sizeof(_state.snapshot.layout_ref),
             "%s", "layout-3");
    snprintf(_state.snapshot.native_generation,
             sizeof(_state.snapshot.native_generation), "%s", "native-1");
    _state.cursor_x = -640;
    _state.cursor_y = 500;
    _state.topology_epoch = 5;
    _state.observed_at = 1700000001000000ULL;
    if ([mode isEqual:@"ambiguous"]) {
      _state.displays[0] =
          fixture_display(10, "display-left", -100, 300, 2, false);
      _state.displays[1] =
          fixture_display(20, "display-main", 0, 300, 1, true);
      _state.cursor_x = 50;
      _state.cursor_y = 50;
    } else if ([mode isEqual:@"stale-epoch"]) {
      _state.topology_epoch = 6;
    }
  }
  return self;
}

- (NSDictionary *)sessionIdentity {
  return @{
    @"source" : @"darwin-audit",
    @"uid" : @501,
    @"effectiveUid" : @501,
    @"verified" : @NO,
    @"reason" : @"Тестовый command loop не вызывает audit syscall",
  };
}

- (NSDictionary *)permissions { return @{}; }
- (NSDictionary *)inventory { return nil; }
- (NSDictionary *)inspect:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)resolveApplication:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)hitTest:(NSDictionary *)request {
  (void)request;
  return nil;
}
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)cleanupCapture:(NSDictionary *)request
                       emitBinary:(BOOL (^)(NSDictionary *, NSData *))emitBinary {
  (void)request;
  (void)emitBinary;
  return nil;
}
- (NSDictionary *)supplementStatus:(NSDictionary *)status { return status; }
- (NSDictionary *)reconcileStatus:(NSDictionary *)status { return status; }
- (NSArray<NSString *> *)pendingOperationIds { return @[]; }
- (NSDictionary *)clipboard:(NSDictionary *)command {
  (void)command;
  return nil;
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
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (NSDictionary *)executeApplication:(NSDictionary *)request
                                  job:(MetaInputJob *)job {
  (void)request;
  (void)job;
  return nil;
}
- (BOOL)beginRotation { return YES; }

- (NSDictionary *)cursorDisplay:(NSDictionary *)request {
  if (request[@"operation"] != nil || request[@"fence"] != nil) return nil;
  NSDictionary *payload = request[@"payload"];
  NSDictionary *generation = @{
    @"runtimeEpoch" : request[@"runtimeEpoch"],
    @"loginSessionId" : request[@"loginSessionId"],
    @"nativeGeneration" : request[@"nativeGeneration"],
  };
  size_t snapshot_before = _state.snapshot_calls;
  size_t topology_before = _state.topology_calls;
  size_t cursor_before = _state.cursor_calls;
  NSDictionary *result = meta_cursor_display_read_with_backend(
      generation, payload[@"inventoryId"],
      [payload[@"inventoryRevision"] unsignedLongLongValue],
      [payload[@"displayLayoutRevision"] unsignedLongLongValue],
      (MetaCursorDisplayBackend){
          .context = &_state,
          .snapshot = fixture_snapshot,
          .probe_topology = fixture_probe_topology,
          .current_topology_epoch = fixture_topology_epoch,
          .read_cursor = fixture_cursor,
      });
  assert(_state.snapshot_calls > snapshot_before);
  if ([result[@"status"] isEqual:@"resolved"] ||
      [result[@"status"] isEqual:@"ambiguous"]) {
    assert(_state.topology_calls - topology_before == 2);
    assert(_state.cursor_calls - cursor_before == 1);
  }
  return result;
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *mode = argc == 2 ? @(argv[1]) : @"resolved";
    return meta_command_loop_run(
        [[CursorDisplayCommandBackend alloc] initWithMode:mode],
        @"cursor-display-fixture-build", @"/tmp/cursor-display-fixture",
        @"native-1", STDIN_FILENO, STDOUT_FILENO);
  }
}
