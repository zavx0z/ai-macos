import { join } from "node:path"
import {
  OPERATION_STATES,
  TERMINAL_OPERATION_STATES,
  canTransitionOperation,
  cleanupAuthorityReceiptSchema,
  operationRecordSchema,
  z,
  type CleanupAuthorityReceipt,
  type OperationRecord,
  type OperationState,
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

const operationJournalKeySchema = z.strictObject({
  runtimeEpoch: z.string().min(1).max(64),
  loginSessionId: z.string().min(1).max(64),
  operationId: z.string().min(1).max(127),
})

export type OperationJournalKey = z.infer<typeof operationJournalKeySchema>

const operationEnvelopeSchema = z.strictObject({
  format: z.literal("meta-runtime-operation-record"),
  version: z.literal(STORAGE_FORMAT_VERSION),
  key: operationJournalKeySchema,
  revision: z.number().int().safe().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  record: operationRecordSchema,
})

type OperationEnvelope = z.infer<typeof operationEnvelopeSchema>

export type StoredOperationEvidence = {
  revision: number
  record: OperationRecord
}

export type OperationJournalPersistOptions = {
  cleanupReceipt?: CleanupAuthorityReceipt
}

export interface PersistentOperationJournal {
  persist(
    record: OperationRecord,
    revision: number,
    options?: OperationJournalPersistOptions,
  ): Promise<StoredOperationEvidence>
  read(key: OperationJournalKey): Promise<StoredOperationEvidence | undefined>
  loadRecoveryEvidence(): Promise<StoredOperationEvidence[]>
}

export class FileOperationJournal implements PersistentOperationJournal {
  readonly #directory: string
  readonly #writeOptions: DurableWriteOptions
  #tail: Promise<void> = Promise.resolve()

  constructor(directory: string, writeOptions: DurableWriteOptions = {}) {
    this.#directory = directory
    this.#writeOptions = writeOptions
  }

  async persist(
    value: OperationRecord,
    revision: number,
    options: OperationJournalPersistOptions = {},
  ): Promise<StoredOperationEvidence> {
    return await this.#exclusive(async () => {
      const record = operationRecordSchema.parse(value)
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error("Operation journal revision должна быть положительной")
      }
      const key = operationKey(record)
      const path = this.#path(key)
      const existing = await this.#readEnvelope(path)
      if (existing !== undefined) {
        if (revision < existing.revision) {
          throw new Error("Operation journal revision ниже durable revision")
        }
        if (revision === existing.revision) {
          if (stableJson(record) !== stableJson(existing.record)) {
            throw new Error("Operation journal получил conflicting same revision")
          }
          await syncFileAndParent(path)
          return { revision, record: structuredClone(existing.record) }
        }
        if (stableJson(operationAuthority(record)) !== stableJson(operationAuthority(existing.record))) {
          throw new Error("Operation journal revision изменила immutable operation authority")
        }
        if (
          record.state !== existing.record.state
          && !canReachOperationState(existing.record.state, record.state)
        ) {
          throw new Error("Operation journal revision откатывает state machine")
        }
        if (Date.parse(record.updatedAt) < Date.parse(existing.record.updatedAt)) {
          throw new Error("Operation journal revision откатывает updatedAt")
        }
        assertMonotonicOperationFacts(
          existing.record,
          record,
          options.cleanupReceipt,
        )
      }
      await assertRecordCapacity(this.#directory, path)
      const envelope = createOperationEnvelope(key, revision, record)
      const bytes = new TextEncoder().encode(JSON.stringify(envelope))
      if (bytes.byteLength > MAX_STORAGE_FILE_BYTES) {
        throw new Error("Operation journal record превышает byte limit")
      }
      await atomicReplace(path, bytes, this.#writeOptions)
      return { revision, record: structuredClone(record) }
    })
  }

  async read(keyValue: OperationJournalKey): Promise<StoredOperationEvidence | undefined> {
    return await this.#exclusive(async () => {
      const key = operationJournalKeySchema.parse(keyValue)
      const envelope = await this.#readEnvelope(this.#path(key))
      return envelope === undefined
        ? undefined
        : { revision: envelope.revision, record: structuredClone(envelope.record) }
    })
  }

  async loadRecoveryEvidence(): Promise<StoredOperationEvidence[]> {
    return await this.#exclusive(async () => {
      const evidence: StoredOperationEvidence[] = []
      for (const path of await storageFiles(this.#directory)) {
        const envelope = await this.#readEnvelope(path)
        if (envelope === undefined) throw new Error(`Operation journal record исчез: ${path}`)
        if (requiresRecovery(envelope.record)) {
          evidence.push({
            revision: envelope.revision,
            record: structuredClone(envelope.record),
          })
        }
      }
      return evidence
    })
  }

  async #readEnvelope(path: string): Promise<OperationEnvelope | undefined> {
    const envelope = await readStorageFile(path, operationEnvelopeSchema)
    if (envelope === undefined) return undefined
    const expectedPath = this.#path(envelope.key)
    if (expectedPath !== path) throw new Error("Operation journal filename не совпадает с exact key hash")
    const checksum = operationChecksum(
      envelope.key,
      envelope.revision,
      envelope.record,
    )
    if (checksum !== envelope.checksum) throw new Error("Operation journal checksum не совпадает")
    const recordKey = operationKey(envelope.record)
    if (stableJson(recordKey) !== stableJson(envelope.key)) {
      throw new Error("Operation journal record содержит другой exact key")
    }
    return envelope
  }

  #path(key: OperationJournalKey): string {
    return join(this.#directory, storageFileName([
      "operation",
      key.runtimeEpoch,
      key.loginSessionId,
      key.operationId,
    ]))
  }

  async #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return await result
  }
}

