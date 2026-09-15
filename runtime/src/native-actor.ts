import { join } from "node:path"
import { nativeHandshakeResponseSchema, z, type NativeHandshakeResponse } from "@meta/shared/contracts"
import { atomicReplace, syncFileAndParent, type DurableWriteOptions } from "./storage/atomic-file.ts"
import { readStorageFile, assertRecordCapacity } from "./storage/common.ts"
import { canonicalJson, sha256 } from "./primitives.ts"

export const nativeActorRecordSchema = z.strictObject({
  format: z.literal("meta-native-actor"), version: z.literal(1),
  runtimeEpoch: z.string().min(1).max(64), loginSessionId: z.string().min(1).max(64), nativeGeneration: z.string().min(1).max(64),
  nativeBuildId: z.string().min(1).max(127), helperPath: z.string().min(1).max(4096).startsWith("/"),
  recoveryDomainVersion: z.literal("1").optional(),
  process: nativeHandshakeResponseSchema.shape.process,
  recordedAt: z.iso.datetime({ offset: true }), exitedAt: z.iso.datetime({ offset: true }).optional(),
})
const actorSchema = nativeActorRecordSchema
const envelopeSchema = z.strictObject({ actor: actorSchema, checksum: z.string().regex(/^[a-f0-9]{64}$/) })
export type NativeActorRecord = z.infer<typeof actorSchema>
export type NativeActorQuiescence = { state: "exited", source: "owned-exit" | "process-absent", actor: NativeActorRecord }
  | { state: "unknown", reason: string }

/** Отсутствие actor подтверждается только owned exit или ESRCH, не elapsed time. */
export class NativeActorJournal {
  readonly #absent: (pid: number) => boolean
  readonly #writeOptions: DurableWriteOptions
  readonly #sync: typeof syncFileAndParent
  constructor(readonly directory: string, readonly loginSessionId: string, options: DurableWriteOptions & {
    absent?: (pid: number) => boolean
    sync?: typeof syncFileAndParent
  } = {}) {
    this.#writeOptions = options.failpoint === undefined ? {} : { failpoint: options.failpoint }
    this.#sync = options.sync ?? syncFileAndParent
    this.#absent = options.absent ?? (pid => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })
  }

  async register(handshakeValue: NativeHandshakeResponse, helperPath: string): Promise<NativeActorRecord> {
    const handshake = nativeHandshakeResponseSchema.parse(handshakeValue)
    if (handshake.loginSessionId !== this.loginSessionId || !handshake.session?.verified) throw new Error("Native actor требует verified same audit handshake")
    const actor = actorSchema.parse({ format: "meta-native-actor", version: 1, runtimeEpoch: handshake.runtimeEpoch,
      loginSessionId: handshake.loginSessionId, nativeGeneration: handshake.nativeGeneration, nativeBuildId: handshake.nativeBuildId,
      helperPath, process: handshake.process, recordedAt: new Date().toISOString() })
    if (handshake.recoveryDomainVersion !== undefined) actor.recoveryDomainVersion = handshake.recoveryDomainVersion
    const existing = await this.read(actor.runtimeEpoch, actor.nativeGeneration)
    if (existing !== undefined) {
      if (existing.nativeBuildId !== actor.nativeBuildId || existing.helperPath !== helperPath || existing.recoveryDomainVersion !== actor.recoveryDomainVersion
        || canonicalJson(existing.process) !== canonicalJson(actor.process)) throw new Error("Native actor identity immutable conflict")
      await this.#sync(this.#path(actor.runtimeEpoch, actor.nativeGeneration))
      return existing
    }
    await assertRecordCapacity(this.directory, this.#path(actor.runtimeEpoch, actor.nativeGeneration))
    await this.#write(actor)
    return actor
  }

  async read(runtimeEpoch: string, nativeGeneration: string): Promise<NativeActorRecord | undefined> {
    const envelope = await readStorageFile(this.#path(runtimeEpoch, nativeGeneration), envelopeSchema)
    if (envelope === undefined) return undefined
    if (envelope.actor.runtimeEpoch !== runtimeEpoch || envelope.actor.nativeGeneration !== nativeGeneration
      || envelope.actor.loginSessionId !== this.loginSessionId || sha256(canonicalJson(envelope.actor)) !== envelope.checksum) throw new Error("Native actor record identity/checksum mismatch")
    return envelope.actor
  }

  async markConfirmedExit(actor: NativeActorRecord): Promise<void> {
    const current = await this.read(actor.runtimeEpoch, actor.nativeGeneration)
    if (current === undefined || canonicalJson(current.process) !== canonicalJson(actor.process)) throw new Error("Native actor exit имеет другую identity")
    if (current.exitedAt !== undefined) {
      await this.#sync(this.#path(current.runtimeEpoch, current.nativeGeneration))
      return
    }
    await this.#write({ ...current, exitedAt: new Date().toISOString() })
  }

  async quiescence(runtimeEpoch: string, nativeGeneration: string): Promise<NativeActorQuiescence> {
    const actor = await this.read(runtimeEpoch, nativeGeneration)
    if (actor === undefined) return { state: "unknown", reason: "Verified old actor metadata unavailable" }
    if (actor.exitedAt !== undefined) return { state: "exited", source: "owned-exit", actor }
    if (this.#absent(actor.process.pid)) return { state: "exited", source: "process-absent", actor }
    return { state: "unknown", reason: "Old actor может быть жив; PID existence не доказывает quiescence" }
  }

  #path(runtimeEpoch: string, nativeGeneration: string): string {
    return join(this.directory, `${sha256(canonicalJson([this.loginSessionId, runtimeEpoch, nativeGeneration]))}.json`)
  }

  async #write(actorValue: NativeActorRecord): Promise<void> {
    const actor = actorSchema.parse(actorValue)
    await atomicReplace(this.#path(actor.runtimeEpoch, actor.nativeGeneration), new TextEncoder().encode(canonicalJson({ actor, checksum: sha256(canonicalJson(actor)) })), this.#writeOptions)
  }
}
