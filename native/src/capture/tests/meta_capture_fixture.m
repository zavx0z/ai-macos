#import "../meta_capture.h"
#import "meta_capture_testing.h"

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

@interface FakeStream : NSObject

@property(nonatomic) NSUInteger stopCount;
@property(nonatomic) NSUInteger removeCount;
@property(nonatomic) BOOL removeSucceeds;
@property(nonatomic, copy, nullable) void (^pendingStop)(NSError *_Nullable error);

- (void)resolveStop:(NSError *_Nullable)error;

@end


@implementation FakeStream

- (instancetype)init {
  self = [super init];
  if (self != nil) _removeSucceeds = YES;
  return self;
}

- (BOOL)addStreamOutput:(id)output
                   type:(NSInteger)type
     sampleHandlerQueue:(dispatch_queue_t)queue
                  error:(NSError **)error {
  (void)output;
  (void)type;
  (void)queue;
  (void)error;
  return YES;
}

- (BOOL)removeStreamOutput:(id)output type:(NSInteger)type error:(NSError **)error {
  (void)output;
  (void)type;
  assert(error != NULL);
  self.removeCount += 1;
  if (!self.removeSucceeds) {
    *error = [NSError errorWithDomain:@"fixture-remove" code:1 userInfo:nil];
    return NO;
  }
  return YES;
}

- (void)startCaptureWithCompletionHandler:(void (^)(NSError *_Nullable error))completionHandler {
  (void)completionHandler;
}

- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *_Nullable error))completionHandler {
  assert(self.removeCount == 1);
  self.stopCount += 1;
  self.pendingStop = completionHandler;
}

- (void)resolveStop:(NSError *)error {
  void (^completion)(NSError *) = self.pendingStop;
  self.pendingStop = nil;
  if (completion != nil) completion(error);
}

@end

static bool nearlyEqual(double first, double second) {
  return fabs(first - second) <= 0.000001;
}

static void testBudget(void) {
  assert(meta_capture_dimensions_fit_budget(8000, 4000, 32000000));
  assert(!meta_capture_dimensions_fit_budget(8001, 4000, 32000000));
  assert(!meta_capture_dimensions_fit_budget(SIZE_MAX, 2, UINT64_MAX));
  assert(!meta_capture_dimensions_fit_budget(0, 100, 32000000));
}

static void testCompleteFrame(void) {
  assert(meta_capture_frame_is_complete(true, true, 0));
  for (int32_t status = 1; status <= 5; status += 1) {
    assert(!meta_capture_frame_is_complete(true, true, status));
  }
  assert(!meta_capture_frame_is_complete(false, true, 0));
  assert(!meta_capture_frame_is_complete(true, false, 0));
}

static void testNegativeOriginTransform(void) {
  CGRect image = CGRectMake(0, 0, 2560, 1440);
  CGRect screen = CGRectMake(-1280, -720, 1280, 720);
  MetaCaptureAffineTransform transform = meta_capture_transform_between_rects(image, screen);
  CGPoint topLeft = meta_capture_apply_transform(transform, CGPointMake(0, 0));
  CGPoint bottomRight = meta_capture_apply_transform(transform, CGPointMake(2560, 1440));
  assert(nearlyEqual(topLeft.x, -1280));
  assert(nearlyEqual(topLeft.y, -720));
  assert(nearlyEqual(bottomRight.x, 0));
  assert(nearlyEqual(bottomRight.y, 0));
}

static void testRegionTransform(void) {
  CGRect image = CGRectMake(512, 0, 1536, 1600);
  CGRect screen = CGRectMake(0, 0, 1536, 1600);
  MetaCaptureAffineTransform transform = meta_capture_transform_between_rects(image, screen);
  CGPoint center = meta_capture_apply_transform(transform, CGPointMake(1280, 800));
  assert(nearlyEqual(center.x, 768));
  assert(nearlyEqual(center.y, 800));
}

