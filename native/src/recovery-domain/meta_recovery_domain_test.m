#include "meta_recovery_domain.h"

#include <assert.h>
#include <stdio.h>

static NSDictionary *generation(void) {
  return @{
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
  };
}

static NSDictionary *reference(NSString *identityKey, NSString *identity) {
  NSMutableDictionary *value = [generation() mutableCopy];
  value[identityKey] = identity;
  return value;
}

static NSDictionary *operation(NSString *method) {
  NSString *deadline = @"2030-09-15T10:00:00.000Z";
  NSMutableDictionary *window = [reference(@"windowRef", @"window-1") mutableCopy];
  window[@"applicationRef"] = @"application-1";
  return @{
    @"kind" : @"native",
    @"operationId" : [@"operation-" stringByAppendingString:method],
    @"clientRequestId" : @"client-request-1",
    @"clientSessionId" : @"client-session-1",
    @"principalId" : @"principal-1",
    @"runtimeEpoch" : @"runtime-1",
    @"loginSessionId" : @"login-1",
    @"nativeGeneration" : @"native-1",
    @"inventoryId" : @"inventory-1",
    @"inventoryRevision" : @1,
    @"deadlineAt" : deadline,
    @"target" : @{
      @"kind" : @"window",
      @"ref" : window,
    },
    @"fence" : @{
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"nativeGeneration" : @"native-1",
      @"counter" : @1,
    },
  };
}

static NSDictionary *request(NSString *method, NSDictionary *payload) {
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"kind" : @"request",
    @"protocolVersion" : @"1",
    @"requestId" : [@"request-" stringByAppendingString:method],
    @"deadlineAt" : @"2030-09-15T10:00:00.000Z",
    @"intent" : @"mutation",
    @"method" : method,
    @"operation" : operation(method),
    @"payload" : payload,
  }];
  return value;
}

static NSDictionary *input_request(NSDictionary *action) {
  return request(@"input.execute", @{
    @"actionDeadlineAt" : @"2030-09-15T10:00:00.000Z",
    @"action" : action,
  });
}

static NSDictionary *clipboard_request(NSString *method) {
  NSString *deadline = @"2030-09-15T10:00:00.000Z";
  NSMutableDictionary *value = [generation() mutableCopy];
  [value addEntriesFromDictionary:@{
    @"kind" : @"request",
    @"protocolVersion" : @"1",
    @"requestId" : @"request-clipboard",
    @"deadlineAt" : deadline,
    @"operation" : @{
      @"kind" : @"clipboard",
      @"operationId" : @"operation-clipboard",
      @"clientRequestId" : @"client-request-clipboard",
      @"clientSessionId" : @"client-session-1",
      @"principalId" : @"principal-1",
      @"runtimeEpoch" : @"runtime-1",
      @"loginSessionId" : @"login-1",
      @"inventoryId" : @"inventory-1",
      @"inventoryRevision" : @1,
      @"deadlineAt" : deadline,
      @"target" : @{
        @"kind" : @"clipboard",
        @"ref" : @{
          @"runtimeEpoch" : @"runtime-1",
          @"loginSessionId" : @"login-1",
          @"clipboardRef" : @"system",
        },
      },
    },
    @"command" : @{
      @"method" : method,
      @"payload" : @{@"text" : @"Привет / clipboard", @"expectedChangeCount" : @3},
    },
  }];
  return value;
}

static NSDictionary *classify(NSDictionary *value) {
  NSString *reason = nil;
  NSDictionary *descriptor = meta_recovery_domain_classify_request(
      value, @"native-build-1", &reason);
  assert(descriptor != nil && reason == nil);
  return descriptor;
}

