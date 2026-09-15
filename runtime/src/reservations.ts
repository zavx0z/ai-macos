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
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

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
    this.#bindings.set(id, {
      domain: binding.domain,
      adapter: binding.adapter,
      verifier: Object.freeze({
        verifyConnected: binding.verifier.verifyConnected.bind(binding.verifier),
        verifyRemoved: binding.verifier.verifyRemoved.bind(binding.verifier),
        verifyCompletion: binding.verifier.verifyCompletion.bind(binding.verifier),
        recoverRemoval: binding.verifier.recoverRemoval.bind(binding.verifier),
      }),
    })
  }

  async execute(
    session: RuntimeClientSession,
    bindingId: string,
    intent: RuntimeOperationIntent,
    requestValue: unknown,
    signal?: AbortSignal,
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
        if (!parsed.ok) return () => {
          slot!.children.delete(record.context.operationId)
          delete slot!.disconnecting
          this.#quarantine(slot!)
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
    for (const slot of slots) {
      if (slot.children.size > 0 || slot.disconnecting !== undefined) {
        throw new Error("Lifetime shutdown требует drained child operations и отсутствие disconnect in-flight")
      }
      if (slot.state === "connecting" || slot.handle === undefined) {
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
          const receipt = reservationCleanupReceiptSchema.parse({
            receiptId: this.#ids.next("reservation-shutdown"),
            reservationId: slot.handle!.reservationId,
            reservationGeneration: slot.handle!.reservationGeneration,
            externalGeneration: slot.handle!.externalGeneration,
            statusRevision: slot.handle!.statusRevision + 1,
            cleanupEvidenceRef: slot.disconnecting!,
            issuedAt: this.#clock.now().toISOString(),
            state: "released",
          })
          return () => {
            commitPrevious()
            slot.state = "released"
            slot.receipt = receipt
            slot.handle = { ...slot.handle!, state: "released", statusRevision: receipt.statusRevision }
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
