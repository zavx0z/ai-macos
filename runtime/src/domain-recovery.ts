import { join } from "node:path"
import { canonicalRecoveryJson, z, type OperationRecord } from "@meta/shared/contracts"
import { nativeDomainRecoveryRequestSchema, nativeDomainRecoveryResponseSchema, verifyDomainRecoveryAllUp,
  type NativeDomainRecoveryRequest, type NativeDomainRecoveryResponse } from "@meta/native/protocol"
import { NativeActorJournal, nativeActorRecordSchema } from "./native-actor.ts"
import type { PersistentHeldInputLedger } from "./storage/held-ledger.ts"
import { atomicReplace, syncFileAndParent } from "./storage/atomic-file.ts"
import { assertRecordCapacity, readStorageFile } from "./storage/common.ts"
import { sha256 } from "./primitives.ts"

const receiptSchema = z.strictObject({
  format: z.literal("meta-domain-recovery"), version: z.literal(1), acceptedAt: z.iso.datetime({ offset: true }),
  request: nativeDomainRecoveryRequestSchema, response: nativeDomainRecoveryResponseSchema,
  actor: nativeActorRecordSchema, actorProof: z.enum(["owned-exit", "process-absent"]),
})
const envelopeSchema = z.strictObject({ receipt: receiptSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export type DomainRecoveryNative = {
  generation?: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string }
  loadedBuildId: string
  domainRecovery(request: NativeDomainRecoveryRequest, control: { signal: AbortSignal, checkpoint(): void }): Promise<NativeDomainRecoveryResponse>
}

/** Проверяет весь declared risk set после actor exit, без генерации held ledger. */
export class DomainRecoveryStore {
  constructor(readonly options: { directory: string, loginSessionId: string, runtimeEpoch: string,
    ledgers: PersistentHeldInputLedger, actors: NativeActorJournal, native?: DomainRecoveryNative }) {
    this.options = Object.freeze({ ...options })
  }

  async read(record: OperationRecord): Promise<z.infer<typeof receiptSchema> | undefined> {
    const grant = this.#grant(record)
    if (grant === undefined) return undefined
    const envelope = await readStorageFile(this.#path(record), envelopeSchema)
    if (envelope === undefined) return undefined
    const { receipt } = envelope
    if (envelope.sha256 !== sha256(canonicalRecoveryJson(receipt)) || canonicalRecoveryJson(receipt.request.grant) !== canonicalRecoveryJson(grant)
      || receipt.actor.runtimeEpoch !== grant.runtimeEpoch || receipt.actor.nativeGeneration !== grant.nativeGeneration
      || receipt.actor.loginSessionId !== grant.loginSessionId || receipt.actor.nativeBuildId !== grant.descriptor.nativeBuildId
      || receipt.actor.recoveryDomainVersion !== "1") throw new Error("Domain receipt identity/checksum mismatch")
    const ledger = await this.#ledger(record)
    if (canonicalRecoveryJson(receipt.request.ledger ?? null) !== canonicalRecoveryJson(ledger?.snapshot ?? null)) throw new Error("Domain receipt ledger revision изменилась")
    verifyDomainRecoveryAllUp(receipt.request, receipt.response, receipt.response.nativeBuildId, new Date(receipt.acceptedAt))
    await syncFileAndParent(this.#path(record))
    return receipt
  }

  async recover(record: OperationRecord, signal?: AbortSignal): Promise<boolean> {
    const grant = this.#grant(record)
    if (grant === undefined) return false
    if (await this.read(record) !== undefined) return true
    const native = this.options.native
    const generation = native?.generation
    if (native === undefined || generation === undefined) return false
    if (generation.runtimeEpoch !== this.options.runtimeEpoch || generation.loginSessionId !== this.options.loginSessionId) throw new Error("Domain probe принадлежит другому host")
    const actor = await this.options.actors.quiescence(grant.runtimeEpoch, grant.nativeGeneration)
    if (actor.state !== "exited" || actor.actor.recoveryDomainVersion !== "1" || actor.actor.nativeBuildId !== grant.descriptor.nativeBuildId) return false
    const ledger = await this.#ledger(record)
    const request = nativeDomainRecoveryRequestSchema.parse({ kind: "domain-recovery", protocolVersion: "1", ...generation,
      requestId: `domain-recovery:${crypto.randomUUID()}`, deadlineAt: new Date(Date.now() + 2000).toISOString(), grant,
      ...(ledger === undefined ? {} : { ledger: ledger.snapshot, ack: ledger.ack }) })
    const control = AbortSignal.any([AbortSignal.timeout(2000), ...(signal === undefined ? [] : [signal])])
    control.throwIfAborted()
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(control.reason); control.addEventListener("abort", onAbort, { once: true }) })
    try {
      const response = await Promise.race([native.domainRecovery(request, { signal: control, checkpoint() { control.throwIfAborted() } }), aborted])
      control.throwIfAborted()
      const acceptedAt = new Date()
      try { verifyDomainRecoveryAllUp(request, response, native.loadedBuildId, acceptedAt) }
      catch { return false }
      const receipt = receiptSchema.parse({ format: "meta-domain-recovery", version: 1, acceptedAt: acceptedAt.toISOString(), request, response,
        actor: actor.actor, actorProof: actor.source })
      await assertRecordCapacity(this.options.directory, this.#path(record))
      await atomicReplace(this.#path(record), new TextEncoder().encode(canonicalRecoveryJson({ receipt, sha256: sha256(canonicalRecoveryJson(receipt)) })))
      return true
    } finally { control.removeEventListener("abort", onAbort) }
  }

  #grant(record: OperationRecord) {
    const gate = record.nativeRecovery
    if (gate?.phase !== "send-authorized" || gate.grant.descriptor.domain !== "possible-held-input"
      || record.context.loginSessionId !== this.options.loginSessionId || record.context.runtimeEpoch === this.options.runtimeEpoch) return undefined
    if (gate.grant.contextSha256 !== sha256(canonicalRecoveryJson(record.context))
      || gate.grant.descriptorSha256 !== sha256(canonicalRecoveryJson(gate.grant.descriptor))) throw new Error("Persisted domain grant digest mismatch")
    return gate.grant
  }
  #ledger(record: OperationRecord) {
    const gate = record.nativeRecovery
    if (gate?.phase !== "send-authorized") throw new Error("Domain grant отсутствует")
    return this.options.ledgers.read({ runtimeEpoch: record.context.runtimeEpoch, loginSessionId: record.context.loginSessionId,
      nativeGeneration: gate.grant.nativeGeneration, operationId: record.context.operationId })
  }
  #path(record: OperationRecord) {
    return join(this.options.directory, `${sha256(canonicalRecoveryJson(record.nativeRecovery))}.json`)
  }
}
