import { expect, test } from "bun:test"
import { NativeBrokerAdapter, type NativeTransport } from "@meta/native/adapter"
import { NativeCaptureClient } from "@meta/native/capture-client"
import {
  capturePolicySha256,
  freezeAdapterHostContext,
  operationRecordSchema,
  type NativeContinuationRegistrar,
  type NativeContinuationIssuer,
  type NativeEvidenceReport,
  type NativeExecutionContext,
  type RuntimeOperationContext,
  type ScreenCaptureRequest,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import { NativeContinuationRegistry } from "@meta/runtime"
import type {
  NativeTransportPacket,
  NativeTransportRequestFrame,
} from "@meta/native/protocol"
import { ProtocolNativeCaptureDriver } from "../src/native-driver.ts"
import { NativeCaptureDriverStartError } from "../src/adapter.ts"

const runtimeEpoch = "runtime:protocol"
const loginSessionId = "login:protocol"
const nativeGeneration = "native:protocol"
const nowMs = Date.now()
const now = new Date(nowMs).toISOString()
const deadlineAt = new Date(nowMs + 10_000).toISOString()
const expiresAt = new Date(nowMs + 60_000).toISOString()
const taskRef = "capture-task:protocol"
const displayRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  displayRef: "display:protocol",
  displayLayoutRevision: 3,
}
const target = { kind: "display" as const, ref: displayRef }
const mapping = {
  kind: "display" as const,
  display: { nativeDisplayId: 10, ref: displayRef },
}
const fence = { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 }
const bytes = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
))
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:protocol",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "native-protocol:fixture",
    capabilities: [],
  },
})

function captureRequest(): ScreenCaptureRequest {
  const base: Omit<ScreenCaptureRequest, "publication"> = {
    source: "display-composite",
    caption: "Ожидаю protocol capture",
    target: {
      kind: "display",
      target,
      nativeDisplayId: 10,
      mappingEvidence: {
        state: "confirmed",
        claim: "display-resolved",
        source: "runtime-authority",
        proof: {
          proofRef: "proof:target-resolution",
          authorityRef: "proof-authority:runtime",
          kind: "target-resolution",
          subject: target,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          inventoryRevision: 4,
          displayLayoutRevision: 3,
          issuedAt: now,
          expiresAt,
        },
      },
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: {
      policyId: "readiness:protocol",
      requiredSteps: ["permission", "target", "complete-frame"],
      disabledSteps: [],
    },
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 100,
      maxHeightPx: 100,
      maxPixels: 10_000,
      maxEncodedBytes: 1_000_000,
    },
  }
  return {
    ...base,
    publication: {
      observationId: "observation:protocol",
      frameRef: "frame:protocol",
      source: base.source,
      captureTarget: target,
      capturePolicySha256: capturePolicySha256(base),
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      expiresAt,
      inventoryId: "inventory:protocol",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      cacheScopeRef: "client:protocol",
    },
  }
}

function operationContext(
  signal: AbortSignal = new AbortController().signal,
): RuntimeOperationContext<NativeExecutionContext> {
  return {
    wire: {
      kind: "native",
      operationId: "operation:protocol",
      clientRequestId: "request:protocol",
      clientSessionId: "client:protocol",
      principalId: "principal:protocol",
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory:protocol",
      inventoryRevision: 4,
      target,
      nativeGeneration,
      fence,
      deadlineAt,
    },
    session: {
      clientSessionId: "client:protocol",
      principalId: "principal:protocol",
      runtimeEpoch,
      loginSessionId,
      authenticationGeneration: "auth:protocol",
      authenticatedAt: now,
      expiresAt,
    },
    resources: [{
      kind: "capture-stream",
      resourceRef: "observation:protocol",
      leaseId: "lease:protocol",
      leaseGeneration: "lease-generation:protocol",
      operationId: "operation:protocol",
      clientSessionId: "client:protocol",
      principalId: "principal:protocol",
      runtimeEpoch,
      loginSessionId,
      expiresAt,
      state: "active",
    }],
    control: { signal, checkpoint() {} },
  }
}

