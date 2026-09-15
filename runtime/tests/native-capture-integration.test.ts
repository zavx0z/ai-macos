import { expect, test } from "bun:test"
import {
  capturePolicySha256,
  freezeAdapterHostContext,
  heldInputLedgerDigest,
  operationOutcomeSchema,
  runtimeOperationIntentSchema,
  screenCaptureRequestSchema,
  type NativeCleanupControl,
  type NativeExecutionContext,
  type NativeTargetMapping,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "@meta/native/adapter"
import { NativeCaptureClient } from "@meta/native/capture-client"
import { extractNativeEvidenceReports } from "@meta/native/evidence-extractor"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "@meta/native/protocol"
import { RuntimeCore } from "../src/core.ts"

const generation = {
  runtimeEpoch: "runtime:capture-integration",
  loginSessionId: "login:capture-integration",
  nativeGeneration: "native:capture-integration",
}
const binding = {
  adapterInstanceRef: "native-adapter:capture-integration",
  backendBuildId: "native-build:capture-integration",
  nativeGeneration: generation.nativeGeneration,
}
const now = new Date().toISOString()
const target = {
  kind: "display" as const,
  ref: {
    ...generation,
    displayRef: "display:capture-integration",
    displayLayoutRevision: 1,
  },
}
const nativeMapping: NativeTargetMapping = {
  kind: "display",
  display: { nativeDisplayId: 100, ref: target.ref },
}
const frameBytes = new Uint8Array([1, 2, 3])
const frameSha256 = new Bun.CryptoHasher("sha256").update(frameBytes).digest("hex")

test("NativeCaptureClient uses verified Runtime continuation for normal active release", async () => {
  const transport = new CaptureIntegrationTransport("success")
  let runtime: RuntimeCore
  const native = new NativeBrokerAdapter({
    adapterInstanceRef: binding.adapterInstanceRef,
    host: freezeAdapterHostContext({
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-build:capture-integration",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "native:capture-integration",
        capabilities: [],
      },
    }),
    transport,
    bindEvidence(identity) {
      const actualBinding = {
        adapterInstanceRef: identity.adapterInstanceRef,
        backendBuildId: identity.loadedBuildId,
        nativeGeneration: identity.generation.nativeGeneration,
      }
      runtime.evidence.registerSourceExtractor(actualBinding, extractNativeEvidenceReports)
      return {
        publisher: runtime.evidence.bind(actualBinding),
        sourceResponses: {
          register(sourceResponseRef, bytes) {
            runtime.evidence.registerSourceResponse(actualBinding, sourceResponseRef, bytes)
          },
        },
      }
    },
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
          persistedAt: new Date().toISOString(),
          durable: true,
        }
      },
    },
  })
  runtime = new RuntimeCore({
    generation: {
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
    },
    runtimeBuildId: "runtime-build:capture-integration",
    nativeGeneration: generation.nativeGeneration,
    native,
    nativeSourceIdentity: binding,
  })
  await native.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:capture-integration",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-build:capture-integration",
    expectedNativeBuildId: binding.backendBuildId,
    capabilitySchemaVersion: "1",
  })
  runtime.targets.register(
    target,
    "inventory:capture-integration",
    1,
    "resolution:capture-integration",
    "proof:capture-integration",
    1,
    nativeMapping,
  )
  const client = runtime.openClient("principal:capture-integration")
  const request = captureRequest()
  const intent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "request:capture-integration",
    precondition: {
      target,
      inventoryId: "inventory:capture-integration",
      inventoryRevision: 1,
    },
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    requestedResources: [{ kind: "capture-stream", resourceRef: request.publication.observationId }],
  })
  const capture = new NativeCaptureClient(native, runtime.continuations)
  const execution = await runtime.runOperation(client.session, intent, request, async context => {
    if (context.wire.kind !== "native") throw new Error("Expected native capture context")
    const task = await capture.start(
      context as RuntimeOperationContext<NativeExecutionContext>,
      request,
      nativeMapping,
    )
    const result = await task.result()
    await task.release()
    return {
      ok: true,
      value: { taskRef: task.taskRef, bytes: result.bytes?.byteLength ?? 0 },
      outcome: operationOutcomeSchema.parse({
        dispatch: "finished",
        targetVerified: "verified",
        userInterference: "unknown",
        observation: "available",
        effect: { state: "unverified", proofRefs: [] },
        cleanup: {
          scope: "owned",
          state: "complete",
          resources: context.resources.map(handle => ({ handle, outcome: "released" })),
        },
        restoration: "not-applicable",
        dispatchAttempts: 1,
      }),
    }
  })
  expect(execution.operation.state).toBe("completed")
  expect(execution.result).toMatchObject({ ok: true, value: { taskRef: "capture-task:integration", bytes: 3 } })
  expect(transport.releaseCalls).toBe(1)
  expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toHaveLength(0)
  await native.close()
})

