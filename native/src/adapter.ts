import {
  heldInputLedgerAckMatches,
  nativeCleanupAckMatches,
  nativeCancelAckMatches,
  nativeHandshakeCompatibility,
  nativeLifecycleAckMatches,
  nativeResponseMatchesRequest,
  nativeStatusMatchesRequest,
  nativeExecutionContextSchema,
  clipboardExecutionContextSchema,
  nativeRecoveryGrantSchema,
  nativeRecoveryDescriptorSchema,
  nativeViewAdmissionSchema,
  canonicalRecoveryJson,
  opaqueIdSchema,
  parseWireValue,
  type AdapterControl,
  type AdapterHostContext,
  type BoundNativeEvidencePublisher,
  type HeldInputLedgerSink,
  type NativeAdapter,
  type NativeCancelAck,
  type NativeCancelRequest,
  type NativeCleanupAck,
  type NativeCleanupControl,
  type NativeDrainAck,
  type NativeDrainRequest,
  type NativeGeneration,
  type NativeHandshakeRequest,
  type NativeHandshakeResponse,
  type NativeHeartbeatAck,
  type NativeHeartbeatRequest,
  type NativeOperationStatus,
  type NativeExecutionContext,
  type ClipboardExecutionContext,
  type NativeRecoveryDescriptor,
  type NativeRecoveryGrant,
  type NativeViewAdmission,
  type NativeStatusRequest,
  type ObservedEvent,
  type z,
} from "@meta/shared/contracts"
import {
  NativeTransportStreamDecoder,
  encodeNativeFrame,
  nativeTransportRequestFrameSchema,
  type NativeTransportPacket,
  type NativeTransportRequestFrame,
  type NativeTransportResponseFrame,
} from "./protocol.ts"
import {
  clipboardResponseMatches, nativeClipboardRequestSchema, nativeClipboardResponseSchema,
  NATIVE_CLIPBOARD_WIRE_BYTES,
  type NativeClipboardRequest, type NativeClipboardResponse,
} from "./clipboard-protocol.ts"
import { nativePermissionsRequestSchema, nativePermissionsResponseSchema, nativePermissionsResponseMatches,
  type NativePermissionsRequest, type NativePermissionsResponse } from "./permissions-protocol.ts"
import { nativeHeldRecoveryRequestSchema, nativeHeldRecoveryResponseSchema, nativeHeldRecoveryResponseMatches,
  type NativeHeldRecoveryRequest, type NativeHeldRecoveryResponse } from "./recovery-protocol.ts"
import { nativeDomainRecoveryRequestSchema, nativeDomainRecoveryResponseSchema, nativeDomainRecoveryResponseMatches,
  type NativeDomainRecoveryRequest, type NativeDomainRecoveryResponse } from "./domain-recovery-protocol.ts"
import { nativeObserverRequestSchema, nativeObserverResponseSchema, nativeObserverResponseMatches,
  type NativeObserverRequest, type NativeObserverResponse, type NativeObservedEvent } from "./observer-protocol.ts"
import { nativeHitTestRequestSchema, nativeHitTestResponseSchema, nativeHitTestResultMatches,
  type NativeHitTestRequest, type NativeHitTestResponse } from "./hit-test-protocol.ts"
import { nativeInputReadinessRequestSchema, nativeInputReadinessResponseSchema, nativeInputReadinessResultMatches,
  type NativeInputReadinessRequest, type NativeInputReadinessResponse } from "./readiness-protocol.ts"
import { classifyNativeRecoveryDescriptor } from "./recovery-domain-classifier.ts"

export type NativeRecoveryAuthorizer = (
  wire: NativeExecutionContext | ClipboardExecutionContext,
  descriptor: NativeRecoveryDescriptor,
) => Promise<NativeRecoveryGrant>

export type NativeViewAdmissionAuthorizer = (
  wire: NativeExecutionContext,
  action: Readonly<{ method: "input.execute" | "ax.press", actionKind?: string }>,
  control: AdapterControl,
) => Promise<NativeViewAdmission>

function recoveryDigest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalRecoveryJson(value)).digest("hex")
}

async function waitForAuthority<Value>(work: Promise<Value>, signal: AbortSignal, deadlineAt: string): Promise<Value> {
  signal.throwIfAborted()
  const remaining = Date.parse(deadlineAt) - Date.now()
  if (remaining <= 0) throw new Error("Recovery authorization deadline истёк до send")
  return await new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
    const abort = () => { done(); reject(signal.reason ?? new Error("Recovery authorization отменена")) }
    const timer = setTimeout(() => { done(); reject(new Error("Recovery authorization deadline истёк до send")) }, remaining)
    signal.addEventListener("abort", abort, { once: true })
    void work.then(value => { done(); resolve(value) }, error => { done(); reject(error) })
    if (signal.aborted) abort()
  })
}

export interface NativeTransport {
  send(frame: NativeTransportRequestFrame): Promise<void>
  packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket>
  close(): Promise<void>
}

export interface NativeMutationDeliveryAuthority {
  register(wire: NativeExecutionContext): void
  assertNeverAttempted(wire: NativeExecutionContext): void
}

export interface NativeSourceResponseRegistrar {
  register(sourceResponseRef: string, bytes: Uint8Array): void
}

export type NativeEvidenceBindingResult = {
  publisher: BoundNativeEvidencePublisher
  sourceResponses: NativeSourceResponseRegistrar
}

export type NativeEvidenceBinder = (identity: {
  adapterInstanceRef: string
  loadedBuildId: string
  generation: NativeGeneration
}) => NativeEvidenceBindingResult

type PendingResponse = {
  channel: NativeTransportResponseFrame["channel"]
  resolve: (frame: NativeTransportResponseFrame) => void
  reject: (error: Error) => void
}

type BinaryWaiter = {
  expectedLength: number
  resolve: (bytes: Uint8Array) => void
  reject: (error: Error) => void
}

