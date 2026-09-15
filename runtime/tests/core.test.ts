import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  freezeAdapterHostContext,
  operationOutcomeSchema,
  nativeEvidenceReportSchema,
  runtimeOperationIntentSchema,
  type AdapterResult,
  type NativeAdapter,
  type NativeCancelRequest,
  type NativeExecutionContext,
  type NativeStatusRequest,
  type RuntimeOperationContext,
  type OperationOutcome,
  type RuntimeResourceHandle,
  type z,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import type { RuntimeCoreOptions } from "../src/core.ts"

const generation = { runtimeEpoch: "runtime:test", loginSessionId: "login:test" }
const nativeGeneration = "native:test"
const windowTarget = {
  kind: "window" as const,
  ref: {
    ...generation,
    nativeGeneration,
    applicationRef: "application:test",
    windowRef: "window:test",
  },
}
const browserTarget = {
  kind: "browser-target" as const,
  ref: {
    ...generation,
    browserInstanceRef: "browser:test",
    transportGeneration: "browser-transport:test",
    targetId: "browser-target:test",
    resourceRef: "browser-resource:test",
  },
}

class FakeNativeAdapter implements NativeAdapter {
  readonly adapterInstanceRef = "native-adapter:continuation"
  readonly loadedBuildId = "native-build:continuation"
  readonly host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "runtime-build:test",
    capabilities: capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "native-adapter:test",
      capabilities: [{ id: "runtime.identity", state: "ready" }],
    }),
  })
  readonly generation = { ...generation, nativeGeneration }
  readonly ledgerSink = {
    async persist() {
      throw new Error("ledger не используется в этом fake")
    },
  }
  readonly evidencePublisher = {
    async publish() {
      throw new Error("evidence не используется в этом fake")
    },
  }
  active = 0
  maxActive = 0
  dispatches = 0
  lastOperationId: string | undefined
  lastWire: NativeExecutionContext | undefined
  lastReportedStatus: ReturnType<typeof nativeStatus> | undefined
  cancelCalls = 0
  statusCalls = 0
  statusMode: "normal" | "block" = "normal"
  mode: "complete" | "block" | "cancel" | "throw" | "hang" = "complete"
  signalObserved = false
  #release: (() => void) | undefined
  #started: (() => void) | undefined
  #releaseStatuses: Array<() => void> = []
  started = new Promise<void>(resolve => { this.#started = resolve })

  async dispatch(context: RuntimeOperationContext): Promise<AdapterResult<{ delivered: true }>> {
    if (context.wire.kind !== "native") throw new Error("FakeNativeAdapter получил non-native context")
    this.dispatches++
    this.lastWire = context.wire
    this.lastOperationId = context.wire.operationId
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    this.#started?.()
    try {
      await context.control.checkpoint("native-before-event")
      if (this.mode === "block") await new Promise<void>(resolve => { this.#release = resolve })
      if (this.mode === "hang") {
        context.control.signal.addEventListener("abort", () => { this.signalObserved = true }, { once: true })
        await new Promise<void>(() => {})
      }
      if (this.mode === "cancel") {
        await new Promise<void>(resolve => {
          if (context.control.signal.aborted) return resolve()
          context.control.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        const status = nativeStatus(context.wire, "cancelled", "none")
        this.lastReportedStatus = status
        return {
          ok: false,
          error: {
            code: "cancelled",
            message: "fake dispatch отменён",
            stage: "fake-native",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "none",
          },
          outcome: completeOutcome(context.resources, "none", "cancelled"),
          nativeStatus: status,
        }
      }
      if (this.mode === "throw") throw new Error("reply lost after possible dispatch")
      const status = nativeStatus(context.wire, "finished", "finished")
      this.lastReportedStatus = status
      return {
        ok: true,
        value: { delivered: true },
        outcome: completeOutcome(context.resources, "finished", "completed"),
        nativeStatus: status,
      }
    } finally {
      this.active--
    }
  }

  release(): void {
    this.#release?.()
  }

  releaseStatus(): void {
    for (const release of this.#releaseStatuses.splice(0)) release()
  }

  async handshake(): Promise<never> { throw new Error("not used") }
  async request<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    _requestSchema: RequestSchema,
    _request: z.input<RequestSchema>,
    _responseSchema: ResponseSchema,
  ): Promise<z.output<ResponseSchema>> { throw new Error("not used") }
  async heartbeat(): Promise<never> { throw new Error("not used") }
  async status(request: NativeStatusRequest) {
    this.statusCalls++
    if (this.statusMode === "block") await new Promise<void>(resolve => { this.#releaseStatuses.push(resolve) })
    if (this.lastReportedStatus === undefined) throw new Error("Нет native operation status")
    return { ...this.lastReportedStatus, requestId: request.requestId }
  }
  async cancel(request: NativeCancelRequest) {
    this.cancelCalls++
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
      lastCheckpoint: "cancelled",
      quarantined: false,
    }
  }
  async drain(): Promise<never> { throw new Error("not used") }
  async *events(): AsyncIterable<never> {}
  async close(): Promise<void> {}
}

function completeOutcome(
  handles: readonly RuntimeResourceHandle[],
  dispatch: "none" | "finished",
  kind: "completed" | "cancelled",
) {
  return operationOutcomeSchema.parse({
    dispatch,
    targetVerified: dispatch === "none" ? "unknown" : "verified",
    userInterference: "none-observed",
    observation: "available",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: handles.length === 0
      ? { scope: "none", state: "complete", resources: [] }
      : { scope: "owned", state: "complete", resources: handles.map(handle => ({ handle, outcome: "released" })) },
    restoration: kind === "cancelled" ? "unknown" : "not-applicable",
    dispatchAttempts: dispatch === "none" ? 0 : 1,
  })
}

function nativeStatus(
  wire: NativeExecutionContext,
  execution: "finished" | "cancelled" | "failed",
  dispatch: "none" | "finished",
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
    targetVerified: "verified" as const,
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
      coverageStartCursor: "observer:start",
      cursor: "observer:current",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: true,
      reason: "fake observer unavailable",
    },
  }
}

function createRuntime(
  native = new FakeNativeAdapter(),
  options: Partial<RuntimeCoreOptions> = {},
) {
  const runtime = new RuntimeCore({
      generation,
      runtimeBuildId: "runtime-build:test",
      nativeGeneration,
      native,
      secret: new Uint8Array(32).fill(7),
      nativeSourceIdentity: {
        adapterInstanceRef: native.adapterInstanceRef,
        backendBuildId: native.loadedBuildId,
        nativeGeneration,
      },
      ...options,
    })
  runtime.targets.register(
    windowTarget,
    "inventory:test",
    1,
    "resolution:window:test",
    "proof:window:test",
    1,
    { kind: "window", cgWindowId: 10, ownerPid: 20, displays: [] },
  )
  return { native, runtime }
}

function intent(clientRequestId: string, deadlineAt = new Date(Date.now() + 30_000).toISOString()) {
  return runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId,
    precondition: {
      target: windowTarget,
      inventoryId: "inventory:test",
      inventoryRevision: 1,
    },
    deadlineAt,
    requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
  })
}

describe("RuntimeCore operations", () => {
  test("два клиента не выполняют desktop dispatch одновременно", async () => {
    const { runtime, native } = createRuntime()
    native.mode = "block"
    const first = runtime.openClient("principal:first")
    const second = runtime.openClient("principal:second")
    const firstRun = runtime.runOperation(first.session, intent("request:first"), { click: [1, 2] }, context => native.dispatch(context))
    await native.started
    await expect(runtime.runOperation(
      second.session,
      intent("request:second"),
      { click: [3, 4] },
      context => native.dispatch(context),
    )).rejects.toThrow("Resource занят")
    native.release()
    const firstResult = await firstRun
    expect(firstResult.operation.state).toBe("completed")
    expect(native.maxActive).toBe(1)
  })

  test("reply loss и reconnect возвращают ту же operation без повторного dispatch", async () => {
    const { runtime, native } = createRuntime()
    const first = runtime.openClient("principal:one")
    const requestIntent = intent("request:dedup")
    const payload = { text: "секретный текст" }
    const firstResult = await runtime.runOperation(first.session, requestIntent, payload, context => native.dispatch(context))
    const resumed = runtime.clients.resume(first.resumptionToken)
    const repeated = await runtime.runOperation(resumed.session, requestIntent, payload, context => native.dispatch(context))
    expect(repeated.operation.context.operationId).toBe(firstResult.operation.context.operationId)
    expect(native.dispatches).toBe(1)
    expect(JSON.stringify(repeated.operation)).not.toContain(payload.text)
    expect(JSON.stringify(repeated.operation)).toContain("hmacSha256")
    const unrelated = runtime.openClient("principal:one")
    await expect(runtime.getOperation(unrelated.session, repeated.operation.context.operationId)).rejects.toMatchObject({
      contract: { code: "unauthorized" },
    })
    await expect(runtime.cancelOperation(
      unrelated.session,
      repeated.operation.context.operationId,
      "foreign lineage",
    )).rejects.toMatchObject({ contract: { code: "unauthorized" } })
    runtime.targets.remove(windowTarget)
    const expiredRetry = await runtime.runOperation(
      resumed.session,
      intent("request:dedup", new Date(Date.now() - 1_000).toISOString()),
      payload,
      context => native.dispatch(context),
    )
    expect(expiredRetry.operation.context.operationId).toBe(firstResult.operation.context.operationId)
    expect(native.dispatches).toBe(1)
  })

  test("тот же clientRequestId с другим payload отклоняется", async () => {
    const { runtime, native } = createRuntime()
    const client = runtime.openClient("principal:one")
    const requestIntent = intent("request:mismatch")
    await runtime.runOperation(client.session, requestIntent, { text: "one" }, context => native.dispatch(context))
    await expect(runtime.runOperation(
      client.session,
      requestIntent,
      { text: "two" },
      context => native.dispatch(context),
    )).rejects.toMatchObject({ contract: { code: "request-payload-mismatch" } })
  })

  test("dedup tuple не смешивает colon-containing principal/request identities", async () => {
    const { runtime, native } = createRuntime()
    const first = runtime.openClient("principal:a")
    const second = runtime.openClient("principal:a:b")
    const firstResult = await runtime.runOperation(first.session, intent("b:c"), { same: true }, context => native.dispatch(context))
    const secondResult = await runtime.runOperation(second.session, intent("c"), { same: true }, context => native.dispatch(context))
    expect(secondResult.operation.context.operationId).not.toBe(firstResult.operation.context.operationId)
    expect(secondResult.operation.principalId).toBe("principal:a:b")
    expect(native.dispatches).toBe(2)
  })

  test("cancel прерывает fake native на checkpoint и освобождает resource только после ACK result", async () => {
    const { runtime, native } = createRuntime()
    native.mode = "cancel"
    const client = runtime.openClient("principal:one")
    const running = runtime.runOperation(client.session, intent("request:cancel"), { key: "a" }, context => native.dispatch(context))
    await native.started
    if (native.lastOperationId === undefined) throw new Error("Fake native не получил operation")
    await runtime.cancelOperation(client.session, native.lastOperationId, "test cancel")
    const result = await running
    expect(result.operation.state).toBe("cancelled")
    expect(result.operation.outcome.cleanup.state).toBe("complete")
    expect(runtime.resources.handlesForOperation(result.operation.context.operationId)).toHaveLength(0)
  })

  test("exception с неизвестной delivery quarantines resource и запрещает следующий dispatch", async () => {
    const { runtime, native } = createRuntime()
    native.mode = "throw"
    const client = runtime.openClient("principal:one")
    const result = await runtime.runOperation(client.session, intent("request:unknown"), { click: true }, context => native.dispatch(context))
    expect(result.operation.state).toBe("interrupted-unknown")
    expect(result.operation.outcome.cleanup.state).toBe("unknown")
    expect(result.result.ok).toBe(false)
    native.mode = "complete"
    await expect(runtime.runOperation(
      client.session,
      intent("request:after-unknown"),
      { click: true },
      context => native.dispatch(context),
    )).rejects.toThrow("quarantined")
    if (native.lastWire === undefined) throw new Error("Нет native context для reconciliation")
    const cleanup = {
      scope: "owned" as const,
      state: "complete" as const,
      resources: result.operation.resources.map(handle => ({ handle, outcome: "released" as const })),
    }
    const reconciledStatus = nativeStatus(native.lastWire, "failed", "finished")
    const resource = result.operation.resources[0]
    if (resource === undefined || result.operation.context.kind !== "native") throw new Error("Нет native resource для continuation")
    const binding = {
      adapterInstanceRef: "native-adapter:continuation",
      backendBuildId: "native-build:continuation",
      nativeGeneration,
    }
    runtime.evidence.registerSourceExtractor(binding, extractEvidence)
    const evidencePublisher = runtime.evidence.bind(binding)
    const startReport = nativeEvidenceReportSchema.parse({
      factKind: "capture-task-start",
      sourceResponseRef: "native-response:capture-start",
      inventoryId: result.operation.context.inventoryId,
      inventoryRevision: result.operation.context.inventoryRevision,
      displayLayoutRevision: 0,
      observedAt: new Date().toISOString(),
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      acceptedFence: result.operation.context.fence,
      statusRevision: 1,
      statusEvidenceRef: "capture-status:start:1",
    })
    runtime.evidence.registerSourceResponse(
      binding,
      "native-response:capture-start",
      new TextEncoder().encode(JSON.stringify(startReport)),
    )
    const startReceipt = await evidencePublisher.publish(startReport)
    await runtime.continuations.registerAcceptedTask({
      receipt: startReceipt,
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      resourceLeaseId: resource.leaseId,
      acceptedFence: result.operation.context.fence,
      statusRevision: 1,
      statusEvidenceRef: "capture-status:start:1",
    })
    for (const revision of [2, 3]) {
      const sourceResponseRef = `native-response:capture-status:${revision}`
      const statusEvidenceRef = `capture-status:pending:${revision}`
      const statusReport = nativeEvidenceReportSchema.parse({
        factKind: "capture-task-status",
        sourceResponseRef,
        inventoryId: result.operation.context.inventoryId,
        inventoryRevision: result.operation.context.inventoryRevision,
        displayLayoutRevision: 0,
        observedAt: new Date().toISOString(),
        operationId: result.operation.context.operationId,
        taskRef: "capture-task:unknown",
        acceptedFence: result.operation.context.fence,
        statusRevision: revision,
        statusEvidenceRef,
        cleanup: "unknown",
        drained: false,
      })
      runtime.evidence.registerSourceResponse(binding, sourceResponseRef, new TextEncoder().encode(JSON.stringify(statusReport)))
      const statusReceipt = await evidencePublisher.publish(statusReport)
      const advance = {
        receipt: statusReceipt,
        operationId: result.operation.context.operationId,
        taskRef: "capture-task:unknown",
        acceptedFence: result.operation.context.fence,
        statusRevision: revision,
        statusEvidenceRef,
        cleanup: "unknown" as const,
        drained: false,
      }
      await runtime.continuations.advanceVerifiedStatus(advance)
      if (revision === 3) {
        await runtime.continuations.advanceVerifiedStatus(advance)
        const conflictReport = nativeEvidenceReportSchema.parse({
          ...statusReport,
          sourceResponseRef: "native-response:capture-status:3-conflict",
          statusEvidenceRef: "capture-status:pending:3-conflict",
        })
        runtime.evidence.registerSourceResponse(
          binding,
          conflictReport.sourceResponseRef,
          new TextEncoder().encode(JSON.stringify(conflictReport)),
        )
        const conflictReceipt = await evidencePublisher.publish(conflictReport)
        await expect(runtime.continuations.advanceVerifiedStatus({
          ...advance,
          receipt: conflictReceipt,
          statusEvidenceRef: conflictReport.factKind === "capture-task-status"
            ? conflictReport.statusEvidenceRef
            : "unreachable",
        })).rejects.toThrow("equal revision")
      }
    }
    const terminalReport = nativeEvidenceReportSchema.parse({
      factKind: "capture-task-terminal",
      sourceResponseRef: "native-response:capture-terminal",
      inventoryId: result.operation.context.inventoryId,
      inventoryRevision: result.operation.context.inventoryRevision,
      displayLayoutRevision: 0,
      observedAt: new Date().toISOString(),
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      acceptedFence: result.operation.context.fence,
      statusRevision: 4,
      drainedEvidenceRef: "drained-evidence:1",
      terminalReceiptRef: "native-terminal-receipt:1",
      cleanup: "complete",
      drained: true,
    })
    runtime.evidence.registerSourceResponse(
      binding,
      "native-response:capture-terminal",
      new TextEncoder().encode(JSON.stringify(terminalReport)),
    )
    const terminalReceipt = await evidencePublisher.publish(terminalReport)
    const crossOperationReport = nativeEvidenceReportSchema.parse({
      ...terminalReport,
      sourceResponseRef: "native-response:capture-terminal-cross-operation",
      operationId: "operation:foreign",
    })
    runtime.evidence.registerSourceResponse(
      binding,
      crossOperationReport.sourceResponseRef,
      new TextEncoder().encode(JSON.stringify(crossOperationReport)),
    )
    const crossOperationReceipt = await evidencePublisher.publish(crossOperationReport)
    if (crossOperationReport.factKind !== "capture-task-terminal") throw new Error("fixture terminal expected")
    await expect(runtime.continuations.markVerifiedTerminal({
      receipt: crossOperationReceipt,
      operationId: crossOperationReport.operationId,
      taskRef: crossOperationReport.taskRef,
      acceptedFence: crossOperationReport.acceptedFence,
      statusRevision: crossOperationReport.statusRevision,
      drainedEvidenceRef: crossOperationReport.drainedEvidenceRef,
      terminalReceiptRef: crossOperationReport.terminalReceiptRef!,
    })).rejects.toThrow("другой binding")
    await runtime.continuations.markVerifiedTerminal({
      receipt: terminalReceipt,
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      acceptedFence: result.operation.context.fence,
      statusRevision: 4,
      drainedEvidenceRef: "drained-evidence:1",
      terminalReceiptRef: "native-terminal-receipt:1",
    })
    const terminalConflictReport = nativeEvidenceReportSchema.parse({
      ...terminalReport,
      sourceResponseRef: "native-response:capture-terminal-conflict",
      drainedEvidenceRef: "drained-evidence:conflict",
      terminalReceiptRef: "native-terminal-receipt:conflict",
    })
    runtime.evidence.registerSourceResponse(
      binding,
      terminalConflictReport.sourceResponseRef,
      new TextEncoder().encode(JSON.stringify(terminalConflictReport)),
    )
    const terminalConflictReceipt = await evidencePublisher.publish(terminalConflictReport)
    if (terminalConflictReport.factKind !== "capture-task-terminal") throw new Error("fixture terminal expected")
    await expect(runtime.continuations.markVerifiedTerminal({
      receipt: terminalConflictReceipt,
      operationId: terminalConflictReport.operationId,
      taskRef: terminalConflictReport.taskRef,
      acceptedFence: terminalConflictReport.acceptedFence,
      statusRevision: terminalConflictReport.statusRevision,
      drainedEvidenceRef: terminalConflictReport.drainedEvidenceRef,
      terminalReceiptRef: terminalConflictReport.terminalReceiptRef!,
    })).rejects.toThrow("conflicting repeated facts")
    await runtime.continuations.markVerifiedTerminal({
      receipt: terminalReceipt,
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      acceptedFence: result.operation.context.fence,
      statusRevision: 4,
      drainedEvidenceRef: "drained-evidence:1",
      terminalReceiptRef: "native-terminal-receipt:1",
    })
    await expect(runtime.reconcileCleanup({
      operationId: result.operation.context.operationId,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration,
      revision: 1,
      cleanup,
      nativeStatus: reconciledStatus,
    })).rejects.toThrow("runtime status query")
    native.lastReportedStatus = reconciledStatus
    const receipt = await runtime.reconcileCleanup({
      operationId: result.operation.context.operationId,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration,
      revision: 1,
      cleanup,
      nativeStatus: reconciledStatus,
    })
    expect(receipt.operationId).toBe(result.operation.context.operationId)
    expect(runtime.resources.handlesForOperation(result.operation.context.operationId)).toHaveLength(0)
    expect((await runtime.getOperation(client.session, result.operation.context.operationId))?.outcome.cleanup.state).toBe("complete")
    const lateRelease = await runtime.continuations.issue({
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      purpose: "release",
      expectedRevision: 4,
      requestedDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    })
    expect(Date.parse(lateRelease.cleanupControl.deadlineAt) - Date.now()).toBeLessThanOrEqual(1_000)
    expect(lateRelease.cleanupControl.acceptedFence).toEqual(result.operation.context.fence)
    const retryContinuation = await runtime.continuations.issue({
      operationId: result.operation.context.operationId,
      taskRef: "capture-task:unknown",
      purpose: "release",
      expectedRevision: 4,
    })
    expect(retryContinuation.cleanupControl.cleanupRequestId).toBe(lateRelease.cleanupControl.cleanupRequestId)
    expect(retryContinuation.cleanupControl.requestId).not.toBe(lateRelease.cleanupControl.requestId)
    const duplicateReceipt = await runtime.reconcileCleanup({
      operationId: result.operation.context.operationId,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration,
      revision: 1,
      cleanup,
      nativeStatus: reconciledStatus,
    })
    expect(duplicateReceipt.receiptId).toBe(receipt.receiptId)
    await expect(runtime.reconcileCleanup({
      operationId: result.operation.context.operationId,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration,
      revision: 1,
      cleanup: { ...cleanup, resources: [] },
      nativeStatus: reconciledStatus,
    })).rejects.toThrow("другие facts")
    const afterReconcile = await runtime.runOperation(
      client.session,
      intent("request:after-reconcile"),
      { click: true },
      context => native.dispatch(context),
    )
    expect(afterReconcile.operation.state).toBe("completed")
  })

  test("invalid AdapterResult валидируется до cleanup mutation и оставляет resource quarantined", async () => {
    const { runtime, native } = createRuntime()
    const client = runtime.openClient("principal:invalid-result")
    let operationId = ""
    const execution = await runtime.runOperation(
      client.session,
      intent("request:invalid-result"),
      { click: true },
      async context => {
        if (context.wire.kind !== "native") throw new Error("expected native")
        operationId = context.wire.operationId
        const base = completeOutcome(context.resources, "finished", "completed")
        const status = nativeStatus(context.wire, "finished", "finished")
        native.lastReportedStatus = status
        return {
          ok: true,
          value: { delivered: true },
          outcome: operationOutcomeSchema.parse({
            ...base,
            targetVerified: "unknown",
            effect: { state: "verified", proofRefs: ["proof:invalid"] },
          }),
          nativeStatus: status,
        }
      },
    )
    expect(execution.operation.state).toBe("interrupted-unknown")
    expect(runtime.resources.handlesForOperation(operationId)).toMatchObject([{ state: "quarantined" }])
    expect((await runtime.getOperation(client.session, operationId))?.state).toBe("interrupted-unknown")
  })

  test("deadline aborts hanging adapter, requests native stop/status and settles once after bounded grace", async () => {
    const native = new FakeNativeAdapter()
    native.mode = "hang"
    const { runtime } = createRuntime(native, { cancelGraceMs: 20 })
    const client = runtime.openClient("principal:deadline")
    const startedAt = performance.now()
    const execution = await runtime.runOperation(
      client.session,
      intent("request:deadline", new Date(Date.now() + 20).toISOString()),
      { key: "a" },
      context => native.dispatch(context),
    )
    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(native.signalObserved).toBe(true)
    expect(native.cancelCalls).toBe(1)
    expect(native.statusCalls).toBe(1)
    expect(execution.operation.state).toBe("interrupted-unknown")
    expect(execution.operation.outcome.cleanup.state).toBe("unknown")
  })

  test("hung native status finalizer is bounded and late status cannot release or overwrite", async () => {
    const native = new FakeNativeAdapter()
    native.statusMode = "block"
    const { runtime } = createRuntime(native, { cancelGraceMs: 20 })
    const client = runtime.openClient("principal:native-finalizer")
    const execution = await runtime.runOperation(
      client.session,
      intent("request:native-finalizer", new Date(Date.now() + 20).toISOString()),
      { click: true },
      context => native.dispatch(context),
    )
    expect(execution.operation.state).toBe("interrupted-unknown")
    expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toMatchObject([{ state: "quarantined" }])
    native.releaseStatus()
    await Promise.resolve()
    expect((await runtime.getOperation(client.session, execution.operation.context.operationId))?.state).toBe("interrupted-unknown")
    expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toMatchObject([{ state: "quarantined" }])
  })

  test("hung non-native completion verifier is bounded and late resolve cannot commit", async () => {
    let releaseVerifier: (() => void) | undefined
    const completionVerifier = {
      async verify() {
        await new Promise<void>(resolve => { releaseVerifier = resolve })
      },
    }
    const runtime = new RuntimeCore({
      generation,
      runtimeBuildId: "runtime-build:browser-finalizer",
      cancelGraceMs: 20,
      completionVerifier,
      secret: new Uint8Array(32).fill(8),
    })
    runtime.targets.register(
      browserTarget,
      "browser-inventory:test",
      1,
      "resolution:browser:test",
      "proof:browser:test",
      0,
    )
    const client = runtime.openClient("principal:browser-finalizer")
    const browserIntent = runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: "request:browser-finalizer",
      precondition: {
        target: browserTarget,
        inventoryId: "browser-inventory:test",
        inventoryRevision: 1,
      },
      deadlineAt: new Date(Date.now() + 20).toISOString(),
      requestedResources: [{ kind: "cdp-target", resourceRef: browserTarget.ref.resourceRef }],
    })
    const execution = await runtime.runOperation(
      client.session,
      browserIntent,
      { navigate: true },
      async context => ({
        ok: true,
        value: { navigated: true },
        outcome: completeOutcome(context.resources, "finished", "completed"),
      }),
    )
    expect(execution.operation.state).toBe("interrupted-unknown")
    releaseVerifier?.()
    await Promise.resolve()
    expect((await runtime.getOperation(client.session, execution.operation.context.operationId))?.state).toBe("interrupted-unknown")
    expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toMatchObject([{ state: "quarantined" }])
  })

  test("failure до adapter entry остаётся dispatch none и безопасно освобождает lease", async () => {
    const baseTime = Date.now()
    let clockCalls = 0
    const clock = {
      now() {
        clockCalls++
        return new Date(clockCalls <= 5 ? baseTime : baseTime + 2_000)
      },
    }
    const native = new FakeNativeAdapter()
    const { runtime } = createRuntime(native, { clock })
    const client = runtime.openClient("principal:predispatch")
    const execution = await runtime.runOperation(
      client.session,
      intent("request:predispatch", new Date(baseTime + 1_000).toISOString()),
      { key: "a" },
      context => native.dispatch(context),
    )
    expect(execution.operation.state).toBe("rejected")
    expect(execution.operation.outcome.dispatch).toBe("none")
    expect(execution.operation.outcome.cleanup.state).toBe("complete")
    expect(native.dispatches).toBe(0)
    expect(runtime.resources.handlesForOperation(execution.operation.context.operationId)).toHaveLength(0)
  })
})

function extractEvidence(bytes: Uint8Array) {
  return [nativeEvidenceReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)]
}
