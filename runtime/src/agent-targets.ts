import {
  axInspectionResultSchema,
  opaqueIdSchema,
  operationTargetSchema,
  structurallyEqual,
  type AxInspectionResult,
  type ElementRef,
  type OperationTarget,
} from "@meta/shared/contracts"
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export type AgentTarget = Extract<OperationTarget, {
  kind:
    | "window"
    | "surface"
    | "browser-instance"
    | "browser-target"
    | "device"
    | "device-browser-instance"
    | "device-browser-target"
}>

export type AgentTargetAuthority = {
  inventoryId: string
  inventoryRevision: number
}

export type AgentTargetHandle = {
  targetId: string
  kind: AgentTarget["kind"]
  actionExpiresAt: string
}

export type AgentElementHandle = {
  elementId: string
  role: string
  subrole: string
  title: string
  actions: string[]
}

export type AgentTargetActionResolution = AgentTargetAuthority & {
  targetId: string
  target: AgentTarget
  actionExpiresAt: string
}

export type AgentTargetControlResolution = AgentTargetAuthority & {
  targetId: string
  target: AgentTarget
  state: "active" | "closed" | "invalidated"
  actionExpiresAt: string
  controlExpiresAt: string
  reason?: string
}

export type AgentElementResolution = {
  targetId: string
  elementId: string
  snapshotId: string
  elementRef: ElementRef
  actions: string[]
  expiresAt: string
}

export interface AgentTargetScope {
  registerTarget(target: AgentTarget, authority: AgentTargetAuthority): AgentTargetHandle
  resolveAction(targetId: string): AgentTargetActionResolution
  resolveControl(targetId: string): AgentTargetControlResolution
  closeTarget(targetId: string, reason: string): void
  invalidateTarget(targetId: string, reason: string): void
  retainControl(targetId: string, ownerKey: string): void
  releaseControl(targetId: string, ownerKey: string): void
  invalidateElements(targetId: string): void
  registerElements(targetId: string, result: AxInspectionResult): AgentElementHandle[]
  resolveElement(targetId: string, elementId: string, requiredAction?: string): AgentElementResolution
}

type TargetEntry = {
  targetId: string
  lineageId: string
  identityKey: string
  target: AgentTarget
  authority: AgentTargetAuthority
  state: "active" | "closed" | "invalidated"
  actionExpiresAtMs: number
  controlExpiresAtMs: number
  reason?: string
  latestSnapshotId?: string
  elementIds: Set<string>
  controlOwners: Set<string>
  bytes: number
}

type ElementEntry = {
  elementId: string
  targetId: string
  snapshotId: string
  elementRef: ElementRef
  actions: string[]
  expiresAtMs: number
  bytes: number
}

type LineageStore = {
  targets: Map<string, TargetEntry>
  identities: Map<string, string>
}

export type AgentTargetRegistryOptions = {
  generation: { runtimeEpoch: string, loginSessionId: string }
  clock?: RuntimeClock
  ids?: RuntimeIdSource
  actionTtlMs?: number
  controlRetentionMs?: number
  elementTtlMs?: number
  maxTargets?: number
  maxElements?: number
  maxBytes?: number
}

/** Хранит opaque agent handles отдельно для каждой доверенной client lineage. */
export class AgentTargetRegistry {
  readonly #generation: { runtimeEpoch: string, loginSessionId: string }
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #actionTtlMs: number
  readonly #controlRetentionMs: number
  readonly #elementTtlMs: number
  readonly #maxTargets: number
  readonly #maxElements: number
  readonly #maxBytes: number
  readonly #lineages = new Map<string, LineageStore>()
  readonly #targets = new Map<string, TargetEntry>()
  readonly #elements = new Map<string, ElementEntry>()
  #targetCount = 0
  #bytes = 0

