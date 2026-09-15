import { expect, test } from "bun:test"
import {
  capabilitySetSchema,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type RuntimeOperationContext,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../../runtime/src/core.ts"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import { NativeApplicationAdapter } from "../src/application-adapter.ts"
import { createRuntimeNativeEvidenceBinder } from "../src/evidence-extractor.ts"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "../src/protocol.ts"

const generation = {
  runtimeEpoch: "runtime:applications",
  loginSessionId: "login:applications",
  nativeGeneration: "native:applications",
}
const observedAt = new Date().toISOString()
const requestedPath = "/Applications/Fixture Alias.app/"
const bundle = {
  ...generation,
  bundleRef: "bundle:fixture",
  bundleId: "dev.meta.fixture",
  path: "/Applications/Fixture.app",
  device: "16777234",
  inode: "9001",
  modifiedAtNs: "1700000000000000000",
}

test("resolve связывает exact native source с runtime target authority", async () => {
  const runtime = new RuntimeCore({
    generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId },
    runtimeBuildId: "runtime-build:applications",
    nativeGeneration: generation.nativeGeneration,
    nativeSourceIdentity: {
      adapterInstanceRef: "adapter:applications",
      backendBuildId: "native-build:applications",
      nativeGeneration: generation.nativeGeneration,
    },
  })
  const native = new NativeBrokerAdapter({
    adapterInstanceRef: "adapter:applications",
    host: {
      generation: runtime.generation,
      runtimeBuildId: "runtime-build:applications",
      capabilities: capabilitySetSchema.parse({
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "fixture:applications",
        capabilities: [],
      }),
    },
    transport: new ResolveTransport(),
    ledgerSink: { async persist() { throw new Error("ledger не ожидался") } },
    bindEvidence: createRuntimeNativeEvidenceBinder(runtime.evidence),
  })
  await native.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake:applications",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-build:applications",
    expectedNativeBuildId: "native-build:applications",
    capabilitySchemaVersion: "1",
  })
  try {
    const result = await new NativeApplicationAdapter({ native, services: runtime.services }).resolve(
      { path: requestedPath, bundleId: bundle.bundleId },
      { signal: new AbortController().signal, checkpoint() {} },
    )
    expect(result.target).toEqual({ kind: "application-bundle", ref: bundle })
    expect(result.requestedPath).toBe(requestedPath)
    const resolution = await runtime.targets.resolve({
      target: result.target,
      inventoryId: result.inventoryId,
      inventoryRevision: result.inventoryRevision,
      ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
    })
    expect(resolution.target).toEqual(result.target)
    expect(resolution.nativeMapping).toBeUndefined()
  } finally {
    await native.close()
  }
})

test("resolve отклоняет foreign requestedPath до evidence publication", async () => {
  let publications = 0
  const runtime = new RuntimeCore({
    generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId },
    runtimeBuildId: "runtime-build:applications",
  })
  const native = {
    host: {
      generation: runtime.generation,
      runtimeBuildId: "runtime-build:applications",
      capabilities: capabilitySetSchema.parse({
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "fixture:foreign-path",
        capabilities: [],
      }),
    },
    generation,
    async request() {
      return {
        kind: "response",
        protocolVersion: "1",
        requestId: "response:foreign-path",
        ...generation,
        ok: true,
        result: {
          requestedPath: "/Applications/Foreign.app",
          sourceResponseRef: "source:foreign-path",
          inventoryId: "inventory:foreign-path",
          inventoryRevision: 1,
          observedAt,
          target: { kind: "application-bundle", ref: bundle },
        },
      }
    },
    evidencePublisher: {
      async publish(): Promise<VerifiedNativeEvidenceReceipt> {
        publications++
        throw new Error("foreign path не должен публиковаться")
      },
    },
  } as unknown as NativeAdapter
  await expect(new NativeApplicationAdapter({ native, services: runtime.services }).resolve(
    { path: requestedPath, bundleId: bundle.bundleId },
    { signal: new AbortController().signal, checkpoint() {} },
  )).rejects.toThrow("requested path")
  expect(publications).toBe(0)
})

