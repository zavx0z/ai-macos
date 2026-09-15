#import "meta_capture.h"

#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <mach/mach_time.h>
#import <os/lock.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint8_t *bytes;
  size_t length;
  size_t capacity;
  size_t maximum;
  bool exceeded;
} MetaBoundedBuffer;

typedef struct {
  bool matched;
  CGRect bounds;
} MetaWindowEvidence;

@protocol MetaCaptureStreamHandle <NSObject>
- (BOOL)addStreamOutput:(id<SCStreamOutput>)output
                   type:(SCStreamOutputType)type
     sampleHandlerQueue:(dispatch_queue_t _Nullable)sampleHandlerQueue
                  error:(NSError **)error;
- (BOOL)removeStreamOutput:(id<SCStreamOutput>)output
                      type:(SCStreamOutputType)type
                     error:(NSError **)error;
- (void)startCaptureWithCompletionHandler:(void (^)(NSError *_Nullable error))completionHandler;
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *_Nullable error))completionHandler;
@end

@interface MetaCaptureSession : NSObject <SCStreamOutput, SCStreamDelegate> {
  uint32_t _skippedFrameCounts[6];
  os_unfair_lock _statusLock;
  MetaCaptureTaskStatus _taskStatus;
  MetaCaptureResult *_resultStorage;
}

@property(nonatomic) MetaCaptureRequest request;
@property(nonatomic, copy) NSString *caption;
@property(nonatomic, strong) dispatch_queue_t stateQueue;
@property(nonatomic, strong) dispatch_queue_t sampleQueue;
@property(nonatomic, strong) dispatch_queue_t encodeQueue;
@property(nonatomic, strong) dispatch_queue_t callbackQueue;
@property(nonatomic, copy) MetaCaptureCompletion completion;
@property(nonatomic, strong, nullable) dispatch_source_t captureTimer;
@property(nonatomic, strong, nullable) dispatch_source_t stopTimer;
@property(nonatomic, strong, nullable) id<MetaCaptureStreamHandle> stream;
@property(nonatomic, strong, nullable) SCWindow *window;
@property(nonatomic, strong, nullable) SCDisplay *display;
@property(nonatomic, copy) NSArray<SCDisplay *> *displays;
@property(nonatomic) CGRect destinationBounds;
@property(nonatomic) CGRect beforeBounds;
@property(nonatomic) CGRect afterBounds;
@property(nonatomic) bool beforeMatched;
@property(nonatomic) bool afterMatched;
@property(nonatomic) bool acceptedFrame;
@property(nonatomic) bool streamStarted;
@property(nonatomic) bool streamStopped;
@property(nonatomic) bool stopRequested;
@property(nonatomic) bool stopCallInFlight;
@property(nonatomic) uint32_t stopAttemptCount;
@property(nonatomic) bool completionDelivered;
@property(nonatomic) bool cancelled;
@property(nonatomic) bool retainedForUnknownCleanup;
@property(nonatomic) bool encodingInFlight;
@property(nonatomic) uint64_t startedAtMachAbsolute;
@property(nonatomic) uint32_t invalidFrameCount;
@property(nonatomic) size_t imageWidth;
@property(nonatomic) size_t imageHeight;
@property(nonatomic) uint64_t frameDisplayTime;
@property(nonatomic) uint64_t frameTimestampUnixNanoseconds;
@property(nonatomic) int32_t frameStatus;
@property(nonatomic) CGRect contentRect;
@property(nonatomic) bool hasContentRect;
@property(nonatomic) CGRect screenRect;
@property(nonatomic) bool hasScreenRect;
@property(nonatomic) double contentScale;
@property(nonatomic) bool hasContentScale;
@property(nonatomic) double scaleFactor;
@property(nonatomic) bool hasScaleFactor;
@property(nonatomic, strong, nullable) NSData *pngData;
@property(nonatomic) MetaCaptureOutcome pendingOutcome;
@property(nonatomic) MetaCaptureErrorCode pendingErrorCode;
@property(nonatomic, copy, nullable) NSString *pendingErrorMessage;

- (instancetype)initWithRequest:(const MetaCaptureRequest *)request
                  callbackQueue:(dispatch_queue_t)callbackQueue
                     completion:(MetaCaptureCompletion)completion;
- (void)begin;
- (void)cancel;
- (bool)copyTaskStatus:(MetaCaptureTaskStatus *)status;

@end

static dispatch_queue_t MetaActiveQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.meta.capture.active", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

static NSMutableSet<MetaCaptureSession *> *MetaActiveSessions(void) {
  static NSMutableSet<MetaCaptureSession *> *sessions;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    sessions = [NSMutableSet set];
  });
  return sessions;
}

#if META_CAPTURE_TESTING
static bool MetaFailNextResultAllocation = false;
#endif

static MetaCaptureResult *MetaAllocateResult(void) {
#if META_CAPTURE_TESTING
  if (MetaFailNextResultAllocation) {
    MetaFailNextResultAllocation = false;
    return NULL;
  }
#endif
  return calloc(1, sizeof(MetaCaptureResult));
}

static void MetaRetainActiveSession(MetaCaptureSession *session) {
  dispatch_sync(MetaActiveQueue(), ^{
    [MetaActiveSessions() addObject:session];
  });
}

static void MetaReleaseActiveSession(MetaCaptureSession *session) {
  dispatch_async(MetaActiveQueue(), ^{
    [MetaActiveSessions() removeObject:session];
  });
}

static uint64_t MetaMachDurationNanoseconds(uint64_t duration) {
  static mach_timebase_info_data_t info;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    mach_timebase_info(&info);
  });
  long double nanoseconds = (long double)duration * info.numer / info.denom;
  return nanoseconds >= UINT64_MAX ? UINT64_MAX : (uint64_t)nanoseconds;
}

static uint64_t MetaUnixNanosecondsForDisplayTime(uint64_t displayTime) {
  uint64_t nowMach = mach_absolute_time();
  NSTimeInterval nowSeconds = [NSDate date].timeIntervalSince1970;
  uint64_t nowUnix = nowSeconds >= (NSTimeInterval)(UINT64_MAX / 1000000000ULL)
    ? UINT64_MAX
    : (uint64_t)(nowSeconds * 1000000000.0);
  if (displayTime == 0 || displayTime > nowMach) return nowUnix;
  uint64_t age = MetaMachDurationNanoseconds(nowMach - displayTime);
  return age >= nowUnix ? 0 : nowUnix - age;
}

static bool MetaRectIsFinitePositive(CGRect rect) {
  return isfinite(rect.origin.x)
    && isfinite(rect.origin.y)
    && isfinite(rect.size.width)
    && isfinite(rect.size.height)
    && rect.size.width > 0
    && rect.size.height > 0;
}

static CGRect MetaIntersection(CGRect first, CGRect second) {
  CGRect intersection = CGRectIntersection(first, second);
  return CGRectIsNull(intersection) ? CGRectZero : intersection;
}

static bool MetaRectsEqual(CGRect first, CGRect second) {
  return CGRectEqualToRect(first, second);
}

