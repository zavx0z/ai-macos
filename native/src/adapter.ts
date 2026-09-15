import {
  heldInputLedgerAckMatches,
  nativeCleanupAckMatches,
  nativeCancelAckMatches,
  nativeHandshakeCompatibility,
  nativeLifecycleAckMatches,
  nativeResponseMatchesRequest,
  nativeStatusMatchesRequest,
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

export interface NativeTransport {
  send(frame: NativeTransportRequestFrame): Promise<void>
  packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket>
  close(): Promise<void>
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
  readonly #readerAbort = new AbortController()
  readonly #pending = new Map<string, PendingResponse>()
  readonly #expired = new Map<string, number>()
  readonly #seenRequestIds = new Map<string, number>()
  readonly #events: Array<{ event: ObservedEvent, bytes: number }> = []
  #eventBytes = 0
  #eventGap: Error | undefined
  readonly #eventWaiters: EventWaiter[] = []
  readonly #binary = new Map<string, Uint8Array>()
  readonly #binaryWaiters = new Map<string, BinaryWaiter>()
  readonly #reader: Promise<void>
  #closed = false
  #rotationSealed = false
  #ledgerWrites = 0
  readonly #startedAt = Date.now()

  get sessionState() {
    const rotationRequired = this.#seenRequestIds.size >= 9_000 || Date.now() - this.#startedAt >= 24 * 60 * 60 * 1000
    return {
      state: this.#closed ? "closed" as const : this.#rotationSealed ? "draining" as const : rotationRequired ? "rotation-required" as const : "ready" as const,
      requestsUsed: this.#seenRequestIds.size,
      pendingRequests: this.#pending.size,
      pendingBinaries: this.#binary.size + this.#binaryWaiters.size,
      pendingLedgerWrites: this.#ledgerWrites,
    }
  }

  sealForRotation(): void {
    if (this.#closed || this.#rotationSealed) throw new Error("Native session уже закрыта или дренируется")
    if (this.#pending.size || this.#binary.size || this.#binaryWaiters.size || this.#ledgerWrites) {
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
    const evidence = this.#bindEvidence({
      adapterInstanceRef: this.adapterInstanceRef,
      loadedBuildId: this.#loadedBuildId,
      generation: this.generation,
    })
    this.#evidencePublisher = evidence.publisher
    this.#sourceResponses = evidence.sourceResponses
    return response.payload
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
    const frame = nativeTransportRequestFrameSchema.parse({
      channel: "request",
      payload: parsedRequest,
    })
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

  async *events(signal: AbortSignal): AsyncIterable<ObservedEvent> {
    while (!signal.aborted && !this.#closed) {
      if (this.#eventGap !== undefined) throw this.#eventGap
      const current = this.#events.shift()
      if (current !== undefined) {
        this.#eventBytes -= current.bytes
        yield current.event
        continue
      }
      const event = await new Promise<ObservedEvent>((resolve, reject) => {
        const waiter: EventWaiter = {
          resolve,
          reject,
          signal,
          onAbort: () => undefined,
        }
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
    if (this.#closed) return
    this.#closed = true
    this.#readerAbort.abort(new Error("Native adapter закрыт"))
    await this.#transport.close()
    await this.#reader.catch(() => undefined)
    this.#rejectPending(new Error("Native adapter закрыт"))
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
    if (this.#rotationSealed && frame.channel !== "drain") throw new Error("Native session draining: runtime rotation выполняется")
    if (this.sessionState.state === "rotation-required" && frame.channel === "request") {
      throw new Error("Native session rotation-required: runtime должен завершить drain и сменить generation")
    }
    const key = `${expectedChannel}:${requestId}`
    this.#pruneRequestTombstones()
    if (this.#seenRequestIds.has(requestId)) throw new Error(`Native requestId уже использован: ${requestId}`)
    if (this.#seenRequestIds.size >= 10_000 && frame.channel !== "drain") throw new Error("Native session exhausted: разрешён только runtime drain")
    if (this.#pending.size >= 128) throw new Error("Native concurrent request limit исчерпан")
    if (this.#pending.has(key)) throw new Error(`Native request уже ожидается: ${requestId}`)
    this.#seenRequestIds.set(requestId, Date.now() + 24 * 60 * 60 * 1000)
    return await new Promise<NativeTransportResponseFrame>((resolve, reject) => {
      const remainingMs = deadlineAt === undefined ? undefined : Date.parse(deadlineAt) - Date.now()
      if (remainingMs !== undefined && remainingMs <= 0) {
        reject(new Error("Native request deadline уже истёк"))
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const expire = (error: Error) => {
        this.#pending.delete(key)
        this.#expired.set(key, Date.now() + 24 * 60 * 60 * 1000)
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
        if (packet.kind === "binary") {
          this.#acceptBinary(packet.binaryToken, packet.bytes)
          continue
        }
        await this.#acceptFrame(packet.frame, packet.bytes)
      }
      if (!this.#closed) throw new Error("Native transport завершился до close")
    } catch (error) {
      if (!this.#closed) this.#rejectPending(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async #acceptFrame(frame: NativeTransportResponseFrame, bytes?: Uint8Array): Promise<void> {
    if (frame.channel === "event") {
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
        this.#events.push({ event: frame.payload, bytes })
        this.#eventBytes += bytes
      }
      else {
        waiter.signal.removeEventListener("abort", waiter.onAbort)
        waiter.resolve(frame.payload)
      }
      return
    }
    if (frame.channel === "ledger-persist") {
      this.#ledgerWrites += 1
      try {
      const ack = await this.ledgerSink.persist(frame.payload.requestId, frame.payload.snapshot)
      if (!heldInputLedgerAckMatches(frame.payload.requestId, frame.payload.snapshot, ack)) {
        throw new Error("Ledger sink вернул некоррелированный durable ACK")
      }
      await this.#transport.send(nativeTransportRequestFrameSchema.parse({
        channel: "ledger-ack",
        payload: ack,
      }))
      } finally {
        this.#ledgerWrites -= 1
      }
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
      if (this.#expired.delete(key)) return
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

  #pruneRequestTombstones(): void {
    const now = Date.now()
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

  constructor(helperPath: string, args: readonly string[] = []) {
    if (!helperPath.startsWith("/")) throw new Error("Native helper path должен быть абсолютным")
    this.#process = Bun.spawn([helperPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    })
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
    if (this.#closed) return
    this.#closed = true
    this.#process.stdin.end()
    const exited = await Promise.race([
      this.#process.exited.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000)),
    ])
    if (!exited) {
      this.#process.kill()
      await this.#process.exited
    }
  }
}
