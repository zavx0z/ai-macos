import { join } from "node:path"
import {
  lifetimeReservationHandleSchema,
  z,
} from "@meta/shared/contracts"
import { atomicReplace, type DurableWriteOptions } from "./storage/atomic-file.ts"
import {
  MAX_STORAGE_FILE_BYTES,
  STORAGE_FORMAT_VERSION,
  assertRecordCapacity,
  readStorageFile,
  sha256,
  stableJson,
  storageFileName,
  storageFiles,
} from "./storage/common.ts"

export const lifetimePhysicalOwnershipKeySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("chrome-cdp"),
    endpointHost: z.enum(["127.0.0.1", "localhost", "::1"]),
    endpointPort: z.number().int().min(1).max(65_535),
    profilePath: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("android-forward"),
    serial: z.string().min(1).max(256),
    localPort: z.number().int().min(1).max(65_535),
    remoteSocket: z.literal("localabstract:chrome_devtools_remote"),
  }),
])
export type LifetimePhysicalOwnershipKey = z.infer<typeof lifetimePhysicalOwnershipKeySchema>

export const lifetimeStableOwnerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser"), browserInstanceRef: z.string().min(1).max(127) }),
  z.strictObject({
    kind: z.literal("device-browser"),
    deviceRef: z.string().min(1).max(127),
    serial: z.string().min(1).max(256),
    browserInstanceRef: z.string().min(1).max(127),
  }),
])
export type LifetimeStableOwner = z.infer<typeof lifetimeStableOwnerSchema>

export const lifetimeBindingPersistenceSchema = z.strictObject({
  owner: lifetimeStableOwnerSchema,
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  physicalOwnershipKey: lifetimePhysicalOwnershipKeySchema,
})
export type LifetimeBindingPersistence = z.infer<typeof lifetimeBindingPersistenceSchema>

export const lifetimeStateRecordSchema = z.strictObject({
  runtimeEpoch: z.string().min(1).max(64),
  loginSessionId: z.string().min(1).max(64),
  bindingId: z.string().min(1).max(127),
  owner: lifetimeStableOwnerSchema,
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  physicalOwnershipKey: lifetimePhysicalOwnershipKeySchema,
  lineageId: z.string().min(1).max(127),
  operationId: z.string().min(1).max(127),
  initialTarget: lifetimeReservationHandleSchema.shape.target,
  target: lifetimeReservationHandleSchema.shape.target,
  handle: lifetimeReservationHandleSchema.optional(),
  state: z.enum(["connecting", "active", "quarantined", "released"]),
  revision: z.number().int().safe().min(1),
  operationIds: z.array(z.string().min(1).max(127)).min(1).max(10_000),
  updatedAt: z.iso.datetime({ offset: true }),
}).superRefine((record, context) => {
  if (record.state === "connecting" && record.handle !== undefined) {
    context.addIssue({ code: "custom", path: ["handle"], message: "connecting lifetime record ещё не имеет handle" })
  }
  if (record.state === "active" && record.handle === undefined) {
    context.addIssue({ code: "custom", path: ["handle"], message: `${record.state} lifetime record требует handle` })
  }
  if (new Set(record.operationIds).size !== record.operationIds.length) {
    context.addIssue({ code: "custom", path: ["operationIds"], message: "operation ID не должен повторяться" })
  }
  if (
    (record.physicalOwnershipKey.kind === "chrome-cdp" && record.target.kind !== "browser-instance")
    || (record.physicalOwnershipKey.kind === "android-forward" && record.target.kind !== "device-browser-instance")
  ) {
    context.addIssue({ code: "custom", path: ["physicalOwnershipKey"], message: "Physical ownership domain не совпадает с target" })
  }
  if (
    (record.owner.kind === "browser" && (record.target.kind !== "browser-instance"
      || record.owner.browserInstanceRef !== record.target.ref.browserInstanceRef))
    || (record.owner.kind === "device-browser" && (record.target.kind !== "device-browser-instance"
      || record.owner.deviceRef !== record.target.ref.deviceRef
      || record.owner.serial !== record.target.ref.serial
      || record.owner.browserInstanceRef !== record.target.ref.browserInstanceRef))
  ) {
    context.addIssue({ code: "custom", path: ["owner"], message: "Stable owner не совпадает с target" })
  }
})
export type LifetimeStateRecord = z.infer<typeof lifetimeStateRecordSchema>

