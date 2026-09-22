import {
  assertBrowserResultMatchesRequest,
  assertDeviceBrowserResultMatchesRequest,
  browserOperationRequestSchema,
  browserOperationResources,
  browserOperationResultSchema,
  deviceBrowserOperationRequestSchema,
  deviceBrowserOperationResources,
  deviceBrowserOperationResultSchema,
  lifetimeReservationHandleSchema,
  operationOutcomeSchema,
  runtimeOperationIntentSchema,
  reservationCleanupReceiptSchema,
  structurallyEqual,
  type AdapterResult,
  type BrowserAdapter,
  type BrowserExecutionContext,
  type BrowserOperationRequest,
  type BrowserOperationResult,
  type DeviceBrowserAdapter,
  type DeviceExecutionContext,
  type DeviceBrowserOperationRequest,
  type DeviceBrowserOperationResult,
  type LifetimeReservationAuthority,
  type LifetimeReservationHandle,
  type OperationRecord,
  type OperationTarget,
  type ReservationChildRequest,
  type ReservationCleanupReceipt,
  type RuntimeClientSession,
  type RuntimeExecution,
  type RuntimeGeneration,
  type RuntimeOperationContext,
  type RuntimeOperationIntent,
} from "@meta/shared/contracts"
import { ClientSessionRegistry } from "./client-sessions.ts"
import { signalDeadline } from "./deadline.ts"
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"
import {
  lifetimeBindingPersistenceSchema,
  type LifetimeBindingPersistence,
  type LifetimeStateRecord,
  type LifetimeStableOwner,
  type PersistentLifetimeStore,
} from "./lifetime-state.ts"

type Request = BrowserOperationRequest | DeviceBrowserOperationRequest
type Result = BrowserOperationResult | DeviceBrowserOperationResult
type InstanceTarget = LifetimeReservationHandle["target"]

export type CoordinatedLifecycle = {
  admission?: "stored-cleanup"
  before(context: RuntimeOperationContext): Promise<void>
  stage(record: OperationRecord, result: AdapterResult<unknown>): Promise<() => void>
  failed(adapterStarted: boolean): void
}

type Runner = (
  session: RuntimeClientSession,
  intent: RuntimeOperationIntent,
  request: Request,
  execute: (context: RuntimeOperationContext, request: Request) => Promise<AdapterResult<Result>>,
  lifecycle: CoordinatedLifecycle,
  signal?: AbortSignal,
) => Promise<RuntimeExecution<Result>>

// Этот интерфейс предоставляет host composition, а не транспортный caller.
export interface BrowserLifetimeVerifier {
  verifyConnected(target: InstanceTarget, signal: AbortSignal): Promise<void>
  verifyRemoved(target: InstanceTarget, signal: AbortSignal): Promise<void>
  verifyCompletion(request: Request, result: AdapterResult<Result>, signal: AbortSignal): Promise<void>
  recoverRemoval(target: InstanceTarget, signal: AbortSignal): Promise<void>
}

type Binding = {
  domain: "browser" | "device"
  adapter: BrowserAdapter | DeviceBrowserAdapter
  verifier: Readonly<BrowserLifetimeVerifier>
  persistence?: readonly LifetimeBindingPersistence[]
}

type Slot = {
  operationId: string
  lineageId: string
  target: InstanceTarget
  state: "connecting" | "active" | "quarantined" | "released"
  bindingId: string
  handle?: LifetimeReservationHandle
  receipt?: ReservationCleanupReceipt
  children: Set<string>
  disconnecting?: string
  operationIds: Set<string>
  durable?: LifetimeStateRecord
}

export class BrowserLifetimeCoordinator {
  readonly #clients: ClientSessionRegistry
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #generation: RuntimeGeneration
  readonly #run: Runner
  readonly #lookup: (id: string) => OperationRecord | undefined
  readonly #bindings = new Map<string, Binding>()
  readonly #slots = new Map<string, Slot>()
  readonly #byId = new Map<string, Slot>()
  readonly #ttlMs: number
  readonly #shutdownStepMs: number
  readonly #store?: PersistentLifetimeStore
  readonly #durableByPhysical = new Map<string, LifetimeStateRecord>()
  readonly #stageRecovered: (operationIds: readonly string[]) => Promise<() => void>
  readonly authority: LifetimeReservationAuthority & {
    resume(session: RuntimeClientSession, reservationId: string): Promise<LifetimeReservationHandle>
    inspect(session: RuntimeClientSession, target: OperationTarget): Promise<LifetimeReservationHandle | undefined>
  }

