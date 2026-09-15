import {
  observerAllowsLeaseExtension,
  observerAllowsRestoration,
  nativeOperationTargetSchema,
  observedEventSchema,
  observerCoverageSchema,
  runtimeOperationIntentSchema,
  structurallyEqual,
  type AdapterResult,
  type NativeExecutionContext,
  type NativeOperationTarget,
  type ObservedEvent,
  type ObserverCoverage,
  type OperationRecord,
  type RuntimeClientSession,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import { RuntimeContractError } from "./errors.ts"
import { randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export const INTERACTION_LIMITS = Object.freeze({
  idleMs: 30_000,
  hardMs: 120_000,
  observerLagMs: 1_000,
  operationMs: 8_000,
  maxActive: 128,
  maxRecords: 10_000,
  terminalRetentionMs: 86_400_000,
  observerRequestMs: 500,
  closeMs: 1_000,
})

export type InteractionFocusSnapshot =
  | Readonly<{ state: "known", target: NativeOperationTarget, proofRef: string }>
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "unknown", reason: string }>

export type InteractionFocusReceipt = Readonly<{
  receiptId: string
  bindingRef: string
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration: string
  operationId: string
  requestedTarget: NativeOperationTarget
  actualTarget: NativeOperationTarget
  previousFocus: InteractionFocusSnapshot
  focusProofRef: string
  observerCoverage: ObserverCoverage
  startedAt: string
}>

export type InteractionFocusValue = Readonly<{
  requestedTarget: NativeOperationTarget
  actualTarget: NativeOperationTarget
  previousFocus: InteractionFocusSnapshot
  focusProofRef: string
}>

export type InteractionEndValue = Readonly<{
  restoration: "restored" | "kept-target" | "skipped-external-change" | "failed" | "unknown"
  currentFocus?: NativeOperationTarget
  restoredFocus?: NativeOperationTarget
}>

export interface InteractionNativeBinding {
  readonly bindingRef: string
  readonly nativeGeneration: string
  beginFocus(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: { target: NativeOperationTarget, inventoryId: string, inventoryRevision: number },
  ): Promise<{
    result: AdapterResult<InteractionFocusValue>
    receipt: InteractionFocusReceipt
  }>
  observerCoverage(): Promise<ObserverCoverage>
  events(signal: AbortSignal): AsyncIterable<ObservedEvent>
  ownsSyntheticEvent(receipt: InteractionFocusReceipt, event: ObservedEvent): Promise<boolean>
  verifyFocusReceipt(receipt: InteractionFocusReceipt, operation: OperationRecord): Promise<void>
  endRestore(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: {
      receipt: InteractionFocusReceipt
      currentCoverage?: ObserverCoverage
      restoreAllowed: boolean
    },
  ): Promise<AdapterResult<InteractionEndValue>>
}

export type InteractionBeginRequest = Readonly<{
  clientRequestId: string
  target: NativeOperationTarget
  inventoryId: string
  inventoryRevision: number
}>

export type InteractionBeginResult = Readonly<{
  interactionId: string
  state: InteractionState
  idleExpiresAt: string
  hardExpiresAt: string
  receipt: InteractionFocusReceipt
  operation: OperationRecord
  reason?: string
  tombstone?: InteractionTombstone
}>

export type InteractionTombstone = Readonly<{
  tombstoneId: string
  interactionId: string
  state: "revoked" | "expired" | "ended"
  reason?: string
  terminalAt: string
}>

export type InteractionEndRequest = Readonly<{
  clientRequestId: string
  interactionId: string
}>

export type InteractionEndResult = Readonly<{
  interactionId: string
  state: "ended" | "revoked" | "expired"
  reason?: string
  endedAt: string
  operation: OperationRecord
  tombstone: InteractionTombstone
}>

export type InteractionState = "active" | "revoked" | "expired" | "ended"

type InteractionRecord = {
  interactionId: string
  lineageId: string
  clientSessionId: string
  target: NativeOperationTarget
  inventoryId: string
  inventoryRevision: number
  receipt: InteractionFocusReceipt
  state: InteractionState
  startedAtMs: number
  lastActivityAtMs: number
  idleExpiresAtMs: number
  hardExpiresAtMs: number
  reason?: string
  terminalAtMs?: number
  timer?: ReturnType<typeof setTimeout>
  steps: Map<string, AbortController>
  endResult?: InteractionEndResult
  tombstone?: InteractionTombstone
}

type StoredRequest<T> = {
  input: unknown
  promise: Promise<T>
}

export class RuntimeInteractionAuthority {
  readonly #core: RuntimeCore
  readonly #binding: InteractionNativeBinding
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #records = new Map<string, InteractionRecord>()
  readonly #beginRequests = new Map<string, StoredRequest<InteractionBeginResult>>()
  readonly #endRequests = new Map<string, StoredRequest<InteractionEndResult>>()
  readonly #pendingLineages = new Set<string>()
  readonly #eventsAbort = new AbortController()
  #eventsTask: Promise<void> | undefined
  #closed = false
  readonly #observerRequestMs: number
  readonly #closeMs: number

  constructor(options: {
    core: RuntimeCore
    binding: InteractionNativeBinding
    now?: RuntimeClock
    ids?: RuntimeIdSource
    observerRequestMs?: number
    closeMs?: number
  }) {
    this.#core = options.core
    this.#binding = Object.freeze(options.binding)
    this.#clock = options.now ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#observerRequestMs = boundedOption(options.observerRequestMs, INTERACTION_LIMITS.observerRequestMs)
    this.#closeMs = boundedOption(options.closeMs, INTERACTION_LIMITS.closeMs)
    if (this.#binding.bindingRef.length === 0 || this.#binding.nativeGeneration.length === 0) {
      throw new Error("Interaction binding не содержит identity")
    }
  }

  async begin(
    session: RuntimeClientSession,
    request: InteractionBeginRequest,
    signal?: AbortSignal,
  ): Promise<InteractionBeginResult> {
    this.#assertOpen()
    const lineageId = await this.#lineage(session)
    const key = `${lineageId}:${request.clientRequestId}`
    const existing = this.#beginRequests.get(key)
    if (existing !== undefined) {
      if (!structurallyEqual(existing.input, request)) throw requestMismatch("interaction-begin")
      const previous = await existing.promise
      const record = this.#records.get(previous.interactionId)
      if (record === undefined) throw receiptExpired("interaction-begin")
      return this.#beginSnapshot(previous, record)
    }
    if (this.#beginRequests.size + this.#endRequests.size >= INTERACTION_LIMITS.maxRecords) {
      throw new RuntimeContractError("operation-in-progress", "Interaction request tombstone budget исчерпан", "interaction-begin")
    }
    const promise = this.#beginNew(session, lineageId, request, signal)
    this.#beginRequests.set(key, { input: structuredClone(request), promise })
    return await promise
  }

  async runStep<T>(
    session: RuntimeClientSession,
    interactionId: string,
    target: NativeOperationTarget,
    signal: AbortSignal | undefined,
    callback: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen()
    const record = await this.#activeRecord(session, interactionId, target)
    const now = this.#clock.now()
    let coverage: ObserverCoverage | undefined
    try {
      coverage = await bounded(
        this.#binding.observerCoverage(),
        this.#observerRequestMs,
        signal,
        "interaction observer coverage",
      )
    } catch (error) {
      if (signal?.aborted) {
        throw new RuntimeContractError("cancelled", "Interaction step отменён во время observer check", "interaction-step", {
          recoveryAction: "get-operation",
        })
      }
      this.#revoke(record, "revoked", "observer coverage недоступен или превысил deadline")
      throw new RuntimeContractError(
        "user-interference",
        error instanceof Error ? error.message : "Observer coverage недоступен",
        "interaction-step",
        { recoveryAction: "request-user-action" },
      )
    }
    const current = await this.#activeRecord(session, interactionId, target)
    if (current !== record) {
      throw new RuntimeContractError("lease-revoked", "Interaction identity изменилась во время observer check", "interaction-step")
    }
    if (coverage === undefined || !this.#coverageAllows(record, coverage, now, "extension")) {
      this.#revoke(record, "revoked", "observer coverage не разрешает interaction step")
      throw new RuntimeContractError(
        "user-interference",
        "Interaction отозван: observer coverage недостаточен",
        "interaction-step",
        { recoveryAction: "request-user-action" },
      )
    }
    record.lastActivityAtMs = now.getTime()
    record.idleExpiresAtMs = Math.min(record.lastActivityAtMs + INTERACTION_LIMITS.idleMs, record.hardExpiresAtMs)
    this.#scheduleExpiry(record)

    const stepId = this.#ids.next("interaction-step")
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason ?? "interaction step caller aborted")
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    record.steps.set(stepId, controller)
    try {
      if (controller.signal.aborted) {
        throw new RuntimeContractError("cancelled", "Interaction step отменён до callback", "interaction-step", {
          recoveryAction: "get-operation",
        })
      }
      return await callback(controller.signal)
    } finally {
      signal?.removeEventListener("abort", onAbort)
      record.steps.delete(stepId)
    }
  }

  async end(
    session: RuntimeClientSession,
    request: InteractionEndRequest,
    signal?: AbortSignal,
  ): Promise<InteractionEndResult> {
    this.#assertOpen()
    const lineageId = await this.#lineage(session)
    const key = `${lineageId}:${request.clientRequestId}`
    const existing = this.#endRequests.get(key)
    if (existing !== undefined) {
      if (!structurallyEqual(existing.input, request)) throw requestMismatch("interaction-end")
      const previous = await existing.promise
      if (!this.#records.has(previous.interactionId)) throw receiptExpired("interaction-end")
      return previous
    }
    if (this.#beginRequests.size + this.#endRequests.size >= INTERACTION_LIMITS.maxRecords) {
      throw new RuntimeContractError("operation-in-progress", "Interaction request tombstone budget исчерпан", "interaction-end")
    }
    const promise = this.#endExisting(session, lineageId, request, signal)
    this.#endRequests.set(key, { input: structuredClone(request), promise })
    return await promise
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#eventsAbort.abort("interaction authority closed")
    for (const record of this.#records.values()) this.#revoke(record, "revoked", "interaction authority closed")
    if (this.#eventsTask !== undefined) {
      await bounded(this.#eventsTask, this.#closeMs, undefined, "interaction observer close").catch(() => undefined)
    }
  }

  revokeClientSession(clientSessionId: string, reason = "client disconnected"): void {
    for (const record of this.#records.values()) {
      if (record.clientSessionId === clientSessionId) this.#revoke(record, "revoked", reason)
    }
  }

  async #beginNew(
    session: RuntimeClientSession,
    lineageId: string,
    request: InteractionBeginRequest,
    signal?: AbortSignal,
  ): Promise<InteractionBeginResult> {
    this.#prune()
    if ([...this.#records.values()].filter(record => record.state === "active").length >= INTERACTION_LIMITS.maxActive) {
      throw new RuntimeContractError("operation-in-progress", "Достигнут предел active interactions", "interaction-begin")
    }
    if (
      this.#pendingLineages.has(lineageId)
      || [...this.#records.values()].some(record => record.lineageId === lineageId && record.state === "active")
    ) {
      throw new RuntimeContractError("operation-in-progress", "Client lineage уже имеет active interaction", "interaction-begin")
    }
    this.#pendingLineages.add(lineageId)
    try {
      this.#assertTargetGeneration(request.target)
      let nativeReceipt: InteractionFocusReceipt | undefined
      const deadlineAt = new Date(this.#clock.now().getTime() + INTERACTION_LIMITS.operationMs).toISOString()
      const intent = runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: request.clientRequestId,
      precondition: {
        target: request.target,
        inventoryId: request.inventoryId,
        inventoryRevision: request.inventoryRevision,
      },
      deadlineAt,
      requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    })
      const execution = await this.#core.runOperation(
      session,
      intent,
      { target: request.target },
      async context => {
        if (context.wire.kind !== "native") throw new Error("Interaction begin требует NativeExecutionContext")
        const result = await this.#binding.beginFocus(
          context as RuntimeOperationContext<NativeExecutionContext>,
          {
            target: request.target,
            inventoryId: request.inventoryId,
            inventoryRevision: request.inventoryRevision,
          },
        )
        nativeReceipt = result.receipt
        return result.result
      },
      signal,
    )
      if (!execution.result.ok || nativeReceipt === undefined) {
        throw new RuntimeContractError("operation-outcome-unknown", "Interaction focus не подтверждён", "interaction-begin", {
          recoveryAction: "get-operation",
          context: { operationId: execution.operation.context.operationId },
        })
      }
      try {
        await bounded(
          this.#binding.verifyFocusReceipt(nativeReceipt, execution.operation),
          this.#observerRequestMs,
          signal,
          "interaction focus receipt verification",
        )
      } catch {
        throw new RuntimeContractError(
          "proof-invalid",
          "Interaction focus receipt не подтверждён runtime-issued evidence",
          "interaction-begin",
          { recoveryAction: "get-operation", context: { operationId: execution.operation.context.operationId } },
        )
      }
      const receipt = this.#validateReceipt(request, nativeReceipt, execution.result.value, execution.operation)
      const startedAtMs = Date.parse(receipt.startedAt)
      const now = this.#clock.now()
      if (!this.#coverageAllowsReceipt(receipt, now, "extension")) {
        throw new RuntimeContractError("capability-unavailable", "Observer не готов для interaction", "interaction-begin", {
          recoveryAction: "inspect-health",
        })
      }
      const interactionId = this.#ids.next("interaction")
      const hardExpiresAtMs = startedAtMs + INTERACTION_LIMITS.hardMs
      const record: InteractionRecord = {
      interactionId,
      lineageId,
      clientSessionId: session.clientSessionId,
      target: request.target,
      inventoryId: request.inventoryId,
      inventoryRevision: request.inventoryRevision,
      receipt,
      state: "active",
      startedAtMs,
      lastActivityAtMs: now.getTime(),
      idleExpiresAtMs: Math.min(now.getTime() + INTERACTION_LIMITS.idleMs, hardExpiresAtMs),
      hardExpiresAtMs,
      steps: new Map(),
    }
      this.#records.set(interactionId, record)
      this.#scheduleExpiry(record)
      this.#startEvents()
      const result: InteractionBeginResult = {
      interactionId,
      state: "active",
      idleExpiresAt: new Date(record.idleExpiresAtMs).toISOString(),
      hardExpiresAt: new Date(record.hardExpiresAtMs).toISOString(),
      receipt,
      operation: execution.operation,
    }
      return this.#beginSnapshot(result, record)
    } finally {
      this.#pendingLineages.delete(lineageId)
    }
  }

  async #endExisting(
    session: RuntimeClientSession,
    lineageId: string,
    request: InteractionEndRequest,
    signal?: AbortSignal,
  ): Promise<InteractionEndResult> {
    const record = this.#records.get(request.interactionId)
    if (record === undefined || record.lineageId !== lineageId) {
      throw new RuntimeContractError("unauthorized", "Interaction не принадлежит client lineage", "interaction-end")
    }
    if (record.endResult !== undefined) return record.endResult
    this.#expireIfNeeded(record)
    this.#abortSteps(record, "interaction ending")
    const coverage = await bounded(
      this.#binding.observerCoverage(),
      this.#observerRequestMs,
      signal,
      "interaction end observer coverage",
    ).catch(() => undefined)
    const restoreAllowed = record.state === "active"
      && record.receipt.previousFocus.state === "known"
      && coverage !== undefined
      && this.#coverageAllows(record, coverage, this.#clock.now(), "restoration")
    if (!restoreAllowed && record.state === "active") {
      this.#revoke(record, "revoked", "conditional restore preconditions не выполнены")
    }

    const deadlineAt = new Date(this.#clock.now().getTime() + INTERACTION_LIMITS.operationMs).toISOString()
    const intent = runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: request.clientRequestId,
      precondition: {
        target: record.target,
        inventoryId: record.inventoryId,
        inventoryRevision: record.inventoryRevision,
      },
      deadlineAt,
      requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    })
    const execution = await this.#core.runOperation(
      session,
      intent,
      { interactionId: record.interactionId, restoreAllowed },
      async context => {
        if (context.wire.kind !== "native") throw new Error("Interaction end требует NativeExecutionContext")
        return await this.#binding.endRestore(
          context as RuntimeOperationContext<NativeExecutionContext>,
          {
            receipt: record.receipt,
            ...(coverage === undefined ? {} : { currentCoverage: coverage }),
            restoreAllowed,
          },
        )
      },
      signal,
    )
    if (!execution.result.ok && record.state === "active") {
      this.#revoke(record, "revoked", "interaction restore operation не завершена")
    }
    const endedAt = this.#clock.now().toISOString()
    const terminalState = record.state === "expired" ? "expired" : record.state === "revoked" ? "revoked" : "ended"
    record.state = terminalState
    record.terminalAtMs = Date.parse(endedAt)
    if (record.timer !== undefined) clearTimeout(record.timer)
    record.tombstone ??= this.#tombstone(record, terminalState, endedAt)
    const result: InteractionEndResult = {
      interactionId: record.interactionId,
      state: terminalState,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      endedAt,
      operation: execution.operation,
      tombstone: record.tombstone,
    }
    record.endResult = deepFreeze(structuredClone(result))
    return result
  }

  async #activeRecord(
    session: RuntimeClientSession,
    interactionId: string,
    target: NativeOperationTarget,
  ): Promise<InteractionRecord> {
    const lineageId = await this.#lineage(session)
    const record = this.#records.get(interactionId)
    if (record === undefined || record.lineageId !== lineageId) {
      throw new RuntimeContractError("unauthorized", "Interaction не принадлежит client lineage", "interaction-step")
    }
    this.#expireIfNeeded(record)
    if (record.state !== "active") {
      throw new RuntimeContractError("lease-revoked", `Interaction ${record.state}`, "interaction-step", {
        recoveryAction: "request-user-action",
      })
    }
    if (!structurallyEqual(record.target, target)) {
      throw new RuntimeContractError("target-stale", "Interaction step содержит другой target", "interaction-step", {
        recoveryAction: "refresh-inventory",
      })
    }
    return record
  }

  async #lineage(session: RuntimeClientSession): Promise<string> {
    await this.#core.clients.assertActive(session, this.#clock.now())
    return this.#core.clients.lineage(session)
  }

  #validateReceipt(
    request: InteractionBeginRequest,
    value: InteractionFocusReceipt,
    focusValue: InteractionFocusValue,
    operation: OperationRecord,
  ): InteractionFocusReceipt {
    const receipt = structuredClone(value)
    nativeOperationTargetSchema.parse(receipt.requestedTarget)
    nativeOperationTargetSchema.parse(receipt.actualTarget)
    observerCoverageSchema.parse(receipt.observerCoverage)
    if (
      receipt.bindingRef !== this.#binding.bindingRef
      || receipt.nativeGeneration !== this.#binding.nativeGeneration
      || receipt.operationId !== operation.context.operationId
      || receipt.runtimeEpoch !== this.#core.generation.runtimeEpoch
      || receipt.loginSessionId !== this.#core.generation.loginSessionId
      || receipt.receiptId.length === 0
      || receipt.focusProofRef.length === 0
      || !structurallyEqual(receipt.requestedTarget, request.target)
      || !structurallyEqual(receipt.actualTarget, request.target)
      || !structurallyEqual(focusValue.requestedTarget, receipt.requestedTarget)
      || !structurallyEqual(focusValue.actualTarget, receipt.actualTarget)
      || !structurallyEqual(focusValue.previousFocus, receipt.previousFocus)
      || focusValue.focusProofRef !== receipt.focusProofRef
      || operation.context.kind !== "native"
      || operation.context.nativeGeneration !== receipt.nativeGeneration
      || operation.context.operationId.length === 0
    ) {
      throw new RuntimeContractError("proof-invalid", "Interaction focus receipt не связан с runtime/native operation", "interaction-begin", {
        recoveryAction: "get-operation",
        context: { operationId: operation.context.operationId },
      })
    }
    if (
      receipt.previousFocus.state === "known"
      && (
        !nativeOperationTargetSchema.safeParse(receipt.previousFocus.target).success
        ||
        receipt.previousFocus.proofRef.length === 0
        || receipt.previousFocus.target.ref.runtimeEpoch !== receipt.runtimeEpoch
        || receipt.previousFocus.target.ref.loginSessionId !== receipt.loginSessionId
        || receipt.previousFocus.target.ref.nativeGeneration !== receipt.nativeGeneration
      )
    ) {
      throw new RuntimeContractError("proof-invalid", "Previous focus receipt не принадлежит binding generation", "interaction-begin")
    }
    return deepFreeze(receipt)
  }

  #coverageAllows(
    record: InteractionRecord,
    coverage: ObserverCoverage,
    now: Date,
    purpose: "extension" | "restoration",
  ): boolean {
    const decision = {
      runtimeEpoch: record.receipt.runtimeEpoch,
      loginSessionId: record.receipt.loginSessionId,
      nativeGeneration: record.receipt.nativeGeneration,
      interactionStartedAt: record.receipt.startedAt,
      expectedCoverageStartCursor: record.receipt.observerCoverage.coverageStartCursor,
      now,
      maxLagMs: INTERACTION_LIMITS.observerLagMs,
    }
    return purpose === "extension"
      ? observerAllowsLeaseExtension(coverage, decision)
      : observerAllowsRestoration(coverage, decision)
  }

  #coverageAllowsReceipt(
    receipt: InteractionFocusReceipt,
    now: Date,
    purpose: "extension" | "restoration",
  ): boolean {
    const fakeRecord = { receipt } as InteractionRecord
    return this.#coverageAllows(fakeRecord, receipt.observerCoverage, now, purpose)
  }

  #assertTargetGeneration(target: NativeOperationTarget): void {
    if (
      target.ref.runtimeEpoch !== this.#core.generation.runtimeEpoch
      || target.ref.loginSessionId !== this.#core.generation.loginSessionId
      || target.ref.nativeGeneration !== this.#binding.nativeGeneration
    ) {
      throw new RuntimeContractError("target-stale", "Interaction target принадлежит другой generation", "interaction-begin")
    }
  }

  #scheduleExpiry(record: InteractionRecord): void {
    if (record.timer !== undefined) clearTimeout(record.timer)
    const expiresAt = Math.min(record.idleExpiresAtMs, record.hardExpiresAtMs)
    const delay = Math.max(0, expiresAt - this.#clock.now().getTime())
    record.timer = setTimeout(() => this.#expireIfNeeded(record), delay)
  }

  #expireIfNeeded(record: InteractionRecord): void {
    if (record.state !== "active") return
    const now = this.#clock.now().getTime()
    if (now >= record.hardExpiresAtMs || now >= record.idleExpiresAtMs) {
      this.#revoke(record, "expired", "interaction lease истёк")
    }
  }

  #revoke(record: InteractionRecord, state: "revoked" | "expired", reason: string): void {
    if (record.state !== "active") return
    record.state = state
    record.reason = reason
    record.terminalAtMs = this.#clock.now().getTime()
    record.tombstone = this.#tombstone(record, state, new Date(record.terminalAtMs).toISOString())
    if (record.timer !== undefined) clearTimeout(record.timer)
    this.#abortSteps(record, reason)
  }

  #abortSteps(record: InteractionRecord, reason: string): void {
    for (const controller of record.steps.values()) controller.abort(reason)
    record.steps.clear()
  }

  #startEvents(): void {
    if (this.#eventsTask !== undefined) return
    this.#eventsTask = (async () => {
      try {
        for await (const rawEvent of this.#binding.events(this.#eventsAbort.signal)) {
          if (this.#eventsAbort.signal.aborted) break
          const event = observedEventSchema.parse(rawEvent)
          if (
            event.runtimeEpoch !== this.#core.generation.runtimeEpoch
            || event.loginSessionId !== this.#core.generation.loginSessionId
            || event.nativeGeneration !== this.#binding.nativeGeneration
          ) {
            this.#revokeAll("observer event принадлежит другой generation")
            continue
          }
          if (event.kind === "lifecycle") {
            this.#revokeAll(`observer event ${event.kind}/${event.source}`)
            continue
          }
          if (["input", "focus"].includes(event.kind)) {
            for (const record of this.#records.values()) {
              if (record.state !== "active") continue
              const owned = event.source === "synthetic"
                && await bounded(
                  this.#binding.ownsSyntheticEvent(record.receipt, event),
                  this.#observerRequestMs,
                  this.#eventsAbort.signal,
                  "interaction synthetic ownership",
                ).catch(() => false)
              if (!owned) this.#revoke(record, "revoked", `observer event ${event.kind}/${event.source}`)
            }
          }
        }
        if (!this.#eventsAbort.signal.aborted) this.#revokeAll("observer event stream завершился")
      } catch {
        if (!this.#eventsAbort.signal.aborted) this.#revokeAll("observer event stream недоступен")
      }
    })()
  }

  #revokeAll(reason: string): void {
    for (const record of this.#records.values()) this.#revoke(record, "revoked", reason)
  }

  #prune(): void {
    const now = this.#clock.now().getTime()
    for (const [id, record] of this.#records) {
      if (
        record.state !== "active"
        && record.terminalAtMs !== undefined
        && now - record.terminalAtMs >= INTERACTION_LIMITS.terminalRetentionMs
      ) {
        this.#records.delete(id)
      }
    }
    if (this.#records.size >= INTERACTION_LIMITS.maxRecords) {
      throw new RuntimeContractError("operation-in-progress", "Interaction tombstone budget исчерпан", "interaction-admission")
    }
  }

  #beginSnapshot(result: InteractionBeginResult, record: InteractionRecord): InteractionBeginResult {
    return {
      ...result,
      state: record.state,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.tombstone === undefined ? {} : { tombstone: record.tombstone }),
    }
  }

  #tombstone(
    record: InteractionRecord,
    state: "revoked" | "expired" | "ended",
    terminalAt: string,
  ): InteractionTombstone {
    return deepFreeze({
      tombstoneId: this.#ids.next("interaction-tombstone"),
      interactionId: record.interactionId,
      state,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      terminalAt,
    })
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Interaction authority закрыта")
  }
}

function requestMismatch(stage: string): RuntimeContractError {
  return new RuntimeContractError(
    "request-payload-mismatch",
    "Повторный interaction request ID содержит другой payload",
    stage,
    { recoveryAction: "get-operation" },
  )
}

function receiptExpired(stage: string): RuntimeContractError {
  return new RuntimeContractError(
    "receipt-expired",
    "Interaction tombstone вышел за предел retention; replay запрещён",
    stage,
    { recoveryAction: "get-operation" },
  )
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

function boundedOption(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 1 || selected > 5_000) {
    throw new Error("Interaction timeout должен быть в пределах 1..5000 мс")
  }
  return selected
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${stage} превысил ${timeoutMs} мс`)), timeoutMs)
    if (signal !== undefined) {
      onAbort = () => reject(signal.reason ?? new Error(`${stage} отменён`))
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
  try {
    return await Promise.race([promise, stop])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
  }
}