static MetaWindowEvidence MetaReadWindowEvidence(uint32_t windowID, int32_t ownerPID) {
  MetaWindowEvidence evidence = { .matched = false, .bounds = CGRectZero };
  CFArrayRef records = CGWindowListCopyWindowInfo(
    kCGWindowListOptionIncludingWindow,
    (CGWindowID)windowID
  );
  if (records == NULL) return evidence;

  for (NSDictionary *record in (__bridge NSArray *)records) {
    NSNumber *number = record[(id)kCGWindowNumber];
    NSNumber *pid = record[(id)kCGWindowOwnerPID];
    NSDictionary *bounds = record[(id)kCGWindowBounds];
    CGRect rect = CGRectZero;
    if (number.unsignedIntValue == windowID
        && pid.intValue == ownerPID
        && bounds != nil
        && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect)) {
      evidence.matched = true;
      evidence.bounds = rect;
      break;
    }
  }
  CFRelease(records);
  return evidence;
}

static size_t MetaBoundedPutBytes(void *info, const void *buffer, size_t count) {
  MetaBoundedBuffer *output = info;
  if (count > output->maximum - output->length) {
    output->exceeded = true;
    return 0;
  }

  size_t required = output->length + count;
  if (required > output->capacity) {
    size_t next = output->capacity == 0 ? MIN((size_t)1048576, output->maximum) : output->capacity;
    while (next < required && next < output->maximum) {
      size_t doubled = next > SIZE_MAX / 2 ? output->maximum : next * 2;
      next = MIN(doubled, output->maximum);
    }
    uint8_t *resized = realloc(output->bytes, next);
    if (resized == NULL) {
      output->exceeded = true;
      return 0;
    }
    output->bytes = resized;
    output->capacity = next;
  }

  memcpy(output->bytes + output->length, buffer, count);
  output->length = required;
  return count;
}

static void MetaBoundedReleaseInfo(void *info) {
  (void)info;
}

static NSData *MetaEncodeCGImage(
  CGImageRef cgImage,
  uint64_t maximumBytes,
  MetaCaptureErrorCode *errorCode,
  NSString **errorMessage
) {
  MetaBoundedBuffer output = {
    .bytes = NULL,
    .length = 0,
    .capacity = 0,
    .maximum = (size_t)MIN(maximumBytes, (uint64_t)SIZE_MAX),
    .exceeded = false
  };
  CGDataConsumerCallbacks callbacks = {
    .putBytes = MetaBoundedPutBytes,
    .releaseConsumer = MetaBoundedReleaseInfo
  };
  CGDataConsumerRef consumer = CGDataConsumerCreate(&output, &callbacks);
  CGImageDestinationRef destination = consumer == NULL
    ? NULL
    : CGImageDestinationCreateWithDataConsumer(consumer, CFSTR("public.png"), 1, NULL);
  bool encoded = false;
  if (destination != NULL) {
    CGImageDestinationAddImage(destination, cgImage, NULL);
    encoded = CGImageDestinationFinalize(destination);
    CFRelease(destination);
  }
  if (consumer != NULL) CFRelease(consumer);

  if (!encoded || output.exceeded) {
    free(output.bytes);
    *errorCode = output.exceeded
      ? MetaCaptureErrorBudgetExceeded
      : MetaCaptureErrorEncodingFailed;
    *errorMessage = output.exceeded
      ? @"PNG превысил maxEncodedBytes во время bounded encoding"
      : @"ImageIO не завершил PNG encoding";
    return nil;
  }

  return [NSData dataWithBytesNoCopy:output.bytes
                              length:output.length
                        freeWhenDone:YES];
}

static NSData *MetaEncodePng(
  CVPixelBufferRef pixelBuffer,
  uint64_t maximumBytes,
  MetaCaptureErrorCode *errorCode,
  NSString **errorMessage
) {
  CIImage *image = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  CIContext *context = [CIContext contextWithOptions:nil];
  CGImageRef cgImage = [context createCGImage:image fromRect:image.extent];
  if (cgImage == NULL) {
    *errorCode = MetaCaptureErrorEncodingFailed;
    *errorMessage = @"Не удалось создать CGImage из complete frame";
    return nil;
  }
  NSData *encoded = MetaEncodeCGImage(cgImage, maximumBytes, errorCode, errorMessage);
  CGImageRelease(cgImage);
  return encoded;
}

static NSNumber *MetaNumberAttachment(NSDictionary *attachments, SCStreamFrameInfo key) {
  id value = attachments[key];
  return [value isKindOfClass:[NSNumber class]] ? value : nil;
}

static bool MetaRectAttachment(
  NSDictionary *attachments,
  SCStreamFrameInfo key,
  CGRect *value
) {
  id encoded = attachments[key];
  if (![encoded isKindOfClass:[NSDictionary class]]) return false;
  CFTypeRef object = (__bridge CFTypeRef)encoded;
  if (CFGetTypeID(object) != CFDictionaryGetTypeID()) return false;
  return CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)object, value);
}

static double MetaDisplayScaleX(SCDisplay *display) {
  if (display.width <= 0) return 1;
  size_t pixels = CGDisplayPixelsWide(display.displayID);
  return pixels == 0 ? 1 : (double)pixels / (double)display.width;
}

static double MetaDisplayScaleY(SCDisplay *display) {
  if (display.height <= 0) return 1;
  size_t pixels = CGDisplayPixelsHigh(display.displayID);
  return pixels == 0 ? 1 : (double)pixels / (double)display.height;
}

static double MetaMaximumScaleForWindow(CGRect bounds, NSArray<SCDisplay *> *displays) {
  double maximum = 1;
  for (SCDisplay *display in displays) {
    if (CGRectIsEmpty(MetaIntersection(bounds, display.frame))) continue;
    maximum = MAX(maximum, MAX(MetaDisplayScaleX(display), MetaDisplayScaleY(display)));
  }
  return maximum;
}

static CGRect MetaContentPixelRect(
  CGRect contentRect,
  bool hasContentRect,
  double scaleFactor,
  bool hasScaleFactor,
  size_t width,
  size_t height
) {
  if (!hasContentRect || !hasScaleFactor || scaleFactor <= 0) {
    return CGRectMake(0, 0, width, height);
  }
  CGRect pixels = CGRectMake(
    contentRect.origin.x * scaleFactor,
    contentRect.origin.y * scaleFactor,
    contentRect.size.width * scaleFactor,
    contentRect.size.height * scaleFactor
  );
  CGRect surface = CGRectMake(0, 0, width, height);
  CGRect clipped = MetaIntersection(pixels, surface);
  return CGRectIsEmpty(clipped) ? surface : clipped;
}

