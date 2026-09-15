import { join } from "node:path"
import {
  heldInputLedgerAckMatches,
  heldInputLedgerAckSchema,
  heldInputLedgerDigest,
  heldInputLedgerSnapshotSchema,
  validateLedgerTransition,
  z,
  type HeldInputLedgerAck,
  type HeldInputLedgerSink,
  type HeldInputLedgerSnapshot,
} from "@meta/shared/contracts"
import {
  atomicReplace,
  syncFileAndParent,
  type DurableWriteOptions,
} from "./atomic-file.ts"
import {
  MAX_STORAGE_FILE_BYTES,
  STORAGE_FORMAT_VERSION,
  assertRecordCapacity,
  readStorageFile,
  sha256,
  stableJson,
  storageFileName,
  storageFiles,
} from "./common.ts"

const ledgerKeySchema = z.strictObject({
  runtimeEpoch: z.string().min(1).max(64),
  loginSessionId: z.string().min(1).max(64),
  nativeGeneration: z.string().min(1).max(64),
  operationId: z.string().min(1).max(127),
})

export type HeldLedgerKey = z.infer<typeof ledgerKeySchema>

const ledgerEnvelopeSchema = z.strictObject({
  format: z.literal("meta-native-held-ledger"),
  version: z.literal(STORAGE_FORMAT_VERSION),
  key: ledgerKeySchema,
  requestId: z.string().min(1).max(127),
  persistedAt: z.iso.datetime({ offset: true }),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: heldInputLedgerSnapshotSchema,
})

type LedgerEnvelope = z.infer<typeof ledgerEnvelopeSchema>

export type StoredHeldLedgerEvidence = {
  snapshot: HeldInputLedgerSnapshot
  ack: HeldInputLedgerAck
}

export interface PersistentHeldInputLedger extends HeldInputLedgerSink {
  read(key: HeldLedgerKey): Promise<StoredHeldLedgerEvidence | undefined>
  loadAll(): Promise<StoredHeldLedgerEvidence[]>
}

export class FileHeldInputLedger implements PersistentHeldInputLedger {
  readonly #directory: string
  readonly #writeOptions: DurableWriteOptions
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(
    directory: string,
    options: DurableWriteOptions & { now?: () => Date } = {},
  ) {
    this.#directory = directory
    const { now, ...writeOptions } = options
    this.#writeOptions = writeOptions
    this.#now = now ?? (() => new Date())
  }

  async persist(
    requestIdValue: string,
    snapshotValue: HeldInputLedgerSnapshot,
  ): Promise<HeldInputLedgerAck> {
    return await this.#exclusive(async () => {
      const requestId = z.string().min(1).max(127).parse(requestIdValue)
      const snapshot = heldInputLedgerSnapshotSchema.parse(snapshotValue)
      const key = ledgerKey(snapshot)
      const path = this.#path(key)
      const digest = heldInputLedgerDigest(snapshot)
      const existing = await this.#readEnvelope(path)
      if (existing !== undefined) {
        if (snapshot.revision < existing.snapshot.revision) {
          throw new Error("Held ledger revision ниже durable revision")
        }
        if (snapshot.revision === existing.snapshot.revision) {
          if (digest !== existing.snapshotSha256) {
            throw new Error("Held ledger получил conflicting same revision")
          }
          await syncFileAndParent(path)
          return ledgerAck(requestId, existing)
        }
        validateLedgerTransition(
          existing.snapshot,
          snapshot,
          ledgerAck(existing.requestId, existing),
        )
      } else if (snapshot.revision !== 1 || snapshot.previousSnapshotSha256 !== undefined) {
        throw new Error("Первый durable held ledger snapshot должен иметь revision 1 без previous hash")
      }
      await assertRecordCapacity(this.#directory, path)
      const persistedAt = this.#now().toISOString()
      const envelope = createLedgerEnvelope(
        key,
        requestId,
        persistedAt,
        digest,
        snapshot,
      )
      const bytes = new TextEncoder().encode(JSON.stringify(envelope))
      if (bytes.byteLength > MAX_STORAGE_FILE_BYTES) {
        throw new Error("Held ledger record превышает byte limit")
      }
      await atomicReplace(path, bytes, this.#writeOptions)
      return ledgerAck(requestId, envelope)
    })
  }