  constructor(options: AgentTargetRegistryOptions) {
    this.#generation = Object.freeze({ ...options.generation })
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#actionTtlMs = bounded(options.actionTtlMs ?? 60_000, 1, 120_000, "action TTL")
    this.#controlRetentionMs = bounded(options.controlRetentionMs ?? 300_000, 1, 30 * 60_000, "control retention")
    if (this.#controlRetentionMs < this.#actionTtlMs) throw new Error("Control retention не может быть короче action TTL")
    this.#elementTtlMs = bounded(options.elementTtlMs ?? 60_000, 1, 120_000, "element TTL")
    this.#maxTargets = bounded(options.maxTargets ?? 4096, 1, 10_000, "target count")
    this.#maxElements = bounded(options.maxElements ?? 10_000, 1, 100_000, "element count")
    this.#maxBytes = bounded(options.maxBytes ?? 8 * 1024 * 1024, 1024, 64 * 1024 * 1024, "registry bytes")
    opaqueIdSchema.parse(this.#generation.runtimeEpoch)
    opaqueIdSchema.parse(this.#generation.loginSessionId)
  }

  forLineage(trustedLineageId: string): AgentTargetScope {
    const lineageId = opaqueIdSchema.parse(trustedLineageId)
    const scope: AgentTargetScope = {
      registerTarget: (target, authority) => this.#registerTarget(lineageId, target, authority),
      resolveAction: targetId => this.#resolveAction(lineageId, targetId),
      resolveControl: targetId => this.#resolveControl(lineageId, targetId),
      closeTarget: (targetId, reason) => this.#invalidateTarget(lineageId, targetId, "closed", reason),
      invalidateTarget: (targetId, reason) => this.#invalidateTarget(lineageId, targetId, "invalidated", reason),
      retainControl: (targetId, ownerKey) => this.#retainControl(lineageId, targetId, ownerKey),
      releaseControl: (targetId, ownerKey) => this.#releaseControl(lineageId, targetId, ownerKey),
      invalidateElements: targetId => this.#invalidateElementsFor(lineageId, targetId),
      registerElements: (targetId, result) => this.#registerElements(lineageId, targetId, result),
      resolveElement: (targetId, elementId, requiredAction) =>
        this.#resolveElement(lineageId, targetId, elementId, requiredAction),
    }
    return Object.freeze(scope)
  }

  prune(): void {
    const now = this.#clock.now().getTime()
    for (const element of [...this.#elements.values()]) {
      if (now >= element.expiresAtMs) this.#deleteElement(element)
    }
    for (const [lineageId, store] of this.#lineages) {
      for (const entry of [...store.targets.values()]) {
        if (now < entry.controlExpiresAtMs || entry.controlOwners.size > 0) continue
        this.#deleteTarget(store, entry)
      }
      if (store.targets.size === 0) this.#lineages.delete(lineageId)
    }
  }

  stats() {
    return Object.freeze({
      lineages: this.#lineages.size,
      targets: this.#targets.size,
      elements: this.#elements.size,
      bytes: this.#bytes,
    })
  }

  #registerTarget(lineageId: string, rawTarget: AgentTarget, rawAuthority: AgentTargetAuthority): AgentTargetHandle {
    this.prune()
    const target = parseAgentTarget(rawTarget)
    this.#assertGeneration(target)
    const authority = parseAuthority(rawAuthority)
    const existingStore = this.#lineages.get(lineageId)
    const store = existingStore ?? { targets: new Map(), identities: new Map() }
    const identityKey = canonicalJson(target)
    const existingId = store.identities.get(identityKey)
    const existing = existingId === undefined ? undefined : store.targets.get(existingId)
    const now = this.#clock.now().getTime()
    if (existing !== undefined && existing.state === "active") {
      if (authority.inventoryRevision < existing.authority.inventoryRevision) {
        throw new Error("Agent target registration использует stale inventory revision")
      }
      const nextActionExpiresAtMs = now + this.#actionTtlMs
      const nextControlExpiresAtMs = Math.max(existing.controlExpiresAtMs, now + this.#controlRetentionMs)
      const nextBytes = targetBytes({
        ...existing,
        authority,
        actionExpiresAtMs: nextActionExpiresAtMs,
        controlExpiresAtMs: nextControlExpiresAtMs,
      })
      this.#assertCapacity(0, 0, nextBytes - existing.bytes)
      this.#bytes += nextBytes - existing.bytes
      existing.authority = authority
      existing.actionExpiresAtMs = nextActionExpiresAtMs
      existing.controlExpiresAtMs = nextControlExpiresAtMs
      existing.bytes = nextBytes
      return publicTarget(existing)
    }

    const targetId = this.#uniqueId("agent-target", id => this.#targets.has(id))
    const entry: TargetEntry = {
      targetId,
      lineageId,
      identityKey,
      target,
      authority,
      state: "active",
      actionExpiresAtMs: now + this.#actionTtlMs,
      controlExpiresAtMs: now + this.#controlRetentionMs,
      elementIds: new Set(),
      controlOwners: new Set(),
      bytes: 0,
    }
    entry.bytes = targetBytes(entry)
    this.#assertCapacity(1, 0, entry.bytes)
    if (existingStore === undefined) this.#lineages.set(lineageId, store)
    store.targets.set(targetId, entry)
    store.identities.set(identityKey, targetId)
    this.#targets.set(targetId, entry)
    this.#targetCount += 1
    this.#bytes += entry.bytes
    return publicTarget(entry)
  }

  #resolveAction(lineageId: string, targetId: string): AgentTargetActionResolution {
    this.prune()
    const entry = this.#ownTarget(lineageId, targetId)
    if (entry.state !== "active") throw new Error(`Agent target ${entry.state}; получите fresh state`)
    if (this.#clock.now().getTime() >= entry.actionExpiresAtMs) {
      throw new Error("Agent target action TTL истёк; получите fresh state")
    }
    return Object.freeze({
      targetId: entry.targetId,
      target: structuredClone(entry.target),
      ...entry.authority,
      actionExpiresAt: timestamp(entry.actionExpiresAtMs),
    })
  }

  #resolveControl(lineageId: string, targetId: string): AgentTargetControlResolution {
    this.prune()
    const entry = this.#ownTarget(lineageId, targetId)
    const now = this.#clock.now().getTime()
    if (now >= entry.controlExpiresAtMs && entry.controlOwners.size === 0) {
      throw new Error("Agent target control retention истёк")
    }
    return Object.freeze({
      targetId: entry.targetId,
      target: structuredClone(entry.target),
      ...entry.authority,
      state: entry.state,
      actionExpiresAt: timestamp(entry.actionExpiresAtMs),
      controlExpiresAt: timestamp(entry.controlExpiresAtMs),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })
  }

  #invalidateTarget(
    lineageId: string,
    targetId: string,
    state: "closed" | "invalidated",
    rawReason: string,
  ): void {
    const entry = this.#ownTarget(lineageId, targetId)
    const reason = boundedText(rawReason, 1024, "target invalidation reason")
    if (entry.state !== "active" && entry.state !== state) {
      throw new Error("Agent target terminal state conflict")
    }
    const now = this.#clock.now().getTime()
    const nextActionExpiresAtMs = Math.min(entry.actionExpiresAtMs, now)
    const nextControlExpiresAtMs = Math.max(entry.controlExpiresAtMs, now + this.#controlRetentionMs)
    const nextBytes = targetBytes({
      ...entry,
      state,
      reason,
      latestSnapshotId: undefined,
      actionExpiresAtMs: nextActionExpiresAtMs,
      controlExpiresAtMs: nextControlExpiresAtMs,
    })
    this.#assertCapacity(0, 0, nextBytes - entry.bytes)
    if (entry.state === "active") this.#lineages.get(lineageId)!.identities.delete(entry.identityKey)
    this.#bytes += nextBytes - entry.bytes
    entry.state = state
    entry.reason = reason
    entry.actionExpiresAtMs = nextActionExpiresAtMs
    entry.controlExpiresAtMs = nextControlExpiresAtMs
    entry.latestSnapshotId = undefined
    entry.bytes = nextBytes
    this.#deleteElements(entry)
  }

  #retainControl(lineageId: string, targetId: string, rawOwnerKey: string): void {
    const entry = this.#ownTarget(lineageId, this.#resolveAction(lineageId, targetId).targetId)
    const ownerKey = opaqueIdSchema.parse(rawOwnerKey)
    if (entry.controlOwners.has(ownerKey)) return
    if (entry.controlOwners.size >= 128) throw new Error("Agent target active control owner limit исчерпан")
    const addedBytes = textBytes(ownerKey) + 8
    this.#assertCapacity(0, 0, addedBytes)
    entry.controlOwners.add(ownerKey)
    entry.bytes += addedBytes
    entry.controlExpiresAtMs = Math.max(entry.controlExpiresAtMs, this.#clock.now().getTime() + this.#controlRetentionMs)
    this.#bytes += addedBytes
  }

  #releaseControl(lineageId: string, targetId: string, rawOwnerKey: string): void {
    const entry = this.#ownTarget(lineageId, targetId)
    const ownerKey = opaqueIdSchema.parse(rawOwnerKey)
    if (!entry.controlOwners.delete(ownerKey)) throw new Error("Agent target control owner не зарегистрирован")
    const removedBytes = textBytes(ownerKey) + 8
    entry.bytes -= removedBytes
    this.#bytes -= removedBytes
    entry.controlExpiresAtMs = Math.max(entry.controlExpiresAtMs, this.#clock.now().getTime() + this.#controlRetentionMs)
  }

  #invalidateElementsFor(lineageId: string, targetId: string): void {
    const entry = this.#ownTarget(lineageId, targetId)
    this.#deleteElements(entry)
    const previousBytes = entry.bytes
    entry.latestSnapshotId = undefined
    entry.bytes = targetBytes(entry)
    this.#bytes += entry.bytes - previousBytes
  }

  #registerElements(lineageId: string, targetId: string, rawResult: AxInspectionResult): AgentElementHandle[] {
    const target = this.#resolveAction(lineageId, targetId)
    if (target.target.kind !== "window" && target.target.kind !== "surface") {
      throw new Error("AX elements разрешены только для window/surface target")
    }
    const result = axInspectionResultSchema.parse(rawResult)
    if (!structurallyEqual(result.target, target.target)) {
      throw new Error("AX snapshot принадлежит другому exact parent target")
    }
    this.prune()
    const parent = this.#ownTarget(lineageId, targetId)
    const expiresAtMs = Math.min(parent.actionExpiresAtMs, this.#clock.now().getTime() + this.#elementTtlMs)
    const pendingIds = new Set<string>()
    const pending = result.nodes.map(node => {
      const elementId = this.#uniqueId("agent-element", id => this.#elements.has(id) || pendingIds.has(id))
      pendingIds.add(elementId)
      const entry: ElementEntry = {
        elementId,
        targetId,
        snapshotId: result.snapshotId,
        elementRef: structuredClone(node.elementRef),
        actions: [...node.actions],
        expiresAtMs,
        bytes: 0,
      }
      entry.bytes = elementBytes(entry, node.role, node.subrole, node.title)
      return { entry, node }
    })
    const oldBytes = [...parent.elementIds].reduce((sum, id) => sum + (this.#elements.get(id)?.bytes ?? 0), 0)
    const newBytes = pending.reduce((sum, item) => sum + item.entry.bytes, 0)
    const nextParentBytes = targetBytes({ ...parent, latestSnapshotId: result.snapshotId })
    this.#assertCapacity(
      0,
      pending.length - parent.elementIds.size,
      newBytes - oldBytes + nextParentBytes - parent.bytes,
    )
    this.#deleteElements(parent)
    this.#bytes += nextParentBytes - parent.bytes
    parent.bytes = nextParentBytes
    parent.latestSnapshotId = result.snapshotId
    for (const { entry } of pending) {
      this.#elements.set(entry.elementId, entry)
      parent.elementIds.add(entry.elementId)
      this.#bytes += entry.bytes
    }
    return pending.map(({ entry, node }) => Object.freeze({
      elementId: entry.elementId,
      role: node.role,
      subrole: node.subrole,
      title: node.title,
      actions: [...node.actions],
    }))
  }

  #resolveElement(
    lineageId: string,
    targetId: string,
    rawElementId: string,
    rawRequiredAction?: string,
  ): AgentElementResolution {
    this.#resolveAction(lineageId, targetId)
    const elementId = opaqueIdSchema.parse(rawElementId)
    const entry = this.#elements.get(elementId)
    const parent = this.#ownTarget(lineageId, targetId)
    if (entry === undefined || entry.targetId !== targetId || parent.latestSnapshotId !== entry.snapshotId) {
      throw new Error("AX element handle не принадлежит latest target snapshot")
    }
    if (this.#clock.now().getTime() >= entry.expiresAtMs) {
      this.#deleteElement(entry)
      throw new Error("AX element handle истёк")
    }
    if (rawRequiredAction !== undefined) {
      const action = boundedText(rawRequiredAction, 128, "AX action")
      if (!entry.actions.includes(action)) throw new Error(`AX element не объявляет action ${action}`)
    }
    return Object.freeze({
      targetId,
      elementId,
      snapshotId: entry.snapshotId,
      elementRef: structuredClone(entry.elementRef),
      actions: [...entry.actions],
      expiresAt: timestamp(entry.expiresAtMs),
    })
  }

  #assertGeneration(target: AgentTarget): void {
    if (
      target.ref.runtimeEpoch !== this.#generation.runtimeEpoch
      || target.ref.loginSessionId !== this.#generation.loginSessionId
    ) {
      throw new Error("Agent target принадлежит другой runtime/login generation")
    }
  }