class FakeContinuationAuthority implements NativeContinuationIssuer, NativeContinuationRegistrar {
  revision = 0
  evidenceRef = ""
  terminalReceiptRef: string | undefined
  registered = false
  issuedPurposes: string[] = []
  statusAdvances: Array<{ revision: number, cleanup: string, drained: boolean }> = []
  requestCounter = 0

  async registerAcceptedTask(request: Parameters<NativeContinuationRegistrar["registerAcceptedTask"]>[0]) {
    expect(request.receipt.factKind).toBe("capture-task-start")
    this.revision = request.statusRevision
    this.evidenceRef = request.statusEvidenceRef
    this.registered = true
  }

  async markVerifiedTerminal(request: Parameters<NativeContinuationRegistrar["markVerifiedTerminal"]>[0]) {
    expect(request.receipt.factKind).toBe("capture-task-terminal")
    expect(request.operationId).toBe("operation:protocol")
    expect(request.acceptedFence).toEqual(fence)
    if (this.terminalReceiptRef !== undefined) {
      if (
        request.statusRevision !== this.revision
        || request.drainedEvidenceRef !== this.evidenceRef
        || request.terminalReceiptRef !== this.terminalReceiptRef
      ) {
        throw new Error("Terminal fixture получил conflicting repeated facts")
      }
      return
    }
    if (request.statusRevision <= this.revision) throw new Error("Первый terminal revision должен быть новее status")
    this.revision = request.statusRevision
    this.evidenceRef = request.drainedEvidenceRef
    this.terminalReceiptRef = request.terminalReceiptRef
  }

  async advanceVerifiedStatus(request: Parameters<NativeContinuationRegistrar["advanceVerifiedStatus"]>[0]) {
    expect(request.receipt.factKind).toBe("capture-task-status")
    expect(request.operationId).toBe("operation:protocol")
    expect(request.acceptedFence).toEqual(fence)
    if (request.statusRevision < this.revision) throw new Error("Status revision уменьшилась")
    this.revision = request.statusRevision
    this.evidenceRef = request.statusEvidenceRef
    this.statusAdvances.push({
      revision: request.statusRevision,
      cleanup: request.cleanup,
      drained: request.drained,
    })
  }

  async issue(request: Parameters<NativeContinuationIssuer["issue"]>[0]) {
    if (!this.registered || request.expectedRevision !== this.revision) {
      throw new Error("Continuation fixture получил незарегистрированный/stale task")
    }
    if (request.purpose === "release" && this.terminalReceiptRef === undefined) {
      throw new Error("Release выдан до verified terminal")
    }
    this.issuedPurposes.push(request.purpose)
    const controller = new AbortController()
    const requestId = `cleanup-rpc:${++this.requestCounter}`
    return {
      control: { signal: controller.signal, checkpoint() {} },
      cleanupControl: {
        kind: "cleanup-only" as const,
        purpose: request.purpose,
        requestId,
        cleanupRequestId: `cleanup:${request.purpose}:${request.expectedRevision}`,
        operationId: request.operationId,
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        acceptedFence: fence,
        currentHighWaterFence: fence,
        deadlineAt: new Date(Date.now() + 1_000).toISOString(),
        expectedStatusRevision: request.expectedRevision,
        expectedDrainedEvidenceRef: this.evidenceRef,
      },
    }
  }
}

class FakeCaptureTransport implements NativeTransport {
  readonly sent: NativeTransportRequestFrame[] = []
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []
  resultPolls = 0
  cancelled = false
  closed = false
  lateStart: Extract<NativeTransportPacket, { kind: "message" }>["frame"] | undefined

  constructor(readonly mode: "success" | "cancel" | "late-start" | "unknown" | "rejected-before-start" | "rejected-unknown" = "success") {}

