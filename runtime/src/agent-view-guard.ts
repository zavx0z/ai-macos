import {
  observedEventSchema,
  opaqueIdSchema,
  operationTargetSchema,
  operationRecordSchema,
  structurallyEqual,
  type ObservedEvent,
  type ObserverCoverage,
  type OperationRecord,
} from "@meta/shared/contracts"
import type { AgentTarget, AgentTargetActionResolution } from "./agent-targets.ts"
import type { RuntimeNativeObserverHub } from "./observer-hub.ts"
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export type AgentViewObserver = Pick<
  RuntimeNativeObserverHub,
  "observerInstanceRef" | "coverage" | "subscribe"
>

export type AgentViewTarget = Extract<AgentTarget, {
  kind: "window" | "surface" | "display" | "desktop-layout"
}>

export type AgentObservationDraft = Readonly<{
  targetId: string
  startedAt: string
}>

export type AgentViewTicket = Readonly<{
  targetId: string
  observedAt: string
  expiresAt?: string
}>

export type AgentViewAdmissionProof = Readonly<{
  viewNonce: string
  targetId: string
  operationId: string
  observerInstanceRef: string
  expectedCoverageStartCursor: string
  baselineCursor: string
  baselineNextSequence: number
  observedCursor: string
  observedNextSequence: number
  admissionCursor: string
  admissionNextSequence: number
  expiresAt: string
}>

export interface AgentViewScope {
  beginObservation(targetId: string, target: AgentViewTarget): Promise<AgentObservationDraft>
  commitObservation(draft: AgentObservationDraft): Promise<AgentViewTicket>
  cancelObservation(draft: AgentObservationDraft): void
  admit(
    ticket: AgentViewTicket,
    operationId: string,
    deadlineAt?: string,
  ): Promise<AgentViewAdmissionProof>
  settleOperation(ticket: AgentViewTicket, operation: OperationRecord): Promise<void>
  invalidateView(ticket: AgentViewTicket, reason: string): void
}

type ViewRecord = {
  viewNonce: string
  lineageId: string
  targetId: string
  target: AgentViewTarget
  state: "draft" | "fresh" | "stale"
  startedAtMs: number
  observedAtMs?: number
  expiresAtMs?: number
  retainUntilMs: number
  baselineCursor: string
  baselineNextSequence: number
  observedCursor?: string
  observedNextSequence?: number
  reason?: string
}

type BoundOperation = {
  deadlineAtMs: number
  operationId: string
  record: ViewRecord
}

export type AgentViewGuardOptions = {
  generation: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string }
  observer: AgentViewObserver
  resolveTarget(lineageId: string, targetId: string): Promise<AgentTargetActionResolution> | AgentTargetActionResolution
  clock?: RuntimeClock
  ids?: RuntimeIdSource
  ticketTtlMs?: number
  retentionMs?: number
  syncTimeoutMs?: number
  maxCoverageLagMs?: number
  maxRecords?: number
  maxBytes?: number
}

/** Связывает agent view с непрерывным cursor одного Runtime Native observer hub. */
export class AgentViewGuard {
  readonly #generation: AgentViewGuardOptions["generation"]
  readonly #observer: AgentViewObserver
  readonly #resolveTarget: AgentViewGuardOptions["resolveTarget"]
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #ticketTtlMs: number | undefined
  readonly #retentionMs: number
  readonly #syncTimeoutMs: number
  readonly #maxCoverageLagMs: number | undefined
  readonly #maxRecords: number
  readonly #maxBytes: number
  readonly #records = new Map<string, ViewRecord>()
  readonly #current = new Map<string, string>()
  readonly #operations = new Map<string, BoundOperation>()
  readonly #draftKeys = new WeakMap<AgentObservationDraft, string>()
  readonly #ticketKeys = new WeakMap<AgentViewTicket, string>()
  readonly #readerAbort = new AbortController()
  #reader: Promise<void> | undefined
  #startPromise: Promise<void> | undefined
  #started = false
  #closed = false
  #terminalError: Error | undefined
  #coverageStartCursor: string | undefined
  #cursor: string | undefined
  #nextSequence: number | undefined
  #pulse: Promise<void> = Promise.resolve()
  #resolvePulse: (() => void) | undefined

