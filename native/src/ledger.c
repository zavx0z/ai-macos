#include "meta_ledger.h"

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define META_LEDGER_MAGIC 0x4d4554414c454447ULL
#define META_LEDGER_VERSION 1U
#define META_LEDGER_ENTRY_LIMIT 512U

typedef struct {
  uint64_t magic;
  uint32_t version;
  uint32_t entry_count;
  uint64_t revision;
  bool has_previous_snapshot_sha256;
  char operation_id[META_NATIVE_REF_CAPACITY];
  char runtime_epoch[META_NATIVE_REF_CAPACITY];
  char login_session_id[META_NATIVE_REF_CAPACITY];
  char native_generation[META_NATIVE_REF_CAPACITY];
  char previous_snapshot_sha256[65];
  char snapshot_sha256[65];
} LedgerHeader;

typedef struct {
  uint64_t sequence;
  uint32_t kind;
  uint32_t code;
  uint32_t state;
} LedgerDiskEntry;

struct MetaLedgerStore {
  char *path;
};

static bool write_all(int descriptor, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    const ssize_t written = write(descriptor, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return true;
}

static bool read_all(int descriptor, void *bytes, size_t length) {
  unsigned char *cursor = bytes;
  while (length > 0) {
    const ssize_t count = read(descriptor, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    cursor += (size_t)count;
    length -= (size_t)count;
  }
  return true;
}

static const char *kind_name(MetaHeldEventKind kind) {
  return kind == META_EVENT_KEY ? "key" : "button";
}

static const char *state_name(MetaLedgerState state) {
  switch (state) {
    case META_LEDGER_PENDING_DOWN:
      return "pending-down";
    case META_LEDGER_CONFIRMED_DOWN:
      return "confirmed-down";
    case META_LEDGER_PENDING_UP:
      return "pending-up";
    case META_LEDGER_RELEASED:
      return "released";
    case META_LEDGER_UNCERTAIN:
      return "uncertain";
  }
  return NULL;
}

static bool append_json(char *buffer, size_t capacity, size_t *length,
                        const char *format, ...) {
  if (*length >= capacity) return false;
  va_list arguments;
  va_start(arguments, format);
  const int written = vsnprintf(buffer + *length, capacity - *length, format,
                                arguments);
  va_end(arguments);
  if (written < 0 || (size_t)written >= capacity - *length) return false;
  *length += (size_t)written;
  return true;
}

bool meta_ledger_snapshot_sha256(const MetaHeldInputLedgerSnapshot *snapshot,
                                 char digest[65]) {
  if (snapshot == NULL || digest == NULL || snapshot->entry_count > 512 ||
      (snapshot->entry_count > 0 && snapshot->entries == NULL) ||
      snapshot->operation_id[0] == '\0' || snapshot->runtime_epoch[0] == '\0' ||
      snapshot->login_session_id[0] == '\0' ||
      snapshot->native_generation[0] == '\0' || snapshot->revision == 0) {
    return false;
  }
  const size_t capacity = 2048 + snapshot->entry_count * 128;
  char *canonical = calloc(capacity, 1);
  if (canonical == NULL) return false;
  size_t length = 0;
  bool ok = append_json(
      canonical, capacity, &length,
      "{\"canonicalVersion\":\"1\",\"operationId\":\"%s\","
      "\"runtimeEpoch\":\"%s\",\"loginSessionId\":\"%s\","
      "\"nativeGeneration\":\"%s\",\"revision\":%llu,"
      "\"previousSnapshotSha256\":",
      snapshot->operation_id, snapshot->runtime_epoch,
      snapshot->login_session_id, snapshot->native_generation,
      (unsigned long long)snapshot->revision);
  if (ok) {
    ok = snapshot->has_previous_snapshot_sha256
             ? append_json(canonical, capacity, &length, "\"%s\"",
                           snapshot->previous_snapshot_sha256)
             : append_json(canonical, capacity, &length, "null");
  }
  if (ok) ok = append_json(canonical, capacity, &length, ",\"entries\":[");
  for (size_t index = 0; ok && index < snapshot->entry_count; index += 1) {
    const MetaLedgerEntry *entry = &snapshot->entries[index];
    const char *state = state_name(entry->state);
    if (entry->sequence == 0 || entry->kind > META_EVENT_BUTTON ||
        state == NULL) {
      ok = false;
      break;
    }
    ok = append_json(
        canonical, capacity, &length,
        "%s{\"sequence\":%llu,\"kind\":\"%s\",\"code\":%u,"
        "\"state\":\"%s\"}",
        index == 0 ? "" : ",", (unsigned long long)entry->sequence,
        kind_name(entry->kind), entry->code, state);
  }
  if (ok) ok = append_json(canonical, capacity, &length, "]}");
  if (!ok) {
    free(canonical);
    return false;
  }
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH] = {0};
  CC_SHA256(canonical, (CC_LONG)length, bytes);
  free(canonical);
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    snprintf(digest + index * 2, 3, "%02x", bytes[index]);
  }
  digest[64] = '\0';
  return true;
}