  async read(keyValue: HeldLedgerKey): Promise<StoredHeldLedgerEvidence | undefined> {
    return await this.#exclusive(async () => {
      const key = ledgerKeySchema.parse(keyValue)
      const envelope = await this.#readEnvelope(this.#path(key))
      return envelope === undefined ? undefined : ledgerEvidence(envelope)
    })
  }

  async loadAll(): Promise<StoredHeldLedgerEvidence[]> {
    return await this.#exclusive(async () => {
      const evidence: StoredHeldLedgerEvidence[] = []
      for (const path of await storageFiles(this.#directory)) {
        const envelope = await this.#readEnvelope(path)
        if (envelope === undefined) throw new Error(`Held ledger record исчез: ${path}`)
        evidence.push(ledgerEvidence(envelope))
      }
      return evidence
    })
  }

  async #readEnvelope(path: string): Promise<LedgerEnvelope | undefined> {
    const envelope = await readStorageFile(path, ledgerEnvelopeSchema)
    if (envelope === undefined) return undefined
    if (this.#path(envelope.key) !== path) throw new Error("Held ledger filename не совпадает с exact key hash")
    const digest = heldInputLedgerDigest(envelope.snapshot)
    if (digest !== envelope.snapshotSha256) throw new Error("Held ledger snapshot digest не совпадает")
    const checksum = ledgerChecksum(
      envelope.key,
      envelope.requestId,
      envelope.persistedAt,
      envelope.snapshotSha256,
      envelope.snapshot,
    )
    if (checksum !== envelope.checksum) throw new Error("Held ledger checksum не совпадает")
    if (stableJson(ledgerKey(envelope.snapshot)) !== stableJson(envelope.key)) {
      throw new Error("Held ledger snapshot содержит другой exact key")
    }
    return envelope
  }

  #path(key: HeldLedgerKey): string {
    return join(this.#directory, storageFileName([
      "held-ledger",
      key.runtimeEpoch,
      key.loginSessionId,
      key.nativeGeneration,
      key.operationId,
    ]))
  }

  async #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return await result
  }
}

function ledgerKey(snapshot: HeldInputLedgerSnapshot): HeldLedgerKey {
  return ledgerKeySchema.parse({
    runtimeEpoch: snapshot.runtimeEpoch,
    loginSessionId: snapshot.loginSessionId,
    nativeGeneration: snapshot.nativeGeneration,
    operationId: snapshot.operationId,
  })
}

function createLedgerEnvelope(
  key: HeldLedgerKey,
  requestId: string,
  persistedAt: string,
  snapshotSha256: string,
  snapshot: HeldInputLedgerSnapshot,
): LedgerEnvelope {
  return ledgerEnvelopeSchema.parse({
    format: "meta-native-held-ledger",
    version: STORAGE_FORMAT_VERSION,
    key,
    requestId,
    persistedAt,
    snapshotSha256,
    checksum: ledgerChecksum(
      key,
      requestId,
      persistedAt,
      snapshotSha256,
      snapshot,
    ),
    snapshot,
  })
}

function ledgerChecksum(
  key: HeldLedgerKey,
  requestId: string,
  persistedAt: string,
  snapshotSha256: string,
  snapshot: HeldInputLedgerSnapshot,
): string {
  return sha256(stableJson({
    format: "meta-native-held-ledger",
    version: STORAGE_FORMAT_VERSION,
    key,
    requestId,
    persistedAt,
    snapshotSha256,
    snapshot,
  }))
}

function ledgerAck(
  requestId: string,
  envelope: LedgerEnvelope,
): HeldInputLedgerAck {
  const ack = heldInputLedgerAckSchema.parse({
    requestId,
    operationId: envelope.snapshot.operationId,
    runtimeEpoch: envelope.snapshot.runtimeEpoch,
    loginSessionId: envelope.snapshot.loginSessionId,
    nativeGeneration: envelope.snapshot.nativeGeneration,
    revision: envelope.snapshot.revision,
    snapshotSha256: envelope.snapshotSha256,
    persistedAt: envelope.persistedAt,
    durable: true,
  })
  if (!heldInputLedgerAckMatches(requestId, envelope.snapshot, ack)) {
    throw new Error("Durable held ledger ACK не коррелирует со snapshot")
  }
  return ack
}

function ledgerEvidence(envelope: LedgerEnvelope): StoredHeldLedgerEvidence {
  return {
    snapshot: structuredClone(envelope.snapshot),
    ack: ledgerAck(envelope.requestId, envelope),
  }
}