static MetaCaptureDisplayRegion *MetaBuildRegions(
  CGRect destinationBounds,
  CGRect contentPixelRect,
  NSArray<SCDisplay *> *displays,
  uint64_t displayTime,
  uint64_t frameTimestamp,
  size_t *regionCount
) {
  NSMutableArray<SCDisplay *> *intersecting = [NSMutableArray array];
  for (SCDisplay *display in displays) {
    if (!CGRectIsEmpty(MetaIntersection(destinationBounds, display.frame))) {
      [intersecting addObject:display];
    }
  }

  *regionCount = intersecting.count;
  if (intersecting.count == 0) return NULL;
  MetaCaptureDisplayRegion *regions = calloc(
    intersecting.count,
    sizeof(MetaCaptureDisplayRegion)
  );
  if (regions == NULL) {
    *regionCount = 0;
    return NULL;
  }

  for (NSUInteger index = 0; index < intersecting.count; index += 1) {
    SCDisplay *display = intersecting[index];
    CGRect destination = MetaIntersection(destinationBounds, display.frame);
    double relativeX = (destination.origin.x - destinationBounds.origin.x)
      / destinationBounds.size.width;
    double relativeY = (destination.origin.y - destinationBounds.origin.y)
      / destinationBounds.size.height;
    double relativeWidth = destination.size.width / destinationBounds.size.width;
    double relativeHeight = destination.size.height / destinationBounds.size.height;
    CGRect imageRect = CGRectMake(
      contentPixelRect.origin.x + relativeX * contentPixelRect.size.width,
      contentPixelRect.origin.y + relativeY * contentPixelRect.size.height,
      relativeWidth * contentPixelRect.size.width,
      relativeHeight * contentPixelRect.size.height
    );
    regions[index] = (MetaCaptureDisplayRegion){
      .displayID = display.displayID,
      .displayBoundsPoints = display.frame,
      .imageRectPixels = imageRect,
      .destinationRectPoints = destination,
      .imageToDestination = meta_capture_transform_between_rects(imageRect, destination),
      .displayRotationDegrees = CGDisplayRotation(display.displayID),
      .backingScaleX = MetaDisplayScaleX(display),
      .backingScaleY = MetaDisplayScaleY(display),
      .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
      .frameDisplayTimeMachAbsolute = displayTime,
      .frameTimestampUnixNanoseconds = frameTimestamp
    };
  }
  return regions;
}

@implementation MetaCaptureSession

- (instancetype)initWithRequest:(const MetaCaptureRequest *)request
                  callbackQueue:(dispatch_queue_t)callbackQueue
                     completion:(MetaCaptureCompletion)completion {
  self = [super init];
  if (self == nil) return nil;
  _request = *request;
  _caption = [(__bridge NSString *)request->caption copy] ?: @"";
  _request.caption = NULL;
  _resultStorage = MetaAllocateResult();
  if (_resultStorage == NULL) return nil;
  _statusLock = OS_UNFAIR_LOCK_INIT;
  _taskStatus = (MetaCaptureTaskStatus){
    .revision = 1,
    .completionDelivered = false,
    .stopRequested = false,
    .stopCallInFlight = false,
    .stopAttemptCount = 0,
    .startPending = true,
    .streamStarted = false,
    .streamStopped = false,
    .encodingInFlight = false,
    .cleanup = MetaCaptureCleanupPending,
    .drained = false
  };
  _stateQueue = dispatch_queue_create("com.meta.capture.state", DISPATCH_QUEUE_SERIAL);
  _sampleQueue = dispatch_queue_create("com.meta.capture.samples", DISPATCH_QUEUE_SERIAL);
  _encodeQueue = dispatch_queue_create("com.meta.capture.encode", DISPATCH_QUEUE_SERIAL);
  _callbackQueue = callbackQueue ?: dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
  _completion = [completion copy];
  _displays = @[];
  _frameStatus = -1;
  return self;
}

- (void)dealloc {
  if (_resultStorage != NULL) free(_resultStorage);
}

- (void)refreshTaskStatus {
  MetaCaptureCleanup cleanup = MetaCaptureCleanupPending;
  bool systemResourceStopped = _stream == nil || _streamStopped;
  bool drained = _completionDelivered && systemResourceStopped && !_encodingInFlight;
  if (drained) {
    cleanup = MetaCaptureCleanupComplete;
  } else if (_completionDelivered) {
    cleanup = MetaCaptureCleanupUnknown;
  }

  os_unfair_lock_lock(&_statusLock);
  _taskStatus = (MetaCaptureTaskStatus){
    .revision = _taskStatus.revision + 1,
    .completionDelivered = _completionDelivered,
    .stopRequested = _stopRequested,
    .stopCallInFlight = _stopCallInFlight,
    .stopAttemptCount = _stopAttemptCount,
    .startPending = !_streamStarted && !_streamStopped && _stream != nil,
    .streamStarted = _streamStarted,
    .streamStopped = _streamStopped,
    .encodingInFlight = _encodingInFlight,
    .cleanup = cleanup,
    .drained = drained
  };
  os_unfair_lock_unlock(&_statusLock);
}

- (bool)copyTaskStatus:(MetaCaptureTaskStatus *)status {
  if (status == NULL) return false;
  os_unfair_lock_lock(&_statusLock);
  *status = _taskStatus;
  os_unfair_lock_unlock(&_statusLock);
  return true;
}

- (nullable NSString *)validateRequest {
  if (_request.abiVersion != META_CAPTURE_ABI_VERSION) return @"Неподдерживаемая ABI-версия capture request";
  if (_caption.length == 0) return @"Caption обязателен до начала capture";
  if (_request.source != MetaCaptureSourceDisplayComposite
      && _request.source != MetaCaptureSourceWindowIsolated) {
    return @"Неизвестный capture source";
  }
  if (_request.source == MetaCaptureSourceDisplayComposite && _request.displayID == 0) {
    return @"Display composite требует точный displayID";
  }
  if (_request.source == MetaCaptureSourceWindowIsolated
      && (_request.windowID == 0 || _request.ownerPID <= 0)) {
    return @"Isolated window требует точные windowID и ownerPID";
  }
  if (_request.source == MetaCaptureSourceWindowIsolated && _request.hasRegion) {
    return @"Region неприменим к isolated window: SCStream захватывает окно целиком";
  }
  if (_request.hasRegion && !MetaRectIsFinitePositive(_request.regionPoints)) {
    return @"Capture region должен быть конечным прямоугольником положительного размера";
  }
  if (!isfinite(_request.outputScale)
      || _request.outputScale <= 0
      || _request.outputScale > 1) {
    return @"outputScale должен быть в диапазоне (0, 1]";
  }
  if (_request.captureTimeoutMilliseconds == 0
      || _request.stopTimeoutMilliseconds == 0
      || _request.maxFrameAgeMilliseconds == 0
      || _request.maxPixels == 0
      || _request.maxEncodedBytes == 0
      || _request.maxEncodedBytes > SIZE_MAX) {
    return @"Capture budgets должны быть положительными и помещаться в адресное пространство";
  }
  return nil;
}

- (void)begin {
  NSString *validation = [self validateRequest];
  if (validation != nil) {
    [self finishWithoutStream:MetaCaptureOutcomeFailed
                    errorCode:MetaCaptureErrorInvalidRequest
                      message:validation];
    return;
  }
  if (!meta_capture_preflight_screen_recording()) {
    [self finishWithoutStream:MetaCaptureOutcomeFailed
                    errorCode:MetaCaptureErrorPermissionDenied
                      message:@"Screen Recording не выдан процессу native capture"];
    return;
  }

  _startedAtMachAbsolute = mach_absolute_time();
  [self armCaptureTimer];
  __weak MetaCaptureSession *weakSelf = self;
  [SCShareableContent
    getShareableContentExcludingDesktopWindows:NO
    onScreenWindowsOnly:NO
    completionHandler:^(SCShareableContent *content, NSError *error) {
      MetaCaptureSession *session = weakSelf;
      if (session == nil) return;
      dispatch_async(session.stateQueue, ^{
        [session receivedShareableContent:content error:error];
      });
    }
  ];
}

