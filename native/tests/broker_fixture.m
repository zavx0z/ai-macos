#import <Foundation/Foundation.h>

#include <arpa/inet.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "meta_ledger.h"
#include "meta_input_bridge.h"
#include "meta_native.h"

typedef struct {
  MetaExecutor *executor;
  uint64_t now_millis;
  size_t posted_events;
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
} FixtureBroker;

static bool read_exact(void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    const ssize_t count = read(STDIN_FILENO, cursor, length);
    if (count <= 0) return false;
    cursor += (size_t)count;
    length -= (size_t)count;
  }
  return true;
}

static bool write_exact(const void *buffer, size_t length) {
  const unsigned char *cursor = buffer;
  while (length > 0) {
    const ssize_t count = write(STDOUT_FILENO, cursor, length);
    if (count <= 0) return false;
    cursor += (size_t)count;
    length -= (size_t)count;
  }
  return true;
}

static NSDictionary *read_frame(void) {
  uint32_t encoded_length = 0;
  if (!read_exact(&encoded_length, sizeof(encoded_length))) return nil;
  const uint32_t length = ntohl(encoded_length);
  if (length == 0 || length > 1024 * 1024) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:length];
  if (!read_exact(data.mutableBytes, length)) return nil;
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  return error == nil && [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static bool write_frame(NSDictionary *frame) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:frame options:0
                                                    error:&error];
  if (data == nil || error != nil || data.length > 1024 * 1024) return false;
  const uint32_t encoded_length = htonl((uint32_t)data.length);
  return write_exact(&encoded_length, sizeof(encoded_length)) &&
         write_exact(data.bytes, data.length);
}

static NSString *string_value(NSDictionary *value, NSString *key) {
  id item = value[key];
  return [item isKindOfClass:NSString.class] ? item : nil;
}

static NSDictionary *dictionary_value(NSDictionary *value, NSString *key) {
  id item = value[key];
  return [item isKindOfClass:NSDictionary.class] ? item : nil;
}

static bool copy_identifier(NSDictionary *value, NSString *key, char *target,
                            size_t capacity) {
  NSString *item = string_value(value, key);
  if (item == nil) return false;
  const char *bytes = item.UTF8String;
  if (bytes == NULL || bytes[0] == '\0' || strlen(bytes) >= capacity) {
    return false;
  }
  snprintf(target, capacity, "%s", bytes);
  return true;
}

static NSString *now_iso(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

static NSDate *parse_iso(NSString *value) {
  if (value == nil) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter dateFromString:value];
}

static uint64_t monotonic_millis(void *context) {
  FixtureBroker *broker = context;
  struct timespec value = {0};
  clock_gettime(CLOCK_MONOTONIC, &value);
  broker->now_millis = (uint64_t)value.tv_sec * 1000ULL +
                       (uint64_t)value.tv_nsec / 1000000ULL;
  return broker->now_millis;
}

static bool verify_target(void *context, const char *target_ref) {
  (void)context;
  return target_ref != NULL && target_ref[0] != '\0';
}

static NSString *ledger_kind(MetaHeldEventKind kind) {
  return kind == META_EVENT_KEY ? @"key" : @"button";
}

static NSString *ledger_state(MetaLedgerState state) {
  switch (state) {
    case META_LEDGER_PENDING_DOWN:
      return @"pending-down";
    case META_LEDGER_CONFIRMED_DOWN:
      return @"confirmed-down";
    case META_LEDGER_PENDING_UP:
      return @"pending-up";
    case META_LEDGER_RELEASED:
      return @"released";
    case META_LEDGER_UNCERTAIN:
      return @"uncertain";
  }
  return @"uncertain";
}