test("NativeCaptureClient unknown cleanup reconciles runtime receipt before late release", async () => {
  const { runtime, native, transport, client, request, intent, capture } = await setupIntegration("unknown")
  let task: Awaited<ReturnType<NativeCaptureClient["start"]>> | undefined
  const execution = await runtime.runOperation(client.session, intent, request, async context => {
    if (context.wire.kind !== "native") throw new Error("Expected native capture context")
    task = await capture.start(context as RuntimeOperationContext<NativeExecutionContext>, request, nativeMapping)
    const result = await task.result()
    expect(result.poll.state === "completed" ? result.poll.status.cleanup : undefined).toBe("unknown")
    return {
      ok: false,
      error: {
        code: "cleanup-incomplete",
        message: "capture cleanup unknown",
        stage: "capture-result",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
      outcome: operationOutcomeSchema.parse({
        dispatch: "finished",
        targetVerified: "verified",
        userInterference: "unknown",
        observation: "available",
        effect: { state: "unverified", proofRefs: [] },
        cleanup: {
          scope: "owned",
          state: "unknown",
          reason: "capture stream not drained",
          resources: context.resources.map(handle => ({ handle, outcome: "quarantined" })),
        },
        restoration: "not-applicable",
        dispatchAttempts: 1,
      }),
    }
  })
  expect(execution.operation.state).toBe("failed")
  if (task === undefined || execution.operation.context.kind !== "native") throw new Error("Missing capture task")
  expect((await task.status()).cleanup).toBe("complete")
  const cleanup = {
    scope: "owned" as const,
    state: "complete" as const,
    resources: execution.operation.resources.map(handle => ({ handle, outcome: "released" as const })),
  }
  await runtime.reconcileCleanup({
    operationId: execution.operation.context.operationId,
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    nativeGeneration: generation.nativeGeneration,
    revision: 3,
    cleanup,
  })
  expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toHaveLength(0)
  await task.release()
  expect(transport.releaseCalls).toBe(1)
  await native.close()
})

async function setupIntegration(mode: "success" | "unknown") {
  const transport = new CaptureIntegrationTransport(mode)
  let runtime: RuntimeCore
  const native = new NativeBrokerAdapter({
    adapterInstanceRef: binding.adapterInstanceRef,
    host: freezeAdapterHostContext({
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-build:capture-integration",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "native:capture-integration",
        capabilities: [],
      },
    }),
    transport,
    bindEvidence(identity) {
      const actualBinding = {
        adapterInstanceRef: identity.adapterInstanceRef,
        backendBuildId: identity.loadedBuildId,
        nativeGeneration: identity.generation.nativeGeneration,
      }
      runtime.evidence.registerSourceExtractor(actualBinding, extractNativeEvidenceReports)
      return {
        publisher: runtime.evidence.bind(actualBinding),
        sourceResponses: {
          register(sourceResponseRef, bytes) {
            runtime.evidence.registerSourceResponse(actualBinding, sourceResponseRef, bytes)
          },
        },
      }
    },
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
          persistedAt: new Date().toISOString(),
          durable: true,
        }
      },
    },
  })
  runtime = new RuntimeCore({
    generation: {
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
    },
    runtimeBuildId: "runtime-build:capture-integration",
    nativeGeneration: generation.nativeGeneration,
    native,
    nativeSourceIdentity: binding,
  })
  await native.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: `handshake:capture-integration:${mode}`,
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-build:capture-integration",
    expectedNativeBuildId: binding.backendBuildId,
    capabilitySchemaVersion: "1",
  })
  runtime.targets.register(
    target,
    "inventory:capture-integration",
    1,
    "resolution:capture-integration",
    "proof:capture-integration",
    1,
    nativeMapping,
  )
  const client = runtime.openClient(`principal:capture-integration:${mode}`)
  const request = captureRequest()
  const intent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: `request:capture-integration:${mode}`,
    precondition: {
      target,
      inventoryId: "inventory:capture-integration",
      inventoryRevision: 1,
    },
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    requestedResources: [{ kind: "capture-stream", resourceRef: request.publication.observationId }],
  })
  return {
    runtime,
    native,
    transport,
    client,
    request,
    intent,
    capture: new NativeCaptureClient(native, runtime.continuations),
  }
}