- (void)armCaptureTimer {
  dispatch_source_t timer = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_TIMER,
    0,
    0,
    _stateQueue
  );
  uint64_t timeout = (uint64_t)_request.captureTimeoutMilliseconds * NSEC_PER_MSEC;
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, timeout), DISPATCH_TIME_FOREVER, 0);
  __weak MetaCaptureSession *weakSelf = self;
  dispatch_source_set_event_handler(timer, ^{
    [weakSelf captureTimedOut];
  });
  dispatch_resume(timer);
  _captureTimer = timer;
}

- (void)captureTimedOut {
  if (_completionDelivered || _stopRequested) return;
  [self finish:MetaCaptureOutcomeTimedOut
        errorCode:MetaCaptureErrorTimedOut
          message:@"Не получен свежий complete SCStream frame до capture deadline"];
}

- (void)receivedShareableContent:(SCShareableContent *)content error:(NSError *)error {
  if (_completionDelivered || _stopRequested) return;
  if (_cancelled) {
    [self finishWithoutStream:MetaCaptureOutcomeCancelled
                    errorCode:MetaCaptureErrorCancelled
                      message:@"Capture отменён до создания SCStream"];
    return;
  }
  if (error != nil || content == nil) {
    [self finishWithoutStream:MetaCaptureOutcomeFailed
                    errorCode:MetaCaptureErrorTargetUnavailable
                      message:error.localizedDescription ?: @"SCShareableContent недоступен"];
    return;
  }

  _displays = [content.displays copy];
  SCContentFilter *filter = nil;
  if (_request.source == MetaCaptureSourceDisplayComposite) {
    NSArray<SCDisplay *> *matches = [content.displays filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(SCDisplay *candidate, NSDictionary *bindings) {
        (void)bindings;
        return candidate.displayID == self.request.displayID;
      }]
    ];
    if (matches.count != 1) {
      [self finishWithoutStream:MetaCaptureOutcomeFailed
                      errorCode:MetaCaptureErrorTargetUnavailable
                        message:@"Точный displayID отсутствует в SCShareableContent"];
      return;
    }
    _display = matches.firstObject;
    CGRect available = _display.frame;
    _destinationBounds = _request.hasRegion
      ? MetaIntersection(_request.regionPoints, available)
      : available;
    if (!MetaRectIsFinitePositive(_destinationBounds)
        || (_request.hasRegion && !CGRectContainsRect(available, _request.regionPoints))) {
      [self finishWithoutStream:MetaCaptureOutcomeFailed
                      errorCode:MetaCaptureErrorInvalidRequest
                        message:@"Display region должен целиком принадлежать выбранному display"];
      return;
    }
    filter = [[SCContentFilter alloc] initWithDisplay:_display excludingWindows:@[]];
  } else {
    NSArray<SCWindow *> *matches = [content.windows filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(SCWindow *candidate, NSDictionary *bindings) {
        (void)bindings;
        return candidate.windowID == self.request.windowID
          && candidate.owningApplication.processID == self.request.ownerPID;
      }]
    ];
    if (matches.count != 1) {
      [self finishWithoutStream:MetaCaptureOutcomeFailed
                      errorCode:MetaCaptureErrorTargetUnavailable
                        message:@"Точная пара windowID/ownerPID отсутствует в SCShareableContent"];
      return;
    }
    _window = matches.firstObject;
    _destinationBounds = _window.frame;
    MetaWindowEvidence before = MetaReadWindowEvidence(_request.windowID, _request.ownerPID);
    _beforeMatched = before.matched;
    _beforeBounds = before.bounds;
    filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:_window];
  }

  SCStreamConfiguration *configuration = [SCStreamConfiguration new];
  double scaleX = 1;
  double scaleY = 1;
  if (_display != nil) {
    scaleX = MetaDisplayScaleX(_display);
    scaleY = MetaDisplayScaleY(_display);
  } else {
    double scale = MetaMaximumScaleForWindow(_destinationBounds, _displays);
    scaleX = scale;
    scaleY = scale;
  }
  size_t width = (size_t)ceil(_destinationBounds.size.width * scaleX * _request.outputScale);
  size_t height = (size_t)ceil(_destinationBounds.size.height * scaleY * _request.outputScale);
  if (!meta_capture_dimensions_fit_budget(width, height, _request.maxPixels)) {
    [self finishWithoutStream:MetaCaptureOutcomeFailed
                    errorCode:MetaCaptureErrorBudgetExceeded
                      message:@"Output dimensions превышают maxPixels до создания SCStream"];
    return;
  }

  configuration.width = width;
  configuration.height = height;
  configuration.minimumFrameInterval = CMTimeMake(1, 60);
  configuration.pixelFormat = kCVPixelFormatType_32BGRA;
  configuration.queueDepth = 1;
  configuration.showsCursor = _request.showsCursor;
  configuration.scalesToFit = YES;
  if (_display != nil && _request.hasRegion) {
    configuration.sourceRect = CGRectOffset(
      _request.regionPoints,
      -_display.frame.origin.x,
      -_display.frame.origin.y
    );
  }

  _stream = (id<MetaCaptureStreamHandle>)[[SCStream alloc]
    initWithFilter:filter
    configuration:configuration
    delegate:self
  ];
  [self refreshTaskStatus];
  NSError *addError = nil;
  if (![_stream addStreamOutput:self
                           type:SCStreamOutputTypeScreen
             sampleHandlerQueue:_sampleQueue
                          error:&addError]) {
    _stream = nil;
    [self finishWithoutStream:MetaCaptureOutcomeFailed
                    errorCode:MetaCaptureErrorStreamFailed
                      message:addError.localizedDescription ?: @"Не удалось добавить SCStream output"];
    return;
  }

  __weak MetaCaptureSession *weakSelf = self;
  [_stream startCaptureWithCompletionHandler:^(NSError *startError) {
    MetaCaptureSession *session = weakSelf;
    if (session == nil) return;
    dispatch_async(session.stateQueue, ^{
      [session captureStarted:startError];
    });
  }];
}

- (void)captureStarted:(NSError *)error {
  if (_completionDelivered && !_retainedForUnknownCleanup) return;
  if (error != nil) {
    [_stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
    _stream = nil;
    _streamStopped = true;
    _stopCallInFlight = false;
    if (!_stopRequested) {
      _pendingOutcome = MetaCaptureOutcomeFailed;
      _pendingErrorCode = MetaCaptureErrorStreamFailed;
      _pendingErrorMessage = [error.localizedDescription copy];
      _stopRequested = true;
    }
    [self finalizeStoppedResourceIfPossible];
    return;
  }
  _streamStarted = true;
  [self refreshTaskStatus];
  if (_stopRequested && !_streamStopped) {
    [self requestStopAttempt];
  } else if (_cancelled) {
    [self finish:MetaCaptureOutcomeCancelled
          errorCode:MetaCaptureErrorCancelled
            message:@"Capture отменён после старта SCStream"];
  }
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
    ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeScreen) return;
  CFRetain(sampleBuffer);
  __weak MetaCaptureSession *weakSelf = self;
  dispatch_async(_stateQueue, ^{
    MetaCaptureSession *session = weakSelf;
    if (session != nil) [session considerSampleBuffer:sampleBuffer];
    CFRelease(sampleBuffer);
  });
}