static NSData *fixturePngFromPixels(size_t width, size_t height, const uint8_t *pixels) {
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
    (void *)pixels,
    width,
    height,
    8,
    width * 4,
    colorSpace,
    kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
  );
  CGColorSpaceRelease(colorSpace);
  assert(context != NULL);
  CGImageRef image = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  assert(image != NULL);

  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
    (__bridge CFMutableDataRef)data,
    CFSTR("public.png"),
    1,
    NULL
  );
  assert(destination != NULL);
  CGImageDestinationAddImage(destination, image, NULL);
  assert(CGImageDestinationFinalize(destination));
  CFRelease(destination);
  CGImageRelease(image);
  return data;
}

static NSData *fixturePng(size_t width, size_t height, uint8_t red, uint8_t green, uint8_t blue) {
  size_t byteCount = width * height * 4;
  uint8_t *pixels = calloc(byteCount, 1);
  assert(pixels != NULL);
  for (size_t index = 0; index < width * height; index += 1) {
    pixels[index * 4] = red;
    pixels[index * 4 + 1] = green;
    pixels[index * 4 + 2] = blue;
    pixels[index * 4 + 3] = 255;
  }
  NSData *data = fixturePngFromPixels(width, height, pixels);
  free(pixels);
  return data;
}

static uint8_t *copyImagePixels(CGImageRef image) {
  size_t width = CGImageGetWidth(image);
  size_t height = CGImageGetHeight(image);
  size_t byteCount = width * height * 4;
  uint8_t *pixels = calloc(byteCount, 1);
  assert(pixels != NULL);
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
    pixels,
    width,
    height,
    8,
    width * 4,
    colorSpace,
    kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
  );
  CGColorSpaceRelease(colorSpace);
  assert(context != NULL);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
  CGContextRelease(context);
  return pixels;
}

static void assertDisplayOrientedPlacement(CGImageRef image, NSData *patternPng) {
  size_t width = CGImageGetWidth(image);
  size_t height = CGImageGetHeight(image);
  uint8_t *pixels = copyImagePixels(image);
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)patternPng, NULL);
  CGImageRef pattern = source == NULL ? NULL : CGImageSourceCreateImageAtIndex(source, 0, NULL);
  assert(pattern != NULL);
  assert(CGImageGetWidth(pattern) == 2);
  assert(CGImageGetHeight(pattern) == 3);
  uint8_t *patternPixels = copyImagePixels(pattern);

  size_t middleRow = height / 2;
  const uint8_t *red = pixels + (middleRow * width) * 4;
  const uint8_t *gap = pixels + (middleRow * width + 2) * 4;
  assert(red[0] == 255 && red[1] == 0 && red[2] == 0 && red[3] == 255);
  assert(gap[3] == 0);
  for (size_t y = 0; y < 3; y += 1) {
    for (size_t x = 0; x < 2; x += 1) {
      const uint8_t *expected = patternPixels + (y * 2 + x) * 4;
      const uint8_t *actual = pixels + (y * width + 4 + x) * 4;
      assert(memcmp(actual, expected, 4) == 0);
    }
  }

  free(patternPixels);
  CGImageRelease(pattern);
  CFRelease(source);
  free(pixels);
}

