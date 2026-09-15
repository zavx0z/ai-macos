#ifndef META_CAPTURE_TESTING_H
#define META_CAPTURE_TESTING_H

#import "../meta_capture.h"

#if !META_CAPTURE_TESTING
#error "meta_capture_testing.h предназначен только для fake lifecycle fixture"
#endif

MetaCaptureTaskRef meta_capture_test_create_lifecycle_task(
  void *streamObject,
  bool encodingInFlight,
  dispatch_queue_t callbackQueue,
  MetaCaptureCompletion completion
);

void meta_capture_test_resolve_start(
  MetaCaptureTaskRef task,
  bool succeeded
);

void meta_capture_test_finish_encoding(MetaCaptureTaskRef task);
void meta_capture_test_fire_capture_timeout(MetaCaptureTaskRef task);
void meta_capture_test_fire_stop_timeout(MetaCaptureTaskRef task);
void meta_capture_test_fail_next_result_allocation(void);
void meta_capture_test_sync(MetaCaptureTaskRef task);

#endif
