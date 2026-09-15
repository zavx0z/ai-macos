import { describe, expect, test } from "bun:test"
import {
  heldInputLedgerDigest,
  type AdapterHostContext,
  type HeldInputLedgerAck,
  type HeldInputLedgerSnapshot,
} from "@meta/shared/contracts"
import {
  NativeBrokerAdapter,
  type NativeTransport,
} from "../src/adapter.ts"
import {
  nativeCaptureStartResponseSchema,
  nativeInputExecutionRequestSchema,
  nativeInputExecutionResponseSchema,
  type NativeTransportPacket,
  type NativeTransportRequestFrame,
} from "../src/protocol.ts"

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}
const now = new Date().toISOString()
const deadline = new Date(Date.now() + 60_000).toISOString()
const unusedEvidencePublisher = {
  publish: async () => { throw new Error("evidence не ожидался") },
}
const evidenceOptions = {
  adapterInstanceRef: "native-adapter-fixture",
  bindEvidence: () => ({
    publisher: unusedEvidencePublisher,
    sourceResponses: { register: () => undefined },
  }),
}

class FakeTransport implements NativeTransport {
  readonly sent: NativeTransportRequestFrame[] = []
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []
  closed = false

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    this.sent.push(frame)
    if (frame.channel === "handshake") {
      this.push({
        kind: "message",
        frame: {
          channel: "handshake",
          payload: {
            kind: "handshake-response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            ...generation,
            nativeBuildId: "native-build-1",
            capabilitySchemaVersion: "1",
            installRoot: "/tmp/meta-native-fixture",
            process: { pid: 100, startedAt: now, nonce: "process-1" },
            capabilities: {
              schemaVersion: "1",
              scope: "adapter",
              producerRef: "native-fixture",
              capabilities: [],
            },
          },
        },
      })
      return
    }
    if (frame.channel === "heartbeat") {
      this.push({
        kind: "message",
        frame: {
          channel: "heartbeat",
          payload: {
            requestId: frame.payload.requestId,
            ...generation,
            accepted: true,
            acknowledgedAt: now,
            quarantined: false,
          },
        },
      })
      return
    }
    if (frame.channel === "observer") {
      this.push({ kind: "message", frame: { channel: "observer", payload: {
        kind: "observer-response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
        command: frame.payload.command, nativeBuildId: "native-build-1", ok: false,
        error: { code: "permission-denied", message: "Fixture observer недоступен", stage: "observer-prepare",
          retryable: false, replayAllowed: false, recoveryAction: "inspect-health" },
        ...(frame.payload.command === "prepare" ? { prepareFailure: {
          stage: "readiness", retryDisposition: "clean-no-instance", transient: true,
        } } : {}),
      } } })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "input.execute") {
      const fence = frame.payload.operation.fence
      this.push({
        kind: "message",
        frame: {
          channel: "response",
          payload: {
            kind: "response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            ...generation,
            operationId: frame.payload.operation.operationId,
            ok: true,
            result: {
              completedSteps: 1,
              totalSteps: 1,
              dispatchAttempts: 2,
              ledgerRevision: 4,
              status: operationStatus(frame.payload.requestId, frame.payload.operation.operationId, fence),
            },
          },
        },
      })
    }
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted && !this.closed) {
      const packet = this.#packets.shift()
      if (packet !== undefined) {
        yield packet
        continue
      }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("fixture aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push((value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  push(packet: NativeTransportPacket): void {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#packets.push(packet)
    else waiter(packet)
  }
}

function operationStatus(requestId: string, operationId: string, fence: typeof generation & { counter: number }) {
  return {
    requestId,
    ...generation,
    highWaterFence: { ...fence },
    acceptedFence: { ...fence },
    operationId,
    execution: "finished" as const,
    dispatch: "finished" as const,
    cleanup: "complete" as const,
    targetVerified: "verified" as const,
    cancellationRequested: false,
    userInterference: "unknown" as const,
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: "after-key-up",
    dispatchAttempts: 2,
    ledgerRevision: 4,
    observer: {
      state: "unavailable" as const,
      ...generation,
      coverageStartCursor: "cursor-1",
      cursor: "cursor-1",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "fixture observer отключён",
    },
  }
}

function host(): AdapterHostContext {
  return {
    generation: {
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
    },
    runtimeBuildId: "runtime-build-1",
    capabilities: {
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "runtime-fixture",
      capabilities: [],
    },
  }
}

