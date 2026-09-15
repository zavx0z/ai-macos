#ifndef META_CAPTURE_H
#define META_CAPTURE_H

#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <dispatch/dispatch.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define META_CAPTURE_ABI_VERSION 1
#define META_CAPTURE_DEFAULT_TIMEOUT_MS 10000
#define META_CAPTURE_DEFAULT_STOP_TIMEOUT_MS 1000
#define META_CAPTURE_DEFAULT_MAX_FRAME_AGE_MS 2000
#define META_CAPTURE_DEFAULT_MAX_PIXELS 32000000ULL
#define META_CAPTURE_DEFAULT_MAX_ENCODED_BYTES (64ULL * 1024ULL * 1024ULL)

typedef CF_ENUM(int32_t, MetaCaptureSource) {
  MetaCaptureSourceDisplayComposite = 1,
  MetaCaptureSourceWindowIsolated = 2
};

typedef CF_ENUM(int32_t, MetaCaptureOutcome) {
  MetaCaptureOutcomeSucceeded = 1,
  MetaCaptureOutcomeFailed = 2,
  MetaCaptureOutcomeCancelled = 3,
  MetaCaptureOutcomeTimedOut = 4
};

typedef CF_ENUM(int32_t, MetaCaptureCleanup) {
  MetaCaptureCleanupPending = 0,
  MetaCaptureCleanupComplete = 1,
  MetaCaptureCleanupUnknown = 2
};

typedef CF_ENUM(int32_t, MetaCaptureErrorCode) {
  MetaCaptureErrorNone = 0,
  MetaCaptureErrorInvalidRequest = 1,
  MetaCaptureErrorPermissionDenied = 2,
  MetaCaptureErrorTargetUnavailable = 3,
  MetaCaptureErrorTargetChanged = 4,
  MetaCaptureErrorFrameUnavailable = 5,
  MetaCaptureErrorFrameStale = 6,
  MetaCaptureErrorBudgetExceeded = 7,
  MetaCaptureErrorEncodingFailed = 8,
  MetaCaptureErrorStreamFailed = 9,
  MetaCaptureErrorCancelled = 10,
  MetaCaptureErrorTimedOut = 11
};

typedef CF_ENUM(int32_t, MetaCaptureFrameOrientation) {
  MetaCaptureFrameOrientationDisplayOriented = 1
};

typedef struct {
  double a;
  double b;
  double c;
  double d;
  double tx;
  double ty;
} MetaCaptureAffineTransform;

typedef struct {
  uint32_t displayID;
  CGRect displayBoundsPoints;
  CGRect imageRectPixels;
  CGRect destinationRectPoints;
  MetaCaptureAffineTransform imageToDestination;
  double displayRotationDegrees;
  double backingScaleX;
  double backingScaleY;
  MetaCaptureFrameOrientation frameOrientation;
  uint64_t frameDisplayTimeMachAbsolute;
  uint64_t frameTimestampUnixNanoseconds;
} MetaCaptureDisplayRegion;

typedef struct {
  uint32_t abiVersion;
  MetaCaptureSource source;
  uint32_t displayID;
  uint32_t windowID;
  int32_t ownerPID;
  bool hasRegion;
  CGRect regionPoints;
  double outputScale;
  bool showsCursor;
  uint32_t captureTimeoutMilliseconds;
  uint32_t stopTimeoutMilliseconds;
  uint32_t maxFrameAgeMilliseconds;
  uint64_t maxPixels;
  uint64_t maxEncodedBytes;
  CFStringRef caption;
} MetaCaptureRequest;