  async send(frame: NativeTransportRequestFrame) {
    this.sent.push(frame)
    if (frame.channel === "handshake") {
      this.pushMessage({
        channel: "handshake",
        payload: {
          kind: "handshake-response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          nativeBuildId: "native-build:protocol",
          capabilitySchemaVersion: "1",
          installRoot: "/tmp/native-protocol-fixture",
          process: { pid: 100, startedAt: now, nonce: "process:protocol" },
          capabilities: {
            schemaVersion: "1",
            scope: "adapter",
            producerRef: "native-protocol:fixture",
            capabilities: [],
          },
        },
      })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "capture.start") {
      if (this.mode === "rejected-before-start" || this.mode === "rejected-unknown") {
        this.pushMessage({
          channel: "response",
          payload: {
            kind: "response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            runtimeEpoch,
            loginSessionId,
            nativeGeneration,
            operationId: frame.payload.operation.operationId,
            ok: false,
            error: {
              code: "target-stale",
              message: "Capture mapping rejected before start",
              stage: "capture-start",
              retryable: false,
              replayAllowed: false,
              recoveryAction: "refresh-inventory",
            },
            ...(this.mode === "rejected-before-start"
              ? { startDisposition: "rejected-before-start" as const }
              : {}),
          },
        })
        return
      }
      const response = {
        channel: "response",
        payload: {
          kind: "response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          operationId: frame.payload.operation.operationId,
          ok: true,
          result: {
            captureTaskRef: taskRef,
            operationId: frame.payload.operation.operationId,
            acceptedFence: frame.payload.operation.fence,
            sourceResponseRef: "native-response:start",
            inventoryId: "inventory:protocol",
            inventoryRevision: 4,
            displayLayoutRevision: 3,
            observedAt: now,
            statusEvidenceRef: "status-evidence:start",
            acceptedAt: now,
            status: captureStatus(1, false),
          },
        },
      } as const
      if (this.mode === "late-start") this.lateStart = response
      else this.pushMessage(response)
      return
    }
    if (frame.channel === "cleanup") {
      const control = frame.payload.control
      if (control.purpose === "result") {
        this.resultPolls += 1
        if (this.resultPolls === 1 || (this.mode === "cancel" && !this.cancelled)) {
          this.pushMessage({
            channel: "cleanup",
            payload: {
              purpose: "result",
              ack: cleanupAck(control, 1, false),
              statusEvidence: captureStatusEvidence(1, false),
              poll: { state: "pending", captureTaskRef: taskRef, status: captureStatus(1, false) },
            },
          })
          return
        }
        const completion = this.mode === "cancel"
          ? cancelledCompletion()
          : this.mode === "unknown" ? unknownCompletion() : captureCompletion()
        const unknown = this.mode === "unknown"
        this.pushMessage({
          channel: "cleanup",
          payload: {
            purpose: "result",
            ack: cleanupAck(control, 2, !unknown),
            statusEvidence: captureStatusEvidence(2, true),
            poll: {
              state: "completed",
              captureTaskRef: taskRef,
              status: unknown ? captureUnknownStatus(2) : captureStatus(2, true),
              result: completion,
            },
          },
        })
        if ("frame" in completion) {
          this.push({ kind: "binary", binaryToken: "binary:protocol", bytes })
        }
        return
      }
      if (control.purpose === "status") {
        const status = captureStatus(3, true)
        this.pushMessage({
          channel: "cleanup",
          payload: {
            purpose: "status",
            ack: cleanupAck(control, 3, true),
            statusEvidence: captureStatusEvidence(3, true),
            status,
            terminal: {
              operationId: "operation:protocol",
              acceptedFence: fence,
              sourceResponseRef: "native-response:terminal-status",
              inventoryId: "inventory:protocol",
              inventoryRevision: 4,
              displayLayoutRevision: 3,
              observedAt: now,
              drainedEvidenceRef: "drained-evidence:3",
              terminalReceiptRef: "terminal-receipt:3",
            },
          },
        })
        return
      }
      if (control.purpose === "release") {
        this.pushMessage({
          channel: "cleanup",
          payload: {
            purpose: "release",
            ack: cleanupAck(control, control.expectedStatusRevision, true),
            alreadyReleased: false,
          },
        })
      }
    }
    if (frame.channel === "cancel") {
      this.cancelled = true
      this.pushMessage({
        channel: "cancel",
        payload: {
          requestId: frame.payload.requestId,
          operationId: frame.payload.operationId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          fence: frame.payload.fence,
          acknowledged: true,
          stopped: true,
          cleanup: "complete",
          ledgerRevision: 0,
          lastCheckpoint: "capture-cancelled",
          quarantined: false,
        },
      })
    }
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted && !this.closed) {
      const current = this.#packets.shift()
      if (current !== undefined) {
        yield current
        continue
      }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("fixture transport aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push(packet => {
          signal.removeEventListener("abort", onAbort)
          resolve(packet)
        })
      })
    }
  }

  async close() {
    this.closed = true
  }

  push(packet: NativeTransportPacket) {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#packets.push(packet)
    else waiter(packet)
  }

  pushMessage(frame: Extract<NativeTransportPacket, { kind: "message" }>["frame"]) {
    this.push({
      kind: "message",
      frame,
      bytes: new TextEncoder().encode(JSON.stringify(frame)),
    })
  }

  releaseLateStart() {
    if (this.lateStart === undefined) throw new Error("late start response отсутствует")
    this.pushMessage(this.lateStart)
    this.lateStart = undefined
  }
}