static void testLayoutComposition(void) {
  NSData *redPng = fixturePng(2, 3, 255, 0, 0);
  const uint8_t patternPixels[] = {
    0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff,
    0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff,
    0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff,
  };
  NSData *patternPng = fixturePngFromPixels(2, 3, patternPixels);
  MetaCaptureDisplayRegion firstRegion = {
    .displayID = 10,
    .displayBoundsPoints = CGRectMake(-3, -1, 2, 3),
    .imageRectPixels = CGRectMake(0, 0, 2, 3),
    .destinationRectPoints = CGRectMake(-3, -1, 2, 3),
    .imageToDestination = meta_capture_transform_between_rects(
      CGRectMake(0, 0, 2, 3),
      CGRectMake(-3, -1, 2, 3)
    ),
    .displayRotationDegrees = 0,
    .backingScaleX = 2,
    .backingScaleY = 2,
    .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
    .frameDisplayTimeMachAbsolute = 100,
    .frameTimestampUnixNanoseconds = 1000
  };
  MetaCaptureDisplayRegion secondRegion = {
    .displayID = 11,
    .displayBoundsPoints = CGRectMake(1, -1, 2, 3),
    .imageRectPixels = CGRectMake(0, 0, 2, 3),
    .destinationRectPoints = CGRectMake(1, -1, 2, 3),
    .imageToDestination = meta_capture_transform_between_rects(
      CGRectMake(0, 0, 2, 3),
      CGRectMake(1, -1, 2, 3)
    ),
    .displayRotationDegrees = 90,
    .backingScaleX = 1,
    .backingScaleY = 1,
    .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
    .frameDisplayTimeMachAbsolute = 110,
    .frameTimestampUnixNanoseconds = 1010
  };
  MetaCaptureResult first = {
    .outcome = MetaCaptureOutcomeSucceeded,
    .cleanup = MetaCaptureCleanupComplete,
    .source = MetaCaptureSourceDisplayComposite,
    .caption = CFSTR("Layout fixture"),
    .pngData = (__bridge CFDataRef)redPng,
    .imageWidthPixels = 2,
    .imageHeightPixels = 3,
    .encodedBytes = redPng.length,
    .capturedAtUnixNanoseconds = 1000,
    .frameDisplayTimeMachAbsolute = 100,
    .frameStatus = 0,
    .shareableTargetMatched = true,
    .regions = &firstRegion,
    .regionCount = 1
  };
  MetaCaptureResult second = {
    .outcome = MetaCaptureOutcomeSucceeded,
    .cleanup = MetaCaptureCleanupUnknown,
    .source = MetaCaptureSourceDisplayComposite,
    .caption = CFSTR("Layout fixture"),
    .pngData = (__bridge CFDataRef)patternPng,
    .imageWidthPixels = 2,
    .imageHeightPixels = 3,
    .encodedBytes = patternPng.length,
    .capturedAtUnixNanoseconds = 1010,
    .frameDisplayTimeMachAbsolute = 110,
    .frameStatus = 0,
    .shareableTargetMatched = true,
    .regions = &secondRegion,
    .regionCount = 1
  };
  const MetaCaptureResult *frames[] = { &first, &second };
  MetaCaptureLayoutRequest request = {
    .frames = frames,
    .frameCount = 2,
    .caption = CFSTR("Layout fixture"),
    .outputScale = 0.5,
    .maxWidthPixels = 10,
    .maxHeightPixels = 10,
    .maxPixels = 100,
    .maxEncodedBytes = 1024 * 1024
  };

  MetaCaptureResult *result = meta_capture_compose_layout(&request);
  assert(result != NULL);
  assert(result->outcome == MetaCaptureOutcomeSucceeded);
  assert(result->cleanup == MetaCaptureCleanupUnknown);
  assert(result->imageWidthPixels == 6);
  assert(result->imageHeightPixels == 3);
  assert(result->regionCount == 2);
  assert(result->capturedAtUnixNanoseconds == 1010);
  assert(result->shareableTargetMatched);
  CGImageSourceRef source = CGImageSourceCreateWithData(result->pngData, NULL);
  CGImageRef composed = source == NULL ? NULL : CGImageSourceCreateImageAtIndex(source, 0, NULL);
  assert(composed != NULL);
  assert(CGImageGetWidth(composed) == 6);
  assert(CGImageGetHeight(composed) == 3);
  assertDisplayOrientedPlacement(composed, patternPng);
  CGImageRelease(composed);
  CFRelease(source);
  CGPoint left = meta_capture_apply_transform(
    result->regions[0].imageToDestination,
    CGPointMake(0, 0)
  );
  assert(nearlyEqual(left.x, -3));
  assert(nearlyEqual(left.y, -1));
  assert(nearlyEqual(result->regions[1].imageRectPixels.origin.x, 4));
  assert(nearlyEqual(result->regions[1].imageRectPixels.size.height, 3));
  assert(result->regions[1].frameOrientation == MetaCaptureFrameOrientationDisplayOriented);
  meta_capture_result_release(result);

  request.maxWidthPixels = 1;
  MetaCaptureResult *bounded = meta_capture_compose_layout(&request);
  assert(bounded != NULL);
  assert(bounded->outcome == MetaCaptureOutcomeFailed);
  assert(bounded->errorCode == MetaCaptureErrorBudgetExceeded);
  meta_capture_result_release(bounded);

  request.maxWidthPixels = 10;
  secondRegion.frameOrientation = 0;
  MetaCaptureResult *unknownOrientation = meta_capture_compose_layout(&request);
  assert(unknownOrientation != NULL);
  assert(unknownOrientation->outcome == MetaCaptureOutcomeFailed);
  assert(unknownOrientation->errorCode == MetaCaptureErrorFrameUnavailable);
  meta_capture_result_release(unknownOrientation);
}

