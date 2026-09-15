#ifndef META_CLIPBOARD_H
#define META_CLIPBOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define META_CLIPBOARD_MAX_UTF8_BYTES 1000000

typedef enum {
  META_CLIPBOARD_OK,
  META_CLIPBOARD_PRECONDITION_MISMATCH,
  META_CLIPBOARD_CHANGED_DURING_READ,
  META_CLIPBOARD_TEXT_UNAVAILABLE,
  META_CLIPBOARD_PAYLOAD_TOO_LARGE,
  META_CLIPBOARD_INVALID_UTF8,
  META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN,
  META_CLIPBOARD_BACKEND_UNAVAILABLE,
  META_CLIPBOARD_INVALID_ARGUMENT,
} MetaClipboardStatus;

typedef enum {
  META_CLIPBOARD_BACKEND_READ_OK,
  META_CLIPBOARD_BACKEND_READ_TEXT_UNAVAILABLE,
  META_CLIPBOARD_BACKEND_READ_PAYLOAD_TOO_LARGE,
  META_CLIPBOARD_BACKEND_READ_FAILED,
} MetaClipboardBackendReadStatus;

typedef struct {
  void *context;
  bool (*change_count)(void *context, int64_t *value);
  MetaClipboardBackendReadStatus (*read_utf8)(
      void *context, size_t max_bytes, uint8_t **bytes, size_t *length);
  void (*release_utf8)(void *context, uint8_t *bytes, size_t length);
  bool (*clear_contents)(void *context, int64_t *change_count);
  bool (*write_utf8)(void *context, const uint8_t *bytes, size_t length);
} MetaClipboardBackend;

typedef struct {
  MetaClipboardStatus status;
  int64_t change_count;
} MetaClipboardVersionResult;

typedef struct {
  MetaClipboardStatus status;
  int64_t before_change_count;
  int64_t after_change_count;
  size_t utf8_bytes;
} MetaClipboardReadResult;

typedef struct {
  const uint8_t *bytes;
  size_t length;
  bool has_expected_change_count;
  int64_t expected_change_count;
} MetaClipboardWriteRequest;

typedef struct {
  MetaClipboardStatus status;
  int64_t before_change_count;
  int64_t declared_change_count;
  int64_t after_change_count;
  bool mutation_attempted;
  bool set_string_succeeded;
  bool ownership_stable_after_write;
  bool atomic_precondition;
  size_t utf8_bytes;
} MetaClipboardWriteResult;

MetaClipboardBackend meta_clipboard_system_backend(void);

MetaClipboardVersionResult meta_clipboard_read_version(
    MetaClipboardBackend backend);

MetaClipboardReadResult meta_clipboard_read_text(
    MetaClipboardBackend backend, uint8_t *output, size_t capacity);

MetaClipboardWriteResult meta_clipboard_write_text(
    MetaClipboardBackend backend, MetaClipboardWriteRequest request);

#endif