- (void)considerSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_completionDelivered || _stopRequested || _acceptedFrame || _cancelled) return;

  bool sampleValid = CMSampleBufferIsValid(sampleBuffer);
  bool dataReady = CMSampleBufferDataIsReady(sampleBuffer);
  CFArrayRef rawAttachments = sampleValid
    ? CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false)
    : NULL;
  NSDictionary *attachments = nil;
  if (rawAttachments != NULL && CFArrayGetCount(rawAttachments) > 0) {
    id first = (__bridge id)CFArrayGetValueAtIndex(rawAttachments, 0);
    if ([first isKindOfClass:[NSDictionary class]]) attachments = first;
  }
  NSNumber *statusValue = attachments == nil
    ? nil
    : MetaNumberAttachment(attachments, SCStreamFrameInfoStatus);
  int32_t status = statusValue == nil ? -1 : statusValue.intValue;

  if (!meta_capture_frame_is_complete(sampleValid, dataReady, status)) {
    if (status >= 0 && status < 6) {
      _skippedFrameCounts[status] += 1;
    } else {
      _invalidFrameCount += 1;
    }
    return;
  }

  CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (imageBuffer == NULL || attachments == nil) {
    _invalidFrameCount += 1;
    return;
  }
  size_t width = CVPixelBufferGetWidth(imageBuffer);
  size_t height = CVPixelBufferGetHeight(imageBuffer);
  if (!meta_capture_dimensions_fit_budget(width, height, _request.maxPixels)) {
    [self finish:MetaCaptureOutcomeFailed
          errorCode:MetaCaptureErrorBudgetExceeded
            message:@"Фактический frame превышает maxPixels до PNG encoding"];
    return;
  }

  NSNumber *displayTimeValue = MetaNumberAttachment(attachments, SCStreamFrameInfoDisplayTime);
  uint64_t displayTime = displayTimeValue.unsignedLongLongValue;
  uint64_t nowMach = mach_absolute_time();
  if (displayTime == 0 || displayTime > nowMach) {
    _invalidFrameCount += 1;
    return;
  }
  uint64_t ageNanoseconds = MetaMachDurationNanoseconds(nowMach - displayTime);
  uint64_t maxAgeNanoseconds = (uint64_t)_request.maxFrameAgeMilliseconds * NSEC_PER_MSEC;
  if (ageNanoseconds > maxAgeNanoseconds) {
    _skippedFrameCounts[SCFrameStatusComplete] += 1;
    return;
  }

  _acceptedFrame = true;
  _imageWidth = width;
  _imageHeight = height;
  _frameDisplayTime = displayTime;
  _frameTimestampUnixNanoseconds = MetaUnixNanosecondsForDisplayTime(displayTime);
  _frameStatus = status;
  _hasContentRect = MetaRectAttachment(attachments, SCStreamFrameInfoContentRect, &_contentRect);
  if (@available(macOS 13.1, *)) {
    _hasScreenRect = MetaRectAttachment(attachments, SCStreamFrameInfoScreenRect, &_screenRect);
  }
  NSNumber *contentScale = MetaNumberAttachment(attachments, SCStreamFrameInfoContentScale);
  NSNumber *scaleFactor = MetaNumberAttachment(attachments, SCStreamFrameInfoScaleFactor);
  _hasContentScale = contentScale != nil;
  _contentScale = contentScale.doubleValue;
  _hasScaleFactor = scaleFactor != nil;
  _scaleFactor = scaleFactor.doubleValue;

  _encodingInFlight = true;
  [self refreshTaskStatus];
  CVPixelBufferRef retainedBuffer = CVPixelBufferRetain(imageBuffer);
  uint64_t maximumEncodedBytes = _request.maxEncodedBytes;
  __weak MetaCaptureSession *weakSelf = self;
  dispatch_async(_encodeQueue, ^{
    MetaCaptureErrorCode errorCode = MetaCaptureErrorNone;
    NSString *errorMessage = nil;
    NSData *png = MetaEncodePng(
      retainedBuffer,
      maximumEncodedBytes,
      &errorCode,
      &errorMessage
    );
    CVPixelBufferRelease(retainedBuffer);
    MetaCaptureSession *session = weakSelf;
    if (session == nil) return;
    dispatch_async(session.stateQueue, ^{
      [session encodedPng:png errorCode:errorCode message:errorMessage];
    });
  });
}

- (void)encodedPng:(NSData *)png
          errorCode:(MetaCaptureErrorCode)errorCode
            message:(NSString *)message {
  _encodingInFlight = false;
  [self refreshTaskStatus];
  if (_completionDelivered || _stopRequested || _cancelled) {
    [self finalizeStoppedResourceIfPossible];
    return;
  }
  if (png == nil) {
    [self finish:MetaCaptureOutcomeFailed errorCode:errorCode message:message];
    return;
  }

  _pngData = png;
  if (_request.source == MetaCaptureSourceWindowIsolated) {
    MetaWindowEvidence after = MetaReadWindowEvidence(_request.windowID, _request.ownerPID);
    _afterMatched = after.matched;
    _afterBounds = after.bounds;
    if (_beforeMatched && _afterMatched && !MetaRectsEqual(_beforeBounds, _afterBounds)) {
      [self finish:MetaCaptureOutcomeFailed
            errorCode:MetaCaptureErrorTargetChanged
              message:@"Окно переместилось или изменило размер во время capture"];
      return;
    }
    if (_beforeMatched && !_afterMatched) {
      [self finish:MetaCaptureOutcomeFailed
            errorCode:MetaCaptureErrorTargetChanged
              message:@"Точная пара windowID/ownerPID исчезла во время capture"];
      return;
    }
  }

  [self finish:MetaCaptureOutcomeSucceeded errorCode:MetaCaptureErrorNone message:nil];
}

- (void)cancel {
  dispatch_async(_stateQueue, ^{
    if (self.completionDelivered || self.stopRequested) return;
    self.cancelled = true;
    if (self.stream == nil) {
      [self finishWithoutStream:MetaCaptureOutcomeCancelled
                      errorCode:MetaCaptureErrorCancelled
                        message:@"Capture отменён до создания SCStream"];
    } else {
      [self finish:MetaCaptureOutcomeCancelled
            errorCode:MetaCaptureErrorCancelled
              message:@"Capture отменён"];
    }
  });
}

- (void)finish:(MetaCaptureOutcome)outcome
      errorCode:(MetaCaptureErrorCode)errorCode
        message:(NSString *)message {
  if (_completionDelivered || _stopRequested) return;
  _pendingOutcome = outcome;
  _pendingErrorCode = errorCode;
  _pendingErrorMessage = [message copy];
  [self cancelCaptureTimer];
  if (_stream == nil) {
    [self finishWithoutStream:outcome errorCode:errorCode message:message];
    return;
  }
  [self beginStop];
}

- (void)finishWithoutStream:(MetaCaptureOutcome)outcome
                   errorCode:(MetaCaptureErrorCode)errorCode
                     message:(NSString *)message {
  if (_completionDelivered) return;
  _pendingOutcome = outcome;
  _pendingErrorCode = errorCode;
  _pendingErrorMessage = [message copy];
  _stopRequested = true;
  _streamStopped = true;
  _stopCallInFlight = false;
  [self cancelCaptureTimer];
  [self deliverWithCleanup:MetaCaptureCleanupComplete];
  MetaReleaseActiveSession(self);
}

