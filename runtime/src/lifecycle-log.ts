import { join } from "node:path"
import { z } from "@meta/shared/contracts"
import { atomicReplace, syncFileAndParent } from "./storage/atomic-file.ts"
import { canonicalJson } from "./primitives.ts"
import { readStorageFile } from "./storage/common.ts"

const entrySchema = z.strictObject({
  recordedAt: z.iso.datetime({ offset: true }),
  event: z.enum(["host-start", "native-revoked", "rotation-trigger", "stop-requested", "drain-start", "drain-complete", "drain-failed",
    "close-start", "close-complete", "close-failed", "observer-failed", "observer-ready"]),
  runtimeEpoch: z.string().min(1).max(64), loginSessionId: z.string().min(1).max(64),
  nativeGeneration: z.string().min(1).max(64).optional(), nativeBuildId: z.string().min(1).max(127).optional(),
  reason: z.string().min(1).max(1024).optional(),
})
const fileSchema = z.strictObject({ format: z.literal("meta-runtime-lifecycle"), version: z.literal(1), entries: z.array(entrySchema).max(128) })
export type RuntimeLifecycleEvent = z.infer<typeof entrySchema>["event"]

/** Bounded operational history; user payload, titles, URLs и clipboard сюда не принимаются. */
export class RuntimeLifecycleLog {
  readonly #path: string
  readonly #identity: Pick<z.infer<typeof entrySchema>, "runtimeEpoch" | "loginSessionId" | "nativeGeneration" | "nativeBuildId">
  #tail: Promise<void> = Promise.resolve()
  constructor(options: { directory: string, runtimeEpoch: string, loginSessionId: string, nativeGeneration?: string, nativeBuildId?: string }) {
    const { directory, ...identity } = options
    this.#path = join(directory, "lifecycle.json")
    this.#identity = Object.freeze(identity)
  }

  record(event: RuntimeLifecycleEvent, reason?: string): Promise<void> {
    const entry = entrySchema.parse({ ...this.#identity, event, recordedAt: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 1024) }) })
    const write = async () => {
      const existing = await readStorageFile(this.#path, fileSchema) ?? { format: "meta-runtime-lifecycle" as const, version: 1 as const, entries: [] }
      const value = fileSchema.parse({ ...existing, entries: [...existing.entries, entry].slice(-128) })
      try { await atomicReplace(this.#path, new TextEncoder().encode(canonicalJson(value))) }
      catch (error) {
        const observed = await readStorageFile(this.#path, fileSchema)
        if (observed === undefined || canonicalJson(observed) !== canonicalJson(value)) throw error
        await syncFileAndParent(this.#path)
      }
    }
    const pending = this.#tail.then(write, write)
    this.#tail = pending.catch(() => undefined)
    return pending
  }

  async entries() { await this.#tail; return (await readStorageFile(this.#path, fileSchema))?.entries ?? [] }
  async flush(): Promise<void> { await this.#tail }
}