  #ownTarget(lineageId: string, rawTargetId: string): TargetEntry {
    const targetId = opaqueIdSchema.parse(rawTargetId)
    const entry = this.#targets.get(targetId)
    if (entry === undefined || entry.lineageId !== lineageId) throw new Error("Agent target не найден в этой client lineage")
    return entry
  }

  #deleteElements(parent: TargetEntry): void {
    for (const id of [...parent.elementIds]) {
      const element = this.#elements.get(id)
      if (element !== undefined) this.#deleteElement(element)
    }
    parent.elementIds.clear()
  }

  #deleteElement(element: ElementEntry): void {
    if (!this.#elements.delete(element.elementId)) return
    this.#targets.get(element.targetId)?.elementIds.delete(element.elementId)
    this.#bytes -= element.bytes
  }

  #deleteTarget(store: LineageStore, entry: TargetEntry): void {
    if (entry.controlOwners.size > 0) throw new Error("Active control ownership нельзя удалить")
    this.#deleteElements(entry)
    store.targets.delete(entry.targetId)
    this.#targets.delete(entry.targetId)
    if (store.identities.get(entry.identityKey) === entry.targetId) store.identities.delete(entry.identityKey)
    this.#targetCount -= 1
    this.#bytes -= entry.bytes
  }

  #assertCapacity(targetDelta: number, elementDelta: number, byteDelta: number): void {
    if (this.#targetCount + targetDelta > this.#maxTargets) throw new Error("Agent target registry capacity исчерпана")
    if (this.#elements.size + elementDelta > this.#maxElements) throw new Error("Agent element registry capacity исчерпана")
    if (this.#bytes + byteDelta > this.#maxBytes) throw new Error("Agent target registry byte budget исчерпан")
  }

  #uniqueId(prefix: string, exists: (id: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const value = opaqueIdSchema.parse(this.#ids.next(prefix))
      if (!exists(value)) return value
    }
    throw new Error(`Не удалось выдать unique ${prefix} ID`)
  }
}

