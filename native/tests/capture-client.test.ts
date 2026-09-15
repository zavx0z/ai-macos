import { describe, expect, test } from "bun:test"
import {
  heldInputLedgerDigest,
  capturePolicySha256,
  screenCaptureRequestSchema,
  structurallyEqual,
  runtimeOperationIntentSchema,
  type AdapterHostContext,
  type NativeCleanupControl,
  type NativeContinuationIssuer,
  type NativeContinuationRegistrar,
  type NativeTargetMapping,
  type RuntimeOperationContext,
  type NativeExecutionContext,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import { NativeCaptureClient } from "../src/capture-client.ts"
import { extractNativeEvidenceReports } from "../src/evidence-extractor.ts"
import { createRuntimeNativeEvidenceBinder } from "../src/evidence-extractor.ts"
import { RuntimeCore } from "../../runtime/src/core.ts"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "../src/protocol.ts"

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}
const now = new Date().toISOString()
const expiresAt = new Date(Date.now() + 60_000).toISOString()
const frameBytes = new Uint8Array([1, 2, 3])
const frameSha256 = new Bun.CryptoHasher("sha256").update(frameBytes).digest("hex")

class CaptureTransport implements NativeTransport {
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []
  readonly #mode: "success" | "failed" | "unknown"
  #operationId = "operation-1"
  #acceptedFence = { ...generation, counter: 1 }
  #captureStatusCalls = 0
  readonly releaseCleanupIds: string[] = []
  readonly #loseFirstReleaseAck: boolean
  #releaseCalls = 0