test("unknown launch сохраняет candidate/status и не подтверждает cleanup", async () => {
  let requestSeen: Record<string, unknown> | undefined
  const core = new RuntimeCore({
    generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId },
    runtimeBuildId: "runtime-build:applications",
  })
  const session = core.openClient("principal:applications").session
  const context = operationContext(session)
  const candidate = {
    ...generation,
    applicationRef: "application:candidate",
    pid: 1234,
    launchedAt: observedAt,
    registrationNonce: "process:candidate",
  }
  const native = {
    host: {
      generation: core.generation,
      runtimeBuildId: "runtime-build:applications",
      capabilities: capabilitySetSchema.parse({
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "fixture:application-unknown",
        capabilities: [],
      }),
    },
    generation,
    async request(_requestSchema: unknown, request: Record<string, unknown>) {
      requestSeen = request
      const operation = request.operation as NativeExecutionContext
      return {
        kind: "response",
        protocolVersion: "1",
        requestId: request.requestId,
        ...generation,
        operationId: operation.operationId,
        ok: true,
        result: {
          value: {
            state: "unknown",
            reason: "Launch dispatch принят, terminal process identity не подтверждена",
            candidate,
            errors: [{
              code: "operation-outcome-unknown",
              message: "Process confirmation unavailable",
              stage: "native-application-launch",
              retryable: false,
              replayAllowed: false,
              recoveryAction: "get-operation",
            }],
          },
          status: statusFor(request.requestId as string, operation, "interrupted-unknown", "unknown"),
        },
      }
    },
    evidencePublisher: { async publish(): Promise<VerifiedNativeEvidenceReceipt> { throw new Error("evidence не ожидался") } },
  } as unknown as NativeAdapter
  const result = await new NativeApplicationAdapter({ native, services: core.services }).launch(context, {
    bundle,
    activate: true,
    newInstance: false,
  })
  expect(requestSeen).toMatchObject({ method: "application.launch", payload: { bundle }, operation: context.wire })
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "operation-outcome-unknown",
      replayAllowed: false,
      context: { operationId: context.wire.operationId, target: { kind: "application", ref: candidate } },
    },
    outcome: { cleanup: { state: "unknown", resources: [{ outcome: "quarantined" }] } },
    nativeStatus: { execution: "interrupted-unknown", cleanup: "unknown" },
  })
})

class ResolveTransport implements NativeTransport {
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []

  async send(frame: NativeTransportRequestFrame) {
    if (frame.channel === "handshake") {
      this.push({ kind: "message", frame: { channel: "handshake", payload: {
        kind: "handshake-response",
        protocolVersion: "1",
        requestId: frame.payload.requestId,
        ...generation,
        nativeBuildId: "native-build:applications",
        capabilitySchemaVersion: "1",
        installRoot: "/tmp/native-applications-fixture",
        process: { pid: 100, startedAt: observedAt, nonce: "process:broker" },
        capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "fixture:applications", capabilities: [] },
      } } })
      return
    }
    if (frame.channel !== "request" || frame.payload.method !== "application.resolve") throw new Error("unexpected fixture request")
    this.push({ kind: "message", frame: { channel: "response", payload: {
      kind: "response",
      protocolVersion: "1",
      requestId: frame.payload.requestId,
      ...generation,
      ok: true,
      result: {
        requestedPath,
        sourceResponseRef: "source:application-resolve",
        inventoryId: "inventory:application-resolve",
        inventoryRevision: 1,
        observedAt,
        target: { kind: "application-bundle", ref: bundle },
      },
    } } })
  }

  async *packets(signal: AbortSignal) {
    while (!signal.aborted) {
      const packet = this.#packets.shift()
      if (packet !== undefined) {
        yield packet
        continue
      }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("fixture stopped"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push(value => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
    }
  }

  async close() {}

  private push(packet: NativeTransportPacket) {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#packets.push(packet)
    else waiter(packet)
  }
}

function operationContext(session: ReturnType<RuntimeCore["openClient"]>["session"]): RuntimeOperationContext<NativeExecutionContext> {
  const fence = { ...generation, counter: 1 }
  const wire = {
    kind: "native" as const,
    operationId: "operation:application-launch",
    clientRequestId: "request:application-launch",
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    ...generation,
    inventoryId: "inventory:application-resolve",
    inventoryRevision: 1,
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    target: { kind: "application-bundle" as const, ref: bundle },
    fence,
  }
  return {
    wire,
    session,
    resources: [{
      kind: "desktop-input",
      resourceRef: "desktop",
      leaseId: "lease:application-launch",
      leaseGeneration: "lease-generation:application-launch",
      operationId: wire.operationId,
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      expiresAt: wire.deadlineAt,
      state: "active",
    }],
    control: { signal: new AbortController().signal, checkpoint() {} },
  }
}

function statusFor(
  requestId: string,
  operation: NativeExecutionContext,
  execution: NativeOperationStatus["execution"],
  cleanup: NativeOperationStatus["cleanup"],
): NativeOperationStatus {
  return {
    requestId,
    ...generation,
    highWaterFence: operation.fence,
    acceptedFence: operation.fence,
    operationId: operation.operationId,
    execution,
    dispatch: "finished",
    cleanup,
    targetVerified: "verified",
    cancellationRequested: false,
    userInterference: "unknown",
    restorationAllowed: false,
    quarantined: execution === "interrupted-unknown",
    heldCount: cleanup === "complete" ? 0 : 1,
    lastCheckpoint: "application-fixture",
    dispatchAttempts: 1,
    ledgerRevision: 1,
    observer: {
      state: "unavailable",
      ...generation,
      coverageStartCursor: "cursor:applications",
      cursor: "cursor:applications",
      nextSequence: 1,
      startedAt: observedAt,
      coveredFrom: observedAt,
      coveredThrough: observedAt,
      heartbeatAt: observedAt,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "Observer fixture недоступен",
    },
  }
}