static void flushCallbackQueue(dispatch_queue_t queue) {
  dispatch_sync(queue, ^{});
}

static MetaCaptureTaskRef lifecycleTask(
  FakeStream *stream,
  bool encodingInFlight,
  dispatch_queue_t callbackQueue,
  NSUInteger *completionCount,
  MetaCaptureCleanup *completionCleanup
) {
  return meta_capture_test_create_lifecycle_task(
    (__bridge void *)stream,
    encodingInFlight,
    callbackQueue,
    ^(MetaCaptureResult *result) {
      *completionCount += 1;
      *completionCleanup = result->cleanup;
      meta_capture_result_release(result);
    }
  );
}

static void testStopBeforeLateStartDoesNotRestart(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.1", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(stream, false, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  assert(stream.stopCount == 1);
  assert(stream.removeCount == 1);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  assert(stream.removeCount == 1);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupComplete);

  meta_capture_test_resolve_start(task, true);
  meta_capture_test_sync(task);
  assert(stream.stopCount == 1);
  assert(stream.removeCount == 1);
  MetaCaptureTaskStatus status;
  assert(meta_capture_task_status(task, &status));
  assert(status.drained);
  assert(status.cleanup == MetaCaptureCleanupComplete);
  meta_capture_task_release(task);
}

static void testStartFailureReleasesStreamWithoutTerminalDetach(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create(
      "capture.fixture.callbacks.start-failure", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(
      stream, false, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_test_resolve_start(task, false);
  flushCallbackQueue(callbacks);
  assert(stream.removeCount == 0);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupComplete);
  meta_capture_task_release(task);
}

static void testDetachFailureStillStopsAndDoesNotRetryRemoval(void) {
  FakeStream *stream = [FakeStream new];
  stream.removeSucceeds = NO;
  dispatch_queue_t callbacks = dispatch_queue_create(
      "capture.fixture.callbacks.detach-failure", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(
      stream, false, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  assert(stream.removeCount == 1);
  assert(stream.stopCount == 1);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);
  assert(stream.removeCount == 1);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupComplete);
  meta_capture_test_resolve_start(task, true);
  meta_capture_test_sync(task);
  assert(stream.removeCount == 1);
  assert(stream.stopCount == 1);
  meta_capture_task_release(task);
}

static void testCaptureTimeoutWhileStartPendingStopsOnce(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.timeout", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureOutcome outcome = 0;
  MetaCaptureTaskRef task = meta_capture_test_create_lifecycle_task(
    (__bridge void *)stream,
    false,
    callbacks,
    ^(MetaCaptureResult *result) {
      completionCount += 1;
      outcome = result->outcome;
      meta_capture_result_release(result);
    }
  );
  assert(task != NULL);

  meta_capture_test_fire_capture_timeout(task);
  assert(stream.stopCount == 1);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(outcome == MetaCaptureOutcomeTimedOut);

  meta_capture_test_resolve_start(task, true);
  meta_capture_test_sync(task);
  assert(stream.stopCount == 1);
  meta_capture_task_release(task);
}

static void testStopErrorRetriesAfterLateStart(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.2", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(stream, false, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  NSError *stopError = [NSError errorWithDomain:@"fixture" code:7 userInfo:nil];
  [stream resolveStop:stopError];
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupUnknown);

  MetaCaptureTaskStatus unknown;
  assert(meta_capture_task_status(task, &unknown));
  assert(!unknown.drained);
  assert(unknown.stopAttemptCount == 1);
  uint64_t unknownRevision = unknown.revision;

  meta_capture_test_resolve_start(task, true);
  meta_capture_test_sync(task);
  assert(stream.stopCount == 2);
  assert(stream.removeCount == 1);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);

  MetaCaptureTaskStatus reconciled;
  assert(meta_capture_task_status(task, &reconciled));
  assert(reconciled.revision > unknownRevision);
  assert(reconciled.drained);
  assert(reconciled.cleanup == MetaCaptureCleanupComplete);
  assert(completionCount == 1);
  meta_capture_task_release(task);
}

