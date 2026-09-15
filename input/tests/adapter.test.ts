import { describe, expect, test } from "bun:test"
import {
  NATIVE_PROTOCOL_VERSION,
  freezeAdapterHostContext,
  nativeOperationStatusSchema,
  type AdapterServices,
  type NativeAdapter,
  type NativeExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { DesktopInputAdapter } from "../src/adapter.ts"

const runtimeEpoch = "runtime:1"
const loginSessionId = "login:1"
const nativeGeneration = "native:1"
const now = new Date("2026-09-15T10:00:00.000Z")
const deadlineAt = "2026-09-15T10:01:00.000Z"
const windowTarget = {
  kind: "window",
  ref: {
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    applicationRef: "application:1",
    windowRef: "window:1",
  },
} as const
const fence = { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 }

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:1",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "input-adapter:1",
    capabilities: [
      { id: "input.pointer", state: "ready" },
      { id: "input.drag", state: "ready" },
      { id: "input.keyboard", state: "ready" },
      { id: "input.readiness", state: "ready" },
    ],
  },
})

const session = {
  clientSessionId: "client:1",
  principalId: "principal:1",
  runtimeEpoch,
  loginSessionId,
  authenticationGeneration: "auth:1",
  authenticatedAt: "2026-09-15T09:59:00.000Z",
  expiresAt: "2026-09-15T10:10:00.000Z",
}

const wire: NativeExecutionContext = {
  kind: "native",
  operationId: "operation:1",
  clientRequestId: "request:1",
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  inventoryId: "inventory:1",
  inventoryRevision: 4,
  deadlineAt,
  target: windowTarget,
  nativeGeneration,
  fence,
}

const resource = {
  kind: "desktop-input",
  resourceRef: "desktop",
  leaseId: "lease:1",
  leaseGeneration: "lease-generation:1",
  operationId: wire.operationId,
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  expiresAt: deadlineAt,
  state: "active",
} as const

function status(requestId: string, overrides: Record<string, unknown> = {}) {
  return nativeOperationStatusSchema.parse({
    requestId,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    highWaterFence: fence,
    acceptedFence: fence,
    operationId: wire.operationId,
    execution: "finished",
    dispatch: "finished",
    cleanup: "complete",
    targetVerified: "verified",
    cancellationRequested: false,
    userInterference: "none-observed",
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: "native.finished",
    dispatchAttempts: 1,
    ledgerRevision: 2,
    observer: {
      state: "ready",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      coverageStartCursor: "cursor:0",
      cursor: "cursor:1",
      nextSequence: 2,
      startedAt: "2026-09-15T09:59:59.000Z",
      coveredFrom: "2026-09-15T09:59:59.000Z",
      coveredThrough: "2026-09-15T10:00:00.000Z",
      heartbeatAt: "2026-09-15T10:00:00.000Z",
      coveredKinds: ["input", "focus"],
      droppedEvents: 0,
      gapDetected: false,
    },
    ...overrides,
  })
}

type NativeBehavior = {
  request?: (request: any, responseSchema: any) => Promise<any>
  status?: (request: any) => Promise<any>
}