function operationKey(record: OperationRecord): OperationJournalKey {
  return operationJournalKeySchema.parse({
    runtimeEpoch: record.context.runtimeEpoch,
    loginSessionId: record.context.loginSessionId,
    operationId: record.context.operationId,
  })
}

function createOperationEnvelope(
  key: OperationJournalKey,
  revision: number,
  record: OperationRecord,
): OperationEnvelope {
  return operationEnvelopeSchema.parse({
    format: "meta-runtime-operation-record",
    version: STORAGE_FORMAT_VERSION,
    key,
    revision,
    checksum: operationChecksum(key, revision, record),
    record,
  })
}

function operationChecksum(
  key: OperationJournalKey,
  revision: number,
  record: OperationRecord,
): string {
  return sha256(stableJson({
    format: "meta-runtime-operation-record",
    version: STORAGE_FORMAT_VERSION,
    key,
    revision,
    record,
  }))
}

function operationAuthority(record: OperationRecord): unknown {
  return {
    clientSessionId: record.clientSessionId,
    principalId: record.principalId,
    intent: record.intent,
    context: record.context,
    resources: record.resources,
    payloadReceipt: record.payloadReceipt,
    registeredAt: record.registeredAt,
  }
}

function assertMonotonicOperationFacts(
  previous: OperationRecord,
  next: OperationRecord,
  cleanupReceipt: CleanupAuthorityReceipt | undefined,
): void {
  if (next.outcome.dispatchAttempts < previous.outcome.dispatchAttempts) {
    throw new Error("Operation journal revision откатывает dispatchAttempts")
  }
  if ((next.outcome.ledgerRevision ?? 0) < (previous.outcome.ledgerRevision ?? 0)) {
    throw new Error("Operation journal revision откатывает ledgerRevision")
  }
  if (!dispatchCanAdvance(previous.outcome.dispatch, next.outcome.dispatch)) {
    throw new Error("Operation journal revision откатывает dispatch facts")
  }
  if (
    previous.outcome.targetVerified === "verified"
    && next.outcome.targetVerified !== "verified"
  ) {
    throw new Error("Operation journal revision теряет verified target")
  }
  if (
    previous.outcome.userInterference === "observed"
    && next.outcome.userInterference !== "observed"
  ) {
    throw new Error("Operation journal revision теряет observed interference")
  }
  if (
    previous.outcome.observation === "available"
    && next.outcome.observation !== "available"
  ) {
    throw new Error("Operation journal revision теряет available observation")
  }
  if (previous.outcome.effect.state === "verified") {
    if (next.outcome.effect.state !== "verified") {
      throw new Error("Operation journal revision теряет verified effect")
    }
    const nextProofs = new Set(next.outcome.effect.proofRefs)
    if (previous.outcome.effect.proofRefs.some(proof => !nextProofs.has(proof))) {
      throw new Error("Operation journal revision теряет effect proof")
    }
  }
  if (TERMINAL_OPERATION_STATES.includes(previous.state)) {
    if (
      stableJson(terminalOutcomeFacts(previous))
      !== stableJson(terminalOutcomeFacts(next))
    ) {
      throw new Error("Operation journal revision изменила terminal outcome facts")
    }
    if (stableJson(previous.error ?? null) !== stableJson(next.error ?? null)) {
      throw new Error("Operation journal revision изменила terminal error facts")
    }
  }
  assertCleanupAdvance(previous, next, cleanupReceipt)
}