static void test_input_holds_follow_physical_bridge(void) {
  NSString *secret = @"секретный / путь\n";
  NSDictionary *text = classify(input_request(@{
    @"kind" : @"text",
    @"utf16Units" : @(secret.length),
    @"clusters" : @[@{
      @"text" : secret,
      @"utf16Units" : @(secret.length),
      @"atMs" : @0,
    }],
  }));
  assert(([text[@"possibleHolds"] isEqual:@[@{@"kind" : @"key", @"code" : @0}]]));
  assert([meta_recovery_domain_canonical_json(text)
      rangeOfString:@"секретный"].location == NSNotFound);

  NSDictionary *key = classify(input_request(@{
    @"kind" : @"key",
    @"stroke" : @{@"keyCode" : @12, @"flags" : @0x00100000},
  }));
  assert(([key[@"possibleHolds"] isEqual:@[@{@"kind" : @"key", @"code" : @12}]]));

  NSDictionary *shortcut = classify(input_request(@{
    @"kind" : @"shortcut",
    @"strokes" : @[
      @{@"keyCode" : @42, @"flags" : @0x00100000},
      @{@"keyCode" : @7, @"flags" : @0x00020000},
      @{@"keyCode" : @42, @"flags" : @0x00100000},
    ],
    @"delayMs" : @10,
  }));
  assert(([shortcut[@"possibleHolds"] isEqual:@[
    @{@"kind" : @"key", @"code" : @7},
    @{@"kind" : @"key", @"code" : @42},
  ]]));

  NSDictionary *click = classify(input_request(@{
    @"kind" : @"click",
    @"button" : @"right",
    @"point" : @{@"x" : @10, @"y" : @20},
    @"count" : @2,
    @"modifiers" : @{@"names" : @[@"cmd"], @"flags" : @0x00100000},
  }));
  assert(([click[@"possibleHolds"] isEqual:@[@{@"kind" : @"button", @"code" : @1}]]));

  NSDictionary *drag = classify(input_request(@{
    @"kind" : @"drag",
    @"button" : @"middle",
    @"modifiers" : @{@"names" : @[@"shift"], @"flags" : @0x00020000},
    @"durationMs" : @20,
    @"trajectory" : @[
      @{@"point" : @{@"x" : @10, @"y" : @20}, @"atMs" : @0},
      @{@"point" : @{@"x" : @30, @"y" : @40}, @"atMs" : @20},
    ],
  }));
  assert(([drag[@"possibleHolds"] isEqual:@[@{@"kind" : @"button", @"code" : @2}]]));
}

static void test_no_hold_methods_are_explicit(void) {
  NSDictionary *emptyModifiers = @{@"names" : @[], @"flags" : @0};
  assert([(classify(input_request(@{
    @"kind" : @"hover", @"point" : @{@"x" : @1, @"y" : @2},
    @"modifiers" : emptyModifiers,
  })))[@"domain"] isEqual:@"no-held-input"]);
  assert([(classify(input_request(@{
    @"kind" : @"scroll", @"anchor" : @{@"x" : @1, @"y" : @2},
    @"dx" : @0, @"dy" : @1, @"unit" : @"line",
    @"modifiers" : emptyModifiers,
  })))[@"domain"] isEqual:@"no-held-input"]);

  NSMutableDictionary *display = [reference(@"displayRef", @"display-1") mutableCopy];
  display[@"displayLayoutRevision"] = @1;
  NSDictionary *element = [reference(@"elementRef", @"element-1") mutableCopy];
  [(NSMutableDictionary *)element setObject:@"application-1" forKey:@"applicationRef"];
  [(NSMutableDictionary *)element setObject:@"snapshot-1" forKey:@"snapshotId"];
  NSMutableDictionary *window = [reference(@"windowRef", @"window-1") mutableCopy];
  window[@"applicationRef"] = @"application-1";
  NSMutableDictionary *bundle = [reference(@"bundleRef", @"bundle-1") mutableCopy];
  [bundle addEntriesFromDictionary:@{@"bundleId" : @"com.example.fixture", @"path" : @"/Applications/Тест.app", @"device" : @"1", @"inode" : @"2", @"modifiedAtNs" : @"3"}];
  NSMutableDictionary *application = [reference(@"applicationRef", @"application-1") mutableCopy];
  [application addEntriesFromDictionary:@{@"pid" : @42, @"launchedAt" : @"2030-09-15T09:00:00.000Z", @"registrationNonce" : @"nonce-1"}];
  NSDictionary *captureRequest = @{
    @"source" : @"display-composite", @"caption" : @"Fixture capture",
    @"target" : @{}, @"clip" : @{}, @"fullPage" : @NO,
    @"cursor" : @"exclude", @"readinessPolicy" : @{}, @"output" : @{},
    @"publication" : @{},
  };
  NSArray *cases = @[
    @[@"input.readiness", @{@"expectedDisplayRef" : display}],
    @[@"ax.press", @{@"element" : element}],
    @[@"window.transition", @{@"kind" : @"show", @"target" : window}],
    @[@"application.launch", @{@"bundle" : bundle, @"activate" : @YES, @"newInstance" : @NO}],
    @[@"application.quit", @{@"application" : application}],
    @[@"capture.start", @{@"request" : captureRequest, @"nativeMapping" : @{@"kind" : @"display"}, @"captureTimeoutMs" : @100, @"stopTimeoutMs" : @50}],
    @[@"capture.cancel", @{@"captureTaskRef" : @"capture-task-1"}],
    @[@"capture.release", @{@"captureTaskRef" : @"capture-task-1"}],
  ];
  for (NSArray *entry in cases) {
    NSDictionary *descriptor = classify(request(entry[0], entry[1]));
    assert([descriptor[@"domain"] isEqual:@"no-held-input"]);
    assert([descriptor[@"possibleHolds"] isEqual:@[]]);
  }
}

