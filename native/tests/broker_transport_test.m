#include "meta_broker_transport.h"
#include <arpa/inet.h>
#include <assert.h>
#include <signal.h>
#include <unistd.h>
#include <sys/ioctl.h>

static void write_frame(int descriptor, NSDictionary *message) {
  NSData *payload = [NSJSONSerialization dataWithJSONObject:message options:0 error:NULL];
  uint32_t header = htonl((uint32_t)payload.length);
  const uint8_t *bytes = (const uint8_t *)&header;
  for (size_t index = 0; index < sizeof(header); index += 1) assert(write(descriptor, &bytes[index], 1) == 1);
  assert(write(descriptor, payload.bytes, payload.length) == (ssize_t)payload.length);
}

static void test_queued_messages_after_close(int failureKind) {
  int input[2], output[2];
  assert(pipe(input) == 0 && pipe(output) == 0);
  dispatch_queue_t callbacks = dispatch_queue_create("fixture.blocked-callbacks", DISPATCH_QUEUE_SERIAL);
  dispatch_suspend(callbacks);
  __block size_t delivered = 0;
  __block NSString *failureReason = nil;
  dispatch_semaphore_t failure = dispatch_semaphore_create(0);
  MetaBrokerTransport *transport = [[MetaBrokerTransport alloc] initWithInput:input[0] output:output[1] callbackQueue:callbacks
    onMessage:^(__unused NSDictionary *frame) { delivered += 1; }
    onFailure:^(NSString *reason) { failureReason = reason; dispatch_semaphore_signal(failure); }];
  assert(transport != nil);
  [transport start];
  write_frame(input[1], @{@"channel": @"mutation-1"});
  write_frame(input[1], @{@"channel": @"mutation-2"});
  for (size_t attempt = 0; attempt < 1000; attempt += 1) {
    int remaining = 0;
    assert(ioctl(input[0], FIONREAD, &remaining) == 0);
    if (remaining == 0) break;
    usleep(1000);
    assert(attempt < 999);
  }
  assert([transport enqueueFrame:@{@"barrier": @YES}]);
  if (failureKind == 0) [transport close];
  else if (failureKind == 1) {
    close(input[1]);
    input[1] = -1;
  } else {
    uint32_t invalidHeader = 0;
    assert(write(input[1], &invalidHeader, sizeof(invalidHeader)) == sizeof(invalidHeader));
  }
  BOOL closed = NO;
  for (size_t attempt = 0; attempt < 1000; attempt += 1) {
    if (![transport enqueueFrame:@{@"barrier": @YES}]) { closed = YES; break; }
    usleep(1000);
  }
  assert(closed);
  dispatch_resume(callbacks);
  if (failureKind != 0) {
    assert(dispatch_semaphore_wait(failure, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert([failureReason containsString:failureKind == 1 ? @"input channel" : @"frame length"]);
  }
  dispatch_sync(callbacks, ^{});
  assert(delivered == 0);
  close(input[0]);
  if (input[1] >= 0) close(input[1]);
  close(output[0]); close(output[1]);
}

static void test_closed_output_with_default_sigpipe(void) {
  signal(SIGPIPE, SIG_DFL);
  int input[2], output[2];
  assert(pipe(input) == 0 && pipe(output) == 0);
  dispatch_queue_t callbacks = dispatch_queue_create("fixture.sigpipe", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t failed = dispatch_semaphore_create(0);
  __block NSString *failureReason = nil;
  MetaBrokerTransport *transport = [[MetaBrokerTransport alloc] initWithInput:input[0] output:output[1] callbackQueue:callbacks
    onMessage:^(__unused NSDictionary *frame) { assert(false); }
    onFailure:^(NSString *reason) { failureReason = reason; dispatch_semaphore_signal(failed); }];
  assert(transport != nil);
  close(output[0]);
  [transport start];
  assert([transport enqueueFrame:@{@"payload": @"output-peer-closed"}]);
  assert(dispatch_semaphore_wait(failed, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
  assert([failureReason containsString:@"output channel"]);
  close(input[0]); close(input[1]); close(output[1]);
}

int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_DFL);
    test_queued_messages_after_close(0);
    test_queued_messages_after_close(1);
    test_queued_messages_after_close(2);
    test_closed_output_with_default_sigpipe();
    int input[2], output[2];
    assert(pipe(input) == 0 && pipe(output) == 0);
    dispatch_queue_t control = dispatch_queue_create("fixture.control", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_t action = dispatch_queue_create("fixture.action", DISPATCH_QUEUE_SERIAL);
    dispatch_semaphore_t actionStarted = dispatch_semaphore_create(0);
    dispatch_semaphore_t actionContinue = dispatch_semaphore_create(0);
    dispatch_semaphore_t controlResponded = dispatch_semaphore_create(0);
    dispatch_semaphore_t failed = dispatch_semaphore_create(0);
    __block NSString *failureReason = nil;
    MetaBrokerTransport *transport = [[MetaBrokerTransport alloc] initWithInput:input[0] output:output[1] callbackQueue:control
      onMessage:^(NSDictionary *frame) {
        if ([frame[@"channel"] isEqual:@"slow-action"]) {
          dispatch_async(action, ^{
            dispatch_semaphore_signal(actionStarted);
            dispatch_semaphore_wait(actionContinue, DISPATCH_TIME_FOREVER);
          });
        } else if ([frame[@"channel"] isEqual:@"cancel"]) {
          dispatch_semaphore_signal(controlResponded);
        }
      } onFailure:^(NSString *reason) { failureReason = reason; dispatch_semaphore_signal(failed); }];
    assert(transport != nil);
    [transport start];
    write_frame(input[1], @{@"channel": @"slow-action"});
    assert(dispatch_semaphore_wait(actionStarted, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    write_frame(input[1], @{@"channel": @"cancel"});
    assert(dispatch_semaphore_wait(controlResponded, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    dispatch_semaphore_signal(actionContinue);

    NSString *text = [@"x" stringByPaddingToLength:900000 withString:@"x" startingAtIndex:0];
    size_t accepted = 0;
    for (size_t index = 0; index < 10; index += 1) {
      if (![transport enqueueFrame:@{@"payload": text}]) break;
      accepted += 1;
    }
    assert(accepted > 0 && accepted <= 5);
    assert(dispatch_semaphore_wait(failed, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert([failureReason containsString:@"writer queue overflow"]);
    [transport close];
    close(input[0]); close(input[1]); close(output[0]); close(output[1]);

    assert(pipe(input) == 0 && pipe(output) == 0);
    MetaBrokerTransport *oversized = [[MetaBrokerTransport alloc] initWithInput:input[0] output:output[1] callbackQueue:control
      onMessage:^(__unused NSDictionary *frame) { assert(false); }
      onFailure:^(NSString *reason) { failureReason = reason; dispatch_semaphore_signal(failed); }];
    [oversized start];
    uint32_t hugeHeader = htonl(64 * 1024 * 1024);
    assert(write(input[1], &hugeHeader, sizeof(hugeHeader)) == sizeof(hugeHeader));
    assert(dispatch_semaphore_wait(failed, dispatch_time(DISPATCH_TIME_NOW, 1000000000)) == 0);
    assert([failureReason containsString:@"frame length"]);
    [oversized close];
    close(input[0]); close(input[1]); close(output[0]); close(output[1]);
    puts("broker transport tests passed");
  }
  return 0;
}