class CaptureIntegrationTransport implements NativeTransport {
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []
  operation: NativeExecutionContext | undefined
  releaseCalls = 0
  captureComplete: boolean

  constructor(readonly mode: "success" | "unknown") {
    this.captureComplete = mode === "success"
  }

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    if (frame.channel === "handshake") {
      this.pushFrame({
        channel: "handshake",
        payload: {
          kind: "handshake-response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          ...generation,
          nativeBuildId: binding.backendBuildId,
          capabilitySchemaVersion: "1",
          installRoot: "/tmp/native-capture-integration",
          process: { pid: 100, startedAt: now, nonce: "process:capture-integration" },
          capabilities: {
            schemaVersion: "1",
            scope: "adapter",
            producerRef: "native:capture-integration",
            capabilities: [],
          },
        },
      })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "capture.start") {
      this.operation = frame.payload.operation
      integrationOperation = frame.payload.operation
      this.pushFrame({
        channel: "response",
        payload: {
          kind: "response",
          protocolVersion: "1",
          requestId: frame.payload.requestId,
          ...generation,
          operationId: frame.payload.operation.operationId,
          ok: true,
          result: {
            captureTaskRef: "capture-task:integration",
            operationId: frame.payload.operation.operationId,
            acceptedFence: frame.payload.operation.fence,
            sourceResponseRef: "capture-start-response:integration",
            inventoryId: "inventory:capture-integration",
            inventoryRevision: 1,
            displayLayoutRevision: 1,
            observedAt: now,
            statusEvidenceRef: "capture-status:start",
            acceptedAt: now,
            status: captureStatus(1, "pending", false),
          },
        },
      })
      return
    }
    if (frame.channel === "cleanup") {
      const control = frame.payload.control
      if (control.purpose === "result") {
        const status = this.mode === "success"
          ? captureStatus(2, "complete", true)
          : captureStatus(2, "unknown", false)
        this.pushFrame({
          channel: "cleanup",
          payload: {
            purpose: "result",
            ack: cleanupAck(control, 2, this.mode === "success"),
            statusEvidence: statusEvidence("capture-status-response:2", 2),
            poll: {
              state: "completed",
              captureTaskRef: "capture-task:integration",
              status,
              result: completion(this.mode),
            },
          },
        })
        this.push({ kind: "binary", binaryToken: "binary:capture-integration", bytes: frameBytes })
        return
      }
      if (control.purpose === "status") {
        this.captureComplete = true
        const status = captureStatus(3, "complete", true)
        this.pushFrame({
          channel: "cleanup",
          payload: {
            purpose: "status",
            ack: cleanupAck(control, 3),
            statusEvidence: statusEvidence("capture-status-response:3", 3),
            status,
            terminal: terminalEvidence(),
          },
        })
        return
      }
      if (control.purpose === "release") {
        this.releaseCalls++
        this.pushFrame({
          channel: "cleanup",
          payload: {
            purpose: "release",
            ack: cleanupAck(control, Math.max(2, control.expectedStatusRevision)),
            alreadyReleased: false,
          },
        })
      }
      return
    }
    if (frame.channel === "status") {
      if (this.operation === undefined) throw new Error("Missing capture operation")
      this.pushFrame({
        channel: "status",
        payload: nativeStatus(frame.payload.requestId, this.operation, this.captureComplete),
      })
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
        const onAbort = () => reject(signal.reason ?? new Error("transport stopped"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push(value => {
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

  pushFrame(frame: Extract<NativeTransportPacket, { kind: "message" }> ["frame"]): void {
    this.push({
      kind: "message",
      frame,
      bytes: new TextEncoder().encode(JSON.stringify(frame)),
    })
  }
}

function captureRequest() {
  const policy = {
    source: "display-composite" as const,
    caption: "Ожидаю увидеть integration display",
    target: {
      kind: "display" as const,
      target,
      nativeDisplayId: 100,
      mappingEvidence: {
        state: "confirmed" as const,
        claim: "display-resolved",
        source: "runtime",
        proof: {
          proofRef: "proof:capture-integration",
          authorityRef: "authority:capture-integration",
          kind: "target-resolution" as const,
          subject: target,
          ...generation,
          inventoryRevision: 1,
          displayLayoutRevision: 1,
          issuedAt: now,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    },
    clip: { kind: "full-target" as const },
    fullPage: false,
    cursor: "exclude" as const,
    readinessPolicy: {
      policyId: "readiness:capture-integration",
      requiredSteps: ["permission", "target", "complete-frame"] as const,
      disabledSteps: [] as const,
    },
    output: {
      format: "image/png" as const,
      scale: 1,
      maxWidthPx: 10,
      maxHeightPx: 10,
      maxPixels: 100,
      maxEncodedBytes: 100,
    },
  }
  return screenCaptureRequestSchema.parse({
    ...policy,
    publication: {
      observationId: "observation:capture-integration",
      frameRef: "frame:capture-integration",
      source: policy.source,
      captureTarget: target,
      capturePolicySha256: capturePolicySha256(policy),
      ...generation,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      inventoryId: "inventory:capture-integration",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      cacheScopeRef: "client:capture-integration",
    },
  })
}

function captureStatus(revision: number, cleanup: "pending" | "complete" | "unknown", drained: boolean) {
  return {
    captureTaskRef: "capture-task:integration",
    revision,
    completionDelivered: revision > 1,
    stopRequested: false,
    stopCallInFlight: false,
    stopAttemptCount: 0,
    startPending: revision === 1,
    streamStarted: revision > 1,
    streamStopped: drained,
    encodingInFlight: false,
    cleanup,
    drained,
  }
}

function statusEvidence(sourceResponseRef: string, revision: number) {
  if (integrationOperation === undefined) throw new Error("Missing operation")
  return {
    operationId: integrationOperation.operationId,
    acceptedFence: integrationOperation.fence,
    sourceResponseRef,
    inventoryId: "inventory:capture-integration",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    statusEvidenceRef: `capture-status:${revision}`,
  }
}

function terminalEvidence() {
  if (integrationOperation === undefined) throw new Error("Missing operation")
  return {
    operationId: integrationOperation.operationId,
    acceptedFence: integrationOperation.fence,
    sourceResponseRef: "capture-terminal-response:integration",
    inventoryId: "inventory:capture-integration",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    drainedEvidenceRef: "drained:capture-integration",
    terminalReceiptRef: "terminal:capture-integration",
  }
}

let integrationOperation: NativeExecutionContext | undefined

function completion(mode: "success" | "unknown" = "success") {
  if (integrationOperation === undefined) throw new Error("Missing operation")
  return {
    captureTaskRef: "capture-task:integration",
    operationId: integrationOperation.operationId,
    acceptedFence: integrationOperation.fence,
    sourceResponseRef: "capture-completion-response:integration",
    observationId: "observation:capture-integration",
    inventoryId: "inventory:capture-integration",
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    observedAt: now,
    source: "display-composite" as const,
    caption: "Ожидаю увидеть integration display",
    target,
    nativeMapping,
    clip: { kind: "full-target" as const },
    cursor: "excluded" as const,
    scale: 1,
    backend: { name: "fixture", buildId: binding.backendBuildId },
    targetEvidence: {
      shareableTargetMatched: true,
      beforeTargetMatched: true,
      afterTargetMatched: true,
      boundsUnchanged: true,
      auxiliarySurfacesExcluded: false,
    },
    readinessFacts: [{ name: "complete-frame", state: "reached" as const, durationMs: 1 }],
    statusRevision: 2,
    ...(mode === "success" ? {
      drainedEvidenceRef: "drained:capture-integration",
      terminalReceiptRef: "terminal:capture-integration",
    } : {}),
    outcome: "succeeded" as const,
    cleanup: mode === "success" ? "complete" as const : "unknown" as const,
    errorCode: "none" as const,
    frame: {
      binaryToken: "binary:capture-integration",
      frameRef: "frame:capture-integration",
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

function cleanupAck(control: NativeCleanupControl, revision: number, complete = true) {
  return {
    kind: "cleanup-ack" as const,
    requestId: control.requestId,
    cleanupRequestId: control.cleanupRequestId,
    operationId: control.operationId,
    runtimeEpoch: control.runtimeEpoch,
    loginSessionId: control.loginSessionId,
    nativeGeneration: control.nativeGeneration,
    acceptedFence: control.acceptedFence,
    currentHighWaterFence: control.currentHighWaterFence,
    statusRevision: revision,
    drainedEvidenceRef: control.expectedDrainedEvidenceRef,
    ...(complete ? { terminalReceiptRef: "terminal:capture-integration" } : {}),
    cleanup: complete ? "complete" as const : "unknown" as const,
    drained: complete,
    quarantined: !complete,
  }
}

function nativeStatus(requestId: string, operation: NativeExecutionContext, complete: boolean) {
  const timestamp = new Date().toISOString()
  return {
    requestId,
    runtimeEpoch: operation.runtimeEpoch,
    loginSessionId: operation.loginSessionId,
    nativeGeneration: operation.nativeGeneration,
    highWaterFence: operation.fence,
    acceptedFence: operation.fence,
    operationId: operation.operationId,
    execution: complete ? "finished" as const : "quarantined" as const,
    dispatch: "finished" as const,
    cleanup: complete ? "complete" as const : "unknown" as const,
    targetVerified: "verified" as const,
    cancellationRequested: false,
    userInterference: "unknown" as const,
    restorationAllowed: false,
    quarantined: !complete,
    heldCount: 0,
    lastCheckpoint: "capture-finished",
    dispatchAttempts: 1,
    ledgerRevision: complete ? 3 : 2,
    observer: {
      state: "unavailable" as const,
      runtimeEpoch: operation.runtimeEpoch,
      loginSessionId: operation.loginSessionId,
      nativeGeneration: operation.nativeGeneration,
      coverageStartCursor: "observer:start",
      cursor: "observer:current",
      nextSequence: 1,
      startedAt: timestamp,
      coveredFrom: timestamp,
      coveredThrough: timestamp,
      heartbeatAt: timestamp,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: true,
      reason: "capture fixture has no input observer",
    },
  }
}