static NSDictionary *granted_request(NSDictionary *source,
                                     NSString *buildId) {
  NSDictionary *descriptor = meta_recovery_domain_classify_request(
      source, buildId, NULL);
  NSMutableDictionary *grant = [generation() mutableCopy];
  [grant addEntriesFromDictionary:@{
    @"policyVersion" : @"1",
    @"operationId" : source[@"operation"][@"operationId"],
    @"contextSha256" : meta_recovery_domain_sha256(source[@"operation"]),
    @"descriptor" : descriptor,
    @"descriptorSha256" : meta_recovery_domain_sha256(descriptor),
    @"journalRevision" : @7,
    @"durable" : @YES,
  }];
  NSMutableDictionary *result = [source mutableCopy];
  result[@"recoveryGrant"] = grant;
  return result;
}

static void test_exact_durable_grant_validation(void) {
  NSDictionary *source = input_request(@{
    @"kind" : @"key",
    @"stroke" : @{@"keyCode" : @15, @"flags" : @0},
  });
  NSDictionary *granted = granted_request(source, @"native-build-1");
  assert([granted[@"recoveryGrant"][@"descriptorSha256"]
      isEqual:@"2b42c4c41d0481a6f639efc29c19082a39ccf950ae6151d55c72f1e474e5bbde"]);
  NSDictionary *descriptor = nil;
  NSString *reason = nil;
  assert(meta_recovery_domain_validate_request(
      granted, @"native-build-1", &descriptor, &reason));
  assert(reason == nil && [descriptor isEqual:granted[@"recoveryGrant"][@"descriptor"]]);
  assert(!meta_recovery_domain_validate_request(
      granted, @"native-build-2", NULL, &reason));
  assert(reason.length > 0);

  NSMutableDictionary *badDigest = [granted mutableCopy];
  NSMutableDictionary *grant = [badDigest[@"recoveryGrant"] mutableCopy];
  grant[@"contextSha256"] = [@"0" stringByPaddingToLength:64 withString:@"0" startingAtIndex:0];
  badDigest[@"recoveryGrant"] = grant;
  assert(!meta_recovery_domain_validate_request(
      badDigest, @"native-build-1", NULL, NULL));

  NSMutableDictionary *notDurable = [granted mutableCopy];
  grant = [notDurable[@"recoveryGrant"] mutableCopy];
  grant[@"durable"] = @NO;
  notDurable[@"recoveryGrant"] = grant;
  assert(!meta_recovery_domain_validate_request(
      notDurable, @"native-build-1", NULL, NULL));

  NSMutableDictionary *badJournal = [granted mutableCopy];
  grant = [badJournal[@"recoveryGrant"] mutableCopy];
  grant[@"journalRevision"] = @0;
  badJournal[@"recoveryGrant"] = grant;
  assert(!meta_recovery_domain_validate_request(
      badJournal, @"native-build-1", NULL, NULL));

  NSMutableDictionary *wrongOwner = [granted mutableCopy];
  grant = [wrongOwner[@"recoveryGrant"] mutableCopy];
  grant[@"nativeGeneration"] = @"native-foreign";
  grant[@"operationId"] = @"operation-foreign";
  wrongOwner[@"recoveryGrant"] = grant;
  assert(!meta_recovery_domain_validate_request(
      wrongOwner, @"native-build-1", NULL, NULL));
}

