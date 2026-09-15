#include "meta_command_loop.h"
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

static BOOL read_exact(int descriptor, void *buffer, size_t length) {
  uint8_t *cursor = buffer;
  while (length > 0) {
    ssize_t received = read(descriptor, cursor, length);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) return NO;
    cursor += received;
    length -= (size_t)received;
  }
  return YES;
}

static BOOL write_exact(int descriptor, const void *buffer, size_t length) {
  const uint8_t *cursor = buffer;
  while (length > 0) {
    ssize_t sent = write(descriptor, cursor, length);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) return NO;
    cursor += sent;
    length -= (size_t)sent;
  }
  return YES;
}

static BOOL json_safe(id value, NSUInteger depth) {
  if (depth > 32) return NO;
  if ([value isKindOfClass:NSDictionary.class]) {
    for (NSString *key in value) {
      if ([@[@"__proto__", @"constructor", @"prototype"] containsObject:key] ||
          !json_safe(value[key], depth + 1)) return NO;
    }
  } else if ([value isKindOfClass:NSArray.class]) {
    for (id child in value) if (!json_safe(child, depth + 1)) return NO;
  }
  return YES;
}

static NSDictionary *read_frame(int descriptor) {
  uint32_t header = 0;
  if (!read_exact(descriptor, &header, sizeof(header))) return nil;
  size_t size = ntohl(header);
  if (size == 0 || size > 1024 * 1024) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:size];
  if (!read_exact(descriptor, data.mutableBytes, size)) return nil;
  id frame = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  if (![frame isKindOfClass:NSDictionary.class] || !json_safe(frame, 0)) return nil;
  return frame;
}

static BOOL send_frame(int descriptor, NSString *channel, NSDictionary *payload) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"channel": channel, @"payload": payload} options:0 error:NULL];
  if (data == nil || data.length > 1024 * 1024) return NO;
  uint32_t header = htonl((uint32_t)data.length);
  return write_exact(descriptor, &header, sizeof(header)) && write_exact(descriptor, data.bytes, data.length);
}

