import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createFixtureDeferred } from "./fixtures/deferred"

const mcpPackageDirectory = resolve(import.meta.dir, "../../mcp")
const runtimePackageEntry = Bun.resolveSync("@meta/runtime", mcpPackageDirectory)
const contractsPackageEntry = Bun.resolveSync(
  "@meta/shared/contracts",
  mcpPackageDirectory
)
const { RuntimeCore } = await import(runtimePackageEntry)
const {
  capabilitySetSchema,
  freezeAdapterHostContext,
  operationOutcomeSchema,
  runtimeOperationIntentSchema
} = await import(contractsPackageEntry)

const generation = {
  runtimeEpoch: "runtime-acceptance",
  loginSessionId: "login-acceptance"
}
const nativeGeneration = "native-acceptance"
const windowTarget = {
  kind: "window" as const,
  ref: {
    ...generation,
    nativeGeneration,
    applicationRef: "application-acceptance",
    windowRef: "window-acceptance"
  }
}

function completeOutcome(
  handles: readonly Record<string, unknown>[],
  dispatch: "none" | "finished",
  restoration: "unknown" | "not-applicable"
) {
  return operationOutcomeSchema.parse({
    dispatch,
    targetVerified: dispatch === "none" ? "unknown" : "verified",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: handles.length === 0
      ? { scope: "none", state: "complete", resources: [] }
      : {
          scope: "owned",
          state: "complete",
          resources: handles.map((handle) => ({ handle, outcome: "released" }))
        },
    restoration,
    dispatchAttempts: dispatch === "none" ? 0 : 1
  })
}

function nativeStatus(
  wire: Record<string, any>,
  execution: "finished" | "cancelled",
  dispatch: "none" | "finished"
) {
  const now = new Date().toISOString()
  return {
    requestId: `native-status:${wire.operationId}`,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    nativeGeneration: wire.nativeGeneration,
    highWaterFence: wire.fence,
    acceptedFence: wire.fence,
    operationId: wire.operationId,
    execution,
    dispatch,
    cleanup: "complete" as const,
    targetVerified: dispatch === "none" ? "unknown" as const : "verified" as const,
    cancellationRequested: execution === "cancelled",
    userInterference: "unknown" as const,
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: execution,
    dispatchAttempts: dispatch === "none" ? 0 : 1,
    ledgerRevision: 1,
    observer: {
      state: "unavailable" as const,
      runtimeEpoch: wire.runtimeEpoch,
      loginSessionId: wire.loginSessionId,
      nativeGeneration: wire.nativeGeneration,
      coverageStartCursor: "observer-start",
      cursor: "observer-current",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: true,
      reason: "Acceptance adapter не наблюдает live events"
    }
  }
}

class ControlledNativeAdapter {
  readonly host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "runtime-build-acceptance",
    capabilities: capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "native-adapter-acceptance",
      capabilities: [{ id: "runtime.identity", state: "ready" }]
    })
  })
  readonly generation = { ...generation, nativeGeneration }
  readonly ledgerSink = {
    async persist() {
      throw new Error("Ledger sink не используется этим runtime integration")
    }
  }
  readonly evidencePublisher = {
    async publish() {
      throw new Error("Evidence publisher не используется этим runtime integration")
    }
  }
  mode: "complete" | "controlled-cancel" | "hang" = "complete"
  dispatches = 0
  active = 0
  maxActive = 0
  cancelCalls = 0
  statusCalls = 0
  signalObserved = false
  lastStatus?: ReturnType<typeof nativeStatus>
  readonly started = createFixtureDeferred<void>()
  readonly cancelAcknowledgement = createFixtureDeferred<void>()

  async dispatch(context: Record<string, any>) {
    if (context.wire.kind !== "native") throw new Error("Ожидался native context")
    this.dispatches += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.started.resolve()
    try {
      await context.control.checkpoint("acceptance-before-native")
      if (this.mode === "controlled-cancel") {
        await new Promise<void>((done) => {
          const onAbort = () => {
            this.signalObserved = true
            done()
          }
          if (context.control.signal.aborted) onAbort()
          else context.control.signal.addEventListener("abort", onAbort, { once: true })
        })
        await this.cancelAcknowledgement.promise
        this.lastStatus = nativeStatus(context.wire, "cancelled", "none")
        return {
          ok: false as const,
          error: {
            code: "cancelled" as const,
            message: "Acceptance dispatch отменён",
            stage: "acceptance-native",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "none" as const
          },
          outcome: completeOutcome(context.resources, "none", "unknown"),
          nativeStatus: this.lastStatus
        }
      }
      if (this.mode === "hang") {
        context.control.signal.addEventListener(
          "abort",
          () => { this.signalObserved = true },
          { once: true }
        )
        await new Promise<void>(() => {})
      }
      this.lastStatus = nativeStatus(context.wire, "finished", "finished")
      return {
        ok: true as const,
        value: { delivered: true },
        outcome: completeOutcome(context.resources, "finished", "not-applicable"),
        nativeStatus: this.lastStatus
      }
    } finally {
      this.active -= 1
    }
  }

  async handshake(): Promise<never> {
    throw new Error("Handshake не используется этим runtime integration")
  }

  async request(): Promise<never> {
    throw new Error("Raw request не используется этим runtime integration")
  }

  async heartbeat(): Promise<never> {
    throw new Error("Heartbeat не используется этим runtime integration")
  }

  async status(request: Record<string, any>) {
    this.statusCalls += 1
    if (this.lastStatus === undefined) throw new Error("Native status ещё неизвестен")
    return { ...this.lastStatus, requestId: request.requestId }
  }

  async cancel(request: Record<string, any>) {
    this.cancelCalls += 1
    if (this.mode !== "complete") await this.cancelAcknowledgement.promise
    return {
      requestId: request.requestId,
      operationId: request.operationId,
      runtimeEpoch: request.runtimeEpoch,
      loginSessionId: request.loginSessionId,
      nativeGeneration: request.nativeGeneration,
      fence: request.fence,
      acknowledged: true,
      stopped: true,
      cleanup: "complete" as const,
      ledgerRevision: 1,
      lastCheckpoint: "acceptance-cancel",
      quarantined: false
    }
  }

  async drain(): Promise<never> {
    throw new Error("Drain не используется этим runtime integration")
  }

  async *events(): AsyncIterable<never> {}

  async close(): Promise<void> {}
}