type EventWaiter = {
  resolve: (event: ObservedEvent) => void
  reject: (error: Error) => void
  signal: AbortSignal
  onAbort: () => void
}

export class NativeBrokerAdapter implements NativeAdapter {
  readonly host: AdapterHostContext
  readonly adapterInstanceRef: string
  readonly ledgerSink: HeldInputLedgerSink
  generation?: NativeGeneration

  readonly #transport: NativeTransport
  readonly #bindEvidence: NativeEvidenceBinder
  #sourceResponses: NativeSourceResponseRegistrar | undefined
  #evidencePublisher: BoundNativeEvidencePublisher | undefined
  #loadedBuildId: string | undefined
  #recoveryDomainVersion: "1" | undefined
  #viewAdmissionVersion: "1" | undefined
  #viewAuthorizer: NativeViewAdmissionAuthorizer | undefined
  #pendingViewAuthorizations = 0
  #recoveryAuthorizer: NativeRecoveryAuthorizer | undefined
  #pendingRecoveryAuthorizations = 0
  #anyMutationAttempted = false
  readonly #readerAbort = new AbortController()
  readonly #pending = new Map<string, PendingResponse>()
  readonly #expired = new Map<string, number>()
  readonly #seenRequestIds = new Map<string, number>()
  readonly #mutationDeliveries = new Map<string, { fingerprint: string, registered: boolean, attempted: boolean }>()
  readonly mutationDelivery: NativeMutationDeliveryAuthority = Object.freeze({
    register: (wire: NativeExecutionContext) => {
      const entry = this.#deliveryEntry(wire)
      entry.registered = true
    },
    assertNeverAttempted: (wire: NativeExecutionContext) => {
      const parsed = parseWireValue(nativeExecutionContextSchema, wire)
      this.#assertGeneration(parsed)
      const entry = this.#mutationDeliveries.get(this.#deliveryKey(parsed))
      if (entry === undefined || !entry.registered || entry.fingerprint !== JSON.stringify(parsed) || entry.attempted) {
        throw new Error("Native mutation delivery не подтверждает registered never-attempted context")
      }
    },
  })
  readonly #heartbeatRequestIds = new Map<string, number>()
  readonly #observerPreparations = new Map<string, { request: NativeObserverRequest, expiresAt: number, abandoned: boolean }>()
  readonly #events: Array<{ event: NativeObservedEvent, bytes: number }> = []
  #eventBytes = 0
  #eventGap: Error | undefined
  #eventConsumerActive = false
  readonly #eventWaiters: EventWaiter[] = []
  readonly #binary = new Map<string, Uint8Array>()
  readonly #binaryWaiters = new Map<string, BinaryWaiter>()
  readonly #reader: Promise<void>
  #closed = false
  #poisoned: Error | undefined
  #transportClosing: Promise<void> | undefined
  #rotationSealed = false
  #ledgerWrites = 0
  readonly #startedAt = Date.now()

  get sessionState() {
    const rotationRequired = this.#seenRequestIds.size >= 9_000 || Date.now() - this.#startedAt >= 24 * 60 * 60 * 1000
    return {
      state: this.#poisoned !== undefined ? "poisoned" as const : this.#closed ? "closed" as const : this.#rotationSealed ? "draining" as const : rotationRequired ? "rotation-required" as const : "ready" as const,
      requestsUsed: this.#seenRequestIds.size,
      pendingRequests: this.#pending.size + this.#pendingRecoveryAuthorizations + this.#pendingViewAuthorizations,
      pendingBinaries: this.#binary.size + this.#binaryWaiters.size,
      pendingLedgerWrites: this.#ledgerWrites,
    }
  }