function captureStatus(revision: number, terminal: boolean) {
  return {
    captureTaskRef: taskRef,
    revision,
    completionDelivered: terminal,
    stopRequested: terminal,
    stopCallInFlight: false,
    stopAttemptCount: terminal ? 1 : 0,
    startPending: !terminal,
    streamStarted: terminal,
    streamStopped: terminal,
    encodingInFlight: false,
    cleanup: terminal ? "complete" as const : "pending" as const,
    drained: terminal,
  }
}

function captureUnknownStatus(revision: number) {
  return {
    ...captureStatus(revision, false),
    completionDelivered: true,
    startPending: false,
    streamStarted: true,
    stopRequested: true,
    stopAttemptCount: 1,
    cleanup: "unknown" as const,
  }
}

function cleanupAck(
  control: {
    requestId: string
    cleanupRequestId: string
    operationId: string
    acceptedFence: typeof fence
    currentHighWaterFence: typeof fence
    expectedStatusRevision: number
    expectedDrainedEvidenceRef: string
  },
  revision: number,
  terminal: boolean,
) {
  return {
    kind: "cleanup-ack" as const,
    requestId: control.requestId,
    cleanupRequestId: control.cleanupRequestId,
    operationId: control.operationId,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    acceptedFence: control.acceptedFence,
    currentHighWaterFence: control.currentHighWaterFence,
    statusRevision: revision,
    drainedEvidenceRef: control.expectedDrainedEvidenceRef,
    ...(terminal ? { terminalReceiptRef: "terminal-receipt:2" } : {}),
    cleanup: terminal ? "complete" as const : "unknown" as const,
    drained: terminal,
    quarantined: !terminal,
  }
}

function captureStatusEvidence(revision: number, terminal: boolean) {
  return {
    operationId: "operation:protocol",
    acceptedFence: fence,
    sourceResponseRef: `native-response:status:${revision}`,
    inventoryId: "inventory:protocol",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    observedAt: now,
    statusEvidenceRef: terminal ? "drained-evidence:2" : "status-evidence:start",
  }
}

