import {
  cleanupAuthorityReceiptSchema,
  cleanupCoversExactHandles,
  cleanupOutcomeSchema,
  runtimeResourceHandleSchema,
  sortRuntimeResources,
  type CleanupAuthority,
  type CleanupAuthorityReceipt,
  type CleanupOutcome,
  type ResourceAuthority,
  type ResourceAuthorityRequest,
  type RuntimeClientSession,
  type RuntimeGeneration,
  type RuntimeResourceHandle,
  type RuntimeResourceRef,
} from "@meta/shared/contracts"
import { canonicalJson, hmacSha256, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

type ResourceSlot = {
  issued: RuntimeResourceHandle
  current: RuntimeResourceHandle
}

export class ResourceRegistry implements ResourceAuthority, CleanupAuthority {
  readonly #generation: RuntimeGeneration
  readonly #secret: Uint8Array
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #slots = new Map<string, ResourceSlot>()
  readonly #receipts = new Map<string, CleanupAuthorityReceipt>()
  readonly #tombstones = new Map<string, {
    issued: RuntimeResourceHandle
    current: RuntimeResourceHandle
    receipt?: CleanupAuthorityReceipt
  }>()

  constructor(
    generation: RuntimeGeneration,
    secret: Uint8Array,
    options: { clock?: RuntimeClock, ids?: RuntimeIdSource } = {},
  ) {
    this.#generation = generation
    this.#secret = secret
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  acquire(
    session: RuntimeClientSession,
    operationId: string,
    requested: readonly RuntimeResourceRef[],
    expiresAt: string,
  ): RuntimeResourceHandle[] {
    const canonical = sortRuntimeResources(requested)
    const identities = canonical.map(resourceKey)
    if (new Set(identities).size !== identities.length) throw new Error("Resource request содержит дубликат")
    for (const identity of identities) {
      const occupied = this.#slots.get(identity)?.current
      if (occupied === undefined) continue
      if (occupied.state === "quarantined") throw new Error(`Resource quarantined: ${identity}`)
      throw new Error(`Resource занят operation ${occupied.operationId}: ${identity}`)
    }
    const handles = canonical.map(resource => runtimeResourceHandleSchema.parse({
      ...resource,
      leaseId: this.#ids.next("lease"),
      leaseGeneration: this.#ids.next("lease-generation"),
      operationId,
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      ...this.#generation,
      expiresAt,
      state: "active",
    }))
    for (const handle of handles) {
      const stored = Object.freeze({ ...handle })
      this.#slots.set(resourceKey(stored), { issued: stored, current: stored })
    }
    return handles.map(handle => ({ ...handle }))
  }

  async assertActive(request: ResourceAuthorityRequest): Promise<void> {
    const stored = this.#slots.get(resourceKey(request.handle))?.current
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(request.handle)) {
      throw new Error("Resource handle не выдан runtime")
    }
    if (
      stored.state !== "active"
      || stored.operationId !== request.operationId
      || stored.clientSessionId !== request.clientSessionId
      || stored.principalId !== request.principalId
      || stored.runtimeEpoch !== request.runtimeEpoch
      || stored.loginSessionId !== request.loginSessionId
      || request.now.getTime() >= Date.parse(stored.expiresAt)
    ) {
      throw new Error("Resource handle отозван, истёк или принадлежит другой authority")
    }
  }

  async assertOwnedSet(operationId: string, handles: readonly RuntimeResourceHandle[]): Promise<void> {
    for (const handle of handles) {
      const stored = this.#slots.get(resourceKey(handle))?.issued
      if (stored === undefined || stored.operationId !== operationId || canonicalJson(stored) !== canonicalJson(handle)) {
        throw new Error("Operation не владеет resource handle")
      }
    }
  }

  applyCleanup(operationId: string, handles: readonly RuntimeResourceHandle[], value: unknown): CleanupAuthorityReceipt | undefined {
    const staged = this.prepareCleanup(operationId, handles, value)
    staged.commit()
    return staged.receipt
  }

  prepareCleanup(operationId: string, handles: readonly RuntimeResourceHandle[], value: unknown, from: "active" | "quarantined" = "active") {
    const cleanup = cleanupOutcomeSchema.parse(value)
    if (cleanup.state === "pending") throw new Error("Pending cleanup не является backend completion")
    if (!cleanupCoversExactHandles(handles, cleanup)) throw new Error("Cleanup не покрывает exact operation resources")
    if (handles.length > 0 && cleanup.scope !== "owned") throw new Error("Operation resources потеряны в cleanup")
    const planned = (cleanup.scope === "owned" ? cleanup.resources : []).map(resource => {
      const key = resourceKey(resource.handle)
      const slot = this.#slots.get(key)
      const stored = slot?.issued
      if (
        stored === undefined
        || slot?.current.state !== from
        || stored.operationId !== operationId
        || canonicalJson(stored) !== canonicalJson(resource.handle)
      ) {
        throw new Error("Cleanup содержит чужой resource")
      }
      return { resource, key, stored, current: slot.current }
    })
    const receipt = cleanup.state === "complete" ? this.#makeReceipt(operationId, handles) : undefined
    let committed = false
    return { receipt, commit: () => {
      if (committed) return
      for (const item of planned) {
        if (this.#slots.get(item.key)?.current !== item.current) throw new Error("Cleanup changed during durable staging")
      }
      if (receipt !== undefined) this.#receipts.set(receipt.receiptId, receipt)
      for (const { resource, key, stored } of planned) {
      if (resource.outcome === "released") {
        this.#slots.delete(key)
        this.#tombstones.set(stored.leaseId, {
          issued: stored,
          current: Object.freeze({ ...stored, state: "revoked" }),
          ...(receipt === undefined ? {} : { receipt }),
        })
      } else {
        const slot = this.#slots.get(key)
        if (slot === undefined) throw new Error("Resource slot исчез во время cleanup commit")
        this.#slots.set(key, { issued: slot.issued, current: Object.freeze({ ...slot.current, state: "quarantined" }) })
      }
      }
      committed = true
    } }
  }

  quarantine(operationId: string): CleanupOutcome {
    const resources = [...this.#slots.values()]
      .map(slot => slot.issued)
      .filter(handle => handle.operationId === operationId)
      .map(handle => {
        const quarantined = { ...handle, state: "quarantined" as const }
        this.#slots.set(resourceKey(handle), { issued: handle, current: Object.freeze(quarantined) })
        return { handle, outcome: "quarantined" as const }
      })
    if (resources.length === 0) return cleanupOutcomeSchema.parse({ scope: "none", state: "complete", resources: [] })
    return cleanupOutcomeSchema.parse({
      scope: "owned",
      state: "unknown",
      reason: "operation outcome или cleanup не подтверждены",
      resources,
    })
  }

  async verify(receipt: CleanupAuthorityReceipt, handles: readonly RuntimeResourceHandle[]): Promise<void> {
    const stored = this.#receipts.get(receipt.receiptId)
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(receipt)) throw new Error("Cleanup receipt не выдан runtime")
    if (handles.length !== receipt.leases.length || handles.some(handle => !receipt.leases.some(lease => {
      return lease.leaseId === handle.leaseId && lease.leaseGeneration === handle.leaseGeneration
    }))) {
      throw new Error("Cleanup receipt не покрывает exact leases")
    }
  }

  handlesForOperation(operationId: string): RuntimeResourceHandle[] {
    return [...this.#slots.values()]
      .map(slot => slot.current)
      .filter(handle => handle.operationId === operationId)
      .map(handle => ({ ...handle }))
  }

  handleByLeaseId(leaseId: string): RuntimeResourceHandle | undefined {
    const handle = [...this.#slots.values()].map(slot => slot.current).find(candidate => candidate.leaseId === leaseId)
    if (handle !== undefined) return { ...handle }
    const tombstone = this.#tombstones.get(leaseId)?.current
    return tombstone === undefined ? undefined : { ...tombstone }
  }

  cleanupReceiptByLeaseId(leaseId: string): CleanupAuthorityReceipt | undefined {
    const receipt = this.#tombstones.get(leaseId)?.receipt
    return receipt === undefined ? undefined : structuredClone(receipt)
  }

  quarantinedCount(): number {
    return [...this.#slots.values()].filter(slot => slot.current.state === "quarantined").length
  }

  reconcileCleanup(
    operationId: string,
    handles: readonly RuntimeResourceHandle[],
    cleanupValue: unknown,
  ): CleanupAuthorityReceipt {
    const cleanup = cleanupOutcomeSchema.parse(cleanupValue)
    if (cleanup.state !== "complete" || !cleanupCoversExactHandles(handles, cleanup) || cleanup.scope !== "owned") {
      throw new Error("Late reconciliation требует exact complete/released partition")
    }
    const staged = this.prepareCleanup(operationId, handles, cleanup, "quarantined")
    staged.commit()
    return staged.receipt!
  }

  #makeReceipt(operationId: string, handles: readonly RuntimeResourceHandle[]): CleanupAuthorityReceipt {
    const payload = {
      operationId,
      ...this.#generation,
      leases: handles.map(handle => ({ leaseId: handle.leaseId, leaseGeneration: handle.leaseGeneration })),
    }
    const receipt = cleanupAuthorityReceiptSchema.parse({
      receiptId: this.#ids.next("cleanup-receipt"),
      authorityRef: `cleanup-authority:${hmacSha256(this.#secret, canonicalJson(payload)).slice(0, 32)}`,
      ...payload,
      issuedAt: this.#clock.now().toISOString(),
      state: "complete",
    })
    return receipt
  }
}

function resourceKey(resource: RuntimeResourceRef): string {
  return `${resource.kind}:${resource.resourceRef}`
}