  constructor(options: {
    generation: RuntimeGeneration
    clients: ClientSessionRegistry
    run: Runner
    lookup: (operationId: string) => OperationRecord | undefined
    clock?: RuntimeClock
    ids?: RuntimeIdSource
    ttlMs?: number
    shutdownStepMs?: number
    store?: PersistentLifetimeStore
    stageRecovered: (operationIds: readonly string[]) => Promise<() => void>
  }) {
    this.#generation = options.generation
    this.#clients = options.clients
    this.#run = options.run
    this.#lookup = options.lookup
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#ttlMs = options.ttlMs ?? 120_000
    this.#shutdownStepMs = options.shutdownStepMs ?? 5_000
    this.#store = options.store
    this.#stageRecovered = options.stageRecovered
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 86_400_000) throw new Error("Reservation TTL вне допустимого диапазона")
    if (!Number.isSafeInteger(this.#shutdownStepMs) || this.#shutdownStepMs < 1 || this.#shutdownStepMs > 30_000) throw new Error("Reservation shutdown budget вне допустимого диапазона")
    this.authority = Object.freeze({
      assertChild: (request: ReservationChildRequest) => this.#assertChild(request),
      resume: (session: RuntimeClientSession, id: string) => this.#resume(session, id),
      inspect: (session: RuntimeClientSession, target: OperationTarget) => this.#inspect(session, target),
    })
  }

  configure(id: string, binding: Binding): void {
    if (this.#bindings.has(id)) throw new Error("Lifetime binding immutable: уже зарегистрирован")
    if (!structurallyEqual(binding.adapter.host.generation, this.#generation)) throw new Error("Adapter принадлежит другой runtime generation")
    const persistence = binding.persistence === undefined
      ? undefined
      : binding.persistence.map(value => lifetimeBindingPersistenceSchema.parse(value))
    if (this.#store !== undefined && persistence === undefined) throw new Error("Durable lifetime binding требует persistence metadata")
    if (persistence !== undefined) {
      if (persistence.length < 1 || persistence.length > 128) throw new Error("Durable binding требует 1..128 persistence entries")
      const physical = persistence.map(physicalKey)
      const owners = persistence.map(value => canonicalJson(value.owner))
      if (new Set(physical).size !== physical.length || new Set(owners).size !== owners.length) {
        throw new Error("Durable binding содержит duplicate owner/physical key")
      }
      if ([...this.#bindings.values()].some(existing => existing.persistence?.some(value => physical.includes(physicalKey(value))))) {
        throw new Error("Physical lifetime ownership key уже настроен другим binding")
      }
    }
    this.#bindings.set(id, {
      domain: binding.domain,
      adapter: binding.adapter,
      verifier: Object.freeze({
        verifyConnected: binding.verifier.verifyConnected.bind(binding.verifier),
        verifyRemoved: binding.verifier.verifyRemoved.bind(binding.verifier),
        verifyCompletion: binding.verifier.verifyCompletion.bind(binding.verifier),
        recoverRemoval: binding.verifier.recoverRemoval.bind(binding.verifier),
      }),
      ...(persistence === undefined ? {} : { persistence: Object.freeze(persistence.map(value => Object.freeze(value))) }),
    })
  }

  async restorePersisted(): Promise<readonly LifetimeStateRecord[]> {
    if (this.#store === undefined) return []
    const restored: LifetimeStateRecord[] = []
    for (const loaded of await this.#store.loadAll()) {
      this.#durableByPhysical.set(physicalKey(loaded), loaded)
      if (loaded.state === "released") continue
      const binding = this.#bindings.get(loaded.bindingId)
      const persistence = binding === undefined ? undefined : persistenceForOwner(binding, loaded.owner)
      if (persistence === undefined
        || persistence.configFingerprint !== loaded.configFingerprint
        || physicalKey(persistence) !== physicalKey(loaded)) {
        throw new Error("Persisted lifetime binding/config/physical ownership mismatch")
      }
      const quarantined = await this.#store.persist({
        ...loaded,
        state: "quarantined",
        ...(loaded.handle === undefined ? {} : {
          handle: {
            ...loaded.handle,
            state: "quarantined",
            statusRevision: loaded.handle.statusRevision + 1,
          },
        }),
        revision: loaded.revision + 1,
        updatedAt: this.#clock.now().toISOString(),
      })
      const slot: Slot = {
        operationId: quarantined.operationId,
        lineageId: quarantined.lineageId,
        target: structuredClone(quarantined.target),
        state: "quarantined",
        bindingId: quarantined.bindingId,
        ...(quarantined.handle === undefined ? {} : { handle: structuredClone(quarantined.handle) }),
        children: new Set(),
        operationIds: new Set(quarantined.operationIds),
        durable: quarantined,
      }
      this.#slots.set(stableKey(slot.target), slot)
      if (slot.handle !== undefined) this.#byId.set(slot.handle.reservationId, slot)
      this.#durableByPhysical.set(physicalKey(quarantined), quarantined)
      restored.push(structuredClone(quarantined))
    }
    return restored
  }

  async execute(
    session: RuntimeClientSession,
    bindingId: string,
    intent: RuntimeOperationIntent,
    requestValue: unknown,
    signal?: AbortSignal,
  ): Promise<RuntimeExecution<Result>> {
    return this.#execute(session, bindingId, intent, requestValue, signal)
  }

  /** Acknowledges the existing durable operation; it does not create a second task or connection. */
  async startConnect(
    session: RuntimeClientSession,
    bindingId: string,
    intentValue: RuntimeOperationIntent,
    requestValue: unknown,
    signal?: AbortSignal,
  ): Promise<RuntimeExecution<Result> | { operation: OperationRecord, pending: true }> {
    const binding = this.#bindings.get(bindingId)
    const request = browserOperationRequestSchema.parse(requestValue)
    if (binding?.domain !== "browser" || request.kind !== "connect-instance") {
      throw new Error("Fast return requires Chrome connect-instance")
    }
    const intent = runtimeOperationIntentSchema.parse(intentValue)
    // Keep the old bounded deadline, but let Core own its timer after the RPC returns.
    // Do not bindDeadline on admission.signal: Core must not rely on the disposed RPC timer.
    intent.deadlineAt = new Date(Math.min(Date.parse(intent.deadlineAt),
      this.#clock.now().getTime() + 30_000, signalDeadline(signal) ?? Infinity)).toISOString()
    const admission = new AbortController()
    const abort = () => admission.abort(signal?.reason ?? "connect admission cancelled")
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    let acknowledge!: (reply: { operation: OperationRecord, pending: true }) => void
    const accepted = new Promise<{ operation: OperationRecord, pending: true }>(resolve => { acknowledge = resolve })
    const completion = this.#execute(session, bindingId, intent, request, admission.signal, record => {
      if (admission.signal.aborted) return
      // From this durable acceptance onward, operation deadline, cancel, client disconnect
      // and Runtime drain remain authoritative; finishing this start RPC is not cancellation.
      signal?.removeEventListener("abort", abort)
      acknowledge({ operation: structuredClone(record), pending: true })
    })
    try {
      // Both completion and rejection stay observed even when the pending reply wins.
      // Deduplicated requests use Core's original promise/result, never another dispatch.
      return await Promise.race([accepted, completion])
    } finally { signal?.removeEventListener("abort", abort) }
  }

  async #execute(
    session: RuntimeClientSession,
    bindingId: string,
    intent: RuntimeOperationIntent,
    requestValue: unknown,
    signal?: AbortSignal,
    registered?: (record: OperationRecord) => void,
  ): Promise<RuntimeExecution<Result>> {
    await this.#clients.assertActive(session, this.#clock.now())
    const binding = this.#bindings.get(bindingId)
    if (binding === undefined) throw new Error("Lifetime adapter не настроен")
    const request = binding.domain === "browser"
      ? browserOperationRequestSchema.parse(requestValue)
      : deviceBrowserOperationRequestSchema.parse(requestValue)
    const target = requestTarget(request, binding.domain)
    if (!structurallyEqual(target, intent.precondition.target)) throw new Error("Intent target не совпадает с typed browser request")
    const required = binding.domain === "browser"
      ? browserOperationResources(request as BrowserOperationRequest)
      : deviceBrowserOperationResources(request as DeviceBrowserOperationRequest)
    if (!structurallyEqual(required, intent.requestedResources)) throw new Error("Intent resources не совпадают с runtime operation policy")
    const instance = instanceTarget(target)
    const key = stableKey(instance)
    let slot: Slot | undefined
    let context: RuntimeOperationContext | undefined
    const lifecycle: CoordinatedLifecycle = {
      before: async received => {
        context = received
        await this.#clients.assertActive(session, this.#clock.now())
        const existing = this.#slots.get(key)
        if (existing !== undefined) this.#expire(existing)
        if (request.kind === "connect-instance") {
          const persistence = persistenceForTarget(binding, instance)
          if (persistence !== undefined) {
            const durable = this.#durableByPhysical.get(physicalKey(persistence))
            if (durable !== undefined && durable.state !== "released") {
              throw new Error("Physical lifetime ownership остаётся active/quarantined после прежней generation")
            }
          }
          if (existing !== undefined && existing.state !== "released") throw new Error("Exclusive lifetime reservation уже занята до connect")
          slot = {
            operationId: received.wire.operationId,
            lineageId: this.#clients.lineage(session),
            target: structuredClone(instance),
            state: "connecting",
            bindingId,
            children: new Set(),
            operationIds: new Set([received.wire.operationId]),
          }
          await this.#persistSlot(slot, binding, "connecting")
          this.#slots.set(key, slot)
        } else {
          if (existing === undefined || existing.bindingId !== bindingId || existing.state !== "active"
            || existing.lineageId !== this.#clients.lineage(session) || !structurallyEqual(existing.target, instance)) {
            throw new Error("Нет active exact lifetime reservation")
          }
          if (existing.disconnecting !== undefined) throw new Error("Reservation уже disconnecting")
          if (request.kind === "disconnect-instance") {
            if (existing.children.size > 0) throw new Error("Reservation содержит active child operations")
            existing.disconnecting = received.wire.operationId
          }
          existing.children.add(received.wire.operationId)
          existing.operationIds.add(received.wire.operationId)
          slot = existing
          await this.#persistSlot(existing, binding, existing.state)
        }
        if (registered !== undefined) {
          // Core has persisted registration before invoking lifecycle.before; the exact
          // lifetime slot is now recorded too. No success/result is claimed by this receipt.
          const record = this.#lookup(received.wire.operationId)
          if (record === undefined) throw new Error("Connect registration absent from own journal")
          registered(record)
        }
      },
      stage: async (record, result) => {
        if (slot === undefined || context === undefined) throw new Error("Lifetime admission отсутствует")
        const journal = this.#lookup(context.wire.operationId)
        if (journal === undefined || journal.context.operationId !== record.context.operationId
          || journal.principalId !== session.principalId) throw new Error("Lifecycle result отсутствует в own journal")
        await this.#clients.assertActive(session, this.#clock.now())
        const parsed = binding.domain === "browser"
          ? result.ok ? { ...result, value: browserOperationResultSchema.parse(result.value) } : result
          : result.ok ? { ...result, value: deviceBrowserOperationResultSchema.parse(result.value) } : result
        if (parsed.ok) {
          if (binding.domain === "browser") assertBrowserResultMatchesRequest(request as BrowserOperationRequest, parsed.value as BrowserOperationResult)
          else assertDeviceBrowserResultMatchesRequest(request as DeviceBrowserOperationRequest, parsed.value as DeviceBrowserOperationResult)
        }
        await binding.verifier.verifyCompletion(request, parsed as AdapterResult<Result>, context.control.signal)
        if (!parsed.ok) {
          await this.#persistSlot(slot, binding, "quarantined")
          return () => {
          slot!.children.delete(record.context.operationId)
          delete slot!.disconnecting
          this.#quarantine(slot!)
          }
        }
        if (request.kind === "connect-instance") {
          if (parsed.value.value.kind !== "instance-connected") throw new Error("Connect не вернул actual instance")
          const actual = instanceTarget({
            kind: binding.domain === "browser" ? "browser-instance" : "device-browser-instance",
            ref: parsed.value.value.instance.ref,
          } as InstanceTarget)
          if (stableKey(actual) !== key || structurallyEqual(actual, instance)) throw new Error("Connect не создал новое transport generation")
          await binding.verifier.verifyConnected(actual, context.control.signal)
          await this.#clients.assertActive(session, this.#clock.now())
          const now = this.#clock.now()
          const handle = lifetimeReservationHandleSchema.parse({
            reservationId: this.#ids.next("reservation"),
            reservationGeneration: this.#ids.next("reservation-generation"),
            ...this.#generation,
            principalId: session.principalId,
            lineageRef: slot.lineageId,
            target: actual,
            externalGeneration: externalGeneration(actual),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
            state: "active",
            statusRevision: 1,
          })
          await this.#persistSlot(slot, binding, "active", actual, handle)
          return () => {
            slot!.target = structuredClone(actual)
            slot!.handle = structuredClone(handle)
            slot!.state = "active"
            this.#byId.set(handle.reservationId, slot!)
          }
        }
        if (request.kind === "disconnect-instance") {
          await binding.verifier.verifyRemoved(slot.target, context.control.signal)
          await this.#clients.assertActive(session, this.#clock.now())
          if (slot.handle === undefined) throw new Error("Reservation handle отсутствует")
          const receipt = reservationCleanupReceiptSchema.parse({
            receiptId: this.#ids.next("reservation-cleanup"),
            reservationId: slot.handle.reservationId,
            reservationGeneration: slot.handle.reservationGeneration,
            externalGeneration: slot.handle.externalGeneration,
            statusRevision: slot.handle.statusRevision + 1,
            cleanupEvidenceRef: record.context.operationId,
            issuedAt: this.#clock.now().toISOString(),
            state: "released",
          })
          await this.#persistSlot(slot, binding, "released", slot.target, {
            ...slot.handle,
            state: "released",
            statusRevision: receipt.statusRevision,
          })
          return () => {
            slot!.state = "released"
            slot!.receipt = receipt
            slot!.handle = { ...slot!.handle!, state: "released", statusRevision: receipt.statusRevision }
            slot!.children.delete(record.context.operationId)
            delete slot!.disconnecting
          }
        }
        return () => { slot!.children.delete(record.context.operationId) }
      },
      failed: adapterStarted => {
        if (slot === undefined) return
        if (context !== undefined) slot.children.delete(context.wire.operationId)
        delete slot.disconnecting
        if (!adapterStarted && slot.state === "connecting") this.#slots.delete(key)
        else if (adapterStarted) this.#quarantine(slot)
      },
    }
    return this.#run(session, intent, request, async (received, value) => {
      if (binding.domain === "browser" && received.wire.kind === "browser") {
        return (binding.adapter as BrowserAdapter).execute({ ...received, wire: received.wire }, value as BrowserOperationRequest)
      }
      if (binding.domain === "device" && received.wire.kind === "device") {
        return (binding.adapter as DeviceBrowserAdapter).execute({ ...received, wire: received.wire }, value as DeviceBrowserOperationRequest)
      }
      throw new Error("Domain context не совпадает с configured adapter")
    }, lifecycle, signal)
  }

  async shutdownLineage(lineageId?: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Lifetime shutdown aborted", "AbortError")
    const slots = [...this.#slots.values()].filter(slot => {
      return slot.state !== "released" && (lineageId === undefined || slot.lineageId === lineageId)
    })
    await this.#shutdownSlots(slots, signal)
  }

  /** Только host startup до приёма клиентов: незавершённый connect прежнего Runtime. */
  async recoverRestoredConnect(operationId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const matches = [...this.#slots.values()].filter(slot => slot.durable?.operationId === operationId)
    const slot = matches.length === 1 ? matches[0] : undefined
    const durable = slot?.durable
    const binding = slot === undefined ? undefined : this.#bindings.get(slot.bindingId)
    const persistence = binding === undefined || slot === undefined ? undefined : persistenceForTarget(binding, slot.target)
    const operation = this.#lookup(operationId)
    if (slot === undefined || durable === undefined || binding?.domain !== "browser" || persistence === undefined
      || slot.state !== "quarantined" || durable.state !== "quarantined" || slot.handle !== undefined || durable.handle !== undefined
      || durable.runtimeEpoch === this.#generation.runtimeEpoch || durable.loginSessionId !== this.#generation.loginSessionId
      || durable.bindingId !== slot.bindingId || durable.lineageId !== slot.lineageId
      || persistence.configFingerprint !== durable.configFingerprint || physicalKey(persistence) !== physicalKey(durable)
      || !structurallyEqual(slot.target, durable.target) || !structurallyEqual(durable.target, durable.initialTarget)
      || slot.target.kind !== "browser-instance" || slot.operationId !== operationId
      || slot.target.ref.runtimeEpoch !== durable.runtimeEpoch || slot.target.ref.loginSessionId !== durable.loginSessionId
      || slot.operationIds.size !== 1 || !slot.operationIds.has(operationId)
      || operation?.context.kind !== "browser" || !structurallyEqual(operation.context.target, slot.target)
      || operation.context.runtimeEpoch !== durable.runtimeEpoch || operation.context.loginSessionId !== durable.loginSessionId
      || this.#clients.historicalLineage(operation.clientSessionId, operation.principalId) !== slot.lineageId
      || operation.resources.length !== 1 || operation.resources[0]?.kind !== "cdp-target"
      || operation.resources[0]?.resourceRef !== slot.target.ref.browserInstanceRef) {
      throw new Error("Startup cleanup требует exact orphaned Chrome connect прежней generation")
    }
    const now = this.#clock.now().getTime()
    if (this.#clients.snapshot().some(stored => stored.lineageId === slot.lineageId
      && !stored.disconnected && !stored.revoked && stored.session.runtimeEpoch === this.#generation.runtimeEpoch
      && stored.session.loginSessionId === this.#generation.loginSessionId && Date.parse(stored.session.expiresAt) > now)) {
      throw new Error("Startup cleanup запрещён: lineage уже имеет действующего клиента")
    }
    await this.#shutdownSlots([slot], signal)
  }

  async #shutdownSlots(slots: readonly Slot[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    for (const slot of slots) {
      if (slot.children.size > 0 || slot.disconnecting !== undefined) {
        throw new Error("Lifetime shutdown требует drained child operations и отсутствие disconnect in-flight")
      }
      if (slot.state === "connecting") {
        this.#quarantine(slot)
        throw new Error("Lifetime shutdown обнаружил незавершённый connect без reservation handle")
      }
      const binding = this.#bindings.get(slot.bindingId)
      if (binding === undefined) {
        this.#quarantine(slot)
        throw new Error("Lifetime shutdown не нашёл immutable configured binding")
      }
      slot.disconnecting = `host-shutdown:${this.#ids.next("shutdown")}`
      try {
        const commit = await this.#boundedShutdown(async boundedSignal => {
          await binding.verifier.recoverRemoval(slot.target, boundedSignal)
          await binding.verifier.verifyRemoved(slot.target, boundedSignal)
          const commitPrevious = await this.#stageRecovered([...slot.operationIds])
          const receipt = slot.handle === undefined ? undefined : reservationCleanupReceiptSchema.parse({
            receiptId: this.#ids.next("reservation-shutdown"),
            reservationId: slot.handle.reservationId,
            reservationGeneration: slot.handle.reservationGeneration,
            externalGeneration: slot.handle.externalGeneration,
            statusRevision: slot.handle.statusRevision + 1,
            cleanupEvidenceRef: slot.disconnecting!,
            issuedAt: this.#clock.now().toISOString(),
            state: "released",
          })
          const releasedHandle = slot.handle === undefined || receipt === undefined ? undefined : {
            ...slot.handle,
            state: "released" as const,
            statusRevision: receipt.statusRevision,
          }
          await this.#persistSlot(slot, binding, "released", slot.target, releasedHandle)
          return () => {
            commitPrevious()
            slot.state = "released"
            if (receipt !== undefined && releasedHandle !== undefined) {
              slot.receipt = receipt
              slot.handle = releasedHandle
            }
            delete slot.disconnecting
          }
        }, signal)
        commit()
      } catch (error) {
        delete slot.disconnecting
        this.#quarantine(slot)
        throw error
      }
    }
  }

  async #assertChild(request: ReservationChildRequest): Promise<LifetimeReservationHandle> {
    await this.#clients.assertActive(request.session, this.#clock.now())
    const target = instanceTarget(request.target)
    const slot = this.#slots.get(stableKey(target))
    if (slot !== undefined) this.#expire(slot)
    if (slot === undefined || slot.handle === undefined || slot.state !== "active"
      || !slot.children.has(request.context.wire.operationId)
      || slot.lineageId !== this.#clients.lineage(request.session)
      || !structurallyEqual(slot.target, target)) throw new Error("Child не допущен runtime lifetime coordinator")
    return structuredClone(slot.handle)
  }

  async #persistSlot(
    slot: Slot,
    binding: Binding,
    state: LifetimeStateRecord["state"],
    target: InstanceTarget = slot.target,
    handle: LifetimeReservationHandle | undefined = slot.handle,
  ): Promise<void> {
    if (this.#store === undefined) return
    const persistence = persistenceForTarget(binding, target)
    if (persistence === undefined) throw new Error("Durable lifetime binding metadata отсутствует для exact instance")
    const key = physicalKey(persistence)
    const previous = slot.durable ?? this.#durableByPhysical.get(key)
    const sameLifetime = previous !== undefined && previous.state !== "released"
    const record = await this.#store.persist({
      runtimeEpoch: sameLifetime ? previous.runtimeEpoch : this.#generation.runtimeEpoch,
      loginSessionId: sameLifetime ? previous.loginSessionId : this.#generation.loginSessionId,
      bindingId: slot.bindingId,
      owner: persistence.owner,
      configFingerprint: persistence.configFingerprint,
      physicalOwnershipKey: persistence.physicalOwnershipKey,
      lineageId: sameLifetime ? previous.lineageId : slot.lineageId,
      operationId: sameLifetime ? previous.operationId : slot.operationId,
      initialTarget: sameLifetime ? previous.initialTarget : slot.target,
      target,
      ...(handle === undefined ? {} : { handle }),
      state,
      revision: (previous?.revision ?? 0) + 1,
      operationIds: [...slot.operationIds],
      updatedAt: this.#clock.now().toISOString(),
    })
    slot.durable = record
    this.#durableByPhysical.set(key, record)
  }

  async #boundedShutdown<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(external?.reason)
    external?.addEventListener("abort", onAbort, { once: true })
    if (external?.aborted) onAbort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    try {
      const stop = new Promise<never>((_, reject) => {
        abortListener = () => reject(new DOMException("Lifetime shutdown aborted", "AbortError"))
        controller.signal.addEventListener("abort", abortListener, { once: true })
        timer = setTimeout(() => controller.abort("lifetime shutdown deadline"), this.#shutdownStepMs)
      })
      return await Promise.race([work(controller.signal), stop])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (abortListener !== undefined) controller.signal.removeEventListener("abort", abortListener)
      external?.removeEventListener("abort", onAbort)
    }
  }

  async recover(
    session: RuntimeClientSession,
    bindingId: string,
    intent: RuntimeOperationIntent,
    signal?: AbortSignal,
  ): Promise<RuntimeExecution<Result>> {
    await this.#clients.assertActive(session, this.#clock.now())
    const target = instanceTarget(intent.precondition.target)
    const key = stableKey(target)
    const binding = this.#bindings.get(bindingId)
    if (binding === undefined || intent.intent !== "admin" || intent.requestedResources.length !== 0) {
      throw new Error("Recovery требует configured binding и cleanup-only admin intent")
    }
    const request = { kind: "disconnect-instance", instance: target.ref } as Request
    let slot: Slot | undefined
    let context: RuntimeOperationContext | undefined
    return this.#run(session, intent, request, async received => {
      await binding.verifier.recoverRemoval(target, received.control.signal)
      return {
        ok: true,
        value: { value: { kind: "instance-disconnected", instance: target.ref }, cleanup: { scope: "none", state: "complete", resources: [] } } as Result,
        outcome: operationOutcomeSchema.parse({
          dispatch: "finished", targetVerified: "verified", userInterference: "unknown",
          observation: "unavailable", effect: { state: "unverified", proofRefs: [] },
          cleanup: { scope: "none", state: "complete", resources: [] },
          restoration: "not-applicable", dispatchAttempts: 1,
        }),
      }
    }, {
      admission: "stored-cleanup",
      before: async received => {
        context = received
        await this.#clients.assertActive(session, this.#clock.now())
        const existing = this.#slots.get(key)
        if (existing !== undefined) this.#expire(existing)
        if (existing === undefined || existing.state !== "quarantined" || existing.bindingId !== bindingId
          || existing.lineageId !== this.#clients.lineage(session) || !structurallyEqual(existing.target, target)
          || existing.children.size > 0 || existing.disconnecting !== undefined) {
          throw new Error("Recovery не имеет exact quarantined reservation без active children")
        }
        existing.disconnecting = received.wire.operationId
        slot = existing
      },
      stage: async (record, result) => {
        if (slot === undefined || context === undefined || !result.ok) throw new Error("Recovery не завершено")
        await binding.verifier.verifyRemoved(target, context.control.signal)
        await this.#clients.assertActive(session, this.#clock.now())
        const commitPrevious = await this.#stageRecovered([...slot.operationIds])
        const recoveredBinding = this.#bindings.get(slot.bindingId)
        if (recoveredBinding === undefined) throw new Error("Recovery binding исчез")
        const nextHandle = slot.handle === undefined ? undefined : {
          ...slot.handle,
          state: "released" as const,
          statusRevision: slot.handle.statusRevision + 1,
        }
        await this.#persistSlot(slot, recoveredBinding, "released", slot.target, nextHandle)
        return () => {
          commitPrevious()
          slot!.state = "released"
          if (slot!.handle !== undefined) {
            slot!.handle = { ...slot!.handle, state: "released", statusRevision: slot!.handle.statusRevision + 1 }
            slot!.receipt = reservationCleanupReceiptSchema.parse({
              receiptId: this.#ids.next("reservation-recovery"), reservationId: slot!.handle.reservationId,
              reservationGeneration: slot!.handle.reservationGeneration, externalGeneration: slot!.handle.externalGeneration,
              statusRevision: slot!.handle.statusRevision, cleanupEvidenceRef: record.context.operationId,
              issuedAt: this.#clock.now().toISOString(), state: "released",
            })
          }
          delete slot!.disconnecting
        }
      },
      failed: () => { if (slot !== undefined) { delete slot.disconnecting; this.#quarantine(slot) } },
    }, signal)
  }

  async #resume(session: RuntimeClientSession, id: string): Promise<LifetimeReservationHandle> {
    await this.#clients.assertActive(session, this.#clock.now())
    const slot = this.#byId.get(id)
    if (slot !== undefined) this.#expire(slot)
    if (slot?.handle === undefined || slot.state !== "active" || slot.lineageId !== this.#clients.lineage(session)) throw new Error("Reservation недоступна этой active lineage")
    return structuredClone(slot.handle)
  }

  async #inspect(session: RuntimeClientSession, target: OperationTarget): Promise<LifetimeReservationHandle | undefined> {
    await this.#clients.assertActive(session, this.#clock.now())
    const slot = this.#slots.get(stableKey(instanceTarget(target)))
    if (slot === undefined) return undefined
    if (slot.lineageId !== this.#clients.lineage(session)) throw new Error("Reservation принадлежит другой lineage")
    this.#expire(slot)
    return slot.handle === undefined ? undefined : structuredClone(slot.handle)
  }

  #expire(slot: Slot): void {
    if (slot.state === "active" && slot.handle !== undefined && this.#clock.now().getTime() >= Date.parse(slot.handle.expiresAt)) this.#quarantine(slot)
  }

  #quarantine(slot: Slot): void {
    slot.state = "quarantined"
    if (slot.handle !== undefined) slot.handle = { ...slot.handle, state: "quarantined", statusRevision: slot.handle.statusRevision + 1 }
  }
}