function inputRequest() {
  return {
    kind: "request" as const,
    protocolVersion: "1" as const,
    requestId: "input-request-1",
    ...generation,
    deadlineAt: deadline,
    intent: "mutation" as const,
    method: "input.execute" as const,
    operation: {
      kind: "native" as const,
      operationId: "operation-1",
      clientRequestId: "client-request-1",
      clientSessionId: "client-session-1",
      principalId: "principal-1",
      ...generation,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      target: {
        kind: "window" as const,
        ref: {
          ...generation,
          applicationRef: "application-1",
          windowRef: "window-1",
        },
      },
      fence: { ...generation, counter: 1 },
      deadlineAt: deadline,
    },
    payload: {
      actionDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
      action: {
        kind: "key" as const,
        stroke: { keyCode: 55, flags: 0x0010_0000 },
      },
    },
  }
}

describe("NativeBrokerAdapter", () => {
  test("late prepare после abort останавливает только выданный observer", async () => {
    const transport = new FakeTransport()
    const baseSend = transport.send.bind(transport)
    let prepare!: Extract<NativeTransportRequestFrame, { channel: "observer" }>["payload"]
    let notifyPrepare!: () => void
    let notifyStop!: () => void
    const prepareSent = new Promise<void>(resolve => { notifyPrepare = resolve })
    const stopSent = new Promise<void>(resolve => { notifyStop = resolve })
    let stoppedInstance: string | undefined
    const snapshot = (ready: boolean) => ({ observerInstanceRef: "late-instance", inventoryId: "inventory", inventoryRevision: 1, indexRevision: 1,
      coverage: { ...generation, state: ready ? "ready" as const : "unavailable" as const, coverageStartCursor: "start", cursor: "start", nextSequence: 1,
        startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now, coveredKinds: ["input", "focus", "window-structure", "lifecycle"] as ("input" | "focus" | "window-structure" | "lifecycle")[],
        droppedEvents: 0, gapDetected: !ready, ...(!ready ? { reason: "Остановлен" } : {}) },
      sessionReadiness: { state: "unknown" as const, lockState: "unknown" as const, evidence: "Fixture", observedAt: now }, secureInput: "unknown" as const })
    transport.send = async frame => {
      if (frame.channel !== "observer") return baseSend(frame)
      transport.sent.push(frame)
      if (frame.payload.command === "prepare") {
        prepare = frame.payload
        notifyPrepare()
        return
      }
      stoppedInstance = frame.payload.observerInstanceRef
      transport.push({ kind: "message", frame: { channel: "observer", payload: {
        ...generation, kind: "observer-response", protocolVersion: "1", requestId: frame.payload.requestId, command: "stop", nativeBuildId: "native-build-1",
        ok: true, snapshot: snapshot(false),
      } } })
      notifyStop()
    }
    const adapter = new NativeBrokerAdapter({ ...evidenceOptions, host: host(), transport, ledgerSink: { persist: async () => { throw new Error("unused") } } })
    const controller = new AbortController()
    try {
      await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "late-handshake", runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId, runtimeBuildId: "runtime-build-1", expectedNativeBuildId: "native-build-1", capabilitySchemaVersion: "1" })
      const pending = adapter.observer({ kind: "observer", protocolVersion: "1", requestId: "late-prepare", ...generation,
        command: "prepare", deadlineAt: new Date(Date.now() + 5000).toISOString() }, { signal: controller.signal, checkpoint: () => undefined })
      await prepareSent
      controller.abort(new Error("caller aborted"))
      await expect(pending).rejects.toThrow("caller aborted")
      transport.push({ kind: "message", frame: { channel: "observer", payload: {
        ...generation, kind: "observer-response", protocolVersion: "1", requestId: prepare.requestId, command: "prepare", nativeBuildId: "native-build-1",
        ok: true, snapshot: snapshot(true),
      } } })
      await stopSent
      expect(stoppedInstance).toBe("late-instance")
      const health = await adapter.heartbeat({ requestId: "after-orphan-stop", ...generation, deadlineAt: new Date(Date.now() + 1000).toISOString() },
        { signal: new AbortController().signal, checkpoint: () => undefined })
      expect(health.accepted).toBe(true)
    } finally { await adapter.close() }
  })
  test("mutationDelivery подтверждает только зарегистрированный predispatch context", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({ ...evidenceOptions, host: host(), transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } } })
    try {
      await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "delivery-handshake",
        runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId, runtimeBuildId: "runtime-build-1",
        expectedNativeBuildId: "native-build-1", capabilitySchemaVersion: "1" })
      const request = nativeInputExecutionRequestSchema.parse(inputRequest())
      expect(() => adapter.mutationDelivery.assertNeverAttempted(request.operation)).toThrow("never-attempted")
      adapter.mutationDelivery.register(request.operation)
      expect(() => adapter.mutationDelivery.assertNeverAttempted(request.operation)).not.toThrow()
      await expect(adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema,
        { signal: AbortSignal.abort(new Error("pre-aborted")), checkpoint: () => undefined })).rejects.toThrow("pre-aborted")
      expect(() => adapter.mutationDelivery.assertNeverAttempted(request.operation)).not.toThrow()
      await adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema,
        { signal: new AbortController().signal, checkpoint: () => undefined })
      adapter.mutationDelivery.register(request.operation)
      expect(() => adapter.mutationDelivery.assertNeverAttempted(request.operation)).toThrow("never-attempted")
      expect(() => adapter.mutationDelivery.register({ ...request.operation, inventoryRevision: 2 })).toThrow()
      const failed = nativeInputExecutionRequestSchema.parse({ ...request, requestId: "send-failed", operation: {
        ...request.operation, operationId: "send-failed-operation", fence: { ...request.operation.fence, counter: 2 },
      } })
      adapter.mutationDelivery.register(failed.operation)
      transport.send = async () => { throw new Error("send rejected") }
      await expect(adapter.request(nativeInputExecutionRequestSchema, failed, nativeInputExecutionResponseSchema,
        { signal: new AbortController().signal, checkpoint: () => undefined })).rejects.toThrow("send rejected")
      expect(() => adapter.mutationDelivery.assertNeverAttempted(failed.operation)).toThrow("never-attempted")

      const rejected = nativeInputExecutionRequestSchema.parse({ ...request, requestId: "pre-start-rejected", operation: {
        ...request.operation, operationId: "pre-start-rejected-operation", fence: { ...request.operation.fence, counter: 3 },
      } })
      adapter.mutationDelivery.register(rejected.operation)
      transport.send = async (frame) => {
        transport.sent.push(frame)
        if (frame.channel !== "request") throw new Error("ожидался request")
        transport.push({ kind: "message", frame: { channel: "response", payload: {
          kind: "response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
          operationId: rejected.operation.operationId, ok: false,
          error: { code: "target-stale", message: "Fixture pre-start rejection", stage: "capture-start",
            retryable: false, replayAllowed: false, recoveryAction: "refresh-inventory" },
          startDisposition: "rejected-before-start",
        } } })
      }
      await expect(adapter.request(
        nativeInputExecutionRequestSchema,
        rejected,
        nativeCaptureStartResponseSchema,
        { signal: new AbortController().signal, checkpoint: () => undefined },
      )).rejects.toThrow("exact pending capture.start")
      expect(() => adapter.mutationDelivery.assertNeverAttempted(rejected.operation)).toThrow("never-attempted")
    } finally { await adapter.close() }
  })
  test("PUSH observer event сохраняет instance и имеет единственного consumer", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({ ...evidenceOptions, host: host(), transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } } })
    const controller = new AbortController()
    try {
      await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "events-handshake",
        runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId, runtimeBuildId: "runtime-build-1",
        expectedNativeBuildId: "native-build-1", capabilitySchemaVersion: "1" })
      const first = adapter.events(controller.signal)[Symbol.asyncIterator]()
      const pending = first.next()
      const second = adapter.events(controller.signal)[Symbol.asyncIterator]()
      await expect(second.next()).rejects.toThrow("один host observer consumer")
      transport.push({ kind: "message", frame: { channel: "event", payload: {
        observerInstanceRef: "observer-instance", ...generation,
        event: { eventId: "event-1", ...generation, cursor: "cursor-1", sequence: 1, observedAt: now, kind: "input", source: "unknown" },
      } } })
      const item = await pending
      expect(item.value?.observerInstanceRef).toBe("observer-instance")
      expect(item.value?.eventId).toBe("event-1")
      await first.return?.()
    } finally { controller.abort(); await adapter.close() }
  })
  test("observer channel сохраняет typed отказ без объявления ready", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({ ...evidenceOptions, host: host(), transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } } })
    try {
      await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "observer-handshake",
        runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId, runtimeBuildId: "runtime-build-1",
        expectedNativeBuildId: "native-build-1", capabilitySchemaVersion: "1" })
      const response = await adapter.observer({ kind: "observer", protocolVersion: "1", requestId: "observer-prepare",
        ...generation, command: "prepare", deadlineAt: deadline }, { signal: new AbortController().signal, checkpoint: () => undefined })
      expect(response.ok).toBe(false)
      if (response.ok) throw new Error("Fixture не должен объявить observer готовым")
      expect(response.error.code).toBe("permission-denied")
      expect(transport.sent.at(-1)?.channel).toBe("observer")
    } finally { await adapter.close() }
  })
  test("pre-aborted request не отправляется и не занимает requestId/binary waiter", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions, host: host(), transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    const request = {
      kind: "handshake" as const, protocolVersion: "1" as const,
      requestId: "pre-aborted-id", runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId, runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1", capabilitySchemaVersion: "1" as const,
    }
    const signal = AbortSignal.abort(new Error("уже отменён"))
    await expect(adapter.handshake(request, signal)).rejects.toThrow("уже отменён")
    await expect(adapter.takeBinary("binary-aborted", 3, signal)).rejects.toThrow("уже отменён")
    expect(transport.sent).toHaveLength(0)
    await adapter.handshake(request)
    transport.push({ kind: "binary", binaryToken: "binary-aborted", bytes: new Uint8Array([1, 2, 3]) })
    await expect(adapter.takeBinary("binary-aborted", 3)).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await adapter.close()
  })
  test("коррелирует handshake и сохраняет native generation", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    const response = await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    expect(response.nativeGeneration).toBe("native-1")
    expect(adapter.generation).toEqual(generation)
    await adapter.close()
  })

  test("возвращает inline NativeOperationStatus и checkpoints", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    const checkpoints: string[] = []
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-before-input",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    const response = await adapter.request(
      nativeInputExecutionRequestSchema,
      inputRequest(),
      nativeInputExecutionResponseSchema,
      {
        signal: new AbortController().signal,
        checkpoint: stage => { checkpoints.push(stage) },
      },
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.status.dispatch).toBe("finished")
    expect(response.result.status.dispatchAttempts).toBe(response.result.dispatchAttempts)
    expect(response.result.status.ledgerRevision).toBe(response.result.ledgerRevision)
    expect(checkpoints).toEqual(["native-before-request", "native-after-response"])
    await adapter.close()
  })

  test("передаёт canonical ledger в runtime sink и возвращает точный ACK", async () => {
    const transport = new FakeTransport()
    let persisted: HeldInputLedgerSnapshot | undefined
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: {
        async persist(requestId, snapshot): Promise<HeldInputLedgerAck> {
          persisted = snapshot
          return {
            requestId,
            operationId: snapshot.operationId,
            runtimeEpoch: snapshot.runtimeEpoch,
            loginSessionId: snapshot.loginSessionId,
            nativeGeneration: snapshot.nativeGeneration,
            revision: snapshot.revision,
            snapshotSha256: heldInputLedgerDigest(snapshot),
            persistedAt: now,
            durable: true,
          }
        },
      },
    })
    const snapshot: HeldInputLedgerSnapshot = {
      canonicalVersion: "1",
      operationId: "operation-ledger",
      ...generation,
      revision: 1,
      entries: [{ sequence: 1, kind: "key", code: 55, state: "pending-down" }],
    }
    transport.push({
      kind: "message",
      frame: { channel: "ledger-persist", payload: { requestId: "ledger-request-1", snapshot } },
    })
    for (let attempt = 0; attempt < 20 && persisted === undefined; attempt += 1) await Bun.sleep(1)
    expect(persisted).toEqual(snapshot)
    const ack = transport.sent.find(frame => frame.channel === "ledger-ack")
    expect(ack?.channel).toBe("ledger-ack")
    if (ack?.channel !== "ledger-ack") throw new Error("ledger ACK не отправлен")
    expect(ack.payload.snapshotSha256).toBe(heldInputLedgerDigest(snapshot))
    await adapter.close()
  })

  test("binary channel не использует base64 и проверяет длину", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    transport.push({ kind: "binary", binaryToken: "binary-1", bytes: new Uint8Array([1, 2, 3]) })
    await expect(adapter.takeBinary("binary-1", 3)).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await adapter.close()
  })

  test("не принимает повторный requestId в одной native session", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    const request = {
      kind: "handshake" as const,
      protocolVersion: "1" as const,
      requestId: "handshake-reused",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1" as const,
    }
    await adapter.handshake(request)
    await expect(adapter.handshake(request)).rejects.toThrow("уже использован")
    await adapter.close()
  })

  test("bounded event queue сообщает observer gap при overflow", async () => {
    const transport = new FakeTransport()
    const adapter = new NativeBrokerAdapter({
      ...evidenceOptions,
      host: host(),
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-events",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    for (let index = 0; index <= 1_000; index += 1) {
      transport.push({
        kind: "message",
        frame: {
          channel: "event",
          payload: {
            eventId: `event-${index}`,
            ...generation,
            cursor: `cursor-${index}`,
            sequence: index + 1,
            observedAt: now,
            kind: "input",
            source: "external-user",
          },
        },
      })
    }
    await Bun.sleep(10)
    const events = adapter.events(new AbortController().signal)[Symbol.asyncIterator]()
    await expect(events.next()).rejects.toThrow("observer coverage содержит gap")
    await adapter.close()
  })
})