function fixture(options: NativeBehavior & { stopAt?: string } = {}) {
  const checkpoints: string[] = []
  const nativeRequests: any[] = []
  let requestId = 0
  const context: RuntimeOperationContext<NativeExecutionContext> = {
    wire,
    session,
    resources: [resource],
    control: {
      signal: new AbortController().signal,
      checkpoint(stage) {
        checkpoints.push(stage)
        if (stage === options.stopAt) throw new DOMException("Операция отменена", "AbortError")
      },
    },
  }
  const services: AdapterServices = {
    clientSessions: { async assertActive() {} },
    resources: { async assertActive() {}, async assertOwnedSet() {} },
    cleanup: { async verify() {} },
    targets: {
      async resolve(request) {
        return {
          target: request.target,
          resolutionId: "resolution:1",
          proofRef: "proof:target-resolution",
          inventoryId: request.inventoryId,
          inventoryRevision: request.inventoryRevision,
          displayLayoutRevision: 3,
          nativeGeneration,
          nativeMapping: {
            kind: "window",
            cgWindowId: 42,
            ownerPid: 100,
            displays: [{
              nativeDisplayId: 1,
              ref: {
                runtimeEpoch,
                loginSessionId,
                nativeGeneration,
                displayRef: "display:1",
                displayLayoutRevision: 3,
              },
            }],
          },
        }
      },
    },
    proofs: { async assertValid() {} },
    evidence: {
      async issueTargetResolution() { throw new Error("не используется") },
      async issueFrameFreshness() { throw new Error("не используется") },
      async issueWindowCorrelation() { throw new Error("не используется") },
      async issueInteractionPoint() { throw new Error("не используется") },
    },
    frames: { async publish() {} },
    observations: { async resolvePoint() { throw new Error("keyboard fixture не использует observation") } },
    continuations: {
      async issue() { throw new Error("не используется") },
      async registerAcceptedTask() { throw new Error("не используется") },
      async advanceVerifiedStatus() { throw new Error("не используется") },
      async markVerifiedTerminal() { throw new Error("не используется") },
    },
    reservations: { async assertChild() { throw new Error("не используется") } },
  }
  const native = {
    host,
    generation: { runtimeEpoch, loginSessionId, nativeGeneration },
    ledgerSink: { async persist() { throw new Error("не используется") } },
    evidencePublisher: { async publish() { throw new Error("не используется") } },
    async handshake() { throw new Error("не используется") },
    async request(_requestSchema: any, request: any, responseSchema: any) {
      nativeRequests.push(request)
      if (options.request !== undefined) return await options.request(request, responseSchema)
      const nativeStatus = status(request.requestId)
      return responseSchema.parse({
        kind: "response",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        operationId: wire.operationId,
        ok: true,
        result: {
          completedSteps: 1,
          totalSteps: 1,
          dispatchAttempts: 1,
          ledgerRevision: 2,
          status: nativeStatus,
        },
      })
    },
    async heartbeat() { throw new Error("не используется") },
    async status(request: any) {
      if (options.status !== undefined) return await options.status(request)
      throw new Error("status unavailable")
    },
    async cancel() { throw new Error("не используется") },
    async drain() { throw new Error("не используется") },
    async *events() {},
    async close() {},
  } as unknown as NativeAdapter
  return {
    adapter: new DesktopInputAdapter(host, services, native, {
      now: () => now,
      nextRequestId: (_operationId, purpose) => `native-${purpose}:${++requestId}`,
    }),
    checkpoints,
    context,
    nativeRequests,
  }
}