static bool persist_ledger(void *context,
                           const MetaLedgerPersistenceRequest *request,
                           MetaLedgerPersistenceAck *ack) {
  (void)context;
  NSMutableArray *entries = [NSMutableArray array];
  for (size_t index = 0; index < request->snapshot.entry_count; index += 1) {
    const MetaLedgerEntry *entry = &request->snapshot.entries[index];
    [entries addObject:@{
      @"sequence" : @(entry->sequence),
      @"kind" : ledger_kind(entry->kind),
      @"code" : @(entry->code),
      @"state" : ledger_state(entry->state),
    }];
  }
  NSMutableDictionary *snapshot = [@{
    @"canonicalVersion" : @"1",
    @"operationId" : @(request->snapshot.operation_id),
    @"runtimeEpoch" : @(request->snapshot.runtime_epoch),
    @"loginSessionId" : @(request->snapshot.login_session_id),
    @"nativeGeneration" : @(request->snapshot.native_generation),
    @"revision" : @(request->snapshot.revision),
    @"entries" : entries,
  } mutableCopy];
  if (request->snapshot.has_previous_snapshot_sha256) {
    snapshot[@"previousSnapshotSha256"] =
        @(request->snapshot.previous_snapshot_sha256);
  }
  if (!write_frame(@{
        @"channel" : @"ledger-persist",
        @"payload" : @{
          @"requestId" : @(request->request_id),
          @"snapshot" : snapshot,
        },
      })) {
    return false;
  }
  NSDictionary *frame = read_frame();
  if (![string_value(frame, @"channel") isEqualToString:@"ledger-ack"]) {
    return false;
  }
  NSDictionary *payload = dictionary_value(frame, @"payload");
  if (payload == nil ||
      ![string_value(payload, @"requestId")
          isEqualToString:@(request->request_id)] ||
      ![string_value(payload, @"operationId")
          isEqualToString:@(request->snapshot.operation_id)] ||
      ![string_value(payload, @"runtimeEpoch")
          isEqualToString:@(request->snapshot.runtime_epoch)] ||
      ![string_value(payload, @"loginSessionId")
          isEqualToString:@(request->snapshot.login_session_id)] ||
      ![string_value(payload, @"nativeGeneration")
          isEqualToString:@(request->snapshot.native_generation)] ||
      ![payload[@"durable"] isEqual:@YES] ||
      [payload[@"revision"] unsignedLongLongValue] !=
          request->snapshot.revision) {
    return false;
  }
  char expected_digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(&request->snapshot, expected_digest) ||
      ![string_value(payload, @"snapshotSha256")
          isEqualToString:@(expected_digest)]) {
    return false;
  }
  memset(ack, 0, sizeof(*ack));
  snprintf(ack->request_id, sizeof(ack->request_id), "%s",
           request->request_id);
  snprintf(ack->operation_id, sizeof(ack->operation_id), "%s",
           request->snapshot.operation_id);
  snprintf(ack->runtime_epoch, sizeof(ack->runtime_epoch), "%s",
           request->snapshot.runtime_epoch);
  snprintf(ack->login_session_id, sizeof(ack->login_session_id), "%s",
           request->snapshot.login_session_id);
  snprintf(ack->native_generation, sizeof(ack->native_generation), "%s",
           request->snapshot.native_generation);
  ack->revision = request->snapshot.revision;
  snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s",
           expected_digest);
  ack->persisted_at_unix_micros = 1;
  ack->durable = true;
  return true;
}

static bool post_held_event(void *context, MetaHeldEventKind kind, uint32_t code,
                            bool down, uint64_t synthetic_tag) {
  FixtureBroker *broker = context;
  (void)kind;
  (void)code;
  (void)down;
  (void)synthetic_tag;
  broker->posted_events += 1;
  return true;
}

static bool post_cleanup_up(void *context, MetaHeldEventKind kind, uint32_t code, uint64_t tag) {
  return post_held_event(context, kind, code, false, tag);
}

static bool post_text_cluster(void *context, const uint16_t *utf16_units,
                              size_t utf16_count, uint64_t synthetic_tag) {
  FixtureBroker *broker = context;
  (void)utf16_units;
  if (utf16_count == 0 || synthetic_tag == 0) return false;
  broker->posted_events += 1;
  return true;
}

static bool set_event_flags(void *context, uint64_t flags) {
  (void)context;
  (void)flags;
  return true;
}

static bool wait_until(void *context, uint64_t deadline_millis) {
  FixtureBroker *broker = context;
  while (monotonic_millis(broker) < deadline_millis) {
    const uint64_t remaining = deadline_millis - broker->now_millis;
    usleep((useconds_t)MIN(remaining, 10) * 1000);
  }
  return true;
}

static NSString *execution_name(MetaExecutorState state) {
  switch (state) {
    case META_EXECUTOR_IDLE:
      return @"idle";
    case META_EXECUTOR_DISPATCHING:
      return @"dispatching";
    case META_EXECUTOR_CANCELLING:
      return @"cancelling";
    case META_EXECUTOR_CANCELLED:
      return @"cancelled";
    case META_EXECUTOR_FINISHED:
      return @"finished";
    case META_EXECUTOR_FAILED:
      return @"failed";
    case META_EXECUTOR_INTERRUPTED_UNKNOWN:
      return @"interrupted-unknown";
    case META_EXECUTOR_QUARANTINED:
      return @"quarantined";
  }
  return @"failed";
}