- (void)beginStop {
  if (_stopRequested || _stream == nil) return;
  _stopRequested = true;
  [self refreshTaskStatus];
  [self requestStopAttempt];
}

- (void)requestStopAttempt {
  if (_stream == nil || _streamStopped || _stopCallInFlight || _stopAttemptCount >= 2) return;
  _stopCallInFlight = true;
  _stopAttemptCount += 1;
  [self refreshTaskStatus];
  dispatch_source_t timer = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_TIMER,
    0,
    0,
    _stateQueue
  );
  uint64_t timeout = (uint64_t)_request.stopTimeoutMilliseconds * NSEC_PER_MSEC;
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, timeout), DISPATCH_TIME_FOREVER, 0);
  __weak MetaCaptureSession *weakSelf = self;
  dispatch_source_set_event_handler(timer, ^{
    [weakSelf stopTimedOut];
  });
  dispatch_resume(timer);
  _stopTimer = timer;

  [_stream stopCaptureWithCompletionHandler:^(NSError *error) {
    MetaCaptureSession *session = weakSelf;
    if (session == nil) return;
    dispatch_async(session.stateQueue, ^{
      [session stoppedWithError:error];
    });
  }];
}

- (void)stopTimedOut {
  _stopCallInFlight = false;
  _retainedForUnknownCleanup = true;
  [self cancelStopTimer];
  if (!_completionDelivered) [self deliverWithCleanup:MetaCaptureCleanupUnknown];
  [self refreshTaskStatus];
}

