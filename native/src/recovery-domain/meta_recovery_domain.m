#include "meta_recovery_domain.h"

#import <CommonCrypto/CommonDigest.h>

#include <math.h>

#define META_RECOVERY_CANONICAL_MAX_BYTES (4 * 1024 * 1024)
#define META_RECOVERY_CANONICAL_MAX_DEPTH 32

static void set_reason(NSString **reason, NSString *value) {
  if (reason != NULL) *reason = value;
}

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) return NO;
  NSString *text = value;
  unichar first = [text characterAtIndex:0];
  BOOL validFirst =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return validFirst &&
      [text rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

static BOOL exact_keys(NSDictionary *value, NSArray<NSString *> *required,
                       NSArray<NSString *> *optional) {
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  NSMutableSet *allowed = [NSMutableSet setWithArray:required];
  [allowed addObjectsFromArray:optional];
  for (NSString *key in required) if (value[key] == nil) return NO;
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL boolean_value(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) ==
                             CFBooleanGetTypeID();
}

static BOOL safe_integer(id value, int64_t minimum, uint64_t maximum) {
  if (![value isKindOfClass:NSNumber.class] || boolean_value(value)) return NO;
  double number = [value doubleValue];
  if (!isfinite(number) || trunc(number) != number ||
      number < (double)minimum || number > (double)maximum ||
      fabs(number) > 9007199254740991.0) return NO;
  return YES;
}

static BOOL finite_number(id value) {
  return [value isKindOfClass:NSNumber.class] && !boolean_value(value) &&
         isfinite([value doubleValue]);
}

static BOOL append_json(id value, NSMutableString *output, NSUInteger depth);

static BOOL append_json_string(NSString *value, NSMutableString *output) {
  [output appendString:@"\""];
  for (NSUInteger index = 0; index < value.length; index += 1) {
    unichar unit = [value characterAtIndex:index];
    switch (unit) {
      case '"': [output appendString:@"\\\""]; continue;
      case '\\': [output appendString:@"\\\\"]; continue;
      case '\b': [output appendString:@"\\b"]; continue;
      case '\f': [output appendString:@"\\f"]; continue;
      case '\n': [output appendString:@"\\n"]; continue;
      case '\r': [output appendString:@"\\r"]; continue;
      case '\t': [output appendString:@"\\t"]; continue;
      default: break;
    }
    if (unit < 0x20) {
      [output appendFormat:@"\\u%04x", unit];
      continue;
    }
    if (CFStringIsSurrogateHighCharacter(unit)) {
      if (index + 1 < value.length &&
          CFStringIsSurrogateLowCharacter([value characterAtIndex:index + 1])) {
        [output appendString:[value substringWithRange:NSMakeRange(index, 2)]];
        index += 1;
      } else {
        [output appendFormat:@"\\u%04x", unit];
      }
      continue;
    }
    if (CFStringIsSurrogateLowCharacter(unit)) {
      [output appendFormat:@"\\u%04x", unit];
      continue;
    }
    [output appendString:[value substringWithRange:NSMakeRange(index, 1)]];
  }
  [output appendString:@"\""];
  return [output lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <=
         META_RECOVERY_CANONICAL_MAX_BYTES;
}

static BOOL ascii_key(NSString *key) {
  for (NSUInteger index = 0; index < key.length; index += 1) {
    if ([key characterAtIndex:index] > 0x7f) return NO;
  }
  return YES;
}

static BOOL append_json(id value, NSMutableString *output, NSUInteger depth) {
  if (depth > META_RECOVERY_CANONICAL_MAX_DEPTH) return NO;
  if (value == NSNull.null) {
    [output appendString:@"null"];
  } else if ([value isKindOfClass:NSString.class]) {
    if (!append_json_string(value, output)) return NO;
  } else if ([value isKindOfClass:NSNumber.class]) {
    if (boolean_value(value)) {
      [output appendString:[value boolValue] ? @"true" : @"false"];
    } else if (safe_integer(value, INT64_MIN, 9007199254740991ULL)) {
      [output appendFormat:@"%lld", [value longLongValue]];
    } else {
      return NO;
    }
  } else if ([value isKindOfClass:NSArray.class]) {
    [output appendString:@"["];
    BOOL first = YES;
    for (id child in value) {
      if (!first) [output appendString:@","];
      first = NO;
      if (!append_json(child, output, depth + 1)) return NO;
    }
    [output appendString:@"]"];
  } else if ([value isKindOfClass:NSDictionary.class]) {
    NSMutableArray<NSString *> *keys = [NSMutableArray array];
    for (id key in value) {
      if (![key isKindOfClass:NSString.class] || !ascii_key(key)) return NO;
      [keys addObject:key];
    }
    [keys sortUsingComparator:^NSComparisonResult(NSString *left,
                                                  NSString *right) {
      return [left compare:right options:NSLiteralSearch];
    }];
    [output appendString:@"{"];
    BOOL first = YES;
    for (NSString *key in keys) {
      if (!first) [output appendString:@","];
      first = NO;
      if (!append_json_string(key, output)) return NO;
      [output appendString:@":"];
      if (!append_json(value[key], output, depth + 1)) return NO;
    }
    [output appendString:@"}"];
  } else {
    return NO;
  }
  return [output lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <=
         META_RECOVERY_CANONICAL_MAX_BYTES;
}

NSString *meta_recovery_domain_canonical_json(id value) {
  NSMutableString *output = [NSMutableString string];
  return append_json(value, output, 0) ? [output copy] : nil;
}

NSString *meta_recovery_domain_sha256(id value) {
  NSString *canonical = meta_recovery_domain_canonical_json(value);
  NSData *bytes = [canonical dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes == nil || bytes.length > UINT32_MAX) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {0};
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:64];
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    [result appendFormat:@"%02x", digest[index]];
  }
  return result;
}

static BOOL point_valid(id value) {
  return exact_keys(value, @[@"x", @"y"], @[]) && finite_number(value[@"x"]) &&
         finite_number(value[@"y"]);
}

static BOOL modifiers_valid(id value) {
  if (!exact_keys(value, @[@"names", @"flags"], @[]) ||
      ![value[@"names"] isKindOfClass:NSArray.class] ||
      [value[@"names"] count] > 5 ||
      !safe_integer(value[@"flags"], 0, 9007199254740991ULL)) return NO;
  NSArray *order = @[@"cmd", @"shift", @"alt", @"ctrl", @"fn"];
  uint64_t flags[] = {0x00100000, 0x00020000, 0x00080000, 0x00040000,
                      0x00800000};
  uint64_t expected = 0;
  NSInteger previous = -1;
  for (id name in value[@"names"]) {
    NSUInteger index = [order indexOfObject:name];
    if (index == NSNotFound || (NSInteger)index <= previous) return NO;
    previous = (NSInteger)index;
    expected |= flags[index];
  }
  return expected == [value[@"flags"] unsignedLongLongValue];
}

static BOOL stroke_valid(id value) {
  return exact_keys(value, @[@"keyCode", @"flags"], @[]) &&
         safe_integer(value[@"keyCode"], 0, UINT16_MAX) &&
         safe_integer(value[@"flags"], 0, 9007199254740991ULL);
}

static BOOL input_action_holds(NSDictionary *action,
                               NSMutableArray<NSDictionary *> *holds) {
  NSString *kind = action[@"kind"];
  if ([kind isEqual:@"hover"]) {
    return exact_keys(action, @[@"kind", @"point", @"modifiers"], @[]) &&
           point_valid(action[@"point"]) && modifiers_valid(action[@"modifiers"]);
  }
  if ([kind isEqual:@"scroll"]) {
    return exact_keys(action, @[@"kind", @"anchor", @"dx", @"dy", @"unit", @"modifiers"], @[]) &&
           point_valid(action[@"anchor"]) && finite_number(action[@"dx"]) &&
           finite_number(action[@"dy"]) &&
           ([action[@"dx"] doubleValue] != 0 || [action[@"dy"] doubleValue] != 0) &&
           [@[@"line", @"pixel"] containsObject:action[@"unit"]] &&
           modifiers_valid(action[@"modifiers"]);
  }
  if ([kind isEqual:@"click"] || [kind isEqual:@"drag"]) {
    NSString *button = action[@"button"];
    NSUInteger code = [@[@"left", @"right", @"middle"] indexOfObject:button];
    if (code == NSNotFound || !modifiers_valid(action[@"modifiers"])) return NO;
    if ([kind isEqual:@"click"]) {
      if (!exact_keys(action, @[@"kind", @"button", @"point", @"count", @"modifiers"], @[]) ||
          !point_valid(action[@"point"]) || !safe_integer(action[@"count"], 1, 3)) return NO;
    } else {
      NSArray *trajectory = action[@"trajectory"];
      if (!exact_keys(action, @[@"kind", @"button", @"modifiers", @"durationMs", @"trajectory"], @[]) ||
          !safe_integer(action[@"durationMs"], 1, 5000) ||
          ![trajectory isKindOfClass:NSArray.class] || trajectory.count < 2 || trajectory.count > 512) return NO;
      uint64_t previous = 0;
      for (NSUInteger index = 0; index < trajectory.count; index += 1) {
        NSDictionary *point = trajectory[index];
        if (!exact_keys(point, @[@"point", @"atMs"], @[]) || !point_valid(point[@"point"]) ||
            !safe_integer(point[@"atMs"], 0, 5000)) return NO;
        uint64_t offset = [point[@"atMs"] unsignedLongLongValue];
        if ((index == 0 && offset != 0) || (index > 0 && offset < previous)) return NO;
        previous = offset;
      }
      if (previous != [action[@"durationMs"] unsignedLongLongValue]) return NO;
    }
    [holds addObject:@{@"kind" : @"button", @"code" : @(code)}];
    return YES;
  }
  if ([kind isEqual:@"key"]) {
    if (!exact_keys(action, @[@"kind", @"stroke"], @[]) || !stroke_valid(action[@"stroke"])) return NO;
    [holds addObject:@{@"kind" : @"key", @"code" : action[@"stroke"][@"keyCode"]}];
    return YES;
  }
  if ([kind isEqual:@"shortcut"]) {
    NSArray *strokes = action[@"strokes"];
    if (!exact_keys(action, @[@"kind", @"strokes", @"delayMs"], @[]) ||
        ![strokes isKindOfClass:NSArray.class] || strokes.count == 0 || strokes.count > 64 ||
        !safe_integer(action[@"delayMs"], 0, 5000) ||
        [action[@"delayMs"] unsignedLongLongValue] * (strokes.count - 1) > 5000) return NO;
    for (NSDictionary *stroke in strokes) {
      if (!stroke_valid(stroke)) return NO;
      [holds addObject:@{@"kind" : @"key", @"code" : stroke[@"keyCode"]}];
    }
    return YES;
  }
  if ([kind isEqual:@"text"]) {
    NSArray *clusters = action[@"clusters"];
    if (!exact_keys(action, @[@"kind", @"utf16Units", @"clusters"], @[]) ||
        !safe_integer(action[@"utf16Units"], 1, 10000) ||
        ![clusters isKindOfClass:NSArray.class] || clusters.count == 0 || clusters.count > 10000) return NO;
    NSUInteger total = 0;
    uint64_t previous = 0;
    for (NSUInteger index = 0; index < clusters.count; index += 1) {
      NSDictionary *cluster = clusters[index];
      if (!exact_keys(cluster, @[@"text", @"utf16Units", @"atMs"], @[]) ||
          ![cluster[@"text"] isKindOfClass:NSString.class] ||
          !safe_integer(cluster[@"utf16Units"], 0, 10000) ||
          [cluster[@"text"] length] != [cluster[@"utf16Units"] unsignedIntegerValue] ||
          !safe_integer(cluster[@"atMs"], 0, 30000)) return NO;
      uint64_t offset = [cluster[@"atMs"] unsignedLongLongValue];
      if ((index == 0 && offset != 0) || (index > 0 && offset < previous)) return NO;
      previous = offset;
      total += [cluster[@"text"] length];
      if (total > 10000) return NO;
    }
    if (total != [action[@"utf16Units"] unsignedIntegerValue]) return NO;
    [holds addObject:@{@"kind" : @"key", @"code" : @0}];
    return YES;
  }
  return NO;
}

static BOOL reference_generation(NSDictionary *reference,
                                 NSDictionary *request) {
  if (![reference isKindOfClass:NSDictionary.class]) return NO;
  for (NSString *key in @[@"runtimeEpoch", @"loginSessionId"]) {
    if (![reference[key] isEqual:request[key]]) return NO;
  }
  id native = reference[@"nativeGeneration"];
  return native == nil || [native isEqual:request[@"nativeGeneration"]];
}

static BOOL exact_reference(NSDictionary *reference, NSDictionary *request,
                            NSArray<NSString *> *fields) {
  NSMutableArray *required = [NSMutableArray arrayWithArray:@[
    @"runtimeEpoch", @"loginSessionId", @"nativeGeneration"
  ]];
  [required addObjectsFromArray:fields];
  if (!exact_keys(reference, required, @[]) ||
      !reference_generation(reference, request)) return NO;
  for (NSString *field in fields) {
    if (!identifier(reference[field], 4096)) return NO;
  }
  return YES;
}

static BOOL rect_valid(id value) {
  return exact_keys(value, @[@"x", @"y", @"width", @"height"], @[]) &&
         finite_number(value[@"x"]) && finite_number(value[@"y"]) &&
         finite_number(value[@"width"]) && finite_number(value[@"height"]) &&
         [value[@"width"] doubleValue] >= 0 &&
         [value[@"height"] doubleValue] >= 0;
}

static BOOL operation_target_valid(NSDictionary *target,
                                   NSDictionary *request) {
  if (!exact_keys(target, @[@"kind", @"ref"], @[])) return NO;
  NSDictionary *fields = @{
    @"application-bundle" : @[@"bundleRef", @"bundleId", @"path", @"device", @"inode", @"modifiedAtNs"],
    @"application" : @[@"applicationRef", @"pid", @"launchedAt", @"registrationNonce"],
    @"window" : @[@"applicationRef", @"windowRef"],
    @"surface" : @[@"applicationRef", @"surfaceRef"],
    @"element" : @[@"applicationRef", @"elementRef", @"snapshotId"],
    @"display" : @[@"displayRef", @"displayLayoutRevision"],
    @"desktop-layout" : @[@"layoutRef", @"displayLayoutRevision"],
  };
  NSArray *required = fields[target[@"kind"]];
  if (required == nil || ![target[@"ref"] isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *reference = target[@"ref"];
  if ([target[@"kind"] isEqual:@"application-bundle"]) {
    return exact_keys(reference, @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"bundleRef", @"bundleId", @"path", @"device", @"inode", @"modifiedAtNs"], @[]) &&
           reference_generation(reference, request) &&
           identifier(reference[@"bundleRef"], 127) &&
           [reference[@"bundleId"] isKindOfClass:NSString.class] &&
           [reference[@"bundleId"] length] > 0 && [reference[@"bundleId"] length] <= 255 &&
           [reference[@"path"] isKindOfClass:NSString.class] &&
           [reference[@"path"] hasPrefix:@"/"] && [reference[@"path"] length] <= 4096 &&
           identifier(reference[@"device"], 32) && identifier(reference[@"inode"], 32) &&
           identifier(reference[@"modifiedAtNs"], 32);
  }
  NSMutableArray *keys = [required mutableCopy];
  [keys removeObject:@"pid"];
  [keys removeObject:@"displayLayoutRevision"];
  if ([target[@"kind"] isEqual:@"surface"]) {
    return exact_keys(reference, @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"applicationRef", @"surfaceRef"], @[@"ownerWindowRef"]) &&
           reference_generation(reference, request) &&
           identifier(reference[@"applicationRef"], 127) &&
           identifier(reference[@"surfaceRef"], 127) &&
           (reference[@"ownerWindowRef"] == nil || identifier(reference[@"ownerWindowRef"], 127));
  }
  if (!exact_keys(reference,
                  [@[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]
                      arrayByAddingObjectsFromArray:required], @[]) ||
      !reference_generation(reference, request)) return NO;
  for (NSString *key in keys) if (!identifier(reference[key], 4096)) return NO;
  if ([required containsObject:@"pid"] &&
      !safe_integer(reference[@"pid"], 1, INT32_MAX)) return NO;
  if ([required containsObject:@"displayLayoutRevision"] &&
      !safe_integer(reference[@"displayLayoutRevision"], 0, 9007199254740991ULL)) return NO;
  return YES;
}

static BOOL operation_valid(NSDictionary *request) {
  NSDictionary *operation = request[@"operation"];
  NSArray *required = @[@"kind", @"operationId", @"clientRequestId", @"clientSessionId", @"principalId", @"runtimeEpoch", @"loginSessionId", @"inventoryId", @"inventoryRevision", @"deadlineAt", @"target", @"nativeGeneration", @"fence"];
  if (!exact_keys(operation, required, @[@"observationRef"]) ||
      ![operation[@"kind"] isEqual:@"native"] ||
      !identifier(operation[@"operationId"], 127) ||
      ![operation[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![operation[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![operation[@"deadlineAt"] isEqual:request[@"deadlineAt"]] ||
      !safe_integer(operation[@"inventoryRevision"], 0, 9007199254740991ULL) ||
      !identifier(operation[@"clientRequestId"], 127) ||
      !identifier(operation[@"clientSessionId"], 127) ||
      !identifier(operation[@"principalId"], 127) ||
      !identifier(operation[@"inventoryId"], 127) ||
      !operation_target_valid(operation[@"target"], request)) return NO;
  NSDictionary *fence = operation[@"fence"];
  if (![operation[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] ||
      !exact_keys(fence, @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"counter"], @[]) ||
      ![fence[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![fence[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![fence[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] ||
      !safe_integer(fence[@"counter"], 1, 9007199254740991ULL)) return NO;
  return meta_recovery_domain_canonical_json(operation) != nil;
}

static BOOL request_envelope(NSDictionary *request) {
  NSArray *required = @[@"kind", @"protocolVersion", @"requestId", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"deadlineAt", @"intent", @"method", @"operation", @"payload"];
  if (!exact_keys(request, required, @[@"recoveryGrant"]) ||
      ![request[@"kind"] isEqual:@"request"] ||
      ![request[@"protocolVersion"] isEqual:@"1"] ||
      !identifier(request[@"requestId"], 127) ||
      !identifier(request[@"runtimeEpoch"], 64) ||
      !identifier(request[@"loginSessionId"], 64) ||
      !identifier(request[@"nativeGeneration"], 64) ||
      ![request[@"deadlineAt"] isKindOfClass:NSString.class] ||
      ![request[@"intent"] isEqual:@"mutation"] ||
      !identifier(request[@"method"], 128)) return NO;
  return operation_valid(request);
}

static BOOL clipboard_request_envelope(NSDictionary *request) {
  NSArray *required = @[@"kind", @"protocolVersion", @"requestId", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"deadlineAt", @"operation", @"command"];
  NSDictionary *operation = request[@"operation"];
  NSDictionary *target = operation[@"target"];
  NSDictionary *reference = target[@"ref"];
  if (!exact_keys(request, required, @[@"recoveryGrant"]) ||
      ![request[@"kind"] isEqual:@"request"] ||
      ![request[@"protocolVersion"] isEqual:@"1"] ||
      !identifier(request[@"requestId"], 127) ||
      !identifier(request[@"runtimeEpoch"], 64) ||
      !identifier(request[@"loginSessionId"], 64) ||
      !identifier(request[@"nativeGeneration"], 64) ||
      ![request[@"deadlineAt"] isKindOfClass:NSString.class] ||
      !exact_keys(operation, @[@"kind", @"operationId", @"clientRequestId", @"clientSessionId", @"principalId", @"runtimeEpoch", @"loginSessionId", @"inventoryId", @"inventoryRevision", @"deadlineAt", @"target"], @[@"observationRef"]) ||
      ![operation[@"kind"] isEqual:@"clipboard"] ||
      !identifier(operation[@"operationId"], 127) ||
      !identifier(operation[@"clientRequestId"], 127) ||
      !identifier(operation[@"clientSessionId"], 127) ||
      !identifier(operation[@"principalId"], 127) ||
      !identifier(operation[@"inventoryId"], 127) ||
      !safe_integer(operation[@"inventoryRevision"], 0, 9007199254740991ULL) ||
      ![operation[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![operation[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![operation[@"deadlineAt"] isEqual:request[@"deadlineAt"]] ||
      !exact_keys(target, @[@"kind", @"ref"], @[]) ||
      ![target[@"kind"] isEqual:@"clipboard"] ||
      !exact_keys(reference, @[@"runtimeEpoch", @"loginSessionId", @"clipboardRef"], @[]) ||
      ![reference[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![reference[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![reference[@"clipboardRef"] isEqual:@"system"]) return NO;
  return meta_recovery_domain_canonical_json(operation) != nil;
}

static BOOL no_hold_plan_valid(NSString *method, NSDictionary *payload,
                               NSDictionary *request) {
  if (![payload isKindOfClass:NSDictionary.class]) return NO;
  if ([method isEqual:@"input.readiness"]) {
    return exact_keys(payload, @[@"expectedDisplayRef"], @[]) &&
           operation_target_valid(@{@"kind" : @"display", @"ref" : payload[@"expectedDisplayRef"]}, request);
  }
  if ([method isEqual:@"ax.press"]) {
    return exact_keys(payload, @[@"element"], @[]) &&
           exact_reference(payload[@"element"], request,
                           @[@"applicationRef", @"elementRef", @"snapshotId"]);
  }
  if ([method isEqual:@"window.transition"]) {
    NSString *kind = payload[@"kind"];
    NSArray *required = [kind isEqual:@"set-bounds"] ? @[@"kind", @"target", @"bounds"] :
        [kind isEqual:@"minimize"] ? @[@"kind", @"target", @"minimized"] : @[@"kind", @"target"];
    return [@[@"show", @"focus", @"set-bounds", @"minimize", @"close"] containsObject:kind] &&
           exact_keys(payload, required, @[]) &&
           exact_reference(payload[@"target"], request,
                           @[@"applicationRef", @"windowRef"]) &&
           (![kind isEqual:@"minimize"] || boolean_value(payload[@"minimized"])) &&
           (![kind isEqual:@"set-bounds"] || rect_valid(payload[@"bounds"]));
  }
  if ([method isEqual:@"application.launch"]) {
    return exact_keys(payload, @[@"bundle", @"activate", @"newInstance"], @[]) &&
           operation_target_valid(@{@"kind" : @"application-bundle", @"ref" : payload[@"bundle"]}, request) &&
           boolean_value(payload[@"activate"]) && boolean_value(payload[@"newInstance"]);
  }
  if ([method isEqual:@"application.quit"]) {
    return exact_keys(payload, @[@"application"], @[]) &&
           operation_target_valid(@{@"kind" : @"application", @"ref" : payload[@"application"]}, request);
  }
  if ([method isEqual:@"capture.start"]) {
    return exact_keys(payload, @[@"request", @"nativeMapping", @"captureTimeoutMs", @"stopTimeoutMs"], @[]) &&
           exact_keys(payload[@"request"], @[@"source", @"caption", @"target", @"clip", @"fullPage", @"cursor", @"readinessPolicy", @"output", @"publication"], @[]) &&
           [payload[@"request"][@"source"] isKindOfClass:NSString.class] &&
           [payload[@"request"][@"caption"] isKindOfClass:NSString.class] &&
           [payload[@"request"][@"target"] isKindOfClass:NSDictionary.class] &&
           [payload[@"request"][@"clip"] isKindOfClass:NSDictionary.class] &&
           boolean_value(payload[@"request"][@"fullPage"]) &&
           [@[@"include", @"exclude"] containsObject:payload[@"request"][@"cursor"]] &&
           [payload[@"request"][@"readinessPolicy"] isKindOfClass:NSDictionary.class] &&
           [payload[@"request"][@"output"] isKindOfClass:NSDictionary.class] &&
           [payload[@"request"][@"publication"] isKindOfClass:NSDictionary.class] &&
           [payload[@"nativeMapping"] isKindOfClass:NSDictionary.class] &&
           [payload[@"nativeMapping"] count] > 0 &&
           safe_integer(payload[@"captureTimeoutMs"], 1, 10000) &&
           safe_integer(payload[@"stopTimeoutMs"], 1, 1000);
  }
  if ([method isEqual:@"capture.cancel"] ||
      [method isEqual:@"capture.release"]) {
    return exact_keys(payload, @[@"captureTaskRef"], @[]) &&
           identifier(payload[@"captureTaskRef"], 127);
  }
  return NO;
}

static NSArray<NSDictionary *> *sorted_unique_holds(NSArray *holds) {
  NSMutableDictionary<NSString *, NSDictionary *> *unique = [NSMutableDictionary dictionary];
  for (NSDictionary *hold in holds) {
    unique[[NSString stringWithFormat:@"%@:%05llu", hold[@"kind"],
        [hold[@"code"] unsignedLongLongValue]]] = hold;
  }
  NSArray *keys = [unique.allKeys sortedArrayUsingSelector:@selector(compare:)];
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:keys.count];
  for (NSString *key in keys) [result addObject:unique[key]];
  return result;
}

NSDictionary *meta_recovery_domain_classify_request(
    NSDictionary *request, NSString *loadedNativeBuildId, NSString **reason) {
  set_reason(reason, nil);
  if (!identifier(loadedNativeBuildId, 127) ||
      ![request isKindOfClass:NSDictionary.class]) {
    set_reason(reason, @"Recovery classifier получил malformed request или build identity");
    return nil;
  }
  NSString *method = request[@"method"];
  BOOL clipboard = method == nil &&
      [request[@"command"][@"method"] isEqual:@"clipboard.write"];
  if (!(clipboard ? clipboard_request_envelope(request)
                  : request_envelope(request))) {
    set_reason(reason, @"Native request envelope или operation context malformed");
    return nil;
  }
  NSMutableArray<NSDictionary *> *holds = [NSMutableArray array];
  if (clipboard) {
    NSDictionary *command = request[@"command"];
    NSDictionary *payload = command[@"payload"];
    NSData *text = [payload[@"text"] isKindOfClass:NSString.class]
                       ? [payload[@"text"] dataUsingEncoding:NSUTF8StringEncoding]
                       : nil;
    if (!exact_keys(command, @[@"method", @"payload"], @[]) ||
        !exact_keys(payload, @[@"text"], @[@"expectedChangeCount"]) ||
        text == nil || text.length > 1000000 ||
        (payload[@"expectedChangeCount"] != nil &&
         !safe_integer(payload[@"expectedChangeCount"], 0,
                       9007199254740991ULL))) {
      set_reason(reason, @"Clipboard write plan malformed");
      return nil;
    }
    method = @"clipboard.write";
  } else if ([method isEqual:@"input.execute"]) {
    NSDictionary *payload = request[@"payload"];
    if (!exact_keys(payload, @[@"actionDeadlineAt", @"action"], @[]) ||
        ![payload[@"actionDeadlineAt"] isKindOfClass:NSString.class] ||
        ![payload[@"action"] isKindOfClass:NSDictionary.class] ||
        !input_action_holds(payload[@"action"], holds)) {
      set_reason(reason, @"Input execute plan malformed или неизвестен");
      return nil;
    }
  } else if (!no_hold_plan_valid(method, request[@"payload"], request)) {
    set_reason(reason, @"Native mutation method неизвестен или plan malformed");
    return nil;
  }
  NSArray *canonical = sorted_unique_holds(holds);
  return @{
    @"policyVersion" : @"1",
    @"nativeBuildId" : loadedNativeBuildId,
    @"method" : method,
    @"domain" : canonical.count == 0 ? @"no-held-input" : @"possible-held-input",
    @"possibleHolds" : canonical,
  };
}

static BOOL sha256_value(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

BOOL meta_recovery_domain_validate_request(
    NSDictionary *request, NSString *loadedNativeBuildId,
    NSDictionary **descriptor, NSString **reason) {
  if (descriptor != NULL) *descriptor = nil;
  NSDictionary *expected = meta_recovery_domain_classify_request(
      request, loadedNativeBuildId, reason);
  if (expected == nil) return NO;
  NSDictionary *grant = request[@"recoveryGrant"];
  if (!exact_keys(grant, @[@"policyVersion", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"operationId", @"contextSha256", @"descriptor", @"descriptorSha256", @"journalRevision", @"durable"], @[]) ||
      ![grant[@"policyVersion"] isEqual:@"1"] ||
      ![grant[@"runtimeEpoch"] isEqual:request[@"runtimeEpoch"]] ||
      ![grant[@"loginSessionId"] isEqual:request[@"loginSessionId"]] ||
      ![grant[@"nativeGeneration"] isEqual:request[@"nativeGeneration"]] ||
      ![grant[@"operationId"] isEqual:request[@"operation"][@"operationId"]] ||
      !boolean_value(grant[@"durable"]) || ![grant[@"durable"] boolValue] ||
      !safe_integer(grant[@"journalRevision"], 1, 9007199254740991ULL) ||
      !sha256_value(grant[@"contextSha256"]) || !sha256_value(grant[@"descriptorSha256"]) ||
      ![grant[@"descriptor"] isEqual:expected] ||
      ![grant[@"descriptor"][@"nativeBuildId"] isEqual:loadedNativeBuildId]) {
    set_reason(reason, @"Recovery grant identity, durability или descriptor mismatch");
    return NO;
  }
  NSString *contextDigest = meta_recovery_domain_sha256(request[@"operation"]);
  NSString *descriptorDigest = meta_recovery_domain_sha256(expected);
  if (![grant[@"contextSha256"] isEqual:contextDigest] ||
      ![grant[@"descriptorSha256"] isEqual:descriptorDigest]) {
    set_reason(reason, @"Recovery grant canonical SHA mismatch");
    return NO;
  }
  if (descriptor != NULL) *descriptor = expected;
  set_reason(reason, nil);
  return YES;
}