function terminalOutcomeFacts(record: OperationRecord): unknown {
  const { cleanup: _cleanup, ...facts } = record.outcome
  return facts
}

function assertCleanupAdvance(
  previous: OperationRecord,
  next: OperationRecord,
  cleanupReceipt: CleanupAuthorityReceipt | undefined,
): void {
  const previousCleanup = previous.outcome.cleanup
  const nextCleanup = next.outcome.cleanup
  if (previousCleanup.state === "complete") {
    if (stableJson(previousCleanup) !== stableJson(nextCleanup)) {
      throw new Error("Operation journal revision откатывает complete cleanup")
    }
    return
  }
  if (
    TERMINAL_OPERATION_STATES.includes(previous.state)
    && nextCleanup.state !== "complete"
    && stableJson(previousCleanup) !== stableJson(nextCleanup)
  ) {
    throw new Error("Operation journal revision изменила unresolved terminal cleanup facts")
  }
  if (nextCleanup.state !== "complete") return
  if (cleanupReceipt === undefined) {
    throw new Error("Operation journal cleanup reconciliation требует authority receipt")
  }
  const receipt = cleanupAuthorityReceiptSchema.parse(cleanupReceipt)
  if (
    receipt.operationId !== next.context.operationId
    || receipt.runtimeEpoch !== next.context.runtimeEpoch
    || receipt.loginSessionId !== next.context.loginSessionId
    || receipt.leases.length !== next.resources.length
    || next.resources.some(handle => !receipt.leases.some(lease => {
      return lease.leaseId === handle.leaseId
        && lease.leaseGeneration === handle.leaseGeneration
    }))
  ) {
    throw new Error("Operation journal cleanup receipt не коррелирует с operation resources")
  }
}

function dispatchCanAdvance(
  previous: OperationRecord["outcome"]["dispatch"],
  next: OperationRecord["outcome"]["dispatch"],
): boolean {
  if (previous === next) return true
  const allowed: Record<typeof previous, readonly typeof next[]> = {
    none: ["attempted", "partial", "finished", "unknown"],
    attempted: ["partial", "finished", "unknown"],
    partial: ["finished", "unknown"],
    finished: [],
    unknown: ["partial", "finished"],
  }
  return allowed[previous].includes(next)
}

function canReachOperationState(from: OperationState, to: OperationState): boolean {
  const pending: OperationState[] = [from]
  const visited = new Set<OperationState>()
  while (pending.length > 0) {
    const current = pending.shift()!
    if (current === to) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const candidate of OPERATION_STATES) {
      if (!visited.has(candidate) && canTransitionOperation(current, candidate)) {
        pending.push(candidate)
      }
    }
  }
  return false
}

function requiresRecovery(record: OperationRecord): boolean {
  return !["rejected", "completed", "cancelled", "failed"].includes(record.state)
    || record.state === "interrupted-unknown"
    || record.outcome.cleanup.state !== "complete"
}