function captureCompletion() {
  return {
    captureTaskRef: taskRef,
    operationId: "operation:protocol",
    observationId: "observation:protocol",
    acceptedFence: fence,
    sourceResponseRef: "native-response:terminal",
    inventoryId: "inventory:protocol",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    observedAt: now,
    drainedEvidenceRef: "drained-evidence:2",
    terminalReceiptRef: "terminal-receipt:2",
    outcome: "succeeded" as const,
    cleanup: "complete" as const,
    errorCode: "none" as const,
    source: "display-composite" as const,
    caption: "Ожидаю protocol capture",
    target,
    nativeMapping: mapping,
    clip: { kind: "full-target" as const },
    cursor: "excluded" as const,
    scale: 1,
    backend: { name: "screen-capture-kit", buildId: "native-build:protocol" },
    targetEvidence: {
      shareableTargetMatched: true,
      beforeTargetMatched: false,
      afterTargetMatched: false,
      boundsUnchanged: false,
      auxiliarySurfacesExcluded: false,
    },
    readinessFacts: [
      { name: "permission", state: "reached" as const, durationMs: 0 },
      { name: "target", state: "reached" as const, durationMs: 1 },
      { name: "complete-frame", state: "reached" as const, durationMs: 2 },
    ],
    frame: {
      binaryToken: "binary:protocol",
      frameRef: "frame:protocol",
      sha256,
      widthPx: 1,
      heightPx: 1,
      encodedBytes: bytes.byteLength,
      capturedAt: now,
      frameStatus: "complete" as const,
      regions: [{
        nativeDisplayId: 10,
        frameOrientation: "display-oriented" as const,
        displayBounds: { x: -100, y: 20, width: 2, height: 2 },
        imageRect: { x: 0, y: 0, width: 1, height: 1 },
        destinationRect: { x: -100, y: 20, width: 2, height: 2 },
        imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -100, ty: 20 },
        rotationDegrees: 0,
        backingScaleX: 2,
        backingScaleY: 2,
        frameTimestamp: now,
      }],
    },
    statusRevision: 2,
  }
}

function cancelledCompletion() {
  const { frame: _, ...completion } = captureCompletion()
  return {
    ...completion,
    outcome: "cancelled" as const,
    errorCode: "cancelled" as const,
    errorMessage: "Capture отменён fixture",
  }
}

function unknownCompletion() {
  const {
    drainedEvidenceRef: _,
    terminalReceiptRef: __,
    ...completion
  } = captureCompletion()
  return {
    ...completion,
    cleanup: "unknown" as const,
  }
}

function evidenceReceipt(report: NativeEvidenceReport): VerifiedNativeEvidenceReceipt {
  return {
    evidenceReceiptId: `evidence:${report.factKind}`,
    adapterInstanceRef: "native-adapter:protocol",
    backendBuildId: "native-build:protocol",
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    sourceResponseRef: report.sourceResponseRef,
    sourceResponseSha256: "a".repeat(64),
    inventoryId: report.inventoryId,
    inventoryRevision: report.inventoryRevision,
    displayLayoutRevision: report.displayLayoutRevision,
    observedAt: report.observedAt,
    factKind: report.factKind,
    factSha256: "b".repeat(64),
    issuedAt: now,
  }
}