function requestTarget(request: Request, domain: "browser" | "device"): OperationTarget {
  return "instance" in request
    ? { kind: domain === "browser" ? "browser-instance" : "device-browser-instance", ref: request.instance } as InstanceTarget
    : { kind: domain === "browser" ? "browser-target" : "device-browser-target", ref: request.target } as OperationTarget
}

function instanceTarget(target: OperationTarget): InstanceTarget {
  if (target.kind === "browser-instance" || target.kind === "device-browser-instance") return target
  if (target.kind === "browser-target") {
    const { targetId: _, resourceRef: __, ...ref } = target.ref
    return { kind: "browser-instance", ref }
  }
  if (target.kind === "device-browser-target") {
    const { targetId: _, resourceRef: __, ...ref } = target.ref
    return { kind: "device-browser-instance", ref }
  }
  throw new Error("Target не принадлежит browser/device lifetime")
}

function externalGeneration(target: InstanceTarget): LifetimeReservationHandle["externalGeneration"] {
  return target.kind === "browser-instance"
    ? { kind: "browser", browserTransportGeneration: target.ref.transportGeneration }
    : { kind: "device-browser", deviceTransportGeneration: target.ref.transportGeneration, browserTransportGeneration: target.ref.browserTransportGeneration }
}

function stableKey(target: InstanceTarget): string {
  return target.kind === "browser-instance"
    ? canonicalJson([target.kind, target.ref.browserInstanceRef])
    : canonicalJson([target.kind, target.ref.deviceRef, target.ref.serial])
}

function physicalKey(value: LifetimeBindingPersistence | LifetimeStateRecord): string {
  return canonicalJson(value.physicalOwnershipKey)
}

function persistenceForTarget(binding: Binding, target: InstanceTarget): LifetimeBindingPersistence | undefined {
  const owner: LifetimeStableOwner = target.kind === "browser-instance"
    ? { kind: "browser", browserInstanceRef: target.ref.browserInstanceRef }
    : {
        kind: "device-browser",
        deviceRef: target.ref.deviceRef,
        serial: target.ref.serial,
        browserInstanceRef: target.ref.browserInstanceRef,
      }
  return persistenceForOwner(binding, owner)
}

function persistenceForOwner(binding: Binding, owner: LifetimeStableOwner): LifetimeBindingPersistence | undefined {
  return binding.persistence?.find(value => structurallyEqual(value.owner, owner))
}