function createRuntime(native: ControlledNativeAdapter, cancelGraceMs = 50) {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build-acceptance",
    nativeGeneration,
    native,
    cancelGraceMs,
    secret: new Uint8Array(32).fill(17)
  })
  runtime.targets.register(
    windowTarget,
    "inventory-acceptance",
    1,
    "resolution-acceptance",
    "proof-acceptance",
    1,
    { kind: "window", cgWindowId: 42, ownerPid: 123, displays: [] }
  )
  return runtime
}

function intent(clientRequestId: string, deadlineMs = 5_000) {
  return runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId,
    precondition: {
      target: windowTarget,
      inventoryId: "inventory-acceptance",
      inventoryRevision: 1
    },
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }]
  })
}

describe("real @meta/runtime in-process acceptance", () => {
  test("A03/A05/A11: resource остаётся занят до cancel ACK, resume дедуплицирует lost reply", async () => {
    const native = new ControlledNativeAdapter()
    native.mode = "controlled-cancel"
    const runtime = createRuntime(native)
    const first = runtime.openClient("principal-first")
    const second = runtime.openClient("principal-second")
    const requestIntent = intent("request-lost-reply")
    const secretPayload = { text: "секретный acceptance payload" }
    const lostReply = runtime.runOperation(
      first.session,
      requestIntent,
      secretPayload,
      (context: Record<string, any>) => native.dispatch(context)
    )
    await native.started.promise

    await expect(runtime.runOperation(
      second.session,
      intent("request-competing-before-disconnect"),
      { click: [3, 4] },
      (context: Record<string, any>) => native.dispatch(context)
    )).rejects.toThrow("Resource занят")

    runtime.disconnectClient(first.session.clientSessionId)
    await Promise.resolve()
    await expect(runtime.runOperation(
      second.session,
      intent("request-competing-before-ack"),
      { click: [5, 6] },
      (context: Record<string, any>) => native.dispatch(context)
    )).rejects.toThrow("Resource занят")

    native.cancelAcknowledgement.resolve()
    const cancelled = await lostReply
    const resumed = runtime.clients.resume(first.resumptionToken)
    const repeated = await runtime.runOperation(
      resumed.session,
      requestIntent,
      secretPayload,
      (context: Record<string, any>) => native.dispatch(context)
    )

    expect(cancelled.operation.state).toBe("cancelled")
    expect(repeated.operation.context.operationId).toBe(
      cancelled.operation.context.operationId
    )
    expect(JSON.stringify(repeated.operation)).not.toContain(secretPayload.text)
    expect(JSON.stringify(repeated.operation)).toContain("hmacSha256")
    expect(native.dispatches).toBe(1)
    expect(native.maxActive).toBe(1)
    await expect(runtime.runOperation(
      resumed.session,
      requestIntent,
      { text: "другой payload" },
      (context: Record<string, any>) => native.dispatch(context)
    )).rejects.toMatchObject({
      contract: { code: "request-payload-mismatch" }
    })

    native.mode = "complete"
    const next = await runtime.runOperation(
      second.session,
      intent("request-after-confirmed-cleanup"),
      { click: [7, 8] },
      (context: Record<string, any>) => native.dispatch(context)
    )
    expect(next.operation.state).toBe("completed")
    expect(native.dispatches).toBe(2)
  })

  test("A05/A42: deadline зависшего adapter bounded и оставляет resource quarantined", async () => {
    const native = new ControlledNativeAdapter()
    native.mode = "hang"
    const runtime = createRuntime(native, 20)
    const first = runtime.openClient("principal-hung")
    const second = runtime.openClient("principal-after-hung")
    const secretPayload = { text: "plaintext не должен попасть в journal" }
    const startedAt = performance.now()

    const execution = await runtime.runOperation(
      first.session,
      intent("request-hung", 20),
      secretPayload,
      (context: Record<string, any>) => native.dispatch(context)
    )

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(native.signalObserved).toBe(true)
    expect(native.cancelCalls).toBe(1)
    expect(execution.operation.state).toBe("interrupted-unknown")
    expect(execution.operation.outcome.cleanup.state).toBe("unknown")
    expect(runtime.resources.handlesForOperation(
      execution.operation.context.operationId
    )).toMatchObject([{ state: "quarantined" }])
    expect(JSON.stringify(execution.operation)).not.toContain(secretPayload.text)

    await expect(runtime.runOperation(
      second.session,
      intent("request-after-hung"),
      { click: true },
      (context: Record<string, any>) => native.dispatch(context)
    )).rejects.toThrow("quarantined")
    expect(native.dispatches).toBe(1)
  })
})