static NSString *dispatch_name(MetaDispatchState state) {
  switch (state) {
    case META_DISPATCH_NONE:
      return @"none";
    case META_DISPATCH_ATTEMPTED:
      return @"attempted";
    case META_DISPATCH_PARTIAL:
      return @"partial";
    case META_DISPATCH_FINISHED:
      return @"finished";
    case META_DISPATCH_UNKNOWN:
      return @"unknown";
  }
  return @"unknown";
}

static NSString *cleanup_name(MetaCleanupState state) {
  switch (state) {
    case META_CLEANUP_COMPLETE:
      return @"complete";
    case META_CLEANUP_INCOMPLETE:
      return @"incomplete";
    case META_CLEANUP_UNKNOWN:
      return @"unknown";
  }
  return @"unknown";
}

static NSString *verification_name(MetaVerificationState state) {
  switch (state) {
    case META_VERIFICATION_VERIFIED:
      return @"verified";
    case META_VERIFICATION_FAILED:
      return @"failed";
    case META_VERIFICATION_UNKNOWN:
      return @"unknown";
  }
  return @"unknown";
}

static NSString *interference_name(MetaInterferenceState state) {
  switch (state) {
    case META_INTERFERENCE_NONE_OBSERVED:
      return @"none-observed";
    case META_INTERFERENCE_OBSERVED:
      return @"observed";
    case META_INTERFERENCE_UNKNOWN:
      return @"unknown";
  }
  return @"unknown";
}

static NSDictionary *fence_dictionary(MetaFence fence) {
  return @{
    @"runtimeEpoch" : @(fence.runtime_epoch),
    @"loginSessionId" : @(fence.login_session_id),
    @"nativeGeneration" : @(fence.native_generation),
    @"counter" : @(fence.counter),
  };
}

static NSDictionary *status_dictionary(FixtureBroker *broker,
                                       NSString *request_id) {
  const MetaExecutorStatus status = meta_executor_status(broker->executor);
  const NSString *timestamp = now_iso();
  NSMutableDictionary *result = [@{
    @"requestId" : request_id,
    @"runtimeEpoch" : @(broker->runtime_epoch),
    @"loginSessionId" : @(broker->login_session_id),
    @"nativeGeneration" : @(broker->native_generation),
    @"execution" : execution_name(status.execution),
    @"dispatch" : dispatch_name(status.dispatch),
    @"cleanup" : cleanup_name(status.cleanup),
    @"targetVerified" : verification_name(status.target_verification),
    @"cancellationRequested" : @(status.cancellation_requested),
    @"userInterference" : interference_name(status.user_interference),
    @"restorationAllowed" : @(status.restoration_allowed),
    @"quarantined" : @(status.quarantined),
    @"heldCount" : @(status.held_count),
    @"dispatchAttempts" : @(status.dispatch_attempts),
    @"ledgerRevision" : @(status.ledger_revision),
    @"observer" : @{
      @"state" : @"unavailable",
      @"runtimeEpoch" : @(broker->runtime_epoch),
      @"loginSessionId" : @(broker->login_session_id),
      @"nativeGeneration" : @(broker->native_generation),
      @"coverageStartCursor" : @"observer-0",
      @"cursor" : @"observer-0",
      @"nextSequence" : @1,
      @"startedAt" : timestamp,
      @"coveredFrom" : timestamp,
      @"coveredThrough" : timestamp,
      @"heartbeatAt" : timestamp,
      @"coveredKinds" : @[],
      @"droppedEvents" : @0,
      @"gapDetected" : @NO,
      @"reason" : @"fixture event observer отключён",
    },
  } mutableCopy];
  if (status.operation_id[0] != '\0') {
    result[@"operationId"] = @(status.operation_id);
  }
  if (status.has_high_water_fence) {
    result[@"highWaterFence"] = fence_dictionary(status.high_water_fence);
  }
  if (status.has_accepted_fence) {
    result[@"acceptedFence"] = fence_dictionary(status.accepted_fence);
  }
  if (status.last_checkpoint[0] != '\0') {
    result[@"lastCheckpoint"] = @(status.last_checkpoint);
  }
  return result;
}