static char *parent_directory(const char *path) {
  char *copy = strdup(path);
  if (copy == NULL) return NULL;
  char *separator = strrchr(copy, '/');
  if (separator == NULL) {
    strcpy(copy, ".");
    return copy;
  }
  if (separator == copy) {
    separator[1] = '\0';
    return copy;
  }
  *separator = '\0';
  return copy;
}

static bool sync_parent_directory(const char *path) {
  char *directory = parent_directory(path);
  if (directory == NULL) return false;
  const int descriptor = open(directory, O_RDONLY | O_DIRECTORY);
  free(directory);
  if (descriptor < 0) return false;
  const bool result = fsync(descriptor) == 0;
  close(descriptor);
  return result;
}

MetaLedgerStore *meta_ledger_store_create(const char *path) {
  if (path == NULL || path[0] == '\0') return NULL;
  MetaLedgerStore *store = calloc(1, sizeof(*store));
  if (store == NULL) return NULL;
  store->path = strdup(path);
  if (store->path == NULL) {
    free(store);
    return NULL;
  }
  return store;
}

void meta_ledger_store_destroy(MetaLedgerStore *store) {
  if (store == NULL) return;
  free(store->path);
  free(store);
}

bool meta_ledger_store_persist(void *context,
                               const MetaLedgerPersistenceRequest *request,
                               MetaLedgerPersistenceAck *ack) {
  MetaLedgerStore *store = context;
  if (store == NULL || request == NULL || ack == NULL ||
      request->request_id[0] == '\0' ||
      strnlen(request->request_id, META_NATIVE_REF_CAPACITY) >=
          META_NATIVE_REF_CAPACITY ||
      request->snapshot.entry_count > META_LEDGER_ENTRY_LIMIT ||
      (request->snapshot.entry_count > 0 &&
       request->snapshot.entries == NULL)) {
    return false;
  }
  const MetaHeldInputLedgerSnapshot *snapshot = &request->snapshot;
  char digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(snapshot, digest)) return false;
  LedgerDiskEntry disk_entries[META_LEDGER_ENTRY_LIMIT] = {0};
  for (size_t index = 0; index < snapshot->entry_count; index += 1) {
    disk_entries[index] = (LedgerDiskEntry){
        .sequence = snapshot->entries[index].sequence,
        .kind = (uint32_t)snapshot->entries[index].kind,
        .code = snapshot->entries[index].code,
        .state = (uint32_t)snapshot->entries[index].state,
    };
  }
  LedgerHeader header = {
      .magic = META_LEDGER_MAGIC,
      .version = META_LEDGER_VERSION,
      .entry_count = (uint32_t)snapshot->entry_count,
      .revision = snapshot->revision,
      .has_previous_snapshot_sha256 =
          snapshot->has_previous_snapshot_sha256,
  };
  snprintf(header.operation_id, sizeof(header.operation_id), "%s",
           snapshot->operation_id);
  snprintf(header.runtime_epoch, sizeof(header.runtime_epoch), "%s",
           snapshot->runtime_epoch);
  snprintf(header.login_session_id, sizeof(header.login_session_id), "%s",
           snapshot->login_session_id);
  snprintf(header.native_generation, sizeof(header.native_generation), "%s",
           snapshot->native_generation);
  if (snapshot->has_previous_snapshot_sha256) {
    snprintf(header.previous_snapshot_sha256,
             sizeof(header.previous_snapshot_sha256), "%s",
             snapshot->previous_snapshot_sha256);
  }
  snprintf(header.snapshot_sha256, sizeof(header.snapshot_sha256), "%s",
           digest);

  const size_t temporary_capacity = strlen(store->path) + 16;
  char *temporary = calloc(temporary_capacity, 1);
  if (temporary == NULL) return false;
  snprintf(temporary, temporary_capacity, "%s.tmp.XXXXXX", store->path);
  const int descriptor = mkstemp(temporary);
  if (descriptor < 0) {
    free(temporary);
    return false;
  }
  bool ok = fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 &&
            write_all(descriptor, &header, sizeof(header)) &&
            write_all(descriptor, disk_entries,
                      snapshot->entry_count * sizeof(*disk_entries)) &&
            fsync(descriptor) == 0;
  if (close(descriptor) != 0) ok = false;
  if (ok && rename(temporary, store->path) != 0) ok = false;
  if (ok && !sync_parent_directory(store->path)) ok = false;
  if (!ok) unlink(temporary);
  free(temporary);
  if (ok) {
    struct timeval time = {0};
    gettimeofday(&time, NULL);
    memset(ack, 0, sizeof(*ack));
    snprintf(ack->request_id, sizeof(ack->request_id), "%s",
             request->request_id);
    snprintf(ack->operation_id, sizeof(ack->operation_id), "%s",
             snapshot->operation_id);
    snprintf(ack->runtime_epoch, sizeof(ack->runtime_epoch), "%s",
             snapshot->runtime_epoch);
    snprintf(ack->login_session_id, sizeof(ack->login_session_id), "%s",
             snapshot->login_session_id);
    snprintf(ack->native_generation, sizeof(ack->native_generation), "%s",
             snapshot->native_generation);
    ack->revision = snapshot->revision;
    snprintf(ack->snapshot_sha256, sizeof(ack->snapshot_sha256), "%s",
             digest);
    ack->persisted_at_unix_micros =
        (uint64_t)time.tv_sec * 1000000ULL + (uint64_t)time.tv_usec;
    ack->durable = true;
  }
  return ok;
}