function parseAgentTarget(value: AgentTarget): AgentTarget {
  const target = operationTargetSchema.parse(value)
  if (![
    "window",
    "surface",
    "browser-instance",
    "browser-target",
    "device",
    "device-browser-instance",
    "device-browser-target",
  ].includes(target.kind)) throw new Error("Operation target не поддержан high-level agent registry")
  return structuredClone(target) as AgentTarget
}

function parseAuthority(value: AgentTargetAuthority): AgentTargetAuthority {
  return Object.freeze({
    inventoryId: opaqueIdSchema.parse(value.inventoryId),
    inventoryRevision: bounded(value.inventoryRevision, 0, Number.MAX_SAFE_INTEGER, "inventory revision"),
  })
}

function publicTarget(entry: TargetEntry): AgentTargetHandle {
  return Object.freeze({
    targetId: entry.targetId,
    kind: entry.target.kind,
    actionExpiresAt: timestamp(entry.actionExpiresAtMs),
  })
}

function targetBytes(entry: TargetEntry): number {
  return textBytes(canonicalJson({
    targetId: entry.targetId,
    lineageId: entry.lineageId,
    target: entry.target,
    authority: entry.authority,
    state: entry.state,
    reason: entry.reason,
    latestSnapshotId: entry.latestSnapshotId,
    actionExpiresAtMs: entry.actionExpiresAtMs,
    controlExpiresAtMs: entry.controlExpiresAtMs,
  })) + [...entry.controlOwners].reduce((sum, value) => sum + textBytes(value) + 8, 0)
}

function elementBytes(entry: ElementEntry, role: string, subrole: string, title: string): number {
  return textBytes(canonicalJson({
    elementId: entry.elementId,
    targetId: entry.targetId,
    snapshotId: entry.snapshotId,
    elementRef: entry.elementRef,
    actions: entry.actions,
    role,
    subrole,
    title,
  }))
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} вне bounds`)
  return value
}

function boundedText(value: string, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${name} вне bounds`)
  return value
}