  constructor(
    mode: "success" | "failed" | "unknown" = "success",
    loseFirstReleaseAck = false,
  ) {
    this.#mode = mode
    this.#loseFirstReleaseAck = loseFirstReleaseAck
  }

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    if (frame.channel === "handshake") {
      this.push({ kind: "message", frame: {
        channel: "handshake",
        payload: {
          kind: "handshake-response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          ...generation,
          nativeBuildId: "native-build-1",
          capabilitySchemaVersion: "1",
          installRoot: "/tmp/native-capture-fixture",
          process: { pid: 100, startedAt: now, nonce: "process-1" },
          capabilities: {
            schemaVersion: "1",
            scope: "adapter",
            producerRef: "capture-fixture",
            capabilities: [],
          },
        },
      } })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "capture.start") {
      this.#operationId = frame.payload.operation.operationId
      this.#acceptedFence = { ...frame.payload.operation.fence }
      this.push({ kind: "message", frame: {
        channel: "response",
        payload: {
          kind: "response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          ...generation,
          operationId: frame.payload.operation.operationId,
          ok: true,
          result: {
            captureTaskRef: "capture-task-1",
            operationId: this.#operationId,
            acceptedFence: { ...this.#acceptedFence },
            sourceResponseRef: "capture-start-response-1",
            inventoryId: "inventory-1",
            inventoryRevision: 1,
            displayLayoutRevision: 1,
            observedAt: now,
            statusEvidenceRef: "status-start-1",
            acceptedAt: now,
            status: pendingStatus(),
          },
        },
      } })
      return
    }
    if (frame.channel === "status") {
      this.push({ kind: "message", frame: {
        channel: "status",
        payload: {
          requestId: frame.payload.requestId,
          ...generation,
          highWaterFence: { ...this.#acceptedFence },
          acceptedFence: { ...this.#acceptedFence },
          operationId: this.#operationId,
          execution: "finished",
          dispatch: "finished",
          cleanup: "complete",
          targetVerified: "verified",
          cancellationRequested: false,
          userInterference: "unknown",
          restorationAllowed: false,
          quarantined: false,
          heldCount: 0,
          lastCheckpoint: "capture-terminal",
          dispatchAttempts: 1,
          ledgerRevision: 0,
          observer: {
            state: "unavailable",
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
            reason: "fixture observer unavailable",
          },
        },
      } })
      return
    }
    if (frame.channel === "cleanup") {
      const control = frame.payload.control
      if (control.purpose === "result") {
        const status = this.#mode === "unknown" ? unknownStatus() : completedStatus()
        this.push({
          kind: "message",
          frame: {
            channel: "cleanup",
            payload: {
              purpose: "result",
              ack: cleanupAck(control, 2, this.#mode !== "unknown"),
              statusEvidence: statusEvidence(2, "capture-status-response-2", this.#operationId, this.#acceptedFence),
              poll: {
                state: "completed",
                captureTaskRef: "capture-task-1",
                status,
                result: completion(this.#mode, this.#operationId, this.#acceptedFence),
              },
            },
          },
        })
        if (this.#mode !== "failed") {
          this.push({ kind: "binary", binaryToken: "binary-1", bytes: frameBytes })
        }
        return
      }
      if (control.purpose === "status") {
        this.#captureStatusCalls += 1
        const pending = this.#mode === "unknown" && this.#captureStatusCalls === 1
        const revision = pending ? 3 : this.#mode === "unknown" ? 4 : 3
        this.push({ kind: "message", frame: {
          channel: "cleanup",
          payload: {
            purpose: "status",
            ack: cleanupAck(control, revision, !pending),
            statusEvidence: statusEvidence(revision, `capture-status-response-${revision}`, this.#operationId, this.#acceptedFence),
            status: pending
              ? { ...unknownStatus(), revision }
              : { ...completedStatus(), revision },
            ...(pending ? {} : {
              terminal: terminalEvidence(
                this.#operationId,
                this.#acceptedFence,
                `capture-response-terminal-${revision}-${control.requestId}`,
              ),
            }),
          },
        } })
        return
      }
      if (control.purpose === "release") {
        this.#releaseCalls += 1
        this.releaseCleanupIds.push(control.cleanupRequestId)
        if (this.#loseFirstReleaseAck && this.#releaseCalls === 1) {
          throw new Error("fixture потерял ACK после освобождения task")
        }
        this.push({ kind: "message", frame: {
          channel: "cleanup",
          payload: {
            purpose: "release",
            ack: cleanupAck(control, Math.max(2, control.expectedStatusRevision)),
            alreadyReleased: this.#loseFirstReleaseAck,
          },
        } })
      }
    }
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted) {
      const packet = this.#packets.shift()
      if (packet !== undefined) {
        yield packet
        continue
      }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("fixture stopped"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push((value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
    }
  }

  async close(): Promise<void> {}

  push(packet: NativeTransportPacket): void {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#packets.push(packet)
    else waiter(packet)
  }
}

function pendingStatus() {
  return {
    captureTaskRef: "capture-task-1",
    revision: 1,
    completionDelivered: false,
    stopRequested: false,
    stopCallInFlight: false,
    stopAttemptCount: 0,
    startPending: true,
    streamStarted: false,
    streamStopped: false,
    encodingInFlight: false,
    cleanup: "pending" as const,
    drained: false,
  }
}

function completedStatus() {
  return {
    ...pendingStatus(),
    revision: 2,
    completionDelivered: true,
    startPending: false,
    streamStarted: true,
    streamStopped: true,
    cleanup: "complete" as const,
    drained: true,
  }
}

function unknownStatus() {
  return {
    ...completedStatus(),
    cleanup: "unknown" as const,
    streamStopped: false,
    drained: false,
  }
}

function cleanupAck(control: NativeCleanupControl, revision: number, complete = true) {
  return {
    kind: "cleanup-ack" as const,
    requestId: control.requestId,
    cleanupRequestId: control.cleanupRequestId,
    operationId: control.operationId,
    runtimeEpoch: control.runtimeEpoch,
    loginSessionId: control.loginSessionId,
    nativeGeneration: control.nativeGeneration,
    acceptedFence: { ...control.acceptedFence },
    currentHighWaterFence: { ...control.currentHighWaterFence },
    statusRevision: revision,
    drainedEvidenceRef: control.expectedDrainedEvidenceRef,
    ...(complete ? { terminalReceiptRef: "terminal-receipt-1" } : {}),
    cleanup: complete ? "complete" as const : "unknown" as const,
    drained: complete,
    quarantined: !complete,
  }
}

const target = {
  kind: "display" as const,
  ref: {
    ...generation,
    displayRef: "display-1",
    displayLayoutRevision: 1,
  },
}

const nativeMapping: NativeTargetMapping = {
  kind: "display",
  display: { nativeDisplayId: 100, ref: target.ref },
}

function captureRequest() {
  const value = {
    source: "display-composite",
    caption: "Ожидаю увидеть fixture display",
    target: {
      kind: "display",
      target,
      nativeDisplayId: 100,
      mappingEvidence: {
        state: "confirmed",
        claim: "display-resolved",
        source: "runtime",
        proof: {
          proofRef: "proof-1",
          authorityRef: "authority-1",
          kind: "target-resolution",
          subject: target,
          ...generation,
          inventoryRevision: 1,
          displayLayoutRevision: 1,
          issuedAt: now,
          expiresAt,
        },
      },
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: {
      policyId: "readiness-native-frame",
      requiredSteps: ["permission", "target", "complete-frame"],
      disabledSteps: [],
    },
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 10,
      maxHeightPx: 10,
      maxPixels: 100,
      maxEncodedBytes: 100,
    },
  } as const
  return screenCaptureRequestSchema.parse({
    ...value,
    publication: {
      observationId: "observation-1",
      frameRef: "frame-1",
      source: "display-composite",
      captureTarget: target,
      capturePolicySha256: capturePolicySha256(value),
      ...generation,
      expiresAt,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      cacheScopeRef: "client-1",
    },
  })
}

function completion(
  mode: "success" | "failed" | "unknown" = "success",
  operationId = "operation-1",
  acceptedFence = { ...generation, counter: 1 },
) {
  const base = {
    captureTaskRef: "capture-task-1",
    operationId,
    acceptedFence,
    sourceResponseRef: "capture-response-1",
    observationId: "observation-1",
    inventoryId: "inventory-1",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    source: "display-composite" as const,
    caption: "Ожидаю увидеть fixture display",
    target,
    nativeMapping,
    clip: { kind: "full-target" as const },
    cursor: "excluded" as const,
    scale: 1,
    backend: { name: "fixture", buildId: "native-build-1" },
    targetEvidence: {
      shareableTargetMatched: true,
      beforeTargetMatched: true,
      afterTargetMatched: true,
      boundsUnchanged: true,
      auxiliarySurfacesExcluded: false,
    },
    readinessFacts: [{ name: "complete-frame", state: "reached" as const, durationMs: 1 }],
    statusRevision: 2,
  }
  if (mode === "failed") {
    return {
      ...base,
      drainedEvidenceRef: "drained-1",
      terminalReceiptRef: "terminal-receipt-1",
      outcome: "failed" as const,
      cleanup: "complete" as const,
      errorCode: "frame-unavailable" as const,
      errorMessage: "fixture frame unavailable",
    }
  }
  return {
    ...base,
    ...(mode === "unknown" ? {} : {
      drainedEvidenceRef: "drained-1",
      terminalReceiptRef: "terminal-receipt-1",
    }),
    outcome: "succeeded" as const,
    cleanup: mode === "unknown" ? "unknown" as const : "complete" as const,
    errorCode: "none" as const,
    frame: {
      binaryToken: "binary-1",
      frameRef: "frame-1",
      sha256: frameSha256,
      widthPx: 1,
      heightPx: 1,
      encodedBytes: frameBytes.byteLength,
      capturedAt: now,
      frameStatus: "complete" as const,
      regions: [{
        nativeDisplayId: 100,
        displayBounds: { x: 0, y: 0, width: 100, height: 100 },
        imageRect: { x: 0, y: 0, width: 1, height: 1 },
        destinationRect: { x: 0, y: 0, width: 100, height: 100 },
        imageToDestination: { a: 100, b: 0, c: 0, d: 100, tx: 0, ty: 0 },
        rotationDegrees: 0,
        frameOrientation: "display-oriented" as const,
        backingScaleX: 1,
        backingScaleY: 1,
        frameTimestamp: now,
      }],
    },
  }
}

function terminalEvidence(
  operationId = "operation-1",
  acceptedFence = { ...generation, counter: 1 },
  sourceResponseRef = "capture-response-late-terminal",
) {
  return {
    operationId,
    acceptedFence,
    sourceResponseRef,
    inventoryId: "inventory-1",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    drainedEvidenceRef: "drained-1",
    terminalReceiptRef: "terminal-receipt-1",
  }
}

function statusEvidence(
  revision: number,
  sourceResponseRef: string,
  operationId = "operation-1",
  acceptedFence = { ...generation, counter: 1 },
) {
  return {
    operationId,
    acceptedFence,
    sourceResponseRef,
    inventoryId: "inventory-1",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    statusEvidenceRef: `status-${revision}`,
  }
}

function context(): RuntimeOperationContext<NativeExecutionContext> {
  const deadlineAt = new Date(Date.now() + 10_000).toISOString()
  return {
    wire: {
      kind: "native",
      operationId: "operation-1",
      clientRequestId: "client-request-1",
      clientSessionId: "client-session-1",
      principalId: "principal-1",
      ...generation,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      target,
      fence: { ...generation, counter: 1 },
      deadlineAt,
    },
    session: {
      clientSessionId: "client-session-1",
      principalId: "principal-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      authenticationGeneration: "auth-1",
      authenticatedAt: now,
      expiresAt,
    },
    control: { signal: new AbortController().signal, checkpoint: () => undefined },
    resources: [{
      kind: "capture-stream",
      resourceRef: "observation-1",
      leaseId: "lease-capture-1",
      leaseGeneration: "lease-generation-1",
      operationId: "operation-1",
      clientSessionId: "client-session-1",
      principalId: "principal-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      expiresAt,
      state: "active",
    }],
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
      producerRef: "capture-test",
      capabilities: [],
    },
  }
}

async function createHarness(mode: "success" | "failed" | "unknown") {
    const registered = new Map<string, ReturnType<typeof extractNativeEvidenceReports>>()
    const publishedFacts: string[] = []
    const transport = new CaptureTransport(mode)
    const native = new NativeBrokerAdapter({
      adapterInstanceRef: "native-adapter-1",
      host: host(),
      transport,
      bindEvidence: identity => ({
        sourceResponses: {
          register(sourceResponseRef, bytes) {
            registered.set(sourceResponseRef, extractNativeEvidenceReports(bytes))
          },
        },
        publisher: {
          async publish(report) {
            expect(identity.loadedBuildId).toBe("native-build-1")
            expect(registered.get(report.sourceResponseRef)?.some(candidate => structurallyEqual(candidate, report))).toBe(true)
            publishedFacts.push(report.factKind)
            return {
              evidenceReceiptId: "evidence-receipt-1",
              adapterInstanceRef: identity.adapterInstanceRef,
              backendBuildId: identity.loadedBuildId,
              ...generation,
              sourceResponseRef: report.sourceResponseRef,
              sourceResponseSha256: "b".repeat(64),
              inventoryId: report.inventoryId,
              inventoryRevision: report.inventoryRevision,
              displayLayoutRevision: report.displayLayoutRevision,
              observedAt: report.observedAt,
              factKind: report.factKind,
              factSha256: "c".repeat(64),
              issuedAt: now,
            }
          },
        },
      }),
      ledgerSink: {
        async persist(requestId, snapshot) {
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
    await native.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    let continuationSequence = 0
    const state = { registeredTask: false, terminalTask: false }
    const continuations: NativeContinuationIssuer & NativeContinuationRegistrar = {
      async registerAcceptedTask(request) {
        expect(request.taskRef).toBe("capture-task-1")
        expect(request.resourceLeaseId).toBe("lease-capture-1")
        expect(request.receipt.factKind).toBe("capture-task-start")
        state.registeredTask = true
      },
      async markVerifiedTerminal(request) {
        expect(request.receipt.factKind).toBe("capture-task-terminal")
        expect(request.drainedEvidenceRef).toBe("drained-1")
        state.terminalTask = true
      },
      async advanceVerifiedStatus(request) {
        expect(request.receipt.factKind).toBe("capture-task-status")
        expect(request.statusRevision).toBeGreaterThanOrEqual(2)
      },
      async issue(request) {
        if (!state.registeredTask) throw new Error("task ещё не зарегистрирован")
        if (request.purpose === "release" && !state.terminalTask) throw new Error("terminal task ещё не зарегистрирован")
        continuationSequence += 1
        const cleanupControl: NativeCleanupControl = {
          kind: "cleanup-only",
          purpose: request.purpose,
          requestId: `cleanup-request-${continuationSequence}`,
          cleanupRequestId: `cleanup-authority-${continuationSequence}`,
          operationId: request.operationId,
          ...generation,
          acceptedFence: { ...generation, counter: 1 },
          currentHighWaterFence: { ...generation, counter: 1 },
          deadlineAt: new Date(Date.now() + 1_000).toISOString(),
          expectedStatusRevision: request.expectedRevision,
          expectedDrainedEvidenceRef: "drained-1",
        }
        return {
          cleanupControl,
          control: { signal: new AbortController().signal, checkpoint: () => undefined },
        }
      },
    }
    const task = await new NativeCaptureClient(native, continuations)
      .start(context(), captureRequest(), nativeMapping)
    return { native, task, state, publishedFacts }
}

describe("NativeCaptureClient", () => {
  test("использует runtime continuation, exact binary и verified native evidence receipt", async () => {
    const { native, task, state, publishedFacts } = await createHarness("success")
    expect(task.taskRef).toBe("capture-task-1")
    expect(state.registeredTask).toBe(true)
    expect(task.accepted.status.completionDelivered).toBe(false)
    const result = await task.result()
    expect(result.bytes).toEqual(frameBytes)
    expect(result.evidenceReceipt?.factKind).toBe("frame")
    expect(publishedFacts).toEqual(["capture-task-start", "capture-task-terminal", "frame"])
    expect(state.terminalTask).toBe(true)
    await task.release()
    await expect(task.result()).rejects.toThrow("released")
    await native.close()
  })

  test("failed completion без frame всё равно регистрирует terminal lifecycle", async () => {
    const { native, task, state, publishedFacts } = await createHarness("failed")
    const result = await task.result()
    expect(result.poll.state).toBe("completed")
    expect(result.bytes).toBeUndefined()
    expect(result.evidenceReceipt).toBeUndefined()
    expect(result.terminalEvidenceReceipt?.factKind).toBe("capture-task-terminal")
    expect(publishedFacts).toEqual(["capture-task-start", "capture-task-terminal"])
    expect(state.terminalTask).toBe(true)
    await task.release()
    await native.close()
  })

  test("unknown cleanup не регистрирует terminal до позднего complete status", async () => {
    const { native, task, state, publishedFacts } = await createHarness("unknown")
    const result = await task.result()
    expect(result.bytes).toEqual(frameBytes)
    expect(state.terminalTask).toBe(false)
    expect(publishedFacts).toEqual(["capture-task-start", "capture-task-status", "frame"])
    const status = await task.status()
    expect(status.cleanup).toBe("unknown")
    expect(status.revision).toBe(3)
    expect(state.terminalTask).toBe(false)
    const terminalStatus = await task.status()
    expect(terminalStatus.cleanup).toBe("complete")
    expect(terminalStatus.revision).toBe(4)
    expect(state.terminalTask).toBe(true)
    expect(publishedFacts).toEqual([
      "capture-task-start",
      "capture-task-status",
      "frame",
      "capture-task-status",
      "capture-task-terminal",
    ])
    await task.release()
    await native.close()
  })

  test("регистрирует task и terminal через реальный Runtime continuation registry", async () => {
    const nativeIdentity = {
      adapterInstanceRef: "native-adapter-runtime-capture",
      backendBuildId: "native-build-1",
      nativeGeneration: generation.nativeGeneration,
    }
    let runtime: RuntimeCore
    const runtimeTransport = new CaptureTransport("unknown", true)
    const native = new NativeBrokerAdapter({
      adapterInstanceRef: nativeIdentity.adapterInstanceRef,
      host: host(),
      transport: runtimeTransport,
      bindEvidence: identity => createRuntimeNativeEvidenceBinder(runtime.evidence)(identity),
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
    })
    runtime = new RuntimeCore({
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-build-1",
      nativeGeneration: generation.nativeGeneration,
      native,
      nativeSourceIdentity: nativeIdentity,
    })
    runtime.targets.register(
      target,
      "inventory-1",
      1,
      "resolution-display-1",
      "proof-display-1",
      1,
      nativeMapping,
    )
    await native.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-runtime-capture",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    const client = runtime.openClient("principal-runtime-capture")
    const request = captureRequest()
    const execution = await runtime.runOperation(
      client.session,
      runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: "capture-runtime-request-1",
        precondition: {
          target,
          inventoryId: "inventory-1",
          inventoryRevision: 1,
        },
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        requestedResources: [{ kind: "capture-stream", resourceRef: "observation-1" }],
      }),
      request,
      async (runtimeContext) => {
        if (runtimeContext.wire.kind !== "native") throw new Error("Ожидался native context")
        const task = await new NativeCaptureClient(native, runtime.continuations)
          .start(runtimeContext as RuntimeOperationContext<NativeExecutionContext>, request, nativeMapping)
        const result = await task.result()
        if (result.bytes === undefined) throw new Error("Runtime capture не получил bytes")
        const pending = await task.status()
        if (pending.revision !== 3 || pending.cleanup !== "unknown") throw new Error("Ожидался pending revision 3")
        const terminal = await task.status()
        if (terminal.revision !== 4 || terminal.cleanup !== "complete") throw new Error("Ожидался terminal revision 4")
        const repeated = await task.status()
        if (repeated.revision !== 4 || repeated.cleanup !== "complete") throw new Error("Repeated terminal изменился")
        await expect(task.release()).rejects.toThrow("потерял ACK")
        await task.release()
        return {
          ok: true as const,
          value: { captured: true as const },
          outcome: {
            dispatch: "finished" as const,
            targetVerified: "verified" as const,
            userInterference: "unknown" as const,
            observation: "available" as const,
            effect: { state: "unverified" as const, proofRefs: [] as [] },
            cleanup: {
              scope: "owned" as const,
              state: "complete" as const,
              resources: runtimeContext.resources.map(handle => ({ handle, outcome: "released" as const })),
            },
            restoration: "not-applicable" as const,
            dispatchAttempts: 1,
          },
        }
      },
    )
    if (!execution.result.ok) throw new Error(execution.result.error.message)
    expect(execution.result.ok).toBe(true)
    expect(execution.operation.state).toBe("completed")
    expect(execution.operation.outcome.cleanup.state).toBe("complete")
    expect(runtimeTransport.releaseCleanupIds).toHaveLength(2)
    expect(runtimeTransport.releaseCleanupIds[0]).toBe(runtimeTransport.releaseCleanupIds[1])
    await native.close()
  })
})
