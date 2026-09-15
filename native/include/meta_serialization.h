#ifndef META_SERIALIZATION_H
#define META_SERIALIZATION_H

#include <CoreFoundation/CoreFoundation.h>

#include "meta_native.h"
#include "../src/capture/meta_capture.h"

CFDataRef meta_inventory_copy_json(const MetaInventorySnapshot *snapshot,
                                   const char *source_response_ref);

typedef struct {
  char binary_token[META_NATIVE_REF_CAPACITY];
  char frame_ref[META_NATIVE_REF_CAPACITY];
  char sha256[65];
} MetaCaptureFrameSerializationContext;

CFDataRef meta_capture_frame_copy_json(
    const MetaCaptureResult *result,
    const MetaCaptureFrameSerializationContext *context);

#endif