static BOOL identifier(id value, NSUInteger limit) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 || [value length] > limit) return NO;
  NSString *text = value;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  if ([text rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  unichar first = [text characterAtIndex:0];
  return (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || (first >= '0' && first <= '9');
}

static NSString *timestamp(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

static BOOL future_deadline(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:value];
  if (date == nil) {
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    date = [formatter dateFromString:value];
  }
  return date != nil && date.timeIntervalSinceNow > 0;
}

static NSDictionary *failure(NSString *code, NSString *message) {
  return @{@"code": code, @"message": message, @"stage": @"native-command", @"retryable": @NO,
           @"replayAllowed": @NO, @"recoveryAction": @"inspect-health"};
}

int meta_command_loop_run(id<MetaCommandBackend> backend, NSString *buildId,
                          NSString *installRoot, NSString *nativeGeneration,
                          int inputDescriptor, int outputDescriptor) {
  if (backend == nil || !identifier(buildId, 127) || !identifier(nativeGeneration, 64)) return 64;
  NSString *runtimeEpoch = nil;
  NSString *loginSessionId = nil;
  NSString *startedAt = timestamp();
  NSString *processNonce = NSUUID.UUID.UUIDString;
  BOOL admitted = NO;
  BOOL sealed = NO;
  NSMutableSet<NSString *> *requestIds = [NSMutableSet set];
  signal(SIGPIPE, SIG_IGN);
  while (YES) {
    @autoreleasepool {
      NSDictionary *frame = read_frame(inputDescriptor);
      if (frame == nil) break;
      NSString *channel = frame[@"channel"];
      NSDictionary *payload = frame[@"payload"];
      if (![channel isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) return 65;
      NSString *requestId = payload[@"requestId"];
      if (!identifier(requestId, 127) || [requestIds containsObject:requestId]) return 65;
      if (requestIds.count >= 10000 && ![channel isEqual:@"drain"]) return 75;
      if (requestIds.count >= 10128) return 75;
      [requestIds addObject:requestId];
      if ([channel isEqual:@"handshake"]) {
        if (runtimeEpoch != nil || !identifier(payload[@"runtimeEpoch"], 64) || !identifier(payload[@"loginSessionId"], 64)) return 65;
        runtimeEpoch = payload[@"runtimeEpoch"];
        loginSessionId = payload[@"loginSessionId"];
        admitted = [payload[@"protocolVersion"] isEqual:@"1"] && [payload[@"capabilitySchemaVersion"] isEqual:@"1"] && [payload[@"expectedNativeBuildId"] isEqual:buildId];
        NSDictionary *capabilities = @{@"schemaVersion": @"1", @"scope": @"adapter", @"producerRef": nativeGeneration,
          @"capabilities": @[@{@"id": @"runtime.identity", @"state": @"ready"},
                              @{@"id": @"input.pointer", @"state": @"unavailable", @"reason": @"Broker input dispatch integration pending"},
                              @{@"id": @"capture.window", @"state": @"unavailable", @"reason": @"Broker capture dispatch integration pending"}]};
        if (!send_frame(outputDescriptor, @"handshake", @{
          @"kind": @"handshake-response", @"protocolVersion": @"1", @"requestId": requestId,
          @"runtimeEpoch": runtimeEpoch, @"loginSessionId": loginSessionId, @"nativeGeneration": nativeGeneration,
          @"nativeBuildId": buildId, @"capabilitySchemaVersion": @"1", @"installRoot": installRoot,
          @"process": @{@"pid": @(getpid()), @"startedAt": startedAt, @"nonce": processNonce}, @"capabilities": capabilities,
        })) return 74;
        continue;
      }
      if (!admitted || ![payload[@"runtimeEpoch"] isEqual:runtimeEpoch] || ![payload[@"loginSessionId"] isEqual:loginSessionId]
          || ![payload[@"nativeGeneration"] isEqual:nativeGeneration] || !future_deadline(payload[@"deadlineAt"])) return 65;
      NSDictionary *identity = @{@"requestId": requestId, @"runtimeEpoch": runtimeEpoch, @"loginSessionId": loginSessionId, @"nativeGeneration": nativeGeneration};
      if ([channel isEqual:@"heartbeat"]) {
        NSMutableDictionary *ack = [identity mutableCopy];
        [ack addEntriesFromDictionary:@{@"accepted": sealed ? @NO : @YES, @"acknowledgedAt": timestamp(), @"quarantined": @NO}];
        if (!send_frame(outputDescriptor, channel, ack)) return 74;
        continue;
      }
      if ([channel isEqual:@"drain"]) {
        sealed = YES;
        BOOL ready = [backend beginRotation];
        NSMutableDictionary *ack = [identity mutableCopy];
        [ack addEntriesFromDictionary:@{@"accepted": @YES, @"activeOperationIds": @[],
          @"cleanup": ready ? @"complete" : @"unknown", @"quarantined": ready ? @NO : @YES}];
        if (!send_frame(outputDescriptor, channel, ack)) return 74;
        continue;
      }
      if (![channel isEqual:@"request"] && ![channel isEqual:@"clipboard"]) return 65;
      NSMutableDictionary *response = [identity mutableCopy];
      response[@"kind"] = @"response";
      response[@"protocolVersion"] = @"1";
      NSDictionary *operation = payload[@"operation"];
      if (operation != nil && ![operation isKindOfClass:NSDictionary.class]) return 65;
      if (operation != nil) {
        if (!identifier(operation[@"operationId"], 127) || ![operation[@"runtimeEpoch"] isEqual:runtimeEpoch]
            || ![operation[@"loginSessionId"] isEqual:loginSessionId] || ![operation[@"deadlineAt"] isEqual:payload[@"deadlineAt"]]) return 65;
        response[@"operationId"] = operation[@"operationId"];
      }
      if (sealed) {
        response[@"ok"] = @NO;
        response[@"error"] = failure(@"capability-unavailable", @"Native generation дренируется");
      } else if ([channel isEqual:@"clipboard"]) {
        NSDictionary *target = operation[@"target"];
        NSDictionary *ref = [target isKindOfClass:NSDictionary.class] ? target[@"ref"] : nil;
        if (![ref isKindOfClass:NSDictionary.class] || ![operation[@"kind"] isEqual:@"clipboard"]
            || ![target[@"kind"] isEqual:@"clipboard"] || ![ref[@"clipboardRef"] isEqual:@"system"]
            || ![ref[@"runtimeEpoch"] isEqual:runtimeEpoch] || ![ref[@"loginSessionId"] isEqual:loginSessionId]) return 65;
        NSDictionary *command = payload[@"command"];
        if (![command isKindOfClass:NSDictionary.class]) return 65;
        NSDictionary *result = [backend clipboard:command];
        response[@"ok"] = result != nil ? @YES : @NO;
        if (result != nil) response[@"result"] = result;
        else response[@"error"] = failure(@"invalid-request", @"Некорректная clipboard command");
      } else if ([payload[@"method"] isEqual:@"window.inventory"] && [payload[@"intent"] isEqual:@"read"] && operation == nil) {
        NSDictionary *inventory = [backend inventory];
        response[@"ok"] = inventory != nil ? @YES : @NO;
        if (inventory != nil) response[@"result"] = inventory;
        else response[@"error"] = failure(@"inventory-incomplete", @"Native inventory недоступен");
      } else {
        response[@"ok"] = @NO;
        response[@"error"] = failure(@"unsupported-capability", @"Native command ещё не подключена к broker");
      }
      if (!send_frame(outputDescriptor, [channel isEqual:@"clipboard"] ? channel : @"response", response)) return 74;
    }
  }
  return 0;
}