test("ProtocolNativeCaptureDriver доверяет no-task только typed rejected-before-start reply", async () => {
  for (const [mode, rejectedBeforeStart] of [
    ["rejected-before-start", true],
    ["rejected-unknown", false],
  ] as const) {
    const transport = new FakeCaptureTransport(mode)
    const broker = new NativeBrokerAdapter({
      host,
      transport,
      ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
      adapterInstanceRef: `native-adapter:${mode}`,
      bindEvidence() {
        return {
          sourceResponses: { register() {} },
          publisher: { async publish(report) { return evidenceReceipt(report) } },
        }
      },
    })
    await broker.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: `handshake:${mode}`,
      runtimeEpoch,
      loginSessionId,
      runtimeBuildId: "runtime-build:protocol",
      expectedNativeBuildId: "native-build:protocol",
      capabilitySchemaVersion: "1",
    })
    const driver = new ProtocolNativeCaptureDriver(
      new NativeCaptureClient(broker, new FakeContinuationAuthority()),
      0,
    )
    const context = operationContext()
    broker.mutationDelivery.register(context.wire)
    let failure: unknown
    try {
      await driver.start(context, {
        request: captureRequest(),
        nativeMapping: mapping,
        captureTimeoutMs: 5_000,
        stopTimeoutMs: 1_000,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(NativeCaptureDriverStartError)
    const rejected = failure as NativeCaptureDriverStartError
    expect(rejected.rejectedBeforeStart).toBe(rejectedBeforeStart)
    expect(rejected.nativeStatus).toBeUndefined()
    expect(rejected.nativeError.code).toBe("target-stale")
    if (rejectedBeforeStart) {
      expect(() => broker.mutationDelivery.assertNeverAttempted(context.wire)).not.toThrow()
    } else {
      expect(() => broker.mutationDelivery.assertNeverAttempted(context.wire)).toThrow("never-attempted")
    }
    await broker.close()
  }
})

test("ProtocolNativeCaptureDriver проходит start/pending/result/binary/evidence/release", async () => {
  const transport = new FakeCaptureTransport()
  const registeredSources = new Set<string>()
  const evidenceReports: NativeEvidenceReport[] = []
  const broker = new NativeBrokerAdapter({
    host,
    transport,
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    adapterInstanceRef: "native-adapter:protocol",
    bindEvidence() {
      return {
        sourceResponses: { register(sourceResponseRef) { registeredSources.add(sourceResponseRef) } },
        publisher: {
          async publish(report) {
            if (!registeredSources.has(report.sourceResponseRef)) {
              throw new Error("Evidence report не связан с registered source response")
            }
            evidenceReports.push(report)
            return evidenceReceipt(report)
          },
        },
      }
    },
  })
  await broker.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:protocol",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build:protocol",
    expectedNativeBuildId: "native-build:protocol",
    capabilitySchemaVersion: "1",
  })
  const continuations = new FakeContinuationAuthority()
  const driver = new ProtocolNativeCaptureDriver(
    new NativeCaptureClient(broker, continuations),
    0,
  )
  const task = await driver.start(operationContext(), {
    request: captureRequest(),
    nativeMapping: mapping,
    captureTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  })
  const result = await task.result
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.bytes).toEqual(bytes)
  expect(result.readinessFacts).toEqual({
    permission: { state: "reached", durationMs: 0 },
    target: { state: "reached", durationMs: 1 },
    "complete-frame": { state: "reached", durationMs: 2 },
  })
  expect(result.readinessFacts).not.toHaveProperty("ownership")
  expect(transport.resultPolls).toBe(2)
  expect(evidenceReports.map(report => report.factKind)).toEqual([
    "capture-task-start",
    "capture-task-status",
    "capture-task-terminal",
    "frame",
  ])
  expect(continuations.statusAdvances).toEqual([
    { revision: 1, cleanup: "unknown", drained: false },
  ])
  expect(continuations.issuedPurposes).toEqual(["result", "result"])

  expect(await driver.release(task.taskRef, "release-key:protocol")).toEqual({
    taskRef,
    status: "released",
  })
  expect(await driver.release(task.taskRef, "release-key:protocol")).toEqual({
    taskRef,
    status: "already-released",
  })
  await expect(driver.release(task.taskRef, "release-key:conflict")).rejects.toThrow("конфликтует")
  expect(continuations.issuedPurposes).toEqual(["result", "result", "release"])
  expect(transport.sent.some(frame => JSON.stringify(frame).includes("base64"))).toBe(false)
  await broker.close()
})

