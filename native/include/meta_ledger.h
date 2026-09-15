#ifndef META_LEDGER_H
#define META_LEDGER_H

#include "meta_native.h"

typedef enum {
  META_LEDGER_LOAD_ABSENT,
  META_LEDGER_LOAD_READY,
  META_LEDGER_LOAD_CORRUPT,
  META_LEDGER_LOAD_IO_ERROR,
} MetaLedgerLoadStatus;

typedef struct MetaLedgerStore MetaLedgerStore;

MetaLedgerStore *meta_ledger_store_create(const char *path);
void meta_ledger_store_destroy(MetaLedgerStore *store);
bool meta_ledger_snapshot_sha256(const MetaHeldInputLedgerSnapshot *snapshot,
                                 char digest[65]);
bool meta_ledger_store_persist(void *context,
                               const MetaLedgerPersistenceRequest *request,
                               MetaLedgerPersistenceAck *ack);
MetaLedgerLoadStatus meta_ledger_store_load(
    MetaLedgerStore *store, char operation_id[META_NATIVE_REF_CAPACITY],
    MetaLedgerEntry *entries, size_t capacity, size_t *entry_count);
bool meta_ledger_store_clear_released(MetaLedgerStore *store);

#endif
