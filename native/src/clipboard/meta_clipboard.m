#import <AppKit/AppKit.h>

#include "meta_clipboard.h"

#include <stdlib.h>
#include <string.h>

static bool system_change_count(void *context, int64_t *value) {
  (void)context;
  if (value == NULL) return false;
  @try {
    *value = (int64_t)NSPasteboard.generalPasteboard.changeCount;
    return *value >= 0;
  } @catch (__unused NSException *exception) {
    return false;
  }
}

static MetaClipboardBackendReadStatus system_read_utf8(
    void *context, size_t max_bytes, uint8_t **bytes, size_t *length) {
  (void)context;
  if (bytes == NULL || length == NULL || max_bytes == 0) {
    return META_CLIPBOARD_BACKEND_READ_FAILED;
  }
  *bytes = NULL;
  *length = 0;
  @try {
    NSString *text = [NSPasteboard.generalPasteboard
        stringForType:NSPasteboardTypeString];
    if (text == nil) return META_CLIPBOARD_BACKEND_READ_TEXT_UNAVAILABLE;
    const NSUInteger encoded_length =
        [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (encoded_length > max_bytes ||
        encoded_length > META_CLIPBOARD_MAX_UTF8_BYTES) {
      return META_CLIPBOARD_BACKEND_READ_PAYLOAD_TOO_LARGE;
    }
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    if (data == nil || data.length != encoded_length) {
      return META_CLIPBOARD_BACKEND_READ_FAILED;
    }
    uint8_t *copy = malloc(MAX((NSUInteger)1, data.length));
    if (copy == NULL) return META_CLIPBOARD_BACKEND_READ_FAILED;
    if (data.length > 0) memcpy(copy, data.bytes, data.length);
    *bytes = copy;
    *length = data.length;
    return META_CLIPBOARD_BACKEND_READ_OK;
  } @catch (__unused NSException *exception) {
    return META_CLIPBOARD_BACKEND_READ_FAILED;
  }
}

static void system_release_utf8(void *context, uint8_t *bytes,
                                size_t length) {
  (void)context;
  if (bytes != NULL && length > 0) memset(bytes, 0, length);
  free(bytes);
}

static bool system_clear_contents(void *context, int64_t *change_count) {
  (void)context;
  if (change_count == NULL) return false;
  @try {
    *change_count =
        (int64_t)[NSPasteboard.generalPasteboard clearContents];
    return *change_count >= 0;
  } @catch (__unused NSException *exception) {
    return false;
  }
}

static bool system_write_utf8(void *context, const uint8_t *bytes,
                              size_t length) {
  (void)context;
  if (bytes == NULL && length > 0) return false;
  @try {
    NSString *text = [[NSString alloc] initWithBytes:bytes
                                               length:length
                                             encoding:NSUTF8StringEncoding];
    if (text == nil) return false;
    return [NSPasteboard.generalPasteboard setString:text
                                             forType:NSPasteboardTypeString];
  } @catch (__unused NSException *exception) {
    return false;
  }
}

MetaClipboardBackend meta_clipboard_system_backend(void) {
  return (MetaClipboardBackend){
      .context = NULL,
      .change_count = system_change_count,
      .read_utf8 = system_read_utf8,
      .release_utf8 = system_release_utf8,
      .clear_contents = system_clear_contents,
      .write_utf8 = system_write_utf8,
  };
}

MetaClipboardVersionResult meta_clipboard_read_version(
    MetaClipboardBackend backend) {
  MetaClipboardVersionResult result = {
      .status = META_CLIPBOARD_BACKEND_UNAVAILABLE,
  };
  if (backend.change_count == NULL) {
    result.status = META_CLIPBOARD_INVALID_ARGUMENT;
    return result;
  }
  if (!backend.change_count(backend.context, &result.change_count)) {
    return result;
  }
  result.status = META_CLIPBOARD_OK;
  return result;
}

MetaClipboardReadResult meta_clipboard_read_text(
    MetaClipboardBackend backend, uint8_t *output, size_t capacity) {
  MetaClipboardReadResult result = {
      .status = META_CLIPBOARD_BACKEND_UNAVAILABLE,
  };
  if (backend.change_count == NULL || backend.read_utf8 == NULL ||
      backend.release_utf8 == NULL || output == NULL || capacity == 0) {
    result.status = META_CLIPBOARD_INVALID_ARGUMENT;
    return result;
  }
  if (!backend.change_count(backend.context, &result.before_change_count)) {
    return result;
  }

  uint8_t *bytes = NULL;
  size_t length = 0;
  const size_t read_limit =
      capacity < META_CLIPBOARD_MAX_UTF8_BYTES
          ? capacity
          : META_CLIPBOARD_MAX_UTF8_BYTES;
  const MetaClipboardBackendReadStatus backend_status =
      backend.read_utf8(backend.context, read_limit, &bytes, &length);
  if (backend_status == META_CLIPBOARD_BACKEND_READ_PAYLOAD_TOO_LARGE) {
    if (bytes != NULL) backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_PAYLOAD_TOO_LARGE;
    return result;
  }
  if (backend_status == META_CLIPBOARD_BACKEND_READ_FAILED) {
    if (bytes != NULL) backend.release_utf8(backend.context, bytes, length);
    return result;
  }
  if (!backend.change_count(backend.context, &result.after_change_count)) {
    if (bytes != NULL) backend.release_utf8(backend.context, bytes, length);
    return result;
  }
  if (result.after_change_count != result.before_change_count) {
    backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_CHANGED_DURING_READ;
    return result;
  }
  if (backend_status == META_CLIPBOARD_BACKEND_READ_TEXT_UNAVAILABLE) {
    if (bytes != NULL) backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_TEXT_UNAVAILABLE;
    return result;
  }
  if (backend_status != META_CLIPBOARD_BACKEND_READ_OK || bytes == NULL) {
    if (bytes != NULL) backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_BACKEND_UNAVAILABLE;
    return result;
  }
  if (length > META_CLIPBOARD_MAX_UTF8_BYTES || length > capacity) {
    backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_PAYLOAD_TOO_LARGE;
    return result;
  }
  NSString *validation = [[NSString alloc] initWithBytes:bytes
                                                  length:length
                                                encoding:NSUTF8StringEncoding];
  if (validation == nil) {
    backend.release_utf8(backend.context, bytes, length);
    result.status = META_CLIPBOARD_INVALID_UTF8;
    return result;
  }
  memcpy(output, bytes, length);
  backend.release_utf8(backend.context, bytes, length);
  result.status = META_CLIPBOARD_OK;
  result.utf8_bytes = length;
  return result;
}

MetaClipboardWriteResult meta_clipboard_write_text(
    MetaClipboardBackend backend, MetaClipboardWriteRequest request) {
  MetaClipboardWriteResult result = {
      .status = META_CLIPBOARD_BACKEND_UNAVAILABLE,
      .atomic_precondition = false,
      .utf8_bytes = request.length,
  };
  if (backend.change_count == NULL || backend.clear_contents == NULL ||
      backend.write_utf8 == NULL ||
      (request.bytes == NULL && request.length > 0) ||
      request.expected_change_count < 0) {
    result.status = META_CLIPBOARD_INVALID_ARGUMENT;
    return result;
  }
  if (request.length > META_CLIPBOARD_MAX_UTF8_BYTES) {
    result.status = META_CLIPBOARD_PAYLOAD_TOO_LARGE;
    return result;
  }
  NSString *validation = [[NSString alloc] initWithBytes:request.bytes
                                                  length:request.length
                                                encoding:NSUTF8StringEncoding];
  if (validation == nil) {
    result.status = META_CLIPBOARD_INVALID_UTF8;
    return result;
  }
  if (!backend.change_count(backend.context, &result.before_change_count)) {
    return result;
  }
  if (request.has_expected_change_count &&
      request.expected_change_count != result.before_change_count) {
    result.status = META_CLIPBOARD_PRECONDITION_MISMATCH;
    return result;
  }

  result.mutation_attempted = true;
  if (!backend.clear_contents(backend.context,
                              &result.declared_change_count)) {
    result.status = META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN;
    return result;
  }
  result.set_string_succeeded = backend.write_utf8(
      backend.context, request.bytes, request.length);
  if (!backend.change_count(backend.context, &result.after_change_count)) {
    result.status = META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN;
    return result;
  }
  result.ownership_stable_after_write =
      result.after_change_count == result.declared_change_count;
  if (!result.set_string_succeeded ||
      !result.ownership_stable_after_write) {
    result.status = META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN;
    return result;
  }
  result.status = META_CLIPBOARD_OK;
  return result;
}
