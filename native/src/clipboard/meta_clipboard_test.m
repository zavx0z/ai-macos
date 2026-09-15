#import <Foundation/Foundation.h>

#include "meta_clipboard.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  int64_t change_count;
  int64_t declared_change_count;
  int64_t after_write_change_count;
  const uint8_t *read_bytes;
  size_t read_length;
  size_t change_count_reads;
  size_t clear_calls;
  size_t write_calls;
  size_t release_calls;
  size_t read_allocations;
  bool change_during_read;
  bool empty_text_available;
  bool clear_succeeds;
  bool write_succeeds;
  uint8_t written[128];
  size_t written_length;
} MockPasteboard;

static bool mock_change_count(void *context, int64_t *value) {
  MockPasteboard *pasteboard = context;
  pasteboard->change_count_reads += 1;
  if (pasteboard->change_during_read && pasteboard->change_count_reads == 2) {
    pasteboard->change_count += 1;
  }
  if (pasteboard->write_calls > 0 &&
      pasteboard->after_write_change_count >= 0) {
    *value = pasteboard->after_write_change_count;
  } else {
    *value = pasteboard->change_count;
  }
  return true;
}

static MetaClipboardBackendReadStatus mock_read_utf8(
    void *context, size_t max_bytes, uint8_t **bytes, size_t *length) {
  MockPasteboard *pasteboard = context;
  *bytes = NULL;
  *length = pasteboard->read_length;
  if (pasteboard->read_length == 0 && !pasteboard->empty_text_available) {
    return META_CLIPBOARD_BACKEND_READ_TEXT_UNAVAILABLE;
  }
  if (pasteboard->read_length > max_bytes) {
    return META_CLIPBOARD_BACKEND_READ_PAYLOAD_TOO_LARGE;
  }
  *bytes = malloc(pasteboard->read_length == 0 ? 1 : pasteboard->read_length);
  if (*bytes == NULL) return META_CLIPBOARD_BACKEND_READ_FAILED;
  pasteboard->read_allocations += 1;
  if (pasteboard->read_length > 0) {
    memcpy(*bytes, pasteboard->read_bytes, pasteboard->read_length);
  }
  return META_CLIPBOARD_BACKEND_READ_OK;
}

static void mock_release_utf8(void *context, uint8_t *bytes, size_t length) {
  MockPasteboard *pasteboard = context;
  pasteboard->release_calls += 1;
  if (bytes != NULL && length > 0) memset(bytes, 0, length);
  free(bytes);
}

static bool mock_clear_contents(void *context, int64_t *change_count) {
  MockPasteboard *pasteboard = context;
  pasteboard->clear_calls += 1;
  if (!pasteboard->clear_succeeds) return false;
  pasteboard->change_count = pasteboard->declared_change_count;
  *change_count = pasteboard->declared_change_count;
  return true;
}

static bool mock_write_utf8(void *context, const uint8_t *bytes,
                            size_t length) {
  MockPasteboard *pasteboard = context;
  pasteboard->write_calls += 1;
  assert(length <= sizeof(pasteboard->written));
  memcpy(pasteboard->written, bytes, length);
  pasteboard->written_length = length;
  return pasteboard->write_succeeds;
}

static MetaClipboardBackend backend(MockPasteboard *pasteboard) {
  return (MetaClipboardBackend){
      .context = pasteboard,
      .change_count = mock_change_count,
      .read_utf8 = mock_read_utf8,
      .release_utf8 = mock_release_utf8,
      .clear_contents = mock_clear_contents,
      .write_utf8 = mock_write_utf8,
  };
}