test("ProtocolNativeCaptureDriver адресованно отменяет pending task и принимает terminal без frame", async () => {
  const transport = new FakeCaptureTransport("cancel")
  const registeredSources = new Set<string>()
  const reports: NativeEvidenceReport[] = []
  const broker = new NativeBrokerAdapter({
    host,
    transport,
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    adapterInstanceRef: "native-adapter:cancel",
    bindEvidence() {
      return {
        sourceResponses: { register(sourceResponseRef) { registeredSources.add(sourceResponseRef) } },
        publisher: {
          async publish(report) {
            if (!registeredSources.has(report.sourceResponseRef)) throw new Error("unregistered source response")
            reports.push(report)
            return evidenceReceipt(report)
          },
        },
      }
    },
  })
  await broker.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:cancel",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build:protocol",
    expectedNativeBuildId: "native-build:protocol",
    capabilitySchemaVersion: "1",
  })
  const continuations = new FakeContinuationAuthority()
  const driver = new ProtocolNativeCaptureDriver(new NativeCaptureClient(broker, continuations), 5)
  const task = await driver.start(operationContext(), {
    request: captureRequest(),
    nativeMapping: mapping,
    captureTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  })
  await driver.cancel(task.taskRef, "fixture cancellation")
  const result = await task.result
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected cancelled result")
  expect(result.code).toBe("cancelled")
  expect(result.cleanup).toBe("complete")
  expect(result.drained).toBe(true)
  expect(reports.map(report => report.factKind)).toEqual([
    "capture-task-start",
    "capture-task-status",
    "capture-task-terminal",
  ])
  expect(continuations.statusAdvances).toEqual([
    { revision: 1, cleanup: "unknown", drained: false },
  ])
  expect(continuations.issuedPurposes).toContain("cancel")
  expect(await driver.release(task.taskRef, "release-key:cancel")).toEqual({
    taskRef,
    status: "released",
  })
  await broker.close()
})

test("ProtocolNativeCaptureDriver не регистрирует late start ACK после abort", async () => {
  const transport = new FakeCaptureTransport("late-start")
  const broker = new NativeBrokerAdapter({
    host,
    transport,
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    adapterInstanceRef: "native-adapter:late",
    bindEvidence() {
      return {
        sourceResponses: { register() {} },
        publisher: { async publish(report) { return evidenceReceipt(report) } },
      }
    },
  })
  await broker.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:late-start",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build:protocol",
    expectedNativeBuildId: "native-build:protocol",
    capabilitySchemaVersion: "1",
  })
  const continuations = new FakeContinuationAuthority()
  const driver = new ProtocolNativeCaptureDriver(new NativeCaptureClient(broker, continuations), 0)
  const controller = new AbortController()
  const started = driver.start(operationContext(controller.signal), {
    request: captureRequest(),
    nativeMapping: mapping,
    captureTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  })
  await Bun.sleep(1)
  controller.abort(new Error("fixture start abort"))
  await expect(started).rejects.toThrow("fixture start abort")
  transport.releaseLateStart()
  await Bun.sleep(1)
  expect(continuations.registered).toBe(false)
  expect(continuations.issuedPurposes).toEqual([])
  await broker.close()
})

test("ProtocolNativeCaptureDriver reconciles unknown completion через verified status advance", async () => {
  const transport = new FakeCaptureTransport("unknown")
  const registeredSources = new Set<string>()
  const reports: NativeEvidenceReport[] = []
  const broker = new NativeBrokerAdapter({
    host,
    transport,
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    adapterInstanceRef: "native-adapter:unknown",
    bindEvidence() {
      return {
        sourceResponses: { register(sourceResponseRef) { registeredSources.add(sourceResponseRef) } },
        publisher: {
          async publish(report) {
            if (!registeredSources.has(report.sourceResponseRef)) throw new Error("unregistered source response")
            reports.push(report)
            return evidenceReceipt(report)
          },
        },
      }
    },
  })
  await broker.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:unknown",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build:protocol",
    expectedNativeBuildId: "native-build:protocol",
    capabilitySchemaVersion: "1",
  })
  const continuations = new FakeContinuationAuthority()
  const driver = new ProtocolNativeCaptureDriver(new NativeCaptureClient(broker, continuations), 0)
  const task = await driver.start(operationContext(), {
    request: captureRequest(),
    nativeMapping: mapping,
    captureTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  })
  const completion = await task.result
  expect(completion.ok).toBe(true)
  if (!completion.ok) throw new Error(completion.message)
  expect(completion.cleanup).toBe("unknown")
  expect(completion.drained).toBe(false)

  const status = await driver.status(task.taskRef)
  expect(status).toEqual({
    taskRef,
    revision: 3,
    completionDelivered: true,
    stopRequested: true,
    stopCallInFlight: false,
    stopAttemptCount: 1,
    startPending: false,
    streamStarted: true,
    streamStopped: true,
    encodingInFlight: false,
    cleanup: "complete",
    drained: true,
  })
  expect(continuations.statusAdvances).toEqual([
    { revision: 1, cleanup: "unknown", drained: false },
    { revision: 2, cleanup: "unknown", drained: false },
  ])
  expect(reports.map(report => report.factKind)).toEqual([
    "capture-task-start",
    "capture-task-status",
    "capture-task-status",
    "frame",
    "capture-task-terminal",
  ])
  expect(await driver.release(task.taskRef, "release-key:unknown")).toEqual({
    taskRef,
    status: "released",
  })
  await broker.close()
})