  sealForRotation(): void {
    if (this.#closed || this.#rotationSealed) throw new Error("Native session уже закрыта или дренируется")
    if (this.#pending.size || this.#pendingRecoveryAuthorizations || this.#pendingViewAuthorizations || this.#binary.size || this.#binaryWaiters.size || this.#ledgerWrites) {
      throw new Error("Native rotation требует завершённых requests/binaries/ledger writes")
    }
    this.#rotationSealed = true
  }

  constructor(options: {
    host: AdapterHostContext
    ledgerSink: HeldInputLedgerSink
    adapterInstanceRef: string
    bindEvidence: NativeEvidenceBinder
    transport: NativeTransport
  }) {
    this.host = options.host
    this.adapterInstanceRef = opaqueIdSchema.parse(options.adapterInstanceRef)
    this.ledgerSink = options.ledgerSink
    this.#transport = options.transport
    this.#bindEvidence = options.bindEvidence
    this.#reader = this.#readPackets()
  }

  get loadedBuildId(): string {
    if (this.#loadedBuildId === undefined) throw new Error("Native handshake ещё не подтвердил loaded build")
    return this.#loadedBuildId
  }

  get evidencePublisher(): BoundNativeEvidencePublisher {
    if (this.#evidencePublisher === undefined) throw new Error("Native evidence binding ещё не создан после handshake")
    return this.#evidencePublisher
  }

  async handshake(request: NativeHandshakeRequest, signal?: AbortSignal): Promise<NativeHandshakeResponse> {
    if (
      request.runtimeEpoch !== this.host.generation.runtimeEpoch
      || request.loginSessionId !== this.host.generation.loginSessionId
    ) {
      throw new Error("Native handshake request принадлежит другому adapter host")
    }
    const response = await this.#exchange("handshake", { channel: "handshake", payload: request }, request.requestId, signal)
    if (response.channel !== "handshake") throw new Error("Native transport вернул другой handshake channel")
    const mismatch = nativeHandshakeCompatibility(request, response.payload)
    if (mismatch !== undefined) throw new Error(mismatch.message)
    this.generation = {
      runtimeEpoch: response.payload.runtimeEpoch,
      loginSessionId: response.payload.loginSessionId,
      nativeGeneration: response.payload.nativeGeneration,
    }
    this.#loadedBuildId = response.payload.nativeBuildId
    this.#recoveryDomainVersion = response.payload.recoveryDomainVersion
    this.#viewAdmissionVersion = response.payload.viewAdmissionVersion
    const evidence = this.#bindEvidence({
      adapterInstanceRef: this.adapterInstanceRef,
      loadedBuildId: this.#loadedBuildId,
      generation: this.generation,
    })
    this.#evidencePublisher = evidence.publisher
    this.#sourceResponses = evidence.sourceResponses
    return response.payload
  }

  configureRecoveryAuthority(authorize: NativeRecoveryAuthorizer): void {
    if (typeof authorize !== "function" || this.#closed || this.#recoveryAuthorizer !== undefined || this.#pendingRecoveryAuthorizations > 0
      || this.#anyMutationAttempted) {
      throw new Error("Recovery authority задаётся один раз до mutation send")
    }
    this.#recoveryAuthorizer = authorize
  }

  configureViewAdmissionAuthorizer(authorize: NativeViewAdmissionAuthorizer): void {
    if (typeof authorize !== "function" || this.#closed || this.#viewAuthorizer !== undefined
      || this.#pendingViewAuthorizations > 0 || this.#anyMutationAttempted) {
      throw new Error("View admission authorizer задаётся один раз до mutation send")
    }
    this.#viewAuthorizer = authorize
  }

  async #authorizeViewFrame(frame: NativeTransportRequestFrame, control: AdapterControl): Promise<NativeTransportRequestFrame> {
    if (frame.channel !== "request" || frame.payload.intent !== "mutation") return frame
    const request = frame.payload
    if (request.viewAdmission !== undefined) throw new Error("Caller viewAdmission не является Runtime authority")
    if (request.method !== "input.execute" && request.method !== "ax.press") return frame
    if (this.#viewAdmissionVersion !== "1") return frame
    const authorize = this.#viewAuthorizer
    if (authorize === undefined) throw new Error("Native view admission v1 требует configured Runtime authorizer")
    if (request.recoveryGrant === undefined || this.#recoveryDomainVersion !== "1") throw new Error("View admission требует предшествующий durable recovery grant")
    control.signal.throwIfAborted()
    if (this.#closed || this.#rotationSealed || this.#pending.size + this.#pendingViewAuthorizations + this.#pendingRecoveryAuthorizations >= 128) {
      throw new Error("Native session не принимает view admission")
    }
    const contextSha256 = recoveryDigest(request.operation)
    const wire = parseWireValue(nativeExecutionContextSchema, request.operation)
    const action = request.method === "input.execute"
      ? { method: request.method, actionKind: request.payload.action.kind }
      : { method: request.method }
    this.#pendingViewAuthorizations += 1
    const work = Promise.resolve().then(async () => {
      control.signal.throwIfAborted()
      return await authorize(wire, action, control)
    }).finally(() => { this.#pendingViewAuthorizations -= 1 })
    void work.catch(() => undefined)
    const proof = nativeViewAdmissionSchema.parse(await waitForAuthority(work, control.signal, request.deadlineAt))
    if (proof.contextSha256 !== contextSha256 || Date.parse(proof.expiresAt) > Date.parse(request.deadlineAt)
      || Date.parse(proof.expiresAt) <= Date.now()) {
      throw new Error("View admission не соответствует current context, action или expiry")
    }
    control.signal.throwIfAborted()
    await control.checkpoint("native-after-view-admission")
    if (this.#closed || this.#rotationSealed) throw new Error("Native session закрылась до guarded send")
    return nativeTransportRequestFrameSchema.parse({ ...frame, payload: { ...request, viewAdmission: proof } })
  }

  async #authorizeRecoveryFrame(frame: NativeTransportRequestFrame, control: AdapterControl): Promise<NativeTransportRequestFrame> {
    const mutation = frame.channel === "request" && frame.payload.intent === "mutation"
      ? frame.payload
      : frame.channel === "clipboard" && frame.payload.command.method === "clipboard.write" ? frame.payload : undefined
    if (mutation === undefined) return frame
    if (mutation.recoveryGrant !== undefined) throw new Error("Caller recoveryGrant не является durable authority")
    if (this.#recoveryDomainVersion !== "1") return frame
    const authorize = this.#recoveryAuthorizer
    if (authorize === undefined) throw new Error("Native RecoveryDomain v1 требует configured durable authority до send")
    control.signal.throwIfAborted()
    if (this.#closed || this.#rotationSealed || this.#pending.size + this.#pendingRecoveryAuthorizations >= 128) {
      throw new Error("Native session не принимает recovery authorization")
    }
    const descriptor = classifyNativeRecoveryDescriptor(mutation, this.loadedBuildId)
    const contextSha256 = recoveryDigest(mutation.operation)
    const descriptorSha256 = recoveryDigest(descriptor)
    const wire = mutation.operation.kind === "native"
      ? parseWireValue(nativeExecutionContextSchema, mutation.operation)
      : parseWireValue(clipboardExecutionContextSchema, mutation.operation)
    this.#pendingRecoveryAuthorizations += 1
    const work = Promise.resolve().then(async () => {
      control.signal.throwIfAborted()
      return await authorize(wire, nativeRecoveryDescriptorSchema.parse(descriptor))
    }).finally(() => { this.#pendingRecoveryAuthorizations -= 1 })
    void work.catch(() => undefined)
    const grant = nativeRecoveryGrantSchema.parse(await waitForAuthority(work, control.signal, mutation.deadlineAt))
    if (grant.runtimeEpoch !== mutation.runtimeEpoch || grant.loginSessionId !== mutation.loginSessionId
      || grant.nativeGeneration !== mutation.nativeGeneration || grant.operationId !== mutation.operation.operationId
      || grant.contextSha256 !== contextSha256 || grant.descriptorSha256 !== descriptorSha256
      || recoveryDigest(grant.descriptor) !== descriptorSha256 || canonicalRecoveryJson(grant.descriptor) !== canonicalRecoveryJson(descriptor)) {
      throw new Error("Durable recovery grant не совпадает с actual context или primitive descriptor")
    }
    control.signal.throwIfAborted()
    await control.checkpoint("native-after-recovery-authority")
    if (this.#closed || this.#rotationSealed) throw new Error("Native session закрылась до authorized send")
    return nativeTransportRequestFrameSchema.parse({ ...frame, payload: { ...mutation, recoveryGrant: grant } })
  }

  async request<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    requestSchema: RequestSchema,
    request: z.input<RequestSchema>,
    responseSchema: ResponseSchema,
    control: AdapterControl,
  ): Promise<z.output<ResponseSchema>> {
    await control.checkpoint("native-before-request")
    const parsedRequest = parseWireValue(requestSchema, request) as {
      requestId: string
      runtimeEpoch: string
      loginSessionId: string
      nativeGeneration: string
      operation?: { operationId: string }
    }
    this.#assertGeneration(parsedRequest)
    const rawFrame = nativeTransportRequestFrameSchema.parse({
      channel: "request",
      payload: parsedRequest,
    })
    if (rawFrame.channel === "request" && rawFrame.payload.intent === "mutation" && rawFrame.payload.viewAdmission !== undefined) {
      throw new Error("Caller viewAdmission не является Runtime authority")
    }
    const frame = await this.#authorizeViewFrame(await this.#authorizeRecoveryFrame(rawFrame, control), control)
    const response = await this.#exchange(
      "response",
      frame,
      parsedRequest.requestId,
      control.signal,
      (parsedRequest as { deadlineAt?: string }).deadlineAt,
    )
    await control.checkpoint("native-after-response")
    if (response.channel !== "response") throw new Error("Native transport вернул другой response channel")
    const parsedResponse = parseWireValue(responseSchema, response.payload)
    if (!nativeResponseMatchesRequest(parsedRequest, response.payload)) {
      throw new Error("Native response не коррелирует с request")
    }
    return parsedResponse
  }

  async heartbeat(request: NativeHeartbeatRequest, control: AdapterControl): Promise<NativeHeartbeatAck> {
    this.#assertGeneration(request)
    await control.checkpoint("native-before-heartbeat")
    const response = await this.#exchange("heartbeat", {
      channel: "heartbeat",
      payload: request,
    }, request.requestId, control.signal, request.deadlineAt)
    if (response.channel !== "heartbeat" || !nativeLifecycleAckMatches(request, response.payload)) {
      throw new Error("Native heartbeat ACK не коррелирует с request")
    }
    return response.payload
  }

  async hitTest(request: NativeHitTestRequest, control: AdapterControl): Promise<NativeHitTestResponse> {
    const response = await this.request(nativeHitTestRequestSchema, request, nativeHitTestResponseSchema, control)
    if (response.ok && !nativeHitTestResultMatches(request, response.result)) throw new Error("Native hit-test ответ не совпадает с operation/frame/point")
    return response
  }

  async inputReadiness(request: NativeInputReadinessRequest, control: AdapterControl): Promise<NativeInputReadinessResponse> {
    const response = await this.request(nativeInputReadinessRequestSchema, request, nativeInputReadinessResponseSchema, control)
    if (response.ok && !nativeInputReadinessResultMatches(request, response.result)) {
      throw new Error("Native readiness ответ не совпадает с operation/exact display")
    }
    return response
  }

  async observer(request: NativeObserverRequest, control: AdapterControl): Promise<NativeObserverResponse> {
    control.signal.throwIfAborted()
    const parsed = parseWireValue(nativeObserverRequestSchema, request)
    this.#assertGeneration(parsed)
    await control.checkpoint("native-before-observer-lifecycle")
    if (parsed.command === "prepare") {
      for (const [id, entry] of this.#observerPreparations) if (entry.expiresAt <= Date.now()) this.#observerPreparations.delete(id)
      if (this.#observerPreparations.size >= 128) throw new Error("Native observer prepare retention исчерпан")
      this.#observerPreparations.set(parsed.requestId, { request: parsed, expiresAt: Date.parse(parsed.deadlineAt) + 10000, abandoned: false })
    }
    let value: NativeObserverResponse | undefined
    try {
      const response = await this.#exchange("observer", { channel: "observer", payload: parsed }, parsed.requestId, control.signal, parsed.deadlineAt)
      if (response.channel !== "observer") throw new Error("Native observer response channel не совпадает")
      value = parseWireValue(nativeObserverResponseSchema, response.payload)
      if (!nativeObserverResponseMatches(parsed, value, this.loadedBuildId)) throw new Error("Native observer response identity/instance/cursor не совпадает")
      await control.checkpoint("native-after-observer-lifecycle")
      this.#observerPreparations.delete(parsed.requestId)
      return value
    } catch (error) {
      const pending = this.#observerPreparations.get(parsed.requestId)
      if (pending !== undefined) pending.abandoned = true
      if (value !== undefined && parsed.command === "prepare") {
        this.#observerPreparations.delete(parsed.requestId)
        if (value.ok) await this.#stopOrphanObserver(parsed, value)
      }
      throw error
    }
  }

  async permissions(request: NativePermissionsRequest, control: AdapterControl): Promise<NativePermissionsResponse> {
    control.signal.throwIfAborted()
    const parsed = parseWireValue(nativePermissionsRequestSchema, request)
    this.#assertGeneration(parsed)
    await control.checkpoint("native-before-passive-permissions")
    const response = await this.#exchange("permissions", { channel: "permissions", payload: parsed }, parsed.requestId, control.signal, parsed.deadlineAt)
    if (response.channel !== "permissions") throw new Error("Native permissions response channel mismatch")
    const value = parseWireValue(nativePermissionsResponseSchema, response.payload)
    if (!nativePermissionsResponseMatches(parsed, value, this.loadedBuildId)) throw new Error("Native permissions response identity mismatch")
    await control.checkpoint("native-after-passive-permissions")
    return value
  }

  async heldRecovery(request: NativeHeldRecoveryRequest, control: AdapterControl): Promise<NativeHeldRecoveryResponse> {
    control.signal.throwIfAborted()
    const parsed = parseWireValue(nativeHeldRecoveryRequestSchema, request)
    this.#assertGeneration(parsed)
    await control.checkpoint("native-before-passive-held-recovery")
    const response = await this.#exchange("held-recovery", { channel: "held-recovery", payload: parsed }, parsed.requestId, control.signal, parsed.deadlineAt)
    if (response.channel !== "held-recovery") throw new Error("Native held recovery response channel mismatch")
    const value = parseWireValue(nativeHeldRecoveryResponseSchema, response.payload)
    if (!nativeHeldRecoveryResponseMatches(parsed, value, this.loadedBuildId)) throw new Error("Native held recovery response identity mismatch")
    await control.checkpoint("native-after-passive-held-recovery")
    return value
  }

  async domainRecovery(request: NativeDomainRecoveryRequest, control: AdapterControl): Promise<NativeDomainRecoveryResponse> {
    control.signal.throwIfAborted()
    const parsed = parseWireValue(nativeDomainRecoveryRequestSchema, request)
    this.#assertGeneration(parsed)
    await control.checkpoint("native-before-passive-domain-recovery")
    const response = await this.#exchange("domain-recovery", { channel: "domain-recovery", payload: parsed }, parsed.requestId, control.signal, parsed.deadlineAt)
    if (response.channel !== "domain-recovery") throw new Error("Native domain recovery response channel mismatch")
    const value = parseWireValue(nativeDomainRecoveryResponseSchema, response.payload)
    if (!nativeDomainRecoveryResponseMatches(parsed, value, this.loadedBuildId)) throw new Error("Native domain recovery response identity mismatch")
    await control.checkpoint("native-after-passive-domain-recovery")
    return value
  }

  async clipboard(request: NativeClipboardRequest, control: AdapterControl): Promise<NativeClipboardResponse> {
    control.signal.throwIfAborted()
    const parsed = parseWireValue(nativeClipboardRequestSchema, request, { maxBytes: NATIVE_CLIPBOARD_WIRE_BYTES, maxDepth: 32 })
    this.#assertGeneration(parsed)
    await control.checkpoint("native-before-clipboard")
    const frame = await this.#authorizeRecoveryFrame({ channel: "clipboard", payload: parsed }, control)
    const response = await this.#exchange("clipboard", frame, parsed.requestId, control.signal, parsed.deadlineAt)
    if (response.channel !== "clipboard") throw new Error("Native clipboard response channel mismatch")
    const value = parseWireValue(nativeClipboardResponseSchema, response.payload, { maxBytes: NATIVE_CLIPBOARD_WIRE_BYTES, maxDepth: 32 })
    if (!clipboardResponseMatches(parsed, value)) throw new Error("Native clipboard response identity mismatch")
    return value
  }

  async status(request: NativeStatusRequest, signal?: AbortSignal): Promise<NativeOperationStatus> {
    this.#assertGeneration(request)
    const response = await this.#exchange("status", {
      channel: "status",
      payload: request,
    }, request.requestId, signal, request.deadlineAt)
    if (response.channel !== "status" || !nativeStatusMatchesRequest(request, response.payload)) {
      throw new Error("Native status не коррелирует с request")
    }
    return response.payload
  }

  async cancel(request: NativeCancelRequest, control: AdapterControl): Promise<NativeCancelAck> {
    this.#assertGeneration(request)
    await control.checkpoint("native-before-cancel")
    const response = await this.#exchange("cancel", {
      channel: "cancel",
      payload: request,
    }, request.requestId, control.signal, request.deadlineAt)
    if (response.channel !== "cancel" || !nativeCancelAckMatches(request, response.payload)) {
      throw new Error("Native cancel ACK не коррелирует с request")
    }
    return response.payload
  }

  async drain(request: NativeDrainRequest, control: AdapterControl): Promise<NativeDrainAck> {
    this.#assertGeneration(request)
    await control.checkpoint("native-before-drain")
    const response = await this.#exchange("drain", {
      channel: "drain",
      payload: request,
    }, request.requestId, control.signal, request.deadlineAt)
    if (response.channel !== "drain" || !nativeLifecycleAckMatches(request, response.payload)) {
      throw new Error("Native drain ACK не коррелирует с request")
    }
    return response.payload
  }