static void testStopTimeoutReconcilesAfterLateSuccess(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.3", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(stream, false, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  meta_capture_test_fire_stop_timeout(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupUnknown);

  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  MetaCaptureTaskStatus status;
  assert(meta_capture_task_status(task, &status));
  assert(status.drained);
  assert(status.cleanup == MetaCaptureCleanupComplete);
  assert(completionCount == 1);
  meta_capture_task_release(task);
}

static void testEncodingMustDrainBeforeCompleteCleanup(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.4", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(stream, true, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 0);

  MetaCaptureTaskStatus pending;
  assert(meta_capture_task_status(task, &pending));
  assert(pending.streamStopped);
  assert(pending.encodingInFlight);
  assert(!pending.drained);

  meta_capture_test_finish_encoding(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupComplete);
  meta_capture_task_release(task);
}

static void testEncodingDeadlineReturnsUnknownThenReconciles(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.encoding-timeout", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  MetaCaptureTaskRef task = lifecycleTask(stream, true, callbacks, &completionCount, &cleanup);
  assert(task != NULL);

  meta_capture_cancel(task);
  meta_capture_test_sync(task);
  [stream resolveStop:nil];
  meta_capture_test_sync(task);
  assert(completionCount == 0);

  usleep(1200000);
  meta_capture_test_sync(task);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  assert(cleanup == MetaCaptureCleanupUnknown);

  MetaCaptureTaskStatus unknown;
  assert(meta_capture_task_status(task, &unknown));
  assert(unknown.streamStopped);
  assert(unknown.encodingInFlight);
  assert(!unknown.drained);
  uint64_t unknownRevision = unknown.revision;

  meta_capture_test_finish_encoding(task);
  MetaCaptureTaskStatus reconciled;
  assert(meta_capture_task_status(task, &reconciled));
  assert(reconciled.revision > unknownRevision);
  assert(reconciled.cleanup == MetaCaptureCleanupComplete);
  assert(reconciled.drained);
  flushCallbackQueue(callbacks);
  assert(completionCount == 1);
  meta_capture_task_release(task);
}

static void testAllocationFailureIsSynchronous(void) {
  FakeStream *stream = [FakeStream new];
  dispatch_queue_t callbacks = dispatch_queue_create("capture.fixture.callbacks.5", DISPATCH_QUEUE_SERIAL);
  __block NSUInteger completionCount = 0;
  __block MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  meta_capture_test_fail_next_result_allocation();
  MetaCaptureTaskRef task = lifecycleTask(stream, false, callbacks, &completionCount, &cleanup);
  assert(task == NULL);
  assert(completionCount == 0);
  assert(stream.stopCount == 0);
}

int main(void) {
  @autoreleasepool {
    MetaCaptureRequest request = meta_capture_request_default();
    assert(request.abiVersion == META_CAPTURE_ABI_VERSION);
    assert(request.maxPixels == META_CAPTURE_DEFAULT_MAX_PIXELS);
    assert(request.maxEncodedBytes == META_CAPTURE_DEFAULT_MAX_ENCODED_BYTES);
    testBudget();
    testCompleteFrame();
    testNegativeOriginTransform();
    testRegionTransform();
    testLayoutComposition();
    testStopBeforeLateStartDoesNotRestart();
    testStartFailureReleasesStreamWithoutTerminalDetach();
    testDetachFailureStillStopsAndDoesNotRetryRemoval();
    testCaptureTimeoutWhileStartPendingStopsOnce();
    testStopErrorRetriesAfterLateStart();
    testStopTimeoutReconcilesAfterLateSuccess();
    testEncodingMustDrainBeforeCompleteCleanup();
    testEncodingDeadlineReturnsUnknownThenReconciles();
    testAllocationFailureIsSynchronous();
    NSLog(@"meta_capture_fixture: pass");
  }
  return 0;
}
