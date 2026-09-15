import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { z, parseWireJson } from "@meta/shared/contracts"
import { storedClientSessionSchema, type StoredClientSession } from "./client-sessions.ts"
import { atomicReplace, syncFileAndParent } from "./storage/atomic-file.ts"
import { canonicalJson, sha256 } from "./primitives.ts"

const stateSchema = z.strictObject({
  format: z.literal("meta-runtime-client-state"), version: z.literal(1),
  loginSessionId: z.string().min(1).max(64), keyGeneration: z.string().min(1).max(127),
  secretHex: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().safe().min(1),
  sessions: z.array(storedClientSessionSchema).max(10_000),
})
const envelopeSchema = z.strictObject({ state: stateSchema, checksum: z.string().regex(/^[a-f0-9]{64}$/) })
export type DurableClientState = z.infer<typeof stateSchema>
const MAX_STATE_BYTES = 8 * 1024 * 1024

/** Хранит только hashes credentials и runtime-owned lineage, без plaintext payload. */
export class FileClientState {
  #current?: DurableClientState
  #tail: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}

  async initialize(loginSessionId: string): Promise<DurableClientState> {
    const stored = await this.#read()
    if (stored !== undefined) {
      if (stored.loginSessionId !== loginSessionId) throw new Error("Client state принадлежит другой login session")
      this.#current = stored
      return structuredClone(stored)
    }
    const state = stateSchema.parse({ format: "meta-runtime-client-state", version: 1, loginSessionId,
      keyGeneration: `hmac-key:${crypto.randomUUID()}`, secretHex: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      revision: 1, sessions: [] })
    await this.#write(state)
    this.#current = state
    return structuredClone(state)
  }

  async persist(sessions: readonly StoredClientSession[]): Promise<void> {
    const snapshot = structuredClone(sessions)
    const write = async () => {
      if (this.#current === undefined) throw new Error("Client state не инициализирован")
      const state = stateSchema.parse({ ...this.#current, revision: this.#current.revision + 1, sessions: snapshot })
      await this.#write(state)
      this.#current = state
    }
    const pending = this.#tail.then(write)
    this.#tail = pending
    await pending
  }

  async #write(state: DurableClientState): Promise<void> {
    const bytes = new TextEncoder().encode(canonicalJson({ state, checksum: sha256(canonicalJson(state)) }))
    if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("Client state serialized budget exceeded")
    try { await atomicReplace(this.path, bytes) }
    catch (error) {
      const observed = await this.#read()
      if (observed === undefined || canonicalJson(observed) !== canonicalJson(state)) throw error
      await syncFileAndParent(this.path)
    }
  }

  async #read(): Promise<DurableClientState | undefined> {
    let handle
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > MAX_STATE_BYTES) throw new Error("Client state небезопасен или превышает budget")
      const bytes = Buffer.alloc(info.size + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
      if (bytesRead !== info.size) throw new Error("Client state изменился во время чтения")
      const envelope = parseWireJson(envelopeSchema, bytes.subarray(0, bytesRead).toString("utf8"), { maxBytes: MAX_STATE_BYTES, maxDepth: 16 })
      if (sha256(canonicalJson(envelope.state)) !== envelope.checksum) throw new Error("Client state checksum mismatch")
      return envelope.state
    } finally { await handle.close() }
  }
}