  constructor(options: AgentViewGuardOptions) {
    this.#generation = Object.freeze({ ...options.generation })
    this.#observer = options.observer
    this.#resolveTarget = options.resolveTarget
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#ticketTtlMs = options.ticketTtlMs === undefined ? undefined : limit(options.ticketTtlMs, 1, 120_000, "view ticket TTL")
    this.#retentionMs = limit(options.retentionMs ?? 300_000, this.#ticketTtlMs ?? 1, 30 * 60_000, "view retention")
    this.#syncTimeoutMs = limit(options.syncTimeoutMs ?? 1000, 1, 5000, "observer sync timeout")
    this.#maxCoverageLagMs = options.maxCoverageLagMs === undefined ? undefined : limit(options.maxCoverageLagMs, 1, 5000, "observer coverage lag")
    this.#maxRecords = limit(options.maxRecords ?? 4096, 1, 10_000, "view record count")
    this.#maxBytes = limit(options.maxBytes ?? 4 * 1024 * 1024, 1024, 64 * 1024 * 1024, "view record bytes")
    for (const value of Object.values(this.#generation)) opaqueIdSchema.parse(value)
    opaqueIdSchema.parse(this.#observer.observerInstanceRef)
  }

  get available(): boolean {
    return this.#started && !this.#closed && this.#terminalError === undefined
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Agent view guard закрыт")
    this.#startPromise ??= this.#startOnce()
    try { await this.#startPromise }
    catch (error) {
      if (!this.#started && this.#terminalError === undefined) this.#startPromise = undefined
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#readerAbort.abort("agent view guard closed")
    this.#invalidateAll("Agent view guard закрыт")
    if (this.#reader !== undefined) {
      await withTimeout(this.#reader, this.#syncTimeoutMs, "Agent view guard close timeout").catch(() => undefined)
    }
  }

  forLineage(trustedLineageId: string): AgentViewScope {
    const lineageId = opaqueIdSchema.parse(trustedLineageId)
    const scope: AgentViewScope = {
      beginObservation: (targetId, target) => this.#beginObservation(lineageId, targetId, target),
      commitObservation: draft => this.#commitObservation(lineageId, draft),
      cancelObservation: draft => this.#cancelObservation(lineageId, draft),
      admit: (ticket, operationId, deadlineAt) => this.#admit(lineageId, ticket, operationId, deadlineAt),
      settleOperation: (ticket, operation) => this.#settleOperation(lineageId, ticket, operation),
      invalidateView: (ticket, reason) => this.#invalidateView(lineageId, ticket, reason),
    }
    return Object.freeze(scope)
  }

  releaseLineage(lineageId: string): void {
    for (const record of this.#records.values()) {
      if (record.lineageId === lineageId) this.#invalidate(record, "Client lineage закрыта")
    }
    this.#prune()
  }

  stats() {
    this.#prune()
    return Object.freeze({
      records: this.#records.size,
      operations: this.#operations.size,
      bytes: this.#usageBytes(),
    })
  }

  async #beginObservation(lineageId: string, rawTargetId: string, rawTarget: AgentViewTarget): Promise<AgentObservationDraft> {
    await this.#ensureStarted()
    this.#prune()
    this.#assertCapacity(1)
    const targetId = opaqueIdSchema.parse(rawTargetId)
    const target = parseTarget(rawTarget, this.#generation)
    const resolved = await this.#resolveTarget(lineageId, targetId)
    if (
      resolved.targetId !== targetId
      || !structurallyEqual(parseTarget(resolved.target, this.#generation), target)
    ) throw new Error("Agent view targetId не совпадает с trusted exact target binding")
    const coverage = await this.#synchronize()
    const now = this.#clock.now().getTime()
    const viewNonce = this.#uniqueId("agent-view")
    const record: ViewRecord = {
      viewNonce,
      lineageId,
      targetId,
      target,
      state: "draft",
      startedAtMs: now,
      expiresAtMs: this.#ticketTtlMs === undefined ? undefined : now + this.#ticketTtlMs,
      retainUntilMs: now + this.#retentionMs,
      baselineCursor: coverage.cursor,
      baselineNextSequence: coverage.nextSequence,
    }
    this.#records.set(viewNonce, record)
    try { this.#assertByteBudget() }
    catch (error) { this.#records.delete(viewNonce); throw error }
    const draft = Object.freeze({ targetId, startedAt: timestamp(now) })
    this.#draftKeys.set(draft, viewNonce)
    return draft
  }

  async #commitObservation(lineageId: string, draft: AgentObservationDraft): Promise<AgentViewTicket> {
    const record = this.#recordForDraft(lineageId, draft)
    const coverage = await this.#synchronize()
    if (record.state !== "draft") throw new Error(record.reason ?? "Observation draft invalidated")
    if (
      coverage.coverageStartCursor !== this.#coverageStartCursor
      || coverage.nextSequence < record.baselineNextSequence
    ) {
      this.#invalidate(record, "Observer watermark не продолжает observation baseline")
      throw new Error(record.reason)
    }
    const currentKey = viewKey(lineageId, record.targetId)
    const previous = this.#current.get(currentKey)
    if (previous !== undefined && previous !== record.viewNonce) {
      const old = this.#records.get(previous)
      if (old !== undefined) this.#invalidate(old, "Новый successful observe заменил прежний view")
    }
    const now = this.#clock.now().getTime()
    record.state = "fresh"
    record.observedAtMs = now
    record.observedCursor = coverage.cursor
    record.observedNextSequence = coverage.nextSequence
    record.expiresAtMs = this.#ticketTtlMs === undefined ? undefined : now + this.#ticketTtlMs
    record.retainUntilMs = now + this.#retentionMs
    this.#current.set(currentKey, record.viewNonce)
    try { this.#assertByteBudget() }
    catch (error) {
      this.#invalidate(record, "Observation metadata превысила byte budget")
      throw error
    }
    const ticket = Object.freeze({ targetId: record.targetId, observedAt: timestamp(now), ...(record.expiresAtMs === undefined ? {} : { expiresAt: timestamp(record.expiresAtMs) }) })
    this.#ticketKeys.set(ticket, record.viewNonce)
    return ticket
  }

  #cancelObservation(lineageId: string, draft: AgentObservationDraft): void {
    const record = this.#recordForDraft(lineageId, draft)
    if (record.state === "draft") this.#records.delete(record.viewNonce)
  }

  async #admit(
    lineageId: string,
    ticket: AgentViewTicket,
    rawOperationId: string,
    deadlineAt?: string,
  ): Promise<AgentViewAdmissionProof> {
    const record = this.#freshTicket(lineageId, ticket)
    const operationId = opaqueIdSchema.parse(rawOperationId)
    if (this.#operations.has(operationId)) throw new Error("Agent view operation уже admitted")
    const coverage = await this.#synchronize()
    this.#assertFresh(record)
    const now = this.#clock.now().getTime()
    const deadlineAtMs = deadlineAt === undefined ? now + 120_000 : Date.parse(deadlineAt)
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= now) throw new Error("View admission operation deadline")
    const binding: BoundOperation = {
      deadlineAtMs,
      operationId,
      record,
    }
    this.#invalidateViews("View consumed by admitted action")
    this.#operations.set(operationId, binding)
    try {
      this.#assertCapacity(0)
      this.#assertByteBudget()
    } catch (error) {
      this.#operations.delete(operationId)
      throw error
    }
    return this.#proof(record, binding, coverage)
  }

  async #settleOperation(
    lineageId: string,
    ticket: AgentViewTicket,
    rawOperation: OperationRecord,
  ): Promise<void> {
    const record = this.#recordForTicket(lineageId, ticket)
    const operation = operationRecordSchema.parse(rawOperation)
    const binding = this.#operations.get(operation.context.operationId)
    if (binding === undefined || binding.record !== record) throw new Error("Operation не admitted этим view")
    try {
      if (!structurallyEqual(operation.context.target, record.target)) {
        throw new Error("Terminal operation содержит другой exact target")
      }
      if (!["rejected", "completed", "cancelled", "failed", "interrupted-unknown"].includes(operation.state)) {
        throw new Error("Agent view operation ещё не terminal")
      }
    } finally {
      this.#operations.delete(binding.operationId)
    }
  }

  #invalidateView(lineageId: string, ticket: AgentViewTicket, rawReason: string): void {
    const record = this.#recordForTicket(lineageId, ticket)
    this.#invalidate(record, boundedReason(rawReason))
  }

  async #consume(events: AsyncIterable<ObservedEvent>): Promise<void> {
    try {
      for await (const raw of events) {
        if (this.#readerAbort.signal.aborted) return
        const event = observedEventSchema.parse(raw)
        if (
          event.runtimeEpoch !== this.#generation.runtimeEpoch
          || event.loginSessionId !== this.#generation.loginSessionId
          || event.nativeGeneration !== this.#generation.nativeGeneration
          || event.sequence !== this.#nextSequence
          || event.cursor === this.#cursor
        ) {
          this.#terminal(new Error("Agent view observer event continuity нарушена"), "Observer continuity lost")
          return
        }
        await this.#handleEvent(event)
        this.#cursor = event.cursor
        this.#nextSequence = event.sequence + 1
        this.#notifyPulse()
      }
      if (!this.#readerAbort.signal.aborted) this.#terminal(new Error("Observer EOF"), "Observer stream EOF")
    } catch (error) {
      if (!this.#readerAbort.signal.aborted) this.#terminal(error, "Observer stream/history loss")
    }
  }

  async #handleEvent(event: ObservedEvent): Promise<void> {
    if (event.source === "synthetic") {
      this.#invalidateAll(`Observer synthetic ${event.kind}`)
      return
    }
    if (event.kind === "lifecycle") {
      this.#invalidateAll(`Observer lifecycle ${event.lifecycle ?? "unknown"}`)
      return
    }
    if (event.kind === "window-structure") {
      if (event.target === undefined) {
        this.#invalidateAll("Unknown window structure event")
        return
      }
      for (const record of this.#records.values()) {
        if (relevantStructure(record.target, event.target)) this.#invalidate(record, "Relevant window structure changed")
      }
      return
    }
    this.#invalidateAll(`Observer ${event.kind}/${event.source}`)
  }

  async #synchronize(): Promise<ObserverCoverage> {
    await this.#ensureStarted()
    const deadline = this.#clock.now().getTime() + this.#syncTimeoutMs
    const coverage = await this.#healthyCoverage()
    while (
      this.#nextSequence === undefined
      || this.#nextSequence < coverage.nextSequence
    ) {
      if (this.#terminalError !== undefined) throw this.#terminalError
      if (this.#closed) throw new Error("Agent view guard закрыт")
      const remaining = deadline - this.#clock.now().getTime()
      if (remaining <= 0) {
        this.#invalidateAll("Observer hub watermark sync timeout")
        throw new Error("Observer hub watermark sync timeout")
      }
      try {
        await withTimeout(this.#nextPulse(), remaining, "Observer hub watermark sync timeout")
      } catch (error) {
        this.#invalidateAll("Observer hub watermark sync timeout")
        throw error
      }
    }
    if (this.#terminalError !== undefined) throw this.#terminalError
    if (this.#closed) throw new Error("Agent view guard закрыт")
    if (this.#nextSequence === coverage.nextSequence && this.#cursor !== coverage.cursor) {
      this.#terminal(new Error("Observer hub watermark cursor mismatch"), "Observer continuity lost")
      throw this.#terminalError
    }
    // Уже обработанные более новые события не откатываем к старому снимку.
    return { ...coverage, cursor: this.#cursor!, nextSequence: this.#nextSequence! }
  }

  async #healthyCoverage(): Promise<ObserverCoverage> {
    const coverage = await this.#observer.coverage(this.#readerAbort.signal)
    const now = this.#clock.now().getTime()
    const requiredKinds: ObservedEvent["kind"][] = ["input", "focus", "window-structure", "lifecycle"]
    const failures: string[] = []
    if (coverage.state !== "ready") failures.push(`state=${coverage.state}`)
    if (coverage.gapDetected) failures.push("gapDetected")
    if (coverage.droppedEvents !== 0) failures.push(`droppedEvents=${coverage.droppedEvents}`)
    if (coverage.runtimeEpoch !== this.#generation.runtimeEpoch
      || coverage.loginSessionId !== this.#generation.loginSessionId
      || coverage.nativeGeneration !== this.#generation.nativeGeneration) failures.push("generation mismatch")
    const missing = requiredKinds.filter(kind => !coverage.coveredKinds.includes(kind))
    if (missing.length > 0) failures.push(`missingKinds=${missing.join(",")}`)
    const lag = now - Date.parse(coverage.coveredThrough)
    if (!Number.isFinite(lag) || this.#maxCoverageLagMs !== undefined && lag > this.#maxCoverageLagMs) failures.push(`coverageLagMs=${lag}`)
    const heartbeat = Date.parse(coverage.heartbeatAt)
    if (!Number.isFinite(heartbeat) || heartbeat > now + 1000) failures.push("heartbeat timestamp invalid")
    if (this.#coverageStartCursor !== undefined
      && coverage.coverageStartCursor !== this.#coverageStartCursor) failures.push("coverageStartCursor changed")
    if (failures.length > 0) {
      const reason = `Observer coverage не подтверждает healthy continuous watermark: ${failures.join("; ")}${coverage.reason === undefined ? "" : `; ${coverage.reason}`}`
      this.#invalidateAll(reason.slice(0, 1024))
      throw new Error(reason)
    }
    return coverage
  }

  async #ensureStarted(): Promise<void> {
    if (this.#terminalError !== undefined) throw this.#terminalError
    if (this.#closed) throw new Error("Agent view guard закрыт")
    if (!this.#started) await this.start()
  }

  async #startOnce(): Promise<void> {
    const coverage = await this.#healthyCoverage()
    this.#coverageStartCursor = coverage.coverageStartCursor
    this.#cursor = coverage.cursor
    this.#nextSequence = coverage.nextSequence
    let events: AsyncIterable<ObservedEvent>
    try {
      events = this.#observer.subscribe({ signal: this.#readerAbort.signal, afterCursor: coverage.cursor })
    } catch (error) {
      this.#terminal(error, "Observer history baseline недоступен")
      throw this.#terminalError
    }
    this.#started = true
    this.#reader = this.#consume(events)
    await this.#synchronize()
  }

  #proof(
    record: ViewRecord,
    binding: BoundOperation,
    coverage: ObserverCoverage,
  ): AgentViewAdmissionProof {
    if (record.observedCursor === undefined || record.observedNextSequence === undefined) {
      throw new Error("View observation watermark отсутствует")
    }
    // Native admission обязан проверить instance и admission cursor прямо перед
    // первым dispatch. Этот TS receipt сам по себе не закрывает межпроцессную race.
    return Object.freeze({
      viewNonce: record.viewNonce,
      targetId: record.targetId,
      operationId: binding.operationId,
      observerInstanceRef: this.#observer.observerInstanceRef,
      expectedCoverageStartCursor: this.#coverageStartCursor!,
      baselineCursor: record.baselineCursor,
      baselineNextSequence: record.baselineNextSequence,
      observedCursor: record.observedCursor,
      observedNextSequence: record.observedNextSequence,
      admissionCursor: coverage.cursor,
      admissionNextSequence: coverage.nextSequence,
      // Это срок доставки одноразового допуска, не возраст исходного снимка.
      expiresAt: timestamp(Math.min(record.expiresAtMs ?? Infinity, binding.deadlineAtMs)),
    })
  }

  #freshTicket(lineageId: string, ticket: AgentViewTicket): ViewRecord {
    const record = this.#recordForTicket(lineageId, ticket)
    this.#assertFresh(record)
    return record
  }

  #assertFresh(record: ViewRecord): void {
    if (record.state !== "fresh") throw new Error(record.reason ?? "Agent view stale")
    if (record.expiresAtMs !== undefined && this.#clock.now().getTime() >= record.expiresAtMs) {
      this.#invalidate(record, "Agent view ticket истёк")
      throw new Error(record.reason)
    }
    if (this.#current.get(viewKey(record.lineageId, record.targetId)) !== record.viewNonce) {
      this.#invalidate(record, "Agent view заменён новым observation")
      throw new Error(record.reason)
    }
  }

  #recordForDraft(lineageId: string, draft: AgentObservationDraft): ViewRecord {
    const key = this.#draftKeys.get(draft)
    const record = key === undefined ? undefined : this.#records.get(key)
    if (record === undefined || record.lineageId !== lineageId || record.targetId !== draft.targetId) {
      throw new Error("Observation draft не принадлежит этой lineage")
    }
    return record
  }

  #recordForTicket(lineageId: string, ticket: AgentViewTicket): ViewRecord {
    const key = this.#ticketKeys.get(ticket)
    const record = key === undefined ? undefined : this.#records.get(key)
    if (record === undefined || record.lineageId !== lineageId || record.targetId !== ticket.targetId) {
      throw new Error("View ticket не принадлежит этой lineage")
    }
    return record
  }

  #invalidate(record: ViewRecord, reason: string): void {
    if (record.state === "stale") return
    record.state = "stale"
    record.reason = boundedReason(reason)
    record.retainUntilMs = Math.max(record.retainUntilMs, this.#clock.now().getTime() + this.#retentionMs)
    const key = viewKey(record.lineageId, record.targetId)
    if (this.#current.get(key) === record.viewNonce) this.#current.delete(key)
  }

  #invalidateAll(reason: string): void {
    this.#invalidateViews(reason)
  }

  #invalidateViews(reason: string): void {
    for (const record of this.#records.values()) this.#invalidate(record, reason)
  }

  #terminal(error: unknown, prefix: string): void {
    if (this.#terminalError !== undefined) return
    const detail = error instanceof Error ? error.message : String(error)
    this.#terminalError = new Error(`${prefix}: ${detail}`)
    this.#invalidateAll(this.#terminalError.message)
    this.#notifyPulse()
  }

  #prune(): void {
    const now = this.#clock.now().getTime()
    for (const record of this.#records.values()) {
      if (record.state !== "stale" && record.expiresAtMs !== undefined && now >= record.expiresAtMs) this.#invalidate(record, "Agent view ticket истёк")
    }
    const retainedRecords = new Set([...this.#operations.values()].map(operation => operation.record))
    for (const [id, record] of this.#records) {
      if (record.state === "stale" && now >= record.retainUntilMs && !retainedRecords.has(record)) this.#records.delete(id)
    }
  }

  #assertCapacity(additional: number): void {
    if (this.#records.size + this.#operations.size + additional > this.#maxRecords) {
      throw new Error("Agent view record capacity исчерпана")
    }
  }

  #assertByteBudget(): void {
    if (this.#usageBytes() > this.#maxBytes) throw new Error("Agent view byte budget исчерпан")
  }

  #usageBytes(): number {
    const records = [...this.#records.values()].map(record => ({
      ...record,
      target: record.target,
      reasonBudget: "x".repeat(256),
    }))
    const operations = [...this.#operations.values()].map(binding => ({
      operationId: binding.operationId,
      viewNonce: binding.record.viewNonce,
    }))
    return Buffer.byteLength(canonicalJson({ records, operations }), "utf8")
  }

  #uniqueId(prefix: string): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const value = opaqueIdSchema.parse(this.#ids.next(prefix))
      if (!this.#records.has(value) && !this.#operations.has(value)) return value
    }
    throw new Error(`Не удалось выдать unique ${prefix}`)
  }

  #nextPulse(): Promise<void> {
    if (this.#resolvePulse === undefined) {
      this.#pulse = new Promise(resolve => { this.#resolvePulse = resolve })
    }
    return this.#pulse
  }

  #notifyPulse(): void {
    const resolve = this.#resolvePulse
    this.#resolvePulse = undefined
    resolve?.()
  }
}

function parseTarget(value: AgentTarget, generation: AgentViewGuardOptions["generation"]): AgentViewTarget {
  const target = operationTargetSchema.parse(value)
  if (target.kind !== "window" && target.kind !== "surface"
    && target.kind !== "display" && target.kind !== "desktop-layout") {
    throw new Error("Agent Native view поддерживает только window/surface/display/desktop-layout")
  }
  if (
    target.ref.runtimeEpoch !== generation.runtimeEpoch
    || target.ref.loginSessionId !== generation.loginSessionId
    || target.ref.nativeGeneration !== generation.nativeGeneration
  ) throw new Error("Agent view target принадлежит другой native generation")
  return target
}

function relevantStructure(left: AgentViewTarget, right: ObservedEvent["target"]): boolean {
  if (left.kind === "display" || left.kind === "desktop-layout") return true
  if (right === undefined) return true
  if (structurallyEqual(left, right)) return true
  if (!("applicationRef" in left.ref) || !("applicationRef" in right.ref)) return false
  if (left.ref.applicationRef !== right.ref.applicationRef) return false
  if (left.kind === "window" && right.kind === "surface") return right.ref.ownerWindowRef === left.ref.windowRef
  if (left.kind === "surface" && right.kind === "window") return left.ref.ownerWindowRef === right.ref.windowRef
  return left.kind === "window" || left.kind === "surface"
}

function viewKey(lineageId: string, targetId: string): string {
  return canonicalJson([lineageId, targetId])
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function boundedText(value: string, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${name} вне bounds`)
  return value
}

function boundedReason(value: string): string {
  return boundedText(value, 1024, "view invalidation reason").slice(0, 256)
}

function limit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} вне bounds`)
  return value
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