MetaLedgerLoadStatus meta_ledger_store_load(
    MetaLedgerStore *store, char operation_id[META_NATIVE_REF_CAPACITY],
    MetaLedgerEntry *entries, size_t capacity, size_t *entry_count) {
  if (store == NULL || operation_id == NULL || entry_count == NULL) {
    return META_LEDGER_LOAD_IO_ERROR;
  }
  *entry_count = 0;
  operation_id[0] = '\0';
  const int descriptor = open(store->path, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) {
    return errno == ENOENT ? META_LEDGER_LOAD_ABSENT
                           : META_LEDGER_LOAD_IO_ERROR;
  }
  struct stat info = {0};
  if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != getuid() || (info.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
    close(descriptor);
    return META_LEDGER_LOAD_CORRUPT;
  }
  LedgerHeader header = {0};
  if (!read_all(descriptor, &header, sizeof(header)) ||
      header.magic != META_LEDGER_MAGIC ||
      header.version != META_LEDGER_VERSION ||
      header.entry_count > META_LEDGER_ENTRY_LIMIT ||
      header.operation_id[META_NATIVE_REF_CAPACITY - 1] != '\0' ||
      header.runtime_epoch[META_NATIVE_REF_CAPACITY - 1] != '\0' ||
      header.login_session_id[META_NATIVE_REF_CAPACITY - 1] != '\0' ||
      header.native_generation[META_NATIVE_REF_CAPACITY - 1] != '\0' ||
      header.previous_snapshot_sha256[64] != '\0' ||
      header.snapshot_sha256[64] != '\0') {
    close(descriptor);
    return META_LEDGER_LOAD_CORRUPT;
  }
  LedgerDiskEntry disk_entries[META_LEDGER_ENTRY_LIMIT] = {0};
  if (!read_all(descriptor, disk_entries,
                header.entry_count * sizeof(*disk_entries))) {
    close(descriptor);
    return META_LEDGER_LOAD_CORRUPT;
  }
  unsigned char trailing = 0;
  const ssize_t trailing_count = read(descriptor, &trailing, 1);
  close(descriptor);
  if (trailing_count != 0) {
    return META_LEDGER_LOAD_CORRUPT;
  }
  MetaLedgerEntry loaded_entries[META_LEDGER_ENTRY_LIMIT] = {0};
  for (size_t index = 0; index < header.entry_count; index += 1) {
    if (disk_entries[index].sequence == 0 ||
        disk_entries[index].kind > META_EVENT_BUTTON ||
        disk_entries[index].state > META_LEDGER_UNCERTAIN) {
      return META_LEDGER_LOAD_CORRUPT;
    }
    loaded_entries[index] = (MetaLedgerEntry){
        .sequence = disk_entries[index].sequence,
        .kind = (MetaHeldEventKind)disk_entries[index].kind,
        .code = disk_entries[index].code,
        .state = (MetaLedgerState)disk_entries[index].state,
    };
  }
  MetaHeldInputLedgerSnapshot snapshot = {
      .revision = header.revision,
      .has_previous_snapshot_sha256 =
          header.has_previous_snapshot_sha256,
      .entries = loaded_entries,
      .entry_count = header.entry_count,
  };
  snprintf(snapshot.operation_id, sizeof(snapshot.operation_id), "%s",
           header.operation_id);
  snprintf(snapshot.runtime_epoch, sizeof(snapshot.runtime_epoch), "%s",
           header.runtime_epoch);
  snprintf(snapshot.login_session_id, sizeof(snapshot.login_session_id), "%s",
           header.login_session_id);
  snprintf(snapshot.native_generation, sizeof(snapshot.native_generation),
           "%s", header.native_generation);
  if (header.has_previous_snapshot_sha256) {
    snprintf(snapshot.previous_snapshot_sha256,
             sizeof(snapshot.previous_snapshot_sha256), "%s",
             header.previous_snapshot_sha256);
  }
  char digest[65] = {0};
  if (!meta_ledger_snapshot_sha256(&snapshot, digest) ||
      strcmp(digest, header.snapshot_sha256) != 0) {
    return META_LEDGER_LOAD_CORRUPT;
  }
  snprintf(operation_id, META_NATIVE_REF_CAPACITY, "%s", header.operation_id);
  *entry_count = header.entry_count;
  if (header.entry_count > capacity ||
      (header.entry_count > 0 && entries == NULL)) {
    return META_LEDGER_LOAD_READY;
  }
  memcpy(entries, loaded_entries, header.entry_count * sizeof(*entries));
  return META_LEDGER_LOAD_READY;
}

bool meta_ledger_store_clear_released(MetaLedgerStore *store) {
  if (store == NULL) return false;
  char operation_id[META_NATIVE_REF_CAPACITY] = {0};
  MetaLedgerEntry entries[META_LEDGER_ENTRY_LIMIT] = {0};
  size_t entry_count = 0;
  const MetaLedgerLoadStatus status = meta_ledger_store_load(
      store, operation_id, entries, META_LEDGER_ENTRY_LIMIT, &entry_count);
  if (status == META_LEDGER_LOAD_ABSENT) return true;
  if (status != META_LEDGER_LOAD_READY) return false;
  for (size_t index = 0; index < entry_count; index += 1) {
    if (entries[index].state != META_LEDGER_RELEASED) return false;
  }
  if (unlink(store->path) != 0 && errno != ENOENT) return false;
  return sync_parent_directory(store->path);
}