- (void)stoppedWithError:(NSError *)error {
  _stopCallInFlight = false;
  if (error == nil) {
    [_stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
    _stream = nil;
    _streamStopped = true;
    [self finalizeStoppedResourceIfPossible];
    return;
  }

  [self cancelStopTimer];
  _retainedForUnknownCleanup = true;
  if (!_completionDelivered) [self deliverWithCleanup:MetaCaptureCleanupUnknown];
  [self refreshTaskStatus];
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  __weak MetaCaptureSession *weakSelf = self;
  dispatch_async(_stateQueue, ^{
    MetaCaptureSession *session = weakSelf;
    if (session == nil) return;
    session.stopCallInFlight = false;
    session.streamStopped = true;
    if (!session.stopRequested) {
      session.stopRequested = true;
      session.pendingOutcome = MetaCaptureOutcomeFailed;
      session.pendingErrorCode = MetaCaptureErrorStreamFailed;
      session.pendingErrorMessage = error.localizedDescription;
    }
    session.stream = nil;
    [session finalizeStoppedResourceIfPossible];
  });
}

- (void)finalizeStoppedResourceIfPossible {
  if (!_streamStopped || _encodingInFlight) {
    [self refreshTaskStatus];
    return;
  }
  [self cancelStopTimer];
  if (!_completionDelivered) [self deliverWithCleanup:MetaCaptureCleanupComplete];
  _retainedForUnknownCleanup = false;
  [self refreshTaskStatus];
  MetaReleaseActiveSession(self);
}

- (void)deliverWithCleanup:(MetaCaptureCleanup)cleanup {
  if (_completionDelivered) return;
  [self cancelCaptureTimer];

  MetaCaptureResult *result = _resultStorage;
  NSCAssert(result != NULL, @"Result storage резервируется до meta_capture_start");
  if (result == NULL) return;
  _resultStorage = NULL;
  _completionDelivered = true;
  result->outcome = _pendingOutcome;
  result->cleanup = cleanup;
  result->errorCode = _pendingErrorCode;
  result->source = _request.source;
  result->caption = CFRetain((__bridge CFStringRef)_caption);
  if (_pendingErrorMessage != nil) {
    result->errorMessage = CFRetain((__bridge CFStringRef)_pendingErrorMessage);
  }
  if (_pngData != nil && _pendingOutcome == MetaCaptureOutcomeSucceeded) {
    result->pngData = CFRetain((__bridge CFDataRef)_pngData);
    result->encodedBytes = _pngData.length;
  }
  result->imageWidthPixels = (uint32_t)MIN(_imageWidth, UINT32_MAX);
  result->imageHeightPixels = (uint32_t)MIN(_imageHeight, UINT32_MAX);
  result->capturedAtUnixNanoseconds = _frameTimestampUnixNanoseconds;
  result->frameDisplayTimeMachAbsolute = _frameDisplayTime;
  result->frameStatus = _frameStatus;
  result->contentRectPoints = _contentRect;
  result->hasContentRect = _hasContentRect;
  result->screenRectPoints = _screenRect;
  result->hasScreenRect = _hasScreenRect;
  result->contentScale = _contentScale;
  result->hasContentScale = _hasContentScale;
  result->scaleFactor = _scaleFactor;
  result->hasScaleFactor = _hasScaleFactor;
  result->requestedDisplayID = _request.displayID;
  result->requestedWindowID = _request.windowID;
  result->requestedOwnerPID = _request.ownerPID;
  result->shareableTargetMatched = _display != nil || _window != nil;
  result->beforeTargetMatched = _beforeMatched;
  result->afterTargetMatched = _afterMatched;
  result->beforeBoundsPoints = _beforeBounds;
  result->afterBoundsPoints = _afterBounds;
  result->boundsUnchanged = _beforeMatched
    && _afterMatched
    && MetaRectsEqual(_beforeBounds, _afterBounds);
  result->auxiliarySurfacesExcluded = _request.source == MetaCaptureSourceWindowIsolated;
  memcpy(result->skippedFrameCounts, _skippedFrameCounts, sizeof(_skippedFrameCounts));
  result->invalidFrameCount = _invalidFrameCount;

  if (_pendingOutcome == MetaCaptureOutcomeSucceeded) {
    CGRect contentPixels = MetaContentPixelRect(
      _contentRect,
      _hasContentRect,
      _scaleFactor,
      _hasScaleFactor,
      _imageWidth,
      _imageHeight
    );
    result->regions = MetaBuildRegions(
      _destinationBounds,
      contentPixels,
      _displays,
      _frameDisplayTime,
      _frameTimestampUnixNanoseconds,
      &result->regionCount
    );
  }

  MetaCaptureCompletion completion = _completion;
  [self refreshTaskStatus];
  dispatch_async(_callbackQueue, ^{
    completion(result);
  });
}

- (void)cancelCaptureTimer {
  if (_captureTimer == nil) return;
  dispatch_source_cancel(_captureTimer);
  _captureTimer = nil;
}

- (void)cancelStopTimer {
  if (_stopTimer == nil) return;
  dispatch_source_cancel(_stopTimer);
  _stopTimer = nil;
}

@end

MetaCaptureRequest meta_capture_request_default(void) {
  return (MetaCaptureRequest){
    .abiVersion = META_CAPTURE_ABI_VERSION,
    .source = MetaCaptureSourceDisplayComposite,
    .displayID = 0,
    .windowID = 0,
    .ownerPID = 0,
    .hasRegion = false,
    .regionPoints = CGRectZero,
    .outputScale = 1,
    .showsCursor = false,
    .captureTimeoutMilliseconds = META_CAPTURE_DEFAULT_TIMEOUT_MS,
    .stopTimeoutMilliseconds = META_CAPTURE_DEFAULT_STOP_TIMEOUT_MS,
    .maxFrameAgeMilliseconds = META_CAPTURE_DEFAULT_MAX_FRAME_AGE_MS,
    .maxPixels = META_CAPTURE_DEFAULT_MAX_PIXELS,
    .maxEncodedBytes = META_CAPTURE_DEFAULT_MAX_ENCODED_BYTES,
    .caption = NULL
  };
}

bool meta_capture_preflight_screen_recording(void) {
  return CGPreflightScreenCaptureAccess();
}

MetaCaptureTaskRef meta_capture_start(
  const MetaCaptureRequest *request,
  dispatch_queue_t callbackQueue,
  MetaCaptureCompletion completion
) {
  if (request == NULL || completion == nil) return NULL;
  MetaCaptureSession *session = [[MetaCaptureSession alloc]
    initWithRequest:request
    callbackQueue:callbackQueue
    completion:completion
  ];
  if (session == nil) return NULL;
  MetaRetainActiveSession(session);
  dispatch_async(session.stateQueue, ^{
    [session begin];
  });
  return (__bridge_retained void *)session;
}

void meta_capture_cancel(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  [session cancel];
}

void meta_capture_task_release(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  CFRelease(task);
}

bool meta_capture_task_status(
  MetaCaptureTaskRef task,
  MetaCaptureTaskStatus *status
) {
  if (task == NULL || status == NULL) return false;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  return [session copyTaskStatus:status];
}

void meta_capture_result_release(MetaCaptureResult *result) {
  if (result == NULL) return;
  if (result->caption != NULL) CFRelease(result->caption);
  if (result->errorMessage != NULL) CFRelease(result->errorMessage);
  if (result->pngData != NULL) CFRelease(result->pngData);
  free(result->regions);
  free(result);
}

static MetaCaptureResult *MetaCaptureLayoutError(
  const MetaCaptureLayoutRequest *request,
  MetaCaptureErrorCode code,
  NSString *message,
  MetaCaptureCleanup cleanup
) {
  MetaCaptureResult *result = MetaAllocateResult();
  if (result == NULL) return NULL;
  result->outcome = MetaCaptureOutcomeFailed;
  result->cleanup = cleanup;
  result->errorCode = code;
  result->source = MetaCaptureSourceDisplayComposite;
  if (request != NULL && request->caption != NULL) {
    result->caption = CFRetain(request->caption);
  }
  result->errorMessage = CFRetain((__bridge CFStringRef)message);
  result->frameStatus = -1;
  return result;
}

MetaCaptureResult *meta_capture_compose_layout(
  const MetaCaptureLayoutRequest *request
) {
  if (request == NULL
      || request->frames == NULL
      || request->frameCount == 0
      || request->frameCount > 64
      || request->caption == NULL
      || CFStringGetLength(request->caption) == 0
      || !isfinite(request->outputScale)
      || request->outputScale <= 0
      || request->outputScale > 1
      || request->maxWidthPixels == 0
      || request->maxHeightPixels == 0
      || request->maxPixels == 0
      || request->maxEncodedBytes == 0
      || request->maxEncodedBytes > SIZE_MAX) {
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorInvalidRequest,
      @"Некорректный layout composition request",
      MetaCaptureCleanupComplete
    );
  }

  CGRect layoutBounds = CGRectNull;
  double maximumBackingScale = 1;
  MetaCaptureCleanup cleanup = MetaCaptureCleanupComplete;
  uint64_t capturedAt = 0;
  uint64_t displayTime = 0;
  bool shareableTargetsMatched = true;
  for (size_t index = 0; index < request->frameCount; index += 1) {
    const MetaCaptureResult *frame = request->frames[index];
    if (frame == NULL || frame->cleanup != MetaCaptureCleanupComplete) {
      cleanup = MetaCaptureCleanupUnknown;
    }
  }
  for (size_t index = 0; index < request->frameCount; index += 1) {
    const MetaCaptureResult *frame = request->frames[index];
    if (frame == NULL
        || frame->outcome != MetaCaptureOutcomeSucceeded
        || frame->source != MetaCaptureSourceDisplayComposite
        || frame->pngData == NULL
        || frame->frameStatus != SCFrameStatusComplete
        || frame->regionCount != 1
        || frame->regions == NULL
        || frame->regions[0].frameOrientation != MetaCaptureFrameOrientationDisplayOriented
        || !MetaRectIsFinitePositive(frame->regions[0].destinationRectPoints)) {
      return MetaCaptureLayoutError(
        request,
        MetaCaptureErrorFrameUnavailable,
        @"Layout принимает только complete per-display frames",
        cleanup
      );
    }
    if (frame->caption == NULL || CFStringCompare(frame->caption, request->caption, 0) != kCFCompareEqualTo) {
      return MetaCaptureLayoutError(
        request,
        MetaCaptureErrorInvalidRequest,
        @"Per-display frame потерял layout caption",
        cleanup
      );
    }
    const MetaCaptureDisplayRegion *region = &frame->regions[0];
    layoutBounds = CGRectIsNull(layoutBounds)
      ? region->destinationRectPoints
      : CGRectUnion(layoutBounds, region->destinationRectPoints);
    maximumBackingScale = MAX(
      maximumBackingScale,
      MAX(region->backingScaleX, region->backingScaleY)
    );
    capturedAt = MAX(capturedAt, frame->capturedAtUnixNanoseconds);
    displayTime = MAX(displayTime, frame->frameDisplayTimeMachAbsolute);
    shareableTargetsMatched = shareableTargetsMatched && frame->shareableTargetMatched;
  }

  double pixelsPerPoint = maximumBackingScale * request->outputScale;
  if (!MetaRectIsFinitePositive(layoutBounds)
      || !isfinite(pixelsPerPoint)
      || pixelsPerPoint <= 0) {
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorInvalidRequest,
      @"Layout bounds или backing scale некорректны",
      cleanup
    );
  }
  size_t width = (size_t)ceil(layoutBounds.size.width * pixelsPerPoint);
  size_t height = (size_t)ceil(layoutBounds.size.height * pixelsPerPoint);
  if (width > request->maxWidthPixels
      || height > request->maxHeightPixels
      || !meta_capture_dimensions_fit_budget(width, height, request->maxPixels)) {
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorBudgetExceeded,
      @"Layout dimensions превышают budget до bitmap allocation",
      cleanup
    );
  }

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef bitmap = colorSpace == NULL
    ? NULL
    : CGBitmapContextCreate(
        NULL,
        width,
        height,
        8,
        width * 4,
        colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
      );
  if (colorSpace != NULL) CGColorSpaceRelease(colorSpace);
  if (bitmap == NULL) {
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorEncodingFailed,
      @"Не удалось выделить bounded layout bitmap",
      cleanup
    );
  }

  MetaCaptureDisplayRegion *regions = calloc(
    request->frameCount,
    sizeof(MetaCaptureDisplayRegion)
  );
  if (regions == NULL) {
    CGContextRelease(bitmap);
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorEncodingFailed,
      @"Не удалось выделить layout regions",
      cleanup
    );
  }

  CGContextClearRect(bitmap, CGRectMake(0, 0, width, height));
  for (size_t index = 0; index < request->frameCount; index += 1) {
    const MetaCaptureResult *frame = request->frames[index];
    const MetaCaptureDisplayRegion *sourceRegion = &frame->regions[0];
    CGRect imageRect = CGRectMake(
      (sourceRegion->destinationRectPoints.origin.x - layoutBounds.origin.x) * pixelsPerPoint,
      (sourceRegion->destinationRectPoints.origin.y - layoutBounds.origin.y) * pixelsPerPoint,
      sourceRegion->destinationRectPoints.size.width * pixelsPerPoint,
      sourceRegion->destinationRectPoints.size.height * pixelsPerPoint
    );
    CGImageSourceRef source = CGImageSourceCreateWithData(frame->pngData, NULL);
    CGImageRef image = source == NULL ? NULL : CGImageSourceCreateImageAtIndex(source, 0, NULL);
    if (source != NULL) CFRelease(source);
    if (image == NULL) {
      free(regions);
      CGContextRelease(bitmap);
      return MetaCaptureLayoutError(
        request,
        MetaCaptureErrorEncodingFailed,
        @"Не удалось декодировать per-display PNG",
        cleanup
      );
    }
    // SCStream уже выдаёт frame в ориентации логического SCDisplay. Rotation
    // сохраняется как metadata и не применяется к пикселям compositor повторно.
    CGRect drawRect = imageRect;
    drawRect.origin.y = height - CGRectGetMaxY(imageRect);
    CGContextDrawImage(bitmap, drawRect, image);
    CGImageRelease(image);
    regions[index] = *sourceRegion;
    regions[index].imageRectPixels = imageRect;
    regions[index].imageToDestination = meta_capture_transform_between_rects(
      imageRect,
      sourceRegion->destinationRectPoints
    );
  }

  CGImageRef composedImage = CGBitmapContextCreateImage(bitmap);
  CGContextRelease(bitmap);
  if (composedImage == NULL) {
    free(regions);
    return MetaCaptureLayoutError(
      request,
      MetaCaptureErrorEncodingFailed,
      @"Не удалось получить layout CGImage",
      cleanup
    );
  }
  MetaCaptureErrorCode encodeError = MetaCaptureErrorNone;
  NSString *encodeMessage = nil;
  NSData *png = MetaEncodeCGImage(
    composedImage,
    request->maxEncodedBytes,
    &encodeError,
    &encodeMessage
  );
  CGImageRelease(composedImage);
  if (png == nil) {
    free(regions);
    return MetaCaptureLayoutError(
      request,
      encodeError,
      encodeMessage ?: @"Layout PNG encoding failed",
      cleanup
    );
  }

  MetaCaptureResult *result = MetaAllocateResult();
  if (result == NULL) {
    free(regions);
    return NULL;
  }
  result->outcome = MetaCaptureOutcomeSucceeded;
  result->cleanup = cleanup;
  result->errorCode = MetaCaptureErrorNone;
  result->source = MetaCaptureSourceDisplayComposite;
  result->caption = CFRetain(request->caption);
  result->pngData = CFRetain((__bridge CFDataRef)png);
  result->imageWidthPixels = (uint32_t)width;
  result->imageHeightPixels = (uint32_t)height;
  result->encodedBytes = png.length;
  result->capturedAtUnixNanoseconds = capturedAt;
  result->frameDisplayTimeMachAbsolute = displayTime;
  result->frameStatus = SCFrameStatusComplete;
  result->shareableTargetMatched = shareableTargetsMatched;
  result->regions = regions;
  result->regionCount = request->frameCount;
  for (size_t index = 0; index < request->frameCount; index += 1) {
    const MetaCaptureResult *frame = request->frames[index];
    for (size_t status = 0; status < 6; status += 1) {
      result->skippedFrameCounts[status] += frame->skippedFrameCounts[status];
    }
    result->invalidFrameCount += frame->invalidFrameCount;
  }
  return result;
}

