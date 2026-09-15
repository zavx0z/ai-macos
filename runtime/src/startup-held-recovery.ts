import { join } from "node:path"
import {
  cleanupAuthorityReceiptSchema, heldInputLedgerDigest, z,
  type CleanupAuthorityReceipt, type OperationRecord, type RuntimeGeneration,
} from "@meta/shared/contracts"
import type { NativeBrokerAdapter } from "@meta/native/adapter"
import { nativeHeldRecoveryRequestSchema, nativeHeldRecoveryResponseSchema, verifyHeldRecoveryAllUp } from "@meta/native/protocol"
import { NativeActorJournal, nativeActorRecordSchema } from "./native-actor.ts"
import type { PersistentHeldInputLedger, StoredHeldLedgerEvidence } from "./storage/held-ledger.ts"
import { atomicReplace } from "./storage/atomic-file.ts"
import { readStorageFile, assertRecordCapacity } from "./storage/common.ts"
import { canonicalJson, sha256 } from "./primitives.ts"

const receiptSchema = z.strictObject({
  format: z.literal("meta-held-recovery"), version: z.literal(1),
  acceptedAt: z.iso.datetime({ offset: true }),
  request: nativeHeldRecoveryRequestSchema,
  response: nativeHeldRecoveryResponseSchema,
  actor: nativeActorRecordSchema,
  actorProof: z.enum(["owned-exit", "process-absent"]),
})
const envelopeSchema = z.strictObject({ receipt: receiptSchema, checksum: z.string().regex(/^[a-f0-9]{64}$/) })
type RecoveryReceipt = z.infer<typeof receiptSchema>
type RecoveryNative = Pick<NativeBrokerAdapter, "heldRecovery" | "generation" | "loadedBuildId">

/** Не отправляет input events и не изменяет исходные ledger snapshots. */
export class StartupHeldRecovery {
  readonly #directory: string
  readonly #generation: RuntimeGeneration
  readonly #ledgers: PersistentHeldInputLedger
  readonly #actors: NativeActorJournal
  readonly #native?: RecoveryNative
  #tail: Promise<void> = Promise.resolve()

  constructor(options: { directory: string, generation: RuntimeGeneration, ledgers: PersistentHeldInputLedger, actors: NativeActorJournal, native?: RecoveryNative }) {
    this.#directory = options.directory
    this.#generation = structuredClone(options.generation)
    this.#ledgers = options.ledgers
    this.#actors = options.actors
    this.#native = options.native
  }

  async unresolvedHeld(): Promise<number> {
    let count = 0
    for (const evidence of await this.#pending()) if (await this.#read(evidence) === undefined) count++
    return count
  }

  async receiptFor(record: OperationRecord): Promise<CleanupAuthorityReceipt | undefined> {
    if (record.context.kind !== "native" || record.context.loginSessionId !== this.#generation.loginSessionId
      || record.resources.length === 0 || record.resources.some(handle => handle.kind !== "desktop-input")) return undefined
    const evidence = await this.#ledgers.read({ runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId,
      nativeGeneration: record.context.nativeGeneration, operationId: record.context.operationId })
    if (evidence === undefined) return undefined
    const receipt = await this.#read(evidence)
    if (receipt === undefined) return undefined
    return cleanupAuthorityReceiptSchema.parse({ receiptId: `startup-held:${sha256(canonicalJson(receipt))}`,
      authorityRef: "runtime:startup-held-recovery", operationId: record.context.operationId,
      runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId, issuedAt: receipt.acceptedAt,
      state: "complete", leases: record.resources.map(handle => ({ leaseId: handle.leaseId, leaseGeneration: handle.leaseGeneration })) })
  }

  async recover(operationId?: string, signal?: AbortSignal): Promise<{ resolved: number, unresolved: number }> {
    let result!: { resolved: number, unresolved: number }
    const run = async () => {
      let resolved = 0
      for (const evidence of await this.#pending()) {
        signal?.throwIfAborted()
        if (operationId !== undefined && evidence.snapshot.operationId !== operationId) continue
        if (await this.#read(evidence) !== undefined) continue
        const native = this.#native
        const generation = native?.generation
        if (native === undefined || generation === undefined) continue
        if (generation.runtimeEpoch !== this.#generation.runtimeEpoch || generation.loginSessionId !== this.#generation.loginSessionId) throw new Error("Recovery native принадлежит другому host")
        const actor = await this.#actors.quiescence(evidence.snapshot.runtimeEpoch, evidence.snapshot.nativeGeneration)
        if (actor.state !== "exited") continue
        const request = nativeHeldRecoveryRequestSchema.parse({ kind: "held-recovery", protocolVersion: "1",
          requestId: `held-recovery:${crypto.randomUUID()}`, ...generation,
          deadlineAt: new Date(Date.now() + 2000).toISOString(), ledger: evidence.snapshot, ack: evidence.ack })
        const control = AbortSignal.any([AbortSignal.timeout(2000), ...(signal === undefined ? [] : [signal])])
        const response = await native.heldRecovery(request, { signal: control, checkpoint() { control.throwIfAborted() } })
        const acceptedAt = new Date()
        try { verifyHeldRecoveryAllUp(request, response, native.loadedBuildId, acceptedAt) }
        catch { continue }
        const receipt = receiptSchema.parse({ format: "meta-held-recovery", version: 1, request, response,
          acceptedAt: acceptedAt.toISOString(), actor: actor.actor, actorProof: actor.source })
        await assertRecordCapacity(this.#directory, this.#path(evidence))
        await atomicReplace(this.#path(evidence), new TextEncoder().encode(canonicalJson({ receipt, checksum: sha256(canonicalJson(receipt)) })))
        resolved++
      }
      result = { resolved, unresolved: await this.unresolvedHeld() }
    }
    const pending = this.#tail.then(run, run)
    this.#tail = pending.catch(() => undefined)
    await pending
    return result
  }

  async #pending(): Promise<StoredHeldLedgerEvidence[]> {
    return (await this.#ledgers.loadAll()).filter(evidence => evidence.snapshot.loginSessionId === this.#generation.loginSessionId
      && evidence.snapshot.entries.some(entry => entry.state !== "released"))
  }

  #path(evidence: StoredHeldLedgerEvidence): string {
    return join(this.#directory, `${sha256(canonicalJson([evidence.snapshot.runtimeEpoch, evidence.snapshot.nativeGeneration,
      evidence.snapshot.operationId, evidence.snapshot.revision, heldInputLedgerDigest(evidence.snapshot)]))}.json`)
  }

  async #read(evidence: StoredHeldLedgerEvidence): Promise<RecoveryReceipt | undefined> {
    const envelope = await readStorageFile(this.#path(evidence), envelopeSchema)
    if (envelope === undefined) return undefined
    const receipt = envelope.receipt
    if (envelope.checksum !== sha256(canonicalJson(receipt))
      || canonicalJson(receipt.request.ledger) !== canonicalJson(evidence.snapshot)
      || receipt.actor.runtimeEpoch !== evidence.snapshot.runtimeEpoch
      || receipt.actor.nativeGeneration !== evidence.snapshot.nativeGeneration
      || receipt.actor.loginSessionId !== this.#generation.loginSessionId) throw new Error("Startup recovery receipt identity/checksum mismatch")
    verifyHeldRecoveryAllUp(receipt.request, receipt.response, receipt.response.nativeBuildId, new Date(receipt.acceptedAt))
    return receipt
  }
}
