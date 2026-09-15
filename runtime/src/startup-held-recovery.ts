import { join } from "node:path"
import {
  cleanupAuthorityReceiptSchema, heldInputLedgerDigest, z,
  canonicalRecoveryJson,
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
    if (!["native", "clipboard"].includes(record.context.kind) || record.context.loginSessionId !== this.#generation.loginSessionId
      || record.context.runtimeEpoch === this.#generation.runtimeEpoch || record.resources.length === 0
      || record.resources.some(handle => !["desktop-input", "capture-stream", "clipboard"].includes(handle.kind))) return undefined
    const gate = record.nativeRecovery
    if (gate === undefined) return undefined
    const nativeGeneration = gate?.phase === "not-authorized" ? gate.nativeGeneration
      : gate?.phase === "send-authorized" ? gate.grant.nativeGeneration
        : record.context.kind === "native" ? record.context.nativeGeneration : undefined
    if (nativeGeneration === undefined) return undefined
    if (gate !== undefined) {
      const actor = await this.#actors.read(record.context.runtimeEpoch, nativeGeneration)
      const buildId = gate.phase === "not-authorized" ? gate.nativeBuildId : gate.grant.descriptor.nativeBuildId
      if (actor?.recoveryDomainVersion !== "1" || actor.nativeBuildId !== buildId) return undefined
      if (gate.phase === "not-authorized") {
        const contradictory = await this.#ledgers.read({ runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId,
          nativeGeneration, operationId: record.context.operationId })
        if (contradictory?.snapshot.entries.length) throw new Error("Not-authorized gate противоречит native ledger")
        return this.#cleanupReceipt(record, `not-authorized:${sha256(canonicalRecoveryJson(gate))}`, new Date().toISOString())
      }
      if (gate.grant.contextSha256 !== sha256(canonicalRecoveryJson(record.context))
        || gate.grant.descriptorSha256 !== sha256(canonicalRecoveryJson(gate.grant.descriptor))) throw new Error("Recovery domain digest mismatch")
      if (gate.grant.descriptor.domain === "no-held-input") {
        const contradictory = await this.#ledgers.read({ runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId,
          nativeGeneration, operationId: record.context.operationId })
        if (contradictory?.snapshot.entries.length) throw new Error("No-hold descriptor противоречит held ledger")
        const gone = await this.#actors.quiescence(record.context.runtimeEpoch, nativeGeneration)
        if (gone.state !== "exited") return undefined
        return this.#cleanupReceipt(record, `actor-exited:${gate.grant.descriptorSha256}`, new Date().toISOString())
      }
    }
    if (record.resources.some(handle => handle.kind !== "desktop-input")) return undefined
    const evidence = await this.#ledgers.read({ runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId,
      nativeGeneration, operationId: record.context.operationId })
    if (evidence === undefined) return undefined
    if (gate.phase === "send-authorized" && evidence.snapshot.entries.some(entry => !gate.grant.descriptor.possibleHolds.some(hold =>
      hold.kind === entry.kind && hold.code === entry.code))) throw new Error("Held ledger выходит за declared recovery domain")
    if (gate.phase !== "send-authorized" || gate.grant.descriptor.possibleHolds.some(hold => !evidence.snapshot.entries.some(entry =>
      entry.state !== "released" && entry.kind === hold.kind && entry.code === hold.code))) return undefined
    const receipt = await this.#read(evidence)
    if (receipt === undefined) return undefined
    return this.#cleanupReceipt(record, sha256(canonicalJson(receipt)), receipt.acceptedAt)
  }

  #cleanupReceipt(record: OperationRecord, evidenceId: string, issuedAt: string): CleanupAuthorityReceipt {
    return cleanupAuthorityReceiptSchema.parse({ receiptId: `startup-held:${sha256(evidenceId)}`,
      authorityRef: "runtime:startup-held-recovery", operationId: record.context.operationId,
      runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId, issuedAt,
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