static void test_version_and_stable_read(void) {
  const uint8_t text[] = "Привет";
  MockPasteboard pasteboard = {
      .change_count = 7,
      .after_write_change_count = -1,
      .read_bytes = text,
      .read_length = sizeof(text) - 1,
  };
  MetaClipboardVersionResult version =
      meta_clipboard_read_version(backend(&pasteboard));
  assert(version.status == META_CLIPBOARD_OK);
  assert(version.change_count == 7);

  uint8_t output[64] = {0};
  MetaClipboardReadResult read =
      meta_clipboard_read_text(backend(&pasteboard), output, sizeof(output));
  assert(read.status == META_CLIPBOARD_OK);
  assert(read.before_change_count == 7);
  assert(read.after_change_count == 7);
  assert(read.utf8_bytes == sizeof(text) - 1);
  assert(memcmp(output, text, sizeof(text) - 1) == 0);
  assert(pasteboard.release_calls == 1);
}

static void test_changed_read_returns_no_text(void) {
  const uint8_t text[] = "stale";
  MockPasteboard pasteboard = {
      .change_count = 4,
      .after_write_change_count = -1,
      .read_bytes = text,
      .read_length = sizeof(text) - 1,
      .change_during_read = true,
  };
  uint8_t output[16];
  memset(output, 0xa5, sizeof(output));
  MetaClipboardReadResult read =
      meta_clipboard_read_text(backend(&pasteboard), output, sizeof(output));
  assert(read.status == META_CLIPBOARD_CHANGED_DURING_READ);
  assert(read.utf8_bytes == 0);
  assert(output[0] == 0xa5);
  assert(pasteboard.release_calls == 1);
}

static void test_empty_text_is_distinct_from_unavailable(void) {
  MockPasteboard pasteboard = {
      .change_count = 5,
      .after_write_change_count = -1,
      .empty_text_available = true,
  };
  uint8_t output[1] = {0};
  MetaClipboardReadResult read =
      meta_clipboard_read_text(backend(&pasteboard), output, sizeof(output));
  assert(read.status == META_CLIPBOARD_OK);
  assert(read.utf8_bytes == 0);
  assert(pasteboard.release_calls == 1);

  MockPasteboard unavailable = {
      .change_count = 6,
      .after_write_change_count = -1,
  };
  MetaClipboardReadResult missing =
      meta_clipboard_read_text(backend(&unavailable), output, sizeof(output));
  assert(missing.status == META_CLIPBOARD_TEXT_UNAVAILABLE);
  assert(unavailable.read_allocations == 0);
  assert(unavailable.release_calls == 0);
}

static void test_expected_version_is_precondition_not_cas(void) {
  const uint8_t text[] = "new value";
  MockPasteboard pasteboard = {
      .change_count = 9,
      .declared_change_count = 10,
      .after_write_change_count = 10,
      .clear_succeeds = true,
      .write_succeeds = true,
  };
  MetaClipboardWriteRequest mismatch = {
      .bytes = text,
      .length = sizeof(text) - 1,
      .has_expected_change_count = true,
      .expected_change_count = 8,
  };
  MetaClipboardWriteResult rejected =
      meta_clipboard_write_text(backend(&pasteboard), mismatch);
  assert(rejected.status == META_CLIPBOARD_PRECONDITION_MISMATCH);
  assert(!rejected.mutation_attempted);
  assert(!rejected.atomic_precondition);
  assert(pasteboard.clear_calls == 0);
  assert(pasteboard.write_calls == 0);

  MetaClipboardWriteRequest accepted = mismatch;
  accepted.expected_change_count = 9;
  MetaClipboardWriteResult written =
      meta_clipboard_write_text(backend(&pasteboard), accepted);
  assert(written.status == META_CLIPBOARD_OK);
  assert(written.mutation_attempted);
  assert(written.set_string_succeeded);
  assert(written.ownership_stable_after_write);
  assert(!written.atomic_precondition);
  assert(written.before_change_count == 9);
  assert(written.declared_change_count == 10);
  assert(written.after_change_count == 10);
  assert(pasteboard.written_length == sizeof(text) - 1);
  assert(memcmp(pasteboard.written, text, sizeof(text) - 1) == 0);
}