test("NativeCaptureClient сам регистрирует task/status/terminal в Runtime continuation registry", async () => {
  const transport = new FakeCaptureTransport()
  const context = operationContext()
  const resource = context.resources[0]!
  const operation = operationRecordSchema.parse({
    clientSessionId: context.session.clientSessionId,
    principalId: context.session.principalId,
    intent: "read",
    context: context.wire,
    state: "dispatching",
    outcome: {
      dispatch: "none",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: {
        scope: "owned",
        state: "pending",
        resources: [{ handle: resource, outcome: "held" }],
      },
      restoration: "not-applicable",
      dispatchAttempts: 0,
    },
    resources: [resource],
    payloadReceipt: { keyGeneration: "hmac:protocol", hmacSha256: "c".repeat(64) },
    registeredAt: now,
    updatedAt: now,
  })
  const reports = new Map<string, NativeEvidenceReport>()
  const registeredSources = new Set<string>()
  const continuations = new NativeContinuationRegistry({
    generation: { runtimeEpoch, loginSessionId },
    lookupOperation: operationId => operationId === operation.context.operationId ? operation : undefined,
    lookupHandle: leaseId => leaseId === resource.leaseId ? resource : undefined,
    lookupCleanupReceipt: () => undefined,
    highWaterFence: () => fence,
    verifiedReport(receipt, factKind) {
      const report = reports.get(receipt.evidenceReceiptId)
      if (report === undefined || report.factKind !== factKind) throw new Error("fixture receipt не подтверждает report")
      return report
    },
    clock: { now: () => new Date() },
    ids: { next: prefix => `${prefix}:${crypto.randomUUID().slice(0, 8)}` },
  })
  const broker = new NativeBrokerAdapter({
    host,
    transport,
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    adapterInstanceRef: "native-adapter:protocol",
    bindEvidence() {
      return {
        sourceResponses: { register(sourceResponseRef) { registeredSources.add(sourceResponseRef) } },
        publisher: {
          async publish(report) {
            if (!registeredSources.has(report.sourceResponseRef)) throw new Error("unregistered source response")
            const receipt = evidenceReceipt(report)
            reports.set(receipt.evidenceReceiptId, report)
            return receipt
          },
        },
      }
    },
  })
  await broker.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:runtime-registry",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build:protocol",
    expectedNativeBuildId: "native-build:protocol",
    capabilitySchemaVersion: "1",
  })
  const driver = new ProtocolNativeCaptureDriver(new NativeCaptureClient(broker, continuations), 0)
  const task = await driver.start(context, {
    request: captureRequest(),
    nativeMapping: mapping,
    captureTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  })
  const result = await task.result
  expect(result.ok).toBe(true)
  expect(await driver.release(task.taskRef, "release-key:runtime-registry")).toEqual({
    taskRef,
    status: "released",
  })
  expect([...reports.values()].map(report => report.factKind)).toEqual([
    "capture-task-start",
    "capture-task-status",
    "capture-task-terminal",
    "frame",
  ])
  await broker.close()
})