const lifetimeEnvelopeSchema = z.strictObject({
  format: z.literal("meta-runtime-lifetime-state"),
  version: z.literal(STORAGE_FORMAT_VERSION),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  record: lifetimeStateRecordSchema,
})

export interface PersistentLifetimeStore {
  persist(record: LifetimeStateRecord): Promise<LifetimeStateRecord>
  loadAll(): Promise<LifetimeStateRecord[]>
}

export class FileLifetimeStore implements PersistentLifetimeStore {
  readonly #directory: string
  readonly #writeOptions: DurableWriteOptions
  #tail: Promise<void> = Promise.resolve()

  constructor(directory: string, writeOptions: DurableWriteOptions = {}) {
    this.#directory = directory
    this.#writeOptions = writeOptions
  }

  async persist(value: LifetimeStateRecord): Promise<LifetimeStateRecord> {
    return await this.#exclusive(async () => {
      const record = lifetimeStateRecordSchema.parse(value)
      const path = this.#path(record.physicalOwnershipKey)
      const existing = await this.#read(path)
      if (existing !== undefined) assertLifetimeTransition(existing, record)
      await assertRecordCapacity(this.#directory, path)
      const checksum = lifetimeChecksum(record)
      const bytes = new TextEncoder().encode(JSON.stringify({
        format: "meta-runtime-lifetime-state",
        version: STORAGE_FORMAT_VERSION,
        checksum,
        record,
      }))
      if (bytes.byteLength > MAX_STORAGE_FILE_BYTES) throw new Error("Lifetime state превышает byte limit")
      await atomicReplace(path, bytes, this.#writeOptions)
      return structuredClone(record)
    })
  }

  async loadAll(): Promise<LifetimeStateRecord[]> {
    return await this.#exclusive(async () => {
      const records: LifetimeStateRecord[] = []
      for (const path of await storageFiles(this.#directory)) {
        const record = await this.#read(path)
        if (record === undefined) throw new Error(`Lifetime record исчез: ${path}`)
        records.push(record)
      }
      return records
    })
  }

  async #read(path: string): Promise<LifetimeStateRecord | undefined> {
    const envelope = await readStorageFile(path, lifetimeEnvelopeSchema)
    if (envelope === undefined) return undefined
    if (this.#path(envelope.record.physicalOwnershipKey) !== path) throw new Error("Lifetime filename не совпадает с physical ownership key")
    if (lifetimeChecksum(envelope.record) !== envelope.checksum) throw new Error("Lifetime checksum не совпадает")
    return structuredClone(envelope.record)
  }

  #path(key: LifetimePhysicalOwnershipKey): string {
    return join(this.#directory, storageFileName(["lifetime", stableJson(key)]))
  }

  async #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return await result
  }
}

export function lifetimeConfigFingerprint(value: unknown): string {
  return sha256(stableJson(value))
}

function lifetimeChecksum(record: LifetimeStateRecord): string {
  return sha256(stableJson(record))
}

function assertLifetimeTransition(previous: LifetimeStateRecord, next: LifetimeStateRecord): void {
  if (next.revision <= previous.revision) throw new Error("Lifetime revision должна возрастать")
  if (previous.state !== "released") {
    for (const field of ["bindingId", "owner", "configFingerprint", "physicalOwnershipKey", "lineageId", "operationId", "initialTarget"] as const) {
      if (stableJson(previous[field]) !== stableJson(next[field])) throw new Error(`Lifetime transition изменила immutable ${field}`)
    }
    const allowed: Record<LifetimeStateRecord["state"], readonly LifetimeStateRecord["state"][]> = {
      connecting: ["connecting", "active", "quarantined"],
      active: ["active", "quarantined", "released"],
      quarantined: ["quarantined", "released"],
      released: [],
    }
    if (!allowed[previous.state].includes(next.state)) throw new Error(`Lifetime state transition ${previous.state}->${next.state} запрещён`)
  }
}