static void test_clipboard_write_uses_separate_context_without_native_fence(void) {
  NSDictionary *source = clipboard_request(@"clipboard.write");
  NSDictionary *descriptor = classify(source);
  assert([descriptor[@"domain"] isEqual:@"no-held-input"]);
  assert([descriptor[@"possibleHolds"] isEqual:@[]]);
  assert(source[@"operation"][@"nativeGeneration"] == nil);
  assert(source[@"operation"][@"fence"] == nil);
  NSDictionary *granted = granted_request(source, @"native-build-1");
  assert(meta_recovery_domain_validate_request(
      granted, @"native-build-1", NULL, NULL));
  assert(meta_recovery_domain_classify_request(
      clipboard_request(@"clipboard.read"), @"native-build-1", NULL) == nil);
}

static void test_canonical_json_matches_shared_javascript(void) {
  NSDictionary *value = @{
    @"z" : @"Путь /tmp/\"x\"\n\x01",
    @"a" : @[@YES, NSNull.null, @7],
    @"nested" : @{@"b" : @"\\", @"a" : @"😀"},
  };
  NSString *expected = @"{\"a\":[true,null,7],\"nested\":{\"a\":\"😀\",\"b\":\"\\\\\"},\"z\":\"Путь /tmp/\\\"x\\\"\\n\\u0001\"}";
  assert([meta_recovery_domain_canonical_json(value) isEqual:expected]);
  assert([meta_recovery_domain_sha256(value)
      isEqual:@"70b6e638f87fc7398ad9f1ef6f92a774869b46e5ca10707e7362a5a56752b3e6"]);
}

static void test_unknown_or_malformed_plans_fail_closed(void) {
  NSString *reason = nil;
  assert(meta_recovery_domain_classify_request(
      request(@"input.future", @{}), @"native-build-1", &reason) == nil);
  assert(reason.length > 0);
  assert(meta_recovery_domain_classify_request(
      input_request(@{@"kind" : @"future"}), @"native-build-1", NULL) == nil);
  assert(meta_recovery_domain_classify_request(
      input_request(@{@"kind" : @"key", @"stroke" : @{@"keyCode" : @70000, @"flags" : @0}}),
      @"native-build-1", NULL) == nil);
  assert(meta_recovery_domain_classify_request(
      request(@"capture.start", @{@"request" : @{}, @"nativeMapping" : @{},
                                   @"captureTimeoutMs" : @100,
                                   @"stopTimeoutMs" : @50}),
      @"native-build-1", NULL) == nil);
}

int main(void) {
  @autoreleasepool {
    test_input_holds_follow_physical_bridge();
    test_no_hold_methods_are_explicit();
    test_exact_durable_grant_validation();
    test_clipboard_write_uses_separate_context_without_native_fence();
    test_canonical_json_matches_shared_javascript();
    test_unknown_or_malformed_plans_fail_closed();
  }
  puts("recovery domain tests passed");
}