typedef struct {
  MetaCaptureOutcome outcome;
  MetaCaptureCleanup cleanup;
  MetaCaptureErrorCode errorCode;
  MetaCaptureSource source;
  CFStringRef caption;
  CFStringRef errorMessage;
  CFDataRef pngData;
  uint32_t imageWidthPixels;
  uint32_t imageHeightPixels;
  uint64_t encodedBytes;
  uint64_t capturedAtUnixNanoseconds;
  uint64_t frameDisplayTimeMachAbsolute;
  int32_t frameStatus;
  CGRect contentRectPoints;
  bool hasContentRect;
  CGRect screenRectPoints;
  bool hasScreenRect;
  double contentScale;
  bool hasContentScale;
  double scaleFactor;
  bool hasScaleFactor;
  uint32_t requestedDisplayID;
  uint32_t requestedWindowID;
  int32_t requestedOwnerPID;
  bool shareableTargetMatched;
  bool beforeTargetMatched;
  bool afterTargetMatched;
  bool boundsUnchanged;
  CGRect beforeBoundsPoints;
  CGRect afterBoundsPoints;
  bool auxiliarySurfacesExcluded;
  uint32_t skippedFrameCounts[6];
  uint32_t invalidFrameCount;
  MetaCaptureDisplayRegion *regions;
  size_t regionCount;
} MetaCaptureResult;

typedef struct {
  const MetaCaptureResult *const *frames;
  size_t frameCount;
  CFStringRef caption;
  double outputScale;
  uint32_t maxWidthPixels;
  uint32_t maxHeightPixels;
  uint64_t maxPixels;
  uint64_t maxEncodedBytes;
} MetaCaptureLayoutRequest;

typedef const void *MetaCaptureTaskRef;

typedef struct {
  uint64_t revision;
  bool completionDelivered;
  bool stopRequested;
  bool stopCallInFlight;
  uint32_t stopAttemptCount;
  bool startPending;
  bool streamStarted;
  bool streamStopped;
  bool encodingInFlight;
  MetaCaptureCleanup cleanup;
  bool drained;
} MetaCaptureTaskStatus;

// Completion получает результат во владение и обязан вызвать
// meta_capture_result_release. Callback всегда вызывается не более одного раза.
typedef void (^MetaCaptureCompletion)(MetaCaptureResult *result);

// Заполняет безопасные лимиты и ABI-версию. Caption и target задаёт вызывающий код.
MetaCaptureRequest meta_capture_request_default(void);

// Только пассивная проверка. Функция никогда не открывает System Settings и не
// запрашивает разрешение Screen Recording.
bool meta_capture_preflight_screen_recording(void);

// Запускает асинхронный SCStream. Функция копирует request и caption до возврата.
// callbackQueue может быть NULL; тогда используется системная utility queue.
MetaCaptureTaskRef meta_capture_start(
  const MetaCaptureRequest *request,
  dispatch_queue_t callbackQueue,
  MetaCaptureCompletion completion
);

// Отмена прекращает ожидание следующих кадров. Уже начатое системное действие
// не откатывается; completion всё равно сообщает итог cleanup.
void meta_capture_cancel(MetaCaptureTaskRef task);

// Освобождает caller-owned ссылку на task. Незавершённый stream продолжает жить
// до подтверждённого stop; при stop timeout модуль сохраняет его как unknown.
void meta_capture_task_release(MetaCaptureTaskRef task);

// После completion с cleanup unknown вызывающий код сохраняет task и читает
// status до drained либо до внешнего recovery native generation. Поздний stop
// меняет revision/status, но не вызывает completion повторно.
bool meta_capture_task_status(
  MetaCaptureTaskRef task,
  MetaCaptureTaskStatus *status
);

void meta_capture_result_release(MetaCaptureResult *result);

// Объединяет уже завершённые per-display frames в один layout PNG без shell и
// без новых OS capture side effects. Result принадлежит вызывающему коду.
MetaCaptureResult *meta_capture_compose_layout(
  const MetaCaptureLayoutRequest *request
);

// Чистые функции для native fixture и адаптера координат.
bool meta_capture_dimensions_fit_budget(
  size_t widthPixels,
  size_t heightPixels,
  uint64_t maxPixels
);

MetaCaptureAffineTransform meta_capture_transform_between_rects(
  CGRect source,
  CGRect destination
);

CGPoint meta_capture_apply_transform(
  MetaCaptureAffineTransform transform,
  CGPoint point
);

bool meta_capture_frame_is_complete(
  bool sampleIsValid,
  bool dataIsReady,
  int32_t frameStatus
);

#ifdef __cplusplus
}
#endif

#endif