bool meta_capture_dimensions_fit_budget(
  size_t widthPixels,
  size_t heightPixels,
  uint64_t maxPixels
) {
  if (widthPixels == 0 || heightPixels == 0 || maxPixels == 0) return false;
  if ((uint64_t)widthPixels > maxPixels / (uint64_t)heightPixels) return false;
  return (uint64_t)widthPixels * (uint64_t)heightPixels <= maxPixels;
}

MetaCaptureAffineTransform meta_capture_transform_between_rects(
  CGRect source,
  CGRect destination
) {
  if (!MetaRectIsFinitePositive(source) || !MetaRectIsFinitePositive(destination)) {
    return (MetaCaptureAffineTransform){0};
  }
  double scaleX = destination.size.width / source.size.width;
  double scaleY = destination.size.height / source.size.height;
  return (MetaCaptureAffineTransform){
    .a = scaleX,
    .b = 0,
    .c = 0,
    .d = scaleY,
    .tx = destination.origin.x - source.origin.x * scaleX,
    .ty = destination.origin.y - source.origin.y * scaleY
  };
}

CGPoint meta_capture_apply_transform(
  MetaCaptureAffineTransform transform,
  CGPoint point
) {
  return CGPointMake(
    transform.a * point.x + transform.c * point.y + transform.tx,
    transform.b * point.x + transform.d * point.y + transform.ty
  );
}

bool meta_capture_frame_is_complete(
  bool sampleIsValid,
  bool dataIsReady,
  int32_t frameStatus
) {
  return sampleIsValid && dataIsReady && frameStatus == SCFrameStatusComplete;
}

#if META_CAPTURE_TESTING
MetaCaptureTaskRef meta_capture_test_create_lifecycle_task(
  void *streamObject,
  bool encodingInFlight,
  dispatch_queue_t callbackQueue,
  MetaCaptureCompletion completion
) {
  if (streamObject == NULL || completion == nil) return NULL;
  MetaCaptureRequest request = meta_capture_request_default();
  request.caption = CFSTR("Fake lifecycle fixture");
  MetaCaptureSession *session = [[MetaCaptureSession alloc]
    initWithRequest:&request
    callbackQueue:callbackQueue
    completion:completion
  ];
  if (session == nil) return NULL;
  session.stream = (__bridge id<MetaCaptureStreamHandle>)streamObject;
  session.encodingInFlight = encodingInFlight;
  [session refreshTaskStatus];
  MetaRetainActiveSession(session);
  return (__bridge_retained void *)session;
}

void meta_capture_test_resolve_start(
  MetaCaptureTaskRef task,
  bool succeeded
) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  dispatch_sync(session.stateQueue, ^{
    NSError *error = succeeded
      ? nil
      : [NSError errorWithDomain:@"MetaCaptureFixture" code:1 userInfo:nil];
    [session captureStarted:error];
  });
}

void meta_capture_test_finish_encoding(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  dispatch_sync(session.stateQueue, ^{
    session.encodingInFlight = false;
    [session finalizeStoppedResourceIfPossible];
  });
}

void meta_capture_test_fire_capture_timeout(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  dispatch_sync(session.stateQueue, ^{
    [session captureTimedOut];
  });
}

void meta_capture_test_fire_stop_timeout(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  dispatch_sync(session.stateQueue, ^{
    [session stopTimedOut];
  });
}

void meta_capture_test_fail_next_result_allocation(void) {
  MetaFailNextResultAllocation = true;
}

void meta_capture_test_sync(MetaCaptureTaskRef task) {
  if (task == NULL) return;
  MetaCaptureSession *session = (__bridge MetaCaptureSession *)task;
  dispatch_sync(session.stateQueue, ^{});
}
#endif