static NSDictionary *contract_error(NSString *code, NSString *message,
                                    NSString *stage) {
  return @{
    @"code" : code,
    @"message" : message,
    @"stage" : stage,
    @"retryable" : @NO,
    @"replayAllowed" : @NO,
    @"recoveryAction" : @"get-operation",
  };
}

static NSDictionary *response_base(FixtureBroker *broker,
                                   NSDictionary *request) {
  NSMutableDictionary *response = [@{
    @"kind" : @"response",
    @"protocolVersion" : @"1",
    @"requestId" : string_value(request, @"requestId") ?: @"invalid-request",
    @"runtimeEpoch" : @(broker->runtime_epoch),
    @"loginSessionId" : @(broker->login_session_id),
    @"nativeGeneration" : @(broker->native_generation),
  } mutableCopy];
  NSDictionary *operation = dictionary_value(request, @"operation");
  NSString *operation_id = string_value(operation, @"operationId");
  if (operation_id != nil) response[@"operationId"] = operation_id;
  return response;
}

static bool fill_fence(NSDictionary *operation, MetaFence *fence) {
  NSDictionary *value = dictionary_value(operation, @"fence");
  if (value == nil ||
      !copy_identifier(value, @"runtimeEpoch", fence->runtime_epoch,
                       sizeof(fence->runtime_epoch)) ||
      !copy_identifier(value, @"loginSessionId", fence->login_session_id,
                       sizeof(fence->login_session_id)) ||
      !copy_identifier(value, @"nativeGeneration", fence->native_generation,
                       sizeof(fence->native_generation))) {
    return false;
  }
  fence->counter = [value[@"counter"] unsignedLongLongValue];
  return fence->counter > 0;
}

static NSString *target_ref(NSDictionary *operation) {
  NSDictionary *target = dictionary_value(operation, @"target");
  NSDictionary *reference = dictionary_value(target, @"ref");
  if (reference == nil) return nil;
  for (NSString *key in @[
         @"windowRef", @"surfaceRef", @"elementRef", @"displayRef",
         @"layoutRef", @"applicationRef"
       ]) {
    NSString *value = string_value(reference, key);
    if (value != nil) return value;
  }
  return nil;
}