  async cleanup<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    requestSchema: RequestSchema,
    request: z.input<RequestSchema>,
    responseSchema: ResponseSchema,
    control: AdapterControl,
  ): Promise<z.output<ResponseSchema>> {
    const parsedRequest = parseWireValue(requestSchema, request) as {
      control: NativeCleanupControl
    }
    this.#assertGeneration(parsedRequest.control)
    await control.checkpoint("native-before-cleanup")
    const frame = nativeTransportRequestFrameSchema.parse({
      channel: "cleanup",
      payload: parsedRequest,
    })
    const response = await this.#exchange(
      "cleanup",
      frame,
      parsedRequest.control.requestId,
      control.signal,
      parsedRequest.control.deadlineAt,
    )
    await control.checkpoint("native-after-cleanup")
    if (response.channel !== "cleanup") throw new Error("Native transport вернул другой cleanup channel")
    const parsedResponse = parseWireValue(responseSchema, response.payload)
    const responseWithAck = parsedResponse as { ack: NativeCleanupAck }
    if (!nativeCleanupAckMatches(parsedRequest.control, responseWithAck.ack)) {
      throw new Error("Native cleanup ACK не коррелирует с runtime control")
    }
    return parsedResponse
  }

  async *events(signal: AbortSignal): AsyncIterable<NativeObservedEvent> {
    if (this.#eventConsumerActive) throw new Error("Native events допускает только один host observer consumer")
    this.#eventConsumerActive = true
    try {
      while (!signal.aborted && !this.#closed) {
        if (this.#eventGap !== undefined) throw this.#eventGap
        const current = this.#events.shift()
        if (current !== undefined) {
          this.#eventBytes -= current.bytes
          yield current.event
          continue
        }
        const event = await new Promise<ObservedEvent>((resolve, reject) => {
          const waiter: EventWaiter = { resolve, reject, signal, onAbort: () => undefined }
          const onAbort = () => {
            const index = this.#eventWaiters.indexOf(waiter)
            if (index >= 0) this.#eventWaiters.splice(index, 1)
            reject(signal.reason ?? new Error("Native event stream отменён"))
          }
          waiter.onAbort = onAbort
          signal.addEventListener("abort", onAbort, { once: true })
          this.#eventWaiters.push(waiter)
        })
        yield event
      }
    } finally { this.#eventConsumerActive = false }
  }

  async takeBinary(binaryToken: string, expectedLength: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    if (!Number.isInteger(expectedLength) || expectedLength < 1 || expectedLength > 64 * 1024 * 1024) {
      throw new Error("Некорректный expected binary length")
    }
    const available = this.#binary.get(binaryToken)
    if (available !== undefined) {
      this.#binary.delete(binaryToken)
      if (available.byteLength !== expectedLength) throw new Error("Native binary length не совпадает с metadata")
      return available
    }
    if (this.#binaryWaiters.has(binaryToken)) throw new Error("Binary token уже ожидается")
    const waitingBytes = [...this.#binaryWaiters.values()].reduce((total, item) => total + item.expectedLength, 0)
    if (this.#binaryWaiters.size >= 4 || waitingBytes + expectedLength > 128 * 1024 * 1024) {
      throw new Error("Native binary waiters превышают session limit")
    }
    return await new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = () => {
        this.#binaryWaiters.delete(binaryToken)
        reject(signal?.reason ?? new Error("Ожидание native binary отменено"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#binaryWaiters.set(binaryToken, {
        expectedLength,
        resolve: (bytes) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(bytes)
        },
        reject,
      })
    })
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#transportClosing
      return
    }
    this.#closed = true
    this.#readerAbort.abort(new Error("Native adapter закрыт"))
    this.#transportClosing = (async () => {
      try { await this.#transport.close() }
      finally {
        this.#rejectPending(new Error("Native adapter закрыт"))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([this.#reader.catch(() => undefined), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Native reader shutdown не подтверждён за bounded deadline")), 1000)
          })])
        } finally { if (timer !== undefined) clearTimeout(timer) }
      }
    })()
    await this.#transportClosing
  }

  async #exchange(
    expectedChannel: NativeTransportResponseFrame["channel"],
    frame: NativeTransportRequestFrame,
    requestId: string,
    signal?: AbortSignal,
    deadlineAt?: string,
  ): Promise<NativeTransportResponseFrame> {
    signal?.throwIfAborted()
    if (this.#closed) throw new Error("Native adapter закрыт")
    frame = nativeTransportRequestFrameSchema.parse(frame)
    const sealedControl = ["drain", "cleanup", "status", "cancel", "held-recovery", "domain-recovery", "permissions"].includes(frame.channel)
      || (frame.channel === "observer" && frame.payload.command !== "prepare")
    if (this.#rotationSealed && !sealedControl) throw new Error("Native session draining: runtime rotation выполняется")
    if (this.sessionState.state === "rotation-required" && (frame.channel === "request" || frame.channel === "clipboard")) {
      throw new Error("Native session rotation-required: runtime должен завершить drain и сменить generation")
    }
    const key = `${expectedChannel}:${requestId}`
    this.#pruneRequestTombstones()
    if (this.#seenRequestIds.has(requestId) || this.#heartbeatRequestIds.has(requestId)) throw new Error(`Native requestId уже использован: ${requestId}`)
    if (this.#seenRequestIds.size >= 10_000 && frame.channel !== "drain") throw new Error("Native session exhausted: разрешён только runtime drain")
    if (this.#seenRequestIds.size >= 10_128) throw new Error("Native session exhausted: reserve drain requests исчерпан, требуется runtime quarantine")
    if (this.#pending.size >= 128) throw new Error("Native concurrent request limit исчерпан")
    if (this.#pending.has(key)) throw new Error(`Native request уже ожидается: ${requestId}`)
    if (frame.channel === "heartbeat") {
      if (this.#heartbeatRequestIds.size >= 128) throw new Error("Native heartbeat recent correlation capacity exceeded")
      this.#heartbeatRequestIds.set(requestId, Date.now() + 5000)
    } else this.#seenRequestIds.set(requestId, Date.now() + 24 * 60 * 60 * 1000)
    return await new Promise<NativeTransportResponseFrame>((resolve, reject) => {
      const remainingMs = deadlineAt === undefined ? undefined : Date.parse(deadlineAt) - Date.now()
      if (remainingMs !== undefined && remainingMs <= 0) {
        reject(new Error("Native request deadline уже истёк"))
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const expire = (error: Error) => {
        this.#pending.delete(key)
        this.#expired.set(key, Date.now() + (frame.channel === "heartbeat" ? 5000 : 24 * 60 * 60 * 1000))
        reject(error)
      }
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer)
        expire(signal?.reason ?? new Error("Native request отменён"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (remainingMs !== undefined) {
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          expire(new Error("Native request deadline exceeded; outcome требует status reconciliation"))
        }, remainingMs)
      }
      this.#pending.set(key, {
        channel: expectedChannel,
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort)
          if (timer !== undefined) clearTimeout(timer)
          resolve(response)
        },
        reject,
      })
      try {
        if ((frame.channel === "request" && frame.payload.intent === "mutation")
          || (frame.channel === "clipboard" && frame.payload.command.method === "clipboard.write")) this.#anyMutationAttempted = true
        if (frame.channel === "request" && frame.payload.intent === "mutation") this.#deliveryEntry(frame.payload.operation).attempted = true
      } catch (error) {
        this.#pending.delete(key)
        signal?.removeEventListener("abort", onAbort)
        if (timer !== undefined) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      void this.#transport.send(frame).catch((error) => {
        this.#pending.delete(key)
        signal?.removeEventListener("abort", onAbort)
        if (timer !== undefined) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  async #readPackets(): Promise<void> {
    try {
      for await (const packet of this.#transport.packets(this.#readerAbort.signal)) {
        if (this.#closed) return
        if (packet.kind === "binary") {
          this.#acceptBinary(packet.binaryToken, packet.bytes)
          continue
        }
        await this.#acceptFrame(packet.frame, packet.bytes)
      }
      if (!this.#closed) throw new Error("Native transport завершился до close")
    } catch (error) {
      if (!this.#closed) this.#poison(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async #acceptFrame(frame: NativeTransportResponseFrame, bytes?: Uint8Array): Promise<void> {
    if (frame.channel === "event") {
      this.#assertGeneration(frame.payload)
      const event: NativeObservedEvent = "event" in frame.payload
        ? { ...frame.payload.event, observerInstanceRef: frame.payload.observerInstanceRef }
        : frame.payload
      const waiter = this.#eventWaiters.shift()
      if (waiter === undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(frame.payload)).byteLength
        if (this.#events.length >= 1_000 || this.#eventBytes + bytes > 1024 * 1024) {
          this.#events.length = 0
          this.#eventBytes = 0
          this.#eventGap = new Error("Native event buffer overflow: observer coverage содержит gap")
          for (const pendingWaiter of this.#eventWaiters.splice(0)) {
            pendingWaiter.signal.removeEventListener("abort", pendingWaiter.onAbort)
            pendingWaiter.reject(this.#eventGap)
          }
          return
        }
        this.#events.push({ event, bytes })
        this.#eventBytes += bytes
      }
      else {
        waiter.signal.removeEventListener("abort", waiter.onAbort)
        waiter.resolve(event)
      }
      return
    }
    if (frame.channel === "ledger-persist") {
      if (this.#ledgerWrites >= 8) throw new Error("Native ledger ACK queue overflow")
      this.#ledgerWrites += 1
      void (async () => {
        try {
          const ack = await this.ledgerSink.persist(frame.payload.requestId, frame.payload.snapshot)
          if (!heldInputLedgerAckMatches(frame.payload.requestId, frame.payload.snapshot, ack)) {
            throw new Error("Ledger sink вернул некоррелированный durable ACK")
          }
          await this.#transport.send(nativeTransportRequestFrameSchema.parse({ channel: "ledger-ack", payload: ack }))
        } catch (cause) {
          this.#poison(cause instanceof Error ? cause : new Error(String(cause)))
        } finally {
          this.#ledgerWrites -= 1
        }
      })()
      return
    }
    if (frame.channel === "binary") {
      throw new Error("Binary header не был обработан stream decoder")
    }
    if (this.#sourceResponses !== undefined) {
      for (const sourceResponseRef of sourceResponseRefs(frame)) {
        this.#sourceResponses.register(
          sourceResponseRef,
          bytes ?? new TextEncoder().encode(JSON.stringify(frame)),
        )
      }
    }
    const requestId = frame.channel === "cleanup"
      ? frame.payload.ack.requestId
      : frame.payload.requestId
    const key = `${frame.channel}:${requestId}`
    const pending = this.#pending.get(key)
    if (pending === undefined) {
      if (this.#expired.delete(key)) {
        if (frame.channel === "observer") {
          const orphan = this.#observerPreparations.get(requestId)
          this.#observerPreparations.delete(requestId)
          if (orphan !== undefined && frame.payload.ok) {
            if (!nativeObserverResponseMatches(orphan.request, frame.payload, this.loadedBuildId)) throw new Error("Late observer prepare identity не совпадает")
            void this.#stopOrphanObserver(orphan.request, frame.payload).catch(error => this.#poison(error instanceof Error ? error : new Error(String(error))))
          }
        }
        return
      }
      throw new Error(`Неожиданный native response: ${key}`)
    }
    this.#pending.delete(key)
    pending.resolve(frame)
  }

  #acceptBinary(binaryToken: string, bytes: Uint8Array): void {
    const waiter = this.#binaryWaiters.get(binaryToken)
    if (waiter === undefined) {
      if (this.#binary.has(binaryToken)) throw new Error(`Повторный native binary token: ${binaryToken}`)
      const storedBytes = [...this.#binary.values()].reduce((total, item) => total + item.byteLength, 0)
      if (this.#binary.size >= 4 || storedBytes + bytes.byteLength > 128 * 1024 * 1024) {
        throw new Error("Native binary cache превышает session limit")
      }
      this.#binary.set(binaryToken, bytes)
      return
    }
    this.#binaryWaiters.delete(binaryToken)
    if (bytes.byteLength !== waiter.expectedLength) {
      waiter.reject(new Error("Native binary length не совпадает с metadata"))
      return
    }
    waiter.resolve(bytes)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    for (const waiter of this.#binaryWaiters.values()) waiter.reject(error)
    this.#binaryWaiters.clear()
    for (const waiter of this.#eventWaiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      waiter.reject(error)
    }
    this.#eventWaiters.length = 0
  }

  #poison(error: Error): void {
    if (this.#closed) return
    this.#poisoned = error
    this.#closed = true
    this.#readerAbort.abort(error)
    this.#rejectPending(error)
    this.#transportClosing = this.#transport.close()
    void this.#transportClosing.catch(() => undefined)
  }

  #pruneRequestTombstones(): void {
    const now = Date.now()
    for (const [id, expiresAt] of this.#heartbeatRequestIds) if (expiresAt <= now) this.#heartbeatRequestIds.delete(id)
    for (const [key, expiresAt] of this.#expired) {
      if (expiresAt <= now) this.#expired.delete(key)
    }
  }

  #assertGeneration(value: {
    runtimeEpoch: string
    loginSessionId: string
    nativeGeneration: string
  }): void {
    if (this.generation === undefined) throw new Error("Native handshake ещё не завершён")
    if (
      value.runtimeEpoch !== this.generation.runtimeEpoch
      || value.loginSessionId !== this.generation.loginSessionId
      || value.nativeGeneration !== this.generation.nativeGeneration
    ) {
      throw new Error("Native request принадлежит другой generation")
    }
  }

  #deliveryKey(wire: NativeExecutionContext): string {
    return JSON.stringify([wire.runtimeEpoch, wire.loginSessionId, wire.nativeGeneration, wire.operationId])
  }

  async #stopOrphanObserver(request: NativeObserverRequest, response: NativeObserverResponse): Promise<void> {
    if (!response.ok || !nativeObserverResponseMatches(request, response, this.loadedBuildId)) {
      const error = new Error("Orphan observer не имеет exact identity")
      this.#poison(error)
      throw error
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("Orphan observer stop deadline")), 1000)
    try {
      const stopped = await this.observer({ kind: "observer", protocolVersion: "1", command: "stop", requestId: `observer-stop-${crypto.randomUUID()}`,
        runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration,
        observerInstanceRef: response.snapshot.observerInstanceRef, deadlineAt: new Date(Date.now() + 1000).toISOString() },
      { signal: controller.signal, checkpoint: () => undefined })
      if (!stopped.ok || stopped.snapshot.coverage.state === "ready") throw new Error("Orphan observer stop не подтверждён")
    } catch (error) {
      this.#poison(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally { clearTimeout(timer) }
  }

  #deliveryEntry(wire: NativeExecutionContext) {
    const parsed = parseWireValue(nativeExecutionContextSchema, wire)
    this.#assertGeneration(parsed)
    const key = this.#deliveryKey(parsed)
    const fingerprint = JSON.stringify(parsed)
    const previous = this.#mutationDeliveries.get(key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) throw new Error("Native mutation operationId переиспользован с другим context")
      return previous
    }
    if (this.#mutationDeliveries.size >= 10000) throw new Error("Native mutation delivery horizon исчерпан; требуется rotation")
    const entry = { fingerprint, registered: false, attempted: false }
    this.#mutationDeliveries.set(key, entry)
    return entry
  }
}

function sourceResponseRefs(frame: NativeTransportResponseFrame): string[] {
  const refs = new Set<string>()
  if (frame.channel === "response" && frame.payload.ok) {
    const result = frame.payload.result as { sourceResponseRef?: unknown }
    if (typeof result.sourceResponseRef === "string") refs.add(result.sourceResponseRef)
  }
  if (frame.channel === "cleanup") {
    if (frame.payload.purpose === "result") {
      if (frame.payload.poll.state === "completed") {
        refs.add(frame.payload.poll.result.sourceResponseRef)
        if (frame.payload.poll.status.cleanup !== "complete" || !frame.payload.poll.status.drained) {
          refs.add(frame.payload.statusEvidence.sourceResponseRef)
        }
      } else {
        refs.add(frame.payload.statusEvidence.sourceResponseRef)
      }
    } else if (frame.payload.purpose === "status") {
      if (frame.payload.terminal !== undefined) {
        refs.add(frame.payload.terminal.sourceResponseRef)
      } else {
        refs.add(frame.payload.statusEvidence.sourceResponseRef)
      }
    }
  }
  return [...refs]
}

export class NativeProcessTransport implements NativeTransport {
  readonly #process
  readonly #decoder = new NativeTransportStreamDecoder()
  #closed = false
  #closing: Promise<void> | undefined
  #exitConfirmed = false
  #exitCode: number | null = null

  constructor(helperPath: string, args: readonly string[] = []) {
    if (!helperPath.startsWith("/")) throw new Error("Native helper path должен быть абсолютным")
    this.#process = Bun.spawn([helperPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    })
    void this.#process.exited.then(code => {
      this.#exitConfirmed = true
      this.#exitCode = code
    }, () => undefined)
  }

  get processStatus(): Readonly<{ pid: number, exitConfirmed: boolean, exitCode: number | null }> {
    return { pid: this.#process.pid, exitConfirmed: this.#exitConfirmed, exitCode: this.#exitCode }
  }

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    if (this.#closed) throw new Error("Native process transport закрыт")
    const parsed = nativeTransportRequestFrameSchema.parse(frame)
    this.#process.stdin.write(encodeNativeFrame(parsed))
    await this.#process.stdin.flush()
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    const reader = this.#process.stdout.getReader()
    const onAbort = () => void reader.cancel(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      while (!signal.aborted) {
        const result = await reader.read()
        if (result.done) break
        for (const packet of this.#decoder.push(result.value)) yield packet
      }
      this.#decoder.finish()
    } finally {
      signal.removeEventListener("abort", onAbort)
      reader.releaseLock()
    }
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = this.#closeOwnedChild()
    return this.#closing
  }

  async #waitExit(milliseconds: number): Promise<boolean> {
    if (this.#exitConfirmed) return true
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), milliseconds)
      void this.#process.exited.then(() => {
        clearTimeout(timer)
        resolve(true)
      }, () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }

  async #closeOwnedChild(): Promise<void> {
    try { void Promise.resolve(this.#process.stdin.end()).catch(() => undefined) } catch {}
    if (await this.#waitExit(1000)) return
    try { this.#process.kill("SIGTERM") } catch {}
    if (await this.#waitExit(500)) return
    try { this.#process.kill("SIGKILL") } catch {}
    if (!await this.#waitExit(1000)) {
      throw new Error("Owned native child exit не подтверждён после bounded EOF/TERM/KILL")
    }
  }
}
