#include "meta_ledger.h"

#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void test_round_trip_and_safe_clear(void) {
  char directory[] = "/tmp/meta-ledger-test.XXXXXX";
  assert(mkdtemp(directory) != NULL);
  char path[512] = {0};
  snprintf(path, sizeof(path), "%s/held-input.ledger", directory);
  MetaLedgerStore *store = meta_ledger_store_create(path);
  assert(store != NULL);
  MetaLedgerEntry pending = {
      .sequence = 1,
      .kind = META_EVENT_KEY,
      .code = 55,
      .state = META_LEDGER_PENDING_DOWN,
  };
  MetaLedgerPersistenceRequest request = {0};
  snprintf(request.request_id, sizeof(request.request_id), "%s", "ledger-1");
  snprintf(request.snapshot.operation_id,
           sizeof(request.snapshot.operation_id), "%s", "operation-1");
  snprintf(request.snapshot.runtime_epoch,
           sizeof(request.snapshot.runtime_epoch), "%s", "runtime-1");
  snprintf(request.snapshot.login_session_id,
           sizeof(request.snapshot.login_session_id), "%s", "login-1");
  snprintf(request.snapshot.native_generation,
           sizeof(request.snapshot.native_generation), "%s", "native-1");
  request.snapshot.revision = 1;
  request.snapshot.entries = &pending;
  request.snapshot.entry_count = 1;
  MetaLedgerPersistenceAck ack = {0};
  assert(meta_ledger_store_persist(store, &request, &ack));
  char expected_digest[65] = {0};
  assert(meta_ledger_snapshot_sha256(&request.snapshot, expected_digest));
  assert(strcmp(expected_digest,
                "8654bd7de36928823296c4d369f05b8b29d47ff1d6d18fea1214236bb5b6ba03") == 0);
  assert(strcmp(ack.snapshot_sha256, expected_digest) == 0);
  assert(ack.durable);

  char operation_id[META_NATIVE_REF_CAPACITY] = {0};
  MetaLedgerEntry loaded[2] = {0};
  size_t count = 0;
  assert(meta_ledger_store_load(store, operation_id, loaded, 2, &count) ==
         META_LEDGER_LOAD_READY);
  assert(strcmp(operation_id, "operation-1") == 0);
  assert(count == 1);
  assert(loaded[0].state == META_LEDGER_PENDING_DOWN);
  assert(!meta_ledger_store_clear_released(store));

  pending.state = META_LEDGER_RELEASED;
  request.snapshot.revision = 2;
  request.snapshot.has_previous_snapshot_sha256 = true;
  snprintf(request.snapshot.previous_snapshot_sha256,
           sizeof(request.snapshot.previous_snapshot_sha256), "%s",
           ack.snapshot_sha256);
  snprintf(request.request_id, sizeof(request.request_id), "%s", "ledger-2");
  assert(meta_ledger_store_persist(store, &request, &ack));
  assert(meta_ledger_store_clear_released(store));
  assert(meta_ledger_store_load(store, operation_id, loaded, 2, &count) ==
         META_LEDGER_LOAD_ABSENT);
  meta_ledger_store_destroy(store);
  assert(rmdir(directory) == 0);
}

static void test_corrupt_file_fails_closed(void) {
  char directory[] = "/tmp/meta-ledger-corrupt.XXXXXX";
  assert(mkdtemp(directory) != NULL);
  char path[512] = {0};
  snprintf(path, sizeof(path), "%s/held-input.ledger", directory);
  const int descriptor = open(path, O_CREAT | O_WRONLY, S_IRUSR | S_IWUSR);
  assert(descriptor >= 0);
  assert(write(descriptor, "broken", 6) == 6);
  assert(close(descriptor) == 0);
  MetaLedgerStore *store = meta_ledger_store_create(path);
  assert(store != NULL);
  char operation_id[META_NATIVE_REF_CAPACITY] = {0};
  size_t count = 0;
  assert(meta_ledger_store_load(store, operation_id, NULL, 0, &count) ==
         META_LEDGER_LOAD_CORRUPT);
  assert(!meta_ledger_store_clear_released(store));
  meta_ledger_store_destroy(store);
  assert(unlink(path) == 0);
  assert(rmdir(directory) == 0);
}

int main(void) {
  test_round_trip_and_safe_clear();
  test_corrupt_file_fails_closed();
  puts("ledger tests passed");
  return 0;
}