describe("C2 desktop input adapter", () => {
  test("передаёт outer operation и отдельный short action deadline", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, { kind: "key", key: "A", modifiers: [] })

    expect(value.nativeRequests[0]).toMatchObject({
      deadlineAt,
      operation: wire,
      payload: {
        actionDeadlineAt: "2026-09-15T10:00:05.000Z",
        action: { kind: "key", stroke: { keyCode: 0, flags: 0x0002_0000 } },
      },
    })
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "key", dispatchedUnits: 1 },
      outcome: {
        dispatch: "finished",
        targetVerified: "verified",
        observation: "unavailable",
        cleanup: { state: "complete" },
      },
      nativeStatus: { execution: "finished", ledgerRevision: 2 },
    })
  })

  test("cancel до native request даёт dispatch none", async () => {
    const value = fixture({ stopAt: "input.native-dispatch" })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(value.nativeRequests).toEqual([])
    expect(result).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
      outcome: { dispatch: "none", cleanup: { state: "complete" } },
    })
  })

  test("cancel во время request сохраняет коррелированный native status", async () => {
    const value = fixture({
      async request() {
        throw new DOMException("Операция отменена", "AbortError")
      },
      async status(request) {
        return status(request.requestId, {
          execution: "cancelled",
          dispatch: "partial",
          cleanup: "complete",
          cancellationRequested: true,
          lastCheckpoint: "native.cancelled",
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
      outcome: { dispatch: "partial", cleanup: { state: "complete" } },
      nativeStatus: { execution: "cancelled", cancellationRequested: true },
    })
  })

  test("потеря request и status даёт unknown без blind replay", async () => {
    const value = fixture({
      async request() { throw new Error("transport disconnected") },
      async status() { throw new Error("status disconnected") },
    })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown", replayAllowed: false },
      outcome: { dispatch: "unknown", cleanup: { state: "unknown" } },
    })
    expect("nativeStatus" in result).toBe(false)
  })

  test("active native status не освобождает desktop lease", async () => {
    const value = fixture({
      async request() { throw new Error("transport timeout") },
      async status(request) {
        return status(request.requestId, {
          execution: "dispatching",
          dispatch: "attempted",
          cleanup: "complete",
          lastCheckpoint: "native.event.1",
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-in-progress" },
      outcome: { dispatch: "attempted", cleanup: { state: "unknown" } },
      nativeStatus: { execution: "dispatching" },
    })
  })

  test("partial inline status не становится успешным RPC result", async () => {
    const value = fixture({
      async request(request, responseSchema) {
        const nativeStatus = status(request.requestId, { dispatch: "partial" })
        return responseSchema.parse({
          kind: "response",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          requestId: request.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          operationId: wire.operationId,
          ok: true,
          result: {
            completedSteps: 1,
            totalSteps: 2,
            dispatchAttempts: 1,
            ledgerRevision: 2,
            status: nativeStatus,
          },
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "shortcut", shortcuts: ["cmd+l", "enter"], delayMs: 0 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown" },
      nativeStatus: { dispatch: "partial" },
    })
  })

  test("write-like text payload отсутствует в adapter result", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, { kind: "text", text: "не логировать", delayMs: 0 })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain("не логировать")
    expect(value.nativeRequests[0].payload.actionDeadlineAt).toBe("2026-09-15T10:00:30.000Z")
  })

  test("native error не может вернуть text payload в публичном результате", async () => {
    const value = fixture({
      async request(request) {
        const text = request.payload.action.clusters.map((cluster: { text: string }) => cluster.text).join("")
        throw new Error(`native rejected ${text}`)
      },
      async status() {
        throw new Error("status unavailable")
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "text", text: "очень секретный текст", delayMs: 0 })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("очень секретный текст")
  })

  test("inline status с чужим fence становится unknown без выдачи status", async () => {
    const foreignFence = { ...fence, counter: 2 }
    const value = fixture({
      async request(request, responseSchema) {
        const nativeStatus = status(request.requestId, {
          highWaterFence: foreignFence,
          acceptedFence: foreignFence,
        })
        return responseSchema.parse({
          kind: "response",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          requestId: request.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          operationId: wire.operationId,
          ok: true,
          result: {
            completedSteps: 1,
            totalSteps: 1,
            dispatchAttempts: 1,
            ledgerRevision: 2,
            status: nativeStatus,
          },
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown" },
      outcome: { cleanup: { state: "unknown" } },
    })
    expect("nativeStatus" in result).toBe(false)
  })

  test("reconciled status с чужим fence не считается authority", async () => {
    const foreignFence = { ...fence, counter: 2 }
    const value = fixture({
      async request() { throw new Error("transport lost") },
      async status(request) {
        return status(request.requestId, {
          highWaterFence: foreignFence,
          acceptedFence: foreignFence,
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "key", key: "enter", modifiers: [] })

    expect(result).toMatchObject({ ok: false, outcome: { dispatch: "unknown", cleanup: { state: "unknown" } } })
    expect("nativeStatus" in result).toBe(false)
  })

  test("redacts typed payload из structured response error и reconciled status error", async () => {
    const secret = "секрет-в-ошибке"
    const value = fixture({
      async request(request, responseSchema) {
        return responseSchema.parse({
          kind: "response",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          requestId: request.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          operationId: wire.operationId,
          ok: false,
          error: {
            code: "invalid-request",
            message: `rejected ${secret}`,
            stage: "native-input",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "none",
          },
        })
      },
      async status(request) {
        return status(request.requestId, {
          execution: "failed",
          dispatch: "none",
          targetVerified: "unknown",
          dispatchAttempts: 0,
          error: {
            code: "invalid-request",
            message: `status rejected ${secret}`,
            stage: "native-input",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "none",
          },
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "text", text: secret, delayMs: 0 })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result).toMatchObject({ nativeStatus: { error: { message: "Native text input завершился ошибкой; payload исключён из результата" } } })
  })

  test("redacts typed payload из inline native status error", async () => {
    const secret = "секрет-в-inline-status"
    const value = fixture({
      async request(request, responseSchema) {
        const nativeStatus = status(request.requestId, {
          dispatch: "partial",
          error: {
            code: "operation-outcome-unknown",
            message: `inline status leaked ${secret}`,
            stage: "native-input",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "get-operation",
          },
        })
        return responseSchema.parse({
          kind: "response",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          requestId: request.requestId,
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          operationId: wire.operationId,
          ok: true,
          result: {
            completedSteps: 1,
            totalSteps: 2,
            dispatchAttempts: 1,
            ledgerRevision: 2,
            status: nativeStatus,
          },
        })
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "text", text: secret, delayMs: 0 })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("known shortcut delays должны помещаться в оставшийся operation budget", async () => {
    const value = fixture()
    value.context.wire = { ...wire, deadlineAt: "2026-09-15T10:00:00.100Z" }
    const result = await value.adapter.execute(value.context, {
      kind: "shortcut",
      shortcuts: ["cmd+l", "enter"],
      delayMs: 4_000,
    })

    expect(value.nativeRequests).toEqual([])
    expect(result).toMatchObject({ ok: false, error: { code: "deadline-exceeded" }, outcome: { dispatch: "none" } })
  })
})