static bool handle_input(FixtureBroker *broker, NSDictionary *request) {
  NSDictionary *operation = dictionary_value(request, @"operation");
  NSDictionary *payload = dictionary_value(request, @"payload");
  NSDictionary *action = dictionary_value(payload, @"action");
  NSString *action_kind = string_value(action, @"kind");
  NSString *operation_id = string_value(operation, @"operationId");
  NSString *target = target_ref(operation);
  MetaFence fence = {0};
  NSMutableDictionary *response =
      [response_base(broker, request) mutableCopy];
  if (operation_id == nil || target == nil || action_kind == nil ||
      !fill_fence(operation, &fence)) {
    response[@"ok"] = @NO;
    response[@"error"] = contract_error(@"invalid-request",
                                         @"fixture принимает exact key action",
                                         @"native-parse");
    return write_frame(@{ @"channel" : @"response", @"payload" : response });
  }

  NSDate *action_deadline =
      parse_iso(string_value(payload, @"actionDeadlineAt"));
  const NSTimeInterval remaining =
      action_deadline == nil ? 0 : [action_deadline timeIntervalSinceNow];
  const uint64_t deadline = monotonic_millis(broker) +
                            (uint64_t)MAX(0, MIN(5000, remaining * 1000));
  const char *operation_bytes = operation_id.UTF8String;
  const char *target_bytes = target.UTF8String;
  const bool began = meta_executor_begin(broker->executor, operation_bytes,
                                         target_bytes, fence, deadline);
  bool finished = false;
  size_t completed_steps = 0;
  size_t total_steps = 1;
  if (began && [action_kind isEqualToString:@"key"]) {
    NSDictionary *stroke = dictionary_value(action, @"stroke");
    const uint32_t key_code = [stroke[@"keyCode"] unsignedIntValue];
    finished = stroke != nil && meta_input_execute_key(
                                  broker->executor, key_code,
                                  [stroke[@"flags"] unsignedLongLongValue]);
    completed_steps = finished ? 1 : 0;
  } else if (began && [action_kind isEqualToString:@"text"]) {
    NSArray *cluster_values = action[@"clusters"];
    if ([cluster_values isKindOfClass:NSArray.class] &&
        cluster_values.count <= 10000) {
      total_steps = cluster_values.count;
      MetaTextCluster *clusters =
          calloc(cluster_values.count, sizeof(*clusters));
      uint16_t **buffers = calloc(cluster_values.count, sizeof(*buffers));
      bool valid = clusters != NULL && buffers != NULL;
      for (NSUInteger index = 0; valid && index < cluster_values.count;
           index += 1) {
        NSDictionary *cluster = cluster_values[index];
        NSString *text = string_value(cluster, @"text");
        if (text == nil || text.length == 0 || text.length > 10000) {
          valid = false;
          break;
        }
        buffers[index] = calloc(text.length, sizeof(uint16_t));
        if (buffers[index] == NULL) {
          valid = false;
          break;
        }
        [text getCharacters:buffers[index] range:NSMakeRange(0, text.length)];
        clusters[index] = (MetaTextCluster){
            .utf16_units = buffers[index],
            .utf16_count = text.length,
            .offset_millis = [cluster[@"atMs"] unsignedLongLongValue],
        };
      }
      MetaTextExecutionReport report = {0};
      MetaInputBridgeClock clock = {
          .context = broker,
          .monotonic_millis = monotonic_millis,
          .wait_until = wait_until,
      };
      if (valid) {
        finished = meta_input_execute_text_schedule(
            broker->executor, clusters, cluster_values.count, deadline, clock,
            &report);
        completed_steps = report.completed_clusters;
      } else {
        meta_executor_cancel(broker->executor);
      }
      for (NSUInteger index = 0; index < cluster_values.count; index += 1) {
        free(buffers == NULL ? NULL : buffers[index]);
      }
      free(buffers);
      free(clusters);
    }
  } else if (began) {
    meta_executor_cancel(broker->executor);
  }
  const MetaExecutorStatus status = meta_executor_status(broker->executor);
  if (!finished) {
    response[@"ok"] = @NO;
    response[@"error"] = contract_error(
        status.quarantined ? @"operation-outcome-unknown" : @"internal-error",
        @"fixture executor не завершил key action", @"native-execute");
    response[@"nativeStatus"] = status_dictionary(
        broker, string_value(request, @"requestId"));
  } else {
    response[@"ok"] = @YES;
    response[@"result"] = @{
      @"completedSteps" : @(completed_steps),
      @"totalSteps" : @(total_steps),
      @"dispatchAttempts" : @(status.dispatch_attempts),
      @"ledgerRevision" : @(status.ledger_revision),
      @"status" : status_dictionary(
          broker, string_value(request, @"requestId")),
    };
  }
  return write_frame(@{ @"channel" : @"response", @"payload" : response });
}

static bool handle_handshake(FixtureBroker *broker, NSDictionary *request) {
  if (!copy_identifier(request, @"runtimeEpoch", broker->runtime_epoch,
                       sizeof(broker->runtime_epoch)) ||
      !copy_identifier(request, @"loginSessionId", broker->login_session_id,
                       sizeof(broker->login_session_id)) ||
      !meta_executor_open_runtime_epoch(broker->executor,
                                       broker->runtime_epoch,
                                       broker->login_session_id)) {
    return false;
  }
  NSDictionary *response = @{
    @"kind" : @"handshake-response",
    @"protocolVersion" : @"1",
    @"requestId" : string_value(request, @"requestId"),
    @"runtimeEpoch" : @(broker->runtime_epoch),
    @"loginSessionId" : @(broker->login_session_id),
    @"nativeGeneration" : @(broker->native_generation),
    @"nativeBuildId" : @"native-fixture-build-1",
    @"capabilitySchemaVersion" : @"1",
    @"installRoot" : @"/tmp/meta-native-fixture",
    @"process" : @{
      @"pid" : @(getpid()),
      @"startedAt" : now_iso(),
      @"nonce" : @"fixture-process-1",
    },
    @"capabilities" : @{
      @"schemaVersion" : @"1",
      @"scope" : @"adapter",
      @"producerRef" : @"native-fixture",
      @"capabilities" : @[],
    },
  };
  return write_frame(@{ @"channel" : @"handshake", @"payload" : response });
}

