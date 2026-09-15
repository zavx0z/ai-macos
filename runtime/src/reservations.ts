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
) => Promise<RuntimeExecution<Result>>

// Этот интерфейс предоставляет host composition, а не транспортный caller.
export interface BrowserLifetimeVerifier {
  verifyConnected(target: InstanceTarget, signal: AbortSignal): Promise<void>
  verifyRemoved(target: InstanceTarget, signal: AbortSignal): Promise<void>
  verifyCompletion(request: Request, result: AdapterResult<Result>, signal: AbortSignal): Promise<void>
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
  readonly authority: LifetimeReservationAuthority & {
    resume(session: RuntimeClientSession, reservationId: string): Promise<LifetimeReservationHandle>
  }

  constructor(options: {
    generation: RuntimeGeneration
    clients: ClientSessionRegistry
    run: Runner
    lookup: (operationId: string) => OperationRecord | undefined
    clock?: RuntimeClock
    ids?: RuntimeIdSource
    ttlMs?: number
  }) {
    this.#generation = options.generation
    this.#clients = options.clients
    this.#run = options.run
    this.#lookup = options.lookup
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#ttlMs = options.ttlMs ?? 120_000
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 86_400_000) throw new Error("Reservation TTL вне допустимого диапазона")
    this.authority = Object.freeze({
      assertChild: (request: ReservationChildRequest) => this.#assertChild(request),
      resume: (session: RuntimeClientSession, id: string) => this.#resume(session, id),
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
      }),
    })
  }

  async execute(
    session: RuntimeClientSession,
    bindingId: string,
    intent: RuntimeOperationIntent,
    requestValue: unknown,
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
        if (!parsed.ok) return () => this.#quarantine(slot!)
        if (request.kind === "connect-instance") {
          if (parsed.value.value.kind !== "instance-connected") throw new Error("Connect не вернул actual instance")
          const actual = instanceTarget({
            kind: binding.domain === "browser" ? "browser-instance" : "device-browser-instance",
            ref: parsed.value.value.instance.ref,
          } as InstanceTarget)
          if (stableKey(actual) !== key || structurallyEqual(actual, instance)) throw new Error("Connect не создал новое transport generation")
          await binding.verifier.verifyConnected(actual, context.control.signal)
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
    }, lifecycle)
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

  async #resume(session: RuntimeClientSession, id: string): Promise<LifetimeReservationHandle> {
    await this.#clients.assertActive(session, this.#clock.now())
    const slot = this.#byId.get(id)
    if (slot !== undefined) this.#expire(slot)
    if (slot?.handle === undefined || slot.state !== "active" || slot.lineageId !== this.#clients.lineage(session)) throw new Error("Reservation недоступна этой active lineage")
    return structuredClone(slot.handle)
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