static void test_bounded_read_and_clear_failure(void) {
  uint8_t *large_text = malloc(META_CLIPBOARD_MAX_UTF8_BYTES + 1);
  assert(large_text != NULL);
  memset(large_text, 'x', META_CLIPBOARD_MAX_UTF8_BYTES + 1);
  MockPasteboard read_pasteboard = {
      .change_count = 2,
      .after_write_change_count = -1,
      .read_bytes = large_text,
      .read_length = META_CLIPBOARD_MAX_UTF8_BYTES + 1,
  };
  uint8_t output[8] = {0};
  MetaClipboardReadResult read = meta_clipboard_read_text(
      backend(&read_pasteboard), output, sizeof(output));
  assert(read.status == META_CLIPBOARD_PAYLOAD_TOO_LARGE);
  assert(read.utf8_bytes == 0);
  assert(read_pasteboard.read_allocations == 0);
  assert(read_pasteboard.release_calls == 0);
  free(large_text);

  const uint8_t text[] = "value";
  MockPasteboard write_pasteboard = {
      .change_count = 2,
      .declared_change_count = 3,
      .after_write_change_count = 3,
      .clear_succeeds = false,
      .write_succeeds = true,
  };
  MetaClipboardWriteResult write = meta_clipboard_write_text(
      backend(&write_pasteboard),
      (MetaClipboardWriteRequest){
          .bytes = text,
          .length = sizeof(text) - 1,
          .has_expected_change_count = true,
          .expected_change_count = 2,
      });
  assert(write.status == META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN);
  assert(write.mutation_attempted);
  assert(write_pasteboard.clear_calls == 1);
  assert(write_pasteboard.write_calls == 0);
}

static void test_intervening_owner_is_partial_unknown(void) {
  const uint8_t text[] = "race";
  MockPasteboard pasteboard = {
      .change_count = 3,
      .declared_change_count = 4,
      .after_write_change_count = 5,
      .clear_succeeds = true,
      .write_succeeds = false,
  };
  MetaClipboardWriteResult result = meta_clipboard_write_text(
      backend(&pasteboard),
      (MetaClipboardWriteRequest){
          .bytes = text,
          .length = sizeof(text) - 1,
          .has_expected_change_count = true,
          .expected_change_count = 3,
      });
  assert(result.status == META_CLIPBOARD_WRITE_PARTIAL_UNKNOWN);
  assert(result.mutation_attempted);
  assert(!result.set_string_succeeded);
  assert(!result.ownership_stable_after_write);
  assert(!result.atomic_precondition);
}

static void test_invalid_or_large_payload_never_clears(void) {
  const uint8_t invalid[] = {0xc3, 0x28};
  MockPasteboard pasteboard = {
      .change_count = 1,
      .declared_change_count = 2,
      .after_write_change_count = 2,
      .clear_succeeds = true,
      .write_succeeds = true,
  };
  MetaClipboardWriteResult invalid_result = meta_clipboard_write_text(
      backend(&pasteboard),
      (MetaClipboardWriteRequest){.bytes = invalid, .length = sizeof(invalid)});
  assert(invalid_result.status == META_CLIPBOARD_INVALID_UTF8);
  assert(pasteboard.clear_calls == 0);

  uint8_t marker = 'x';
  MetaClipboardWriteResult large = meta_clipboard_write_text(
      backend(&pasteboard),
      (MetaClipboardWriteRequest){
          .bytes = &marker,
          .length = META_CLIPBOARD_MAX_UTF8_BYTES + 1,
      });
  assert(large.status == META_CLIPBOARD_PAYLOAD_TOO_LARGE);
  assert(pasteboard.clear_calls == 0);
  assert(pasteboard.write_calls == 0);
}

int main(void) {
  @autoreleasepool {
    test_version_and_stable_read();
    test_changed_read_returns_no_text();
    test_empty_text_is_distinct_from_unavailable();
    test_expected_version_is_precondition_not_cas();
    test_bounded_read_and_clear_failure();
    test_intervening_owner_is_partial_unknown();
    test_invalid_or_large_payload_never_clears();
  }
  puts("clipboard module tests passed");
  return 0;
}