static bool handle_lifecycle(FixtureBroker *broker, NSString *channel,
                             NSDictionary *request) {
  NSString *request_id = string_value(request, @"requestId");
  if ([channel isEqualToString:@"heartbeat"]) {
    const bool accepted = meta_executor_heartbeat(
        broker->executor, broker->runtime_epoch, broker->login_session_id);
    return write_frame(@{
      @"channel" : @"heartbeat",
      @"payload" : @{
        @"requestId" : request_id,
        @"runtimeEpoch" : @(broker->runtime_epoch),
        @"loginSessionId" : @(broker->login_session_id),
        @"nativeGeneration" : @(broker->native_generation),
        @"accepted" : @(accepted),
        @"acknowledgedAt" : now_iso(),
        @"quarantined" : @(meta_executor_status(broker->executor).quarantined),
      },
    });
  }
  if ([channel isEqualToString:@"status"]) {
    return write_frame(@{
      @"channel" : @"status",
      @"payload" : status_dictionary(broker, request_id),
    });
  }
  if ([channel isEqualToString:@"cancel"]) {
    NSDictionary *fence_value = dictionary_value(request, @"fence");
    MetaFence accepted_fence = {0};
    NSDictionary *operation = @{
      @"fence" : fence_value ?: @{},
    };
    const bool stopped = fill_fence(operation, &accepted_fence) &&
                         meta_executor_cancel_operation(
                             broker->executor,
                             string_value(request, @"operationId").UTF8String,
                             accepted_fence);
    const MetaExecutorStatus status = meta_executor_status(broker->executor);
    NSMutableDictionary *payload = [@{
      @"requestId" : request_id,
      @"operationId" : string_value(request, @"operationId"),
      @"runtimeEpoch" : @(broker->runtime_epoch),
      @"loginSessionId" : @(broker->login_session_id),
      @"nativeGeneration" : @(broker->native_generation),
      @"fence" : fence_value,
      @"acknowledged" : @YES,
      @"stopped" : @(stopped),
      @"cleanup" : cleanup_name(status.cleanup),
      @"ledgerRevision" : @(status.ledger_revision),
      @"quarantined" : @(status.quarantined),
    } mutableCopy];
    if (status.last_checkpoint[0] != '\0') {
      payload[@"lastCheckpoint"] = @(status.last_checkpoint);
    }
    return write_frame(@{ @"channel" : @"cancel", @"payload" : payload });
  }
  if ([channel isEqualToString:@"drain"]) {
    const MetaExecutorStatus status = meta_executor_status(broker->executor);
    NSArray *active = status.operation_id[0] == '\0'
                          ? @[]
                          : @[ @(status.operation_id) ];
    return write_frame(@{
      @"channel" : @"drain",
      @"payload" : @{
        @"requestId" : request_id,
        @"runtimeEpoch" : @(broker->runtime_epoch),
        @"loginSessionId" : @(broker->login_session_id),
        @"nativeGeneration" : @(broker->native_generation),
        @"accepted" : @YES,
        @"activeOperationIds" : active,
        @"cleanup" : cleanup_name(status.cleanup),
        @"quarantined" : @(status.quarantined),
      },
    });
  }
  return false;
}

int main(void) {
  @autoreleasepool {
    FixtureBroker broker = {0};
    snprintf(broker.native_generation, sizeof(broker.native_generation), "%s",
             "native-1");
    MetaExecutorBackend backend = {
        .context = &broker,
        .monotonic_millis = monotonic_millis,
        .verify_target = verify_target,
        .persist_ledger = persist_ledger,
        .post_held_event = post_held_event,
        .post_cleanup_up = post_cleanup_up,
        .post_text_cluster = post_text_cluster,
        .set_event_flags = set_event_flags,
    };
    broker.executor = meta_executor_create(broker.native_generation, 500,
                                           backend);
    if (broker.executor == NULL) return 1;

    while (true) {
      @autoreleasepool {
        NSDictionary *frame = read_frame();
        if (frame == nil) break;
        NSString *channel = string_value(frame, @"channel");
        NSDictionary *payload = dictionary_value(frame, @"payload");
        if (channel == nil || payload == nil) break;
        bool ok = false;
        if ([channel isEqualToString:@"handshake"]) {
          ok = handle_handshake(&broker, payload);
        } else if ([channel isEqualToString:@"request"] &&
                   [string_value(payload, @"method")
                       isEqualToString:@"input.execute"]) {
          ok = handle_input(&broker, payload);
        } else {
          ok = handle_lifecycle(&broker, channel, payload);
        }
        if (!ok) break;
      }
    }
    meta_executor_destroy(broker.executor);
  }
  return 0;
}
