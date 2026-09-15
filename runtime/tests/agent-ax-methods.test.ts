import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  desktopInventorySnapshotSchema,
  freezeAdapterHostContext,
  z,
  type AdapterResult,
  type AxPressResult,
  type NativeAdapter,
  type NativeCancelRequest,
  type NativeExecutionContext,
  type NativeStatusRequest,
  type ObservedEvent,
  type ObserverCoverage,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import { registerAgentAxMethods } from "../src/agent-ax-methods.ts"
import { registerAgentMethods } from "../src/agent-methods.ts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { AgentViewBindings } from "../src/agent-view-bindings.ts"
import { AgentViewGuard, type AgentViewObserver } from "../src/agent-view-guard.ts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerWindowMethods, type RuntimeWindowAdapter } from "../src/window-methods.ts"

const generation = { runtimeEpoch: "runtime:agent-ax", loginSessionId: "login:agent-ax" }
const nativeGeneration = "native:agent-ax"
const windowRef = { ...generation, nativeGeneration,
  applicationRef: "application:agent-ax", windowRef: "window:agent-ax" }
const target = { kind: "window" as const, ref: windowRef }

test("click выполняет exact AXPress и публикует только короткий operation outcome", async () => {
  const fixture = createFixture()
  const client = fixture.core.openClient("principal:ax-click")
  const selected = await observeButton(fixture, client.session)
  const clicked = await fixture.registry.dispatch(client.session, "click", selected, new AbortController().signal)
  const status = await fixture.methods.operations.getTargetStatus(client.session, selected.targetId)

  expect(fixture.windows.presses).toMatchObject([{ target, request: { element: {
    snapshotId: "snapshot:agent-ax:1", elementRef: "element:save:1",
  } } }])
  expect(clicked.data).toMatchObject({ targetId: selected.targetId,
    outcome: { state: "completed", dispatch: "finished", cleanup: "complete" } })
  expect(JSON.stringify(clicked.data)).not.toContain("elementRef")
  expect(status.recent).toMatchObject([{ action: "ax-press", operationId: clicked.data.operationId }])
  expect(fixture.windows.inspections).toBe(1)
  expect(fixture.windows.admissions).toBe(1)
  await fixture.guard.close()
})

test("старый snapshot element и foreign target отклоняются до AX backend", async () => {
  const fixture = createFixture()
  const first = fixture.core.openClient("principal:ax-first")
  const foreign = fixture.core.openClient("principal:ax-foreign")
  const old = await observeButton(fixture, first.session)
  const current = await observeButton(fixture, first.session, old.targetId)
  const otherTarget = { kind: "window" as const, ref: { ...windowRef,
    applicationRef: "application:agent-ax:other", windowRef: "window:agent-ax:other" } }
  const scope = fixture.targets.forLineage(fixture.core.clients.lineage(first.session))
  const otherHandle = scope.registerTarget(otherTarget, { inventoryId: "inventory:other", inventoryRevision: 1 })
  const [otherElement] = scope.registerElements(otherHandle.targetId, {
    snapshotId: "snapshot:other",
    target: otherTarget,
    complete: true,
    nodeCount: 1,
    encodedBytes: 10,
    nodes: [{ elementRef: { ...generation, nativeGeneration,
      applicationRef: otherTarget.ref.applicationRef, snapshotId: "snapshot:other", elementRef: "element:other" },
      role: "AXButton", subrole: "", title: "Other", actions: ["AXPress"] }],
    errors: [],
  })

  await expect(fixture.registry.dispatch(first.session, "click", old, new AbortController().signal))
    .rejects.toThrow("latest target snapshot")
  await expect(fixture.registry.dispatch(foreign.session, "click", current, new AbortController().signal))
    .rejects.toThrow("client lineage")
  await expect(fixture.registry.dispatch(first.session, "click", {
    targetId: current.targetId,
    elementId: "element-handle:unknown",
  }, new AbortController().signal)).rejects.toThrow("latest target snapshot")
  await expect(fixture.registry.dispatch(first.session, "click", {
    targetId: current.targetId,
    elementId: otherElement!.elementId,
  }, new AbortController().signal)).rejects.toThrow("latest target snapshot")
  await expect(fixture.registry.dispatch(first.session, "click", {
    ...current,
    point: [10, 20],
  }, new AbortController().signal)).rejects.toThrow()
  expect(fixture.windows.presses).toHaveLength(0)
  await fixture.guard.close()
})

test("cancel exact AXPress сохраняет authoritative cancelled cleanup", async () => {
  const fixture = createFixture()
  fixture.windows.cancelMode = true
  const client = fixture.core.openClient("principal:ax-cancel")
  const selected = await observeButton(fixture, client.session)
  const running = fixture.registry.dispatch(client.session, "click", selected, new AbortController().signal)
  await fixture.windows.started
  const cancelled = await fixture.methods.operations.cancelTarget(
    client.session,
    selected.targetId,
    "cancel semantic press",
  )

  await expect(running).rejects.toThrow("Method отменён")
  expect(cancelled).toMatchObject({ active: [], recent: [{ action: "ax-press", phase: "terminal",
    outcome: { state: "cancelled", cleanup: "complete" } }] })
  expect(fixture.native.cancelCalls).toBe(1)
  expect(fixture.windows.admissions).toBe(1)
  await fixture.guard.close()
})

function createFixture() {
  const native = new FixtureNative()
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:agent-ax", nativeGeneration,
    native: native as unknown as NativeAdapter })
  core.updateCapabilities(capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:agent-ax",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })),
  }))
  core.targets.register(target, "inventory:agent-ax", 1,
    "resolution:agent-ax", "proof:agent-ax", 1, undefined, 120_000)
  const registry = new MethodRegistry(core)
  registry.register("system_health", {
    title: "fixture",
    description: "fixture",
    input: z.strictObject({}),
    output: z.object({}).passthrough(),
    readOnly: true,
    execute: async () => ({ machine: { matchesExpected: true }, runtime: { draining: false, admissionSealed: false } }),
  })
  const targets = new AgentTargetRegistry({ generation })
  const observer = new FixtureObserver()
  const guard = new AgentViewGuard({
    generation: { ...generation, nativeGeneration },
    observer,
    resolveTarget: (lineageId, targetId) => targets.forLineage(lineageId).resolveAction(targetId),
  })
  const views = new AgentViewBindings(core, guard)
  const authorizeView = core.bindNativeViewAdmission(views.authorizeNative)
  const windows = new FixtureWindows(core, native, authorizeView)
  registerWindowMethods(registry, core, windows)
  const methods = registerAgentMethods(registry, core, targets, { views })
  registerAgentAxMethods(registry, core, targets, methods)
  return { core, guard, methods, native, registry, targets, windows }
}

async function observeButton(
  fixture: ReturnType<typeof createFixture>,
  session: ReturnType<RuntimeCore["openClient"]>["session"],
  existingTargetId?: string,
): Promise<{ targetId: string, elementId: string }> {
  let targetId = existingTargetId
  if (targetId === undefined) {
    const response = await fixture.registry.dispatch(
      session,
      "get_state",
      { kind: "window" },
      new AbortController().signal,
    )
    targetId = (response.data.windows as Array<{ targetId: string }>)[0]!.targetId
  }
  const observed = await fixture.registry.dispatch(session, "observe", {
    targetId,
    mode: "ax",
  }, new AbortController().signal)
  return {
    targetId,
    elementId: (observed.data.elements as Array<{ elementId: string }>)[0]!.elementId,
  }
}

class FixtureWindows implements RuntimeWindowAdapter {
  readonly host
  readonly services
  readonly capabilities = ["desktop.ax"] as const
  readonly presses: Array<{ target: unknown, request: unknown }> = []
  cancelMode = false
  admissions = 0
  #snapshot = 0
  inspections = 0
  #started!: () => void
  started = new Promise<void>(resolve => { this.#started = resolve })

  constructor(
    core: RuntimeCore,
    private readonly native: FixtureNative,
    private readonly authorizeView: ReturnType<RuntimeCore["bindNativeViewAdmission"]>,
  ) {
    this.host = native.host
    this.services = core.services
  }

  async inventory() {
    return inventory()
  }

  async inspect(request: Parameters<RuntimeWindowAdapter["inspect"]>[0]) {
    this.#snapshot++
    this.inspections++
    const snapshotId = `snapshot:agent-ax:${this.#snapshot}`
    return {
      snapshotId,
      target: request.target,
      complete: true,
      nodeCount: 1,
      encodedBytes: 100,
      nodes: [{
        elementRef: { ...generation, nativeGeneration, applicationRef: windowRef.applicationRef,
          snapshotId, elementRef: `element:save:${this.#snapshot}` },
        role: "AXButton",
        subrole: "",
        title: "Save",
        actions: ["AXPress"],
      }],
      errors: [],
    }
  }

  async transition(): Promise<never> {
    throw new Error("not used")
  }

  async press(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: Parameters<NonNullable<RuntimeWindowAdapter["press"]>>[1],
  ): Promise<AdapterResult<AxPressResult>> {
    await this.authorizeView(context.wire, { method: "ax.press" })
    this.admissions++
    this.presses.push({ target: structuredClone(context.wire.target), request: structuredClone(request) })
    this.#started()
    if (this.cancelMode) {
      await new Promise<void>(resolve => {
        if (context.control.signal.aborted) return resolve()
        context.control.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      const status = nativeStatus(context.wire, "cancelled", "none")
      this.native.lastStatus = status
      return {
        ok: false,
        error: { code: "cancelled", message: "fixture AXPress cancelled", stage: "fixture-ax",
          retryable: false, replayAllowed: false, recoveryAction: "none" },
        outcome: outcome(context.resources, "none", "cancelled"),
        nativeStatus: status,
      }
    }
    const status = nativeStatus(context.wire, "finished", "finished")
    this.native.lastStatus = status
    return {
      ok: true,
      value: { element: request.element, action: "AXPress", performed: true },
      outcome: outcome(context.resources, "finished", "completed"),
      nativeStatus: status,
    }
  }
}

class FixtureObserver implements AgentViewObserver {
  readonly observerInstanceRef = "observer:agent-ax"
  readonly #coverage: ObserverCoverage

  constructor() {
    const now = new Date().toISOString()
    this.#coverage = {
      state: "ready",
      ...generation,
      nativeGeneration,
      coverageStartCursor: "cursor:agent-ax:start",
      cursor: "cursor:agent-ax:start",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: ["input", "focus", "window-structure", "lifecycle"],
      droppedEvents: 0,
      gapDetected: false,
    }
  }

  async coverage(): Promise<ObserverCoverage> {
    return structuredClone(this.#coverage)
  }

  subscribe(options: { signal?: AbortSignal, afterCursor?: string } = {}): AsyncIterable<ObservedEvent> {
    if (options.afterCursor !== this.#coverage.cursor) throw new Error("Fixture observer cursor mismatch")
    return {
      async *[Symbol.asyncIterator]() {
        if (options.signal?.aborted) return
        await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
    }
  }
}

class FixtureNative {
  readonly adapterInstanceRef = "native-adapter:agent-ax"
  readonly loadedBuildId = "native-build:agent-ax"
  readonly host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "build:agent-ax",
    capabilities: capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "native-adapter:agent-ax",
      capabilities: [{ id: "runtime.identity", state: "ready" }],
    }),
  })
  readonly generation = { ...generation, nativeGeneration }
  readonly ledgerSink = { async persist() { throw new Error("not used") } }
  readonly evidencePublisher = { async publish() { throw new Error("not used") } }
  lastStatus: ReturnType<typeof nativeStatus> | undefined
  cancelCalls = 0

  async status(request: NativeStatusRequest) {
    if (this.lastStatus === undefined) throw new Error("Fixture status отсутствует")
    return { ...this.lastStatus, requestId: request.requestId }
  }

  async cancel(request: NativeCancelRequest) {
    this.cancelCalls++
    return { requestId: request.requestId, operationId: request.operationId,
      runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId,
      nativeGeneration: request.nativeGeneration, fence: request.fence,
      acknowledged: true, stopped: true, cleanup: "complete" as const,
      ledgerRevision: 1, lastCheckpoint: "cancelled", quarantined: false }
  }
}

function inventory() {
  const now = new Date().toISOString()
  return desktopInventorySnapshotSchema.parse({
    inventoryId: "inventory:agent-ax",
    ...generation,
    nativeGeneration,
    revision: 1,
    displayLayoutRevision: 1,
    capturedAt: now,
    complete: true,
    errors: [],
    applications: [{ ref: { ...generation, nativeGeneration, applicationRef: windowRef.applicationRef,
      pid: 101, launchedAt: "2026-09-15T10:00:00.000Z", registrationNonce: "registration:agent-ax" },
      name: "Fixture AX", hidden: "false", axStatus: "ready", windowCount: 1 }],
    windows: [{ kind: "ax-window", ref: windowRef, surfaces: [], ownerPid: 101, cgWindowId: 77,
      title: "Fixture AX", role: "AXWindow", subrole: "AXStandardWindow",
      frame: { x: 0, y: 0, width: 640, height: 480 }, applicationHidden: "false",
      minimized: "false", onScreen: "true", spaceVisibility: "current", fullscreen: "false",
      focused: "true", main: "true", mapping: "corroborated",
      mappingEvidence: { cgWindowId: 77, ownerPid: 101, proof: {
        proofRef: "proof:window-agent-ax", authorityRef: "authority:window-agent-ax",
        kind: "cg-ax-correlation", subject: target, ...generation, nativeGeneration,
        inventoryRevision: 1, displayLayoutRevision: 1,
        issuedAt: "2026-09-15T10:00:00.000Z", expiresAt: "2099-09-15T10:00:00.000Z" } },
      actionability: "ax", advertisedActions: ["raise"], permittedActions: ["raise"] }],
    displays: [],
  })
}

function outcome(
  resources: readonly RuntimeResourceHandle[],
  dispatch: "none" | "finished",
  state: "completed" | "cancelled",
) {
  return {
    dispatch,
    targetVerified: dispatch === "finished" ? "verified" as const : "unknown" as const,
    userInterference: "none-observed" as const,
    observation: "unavailable" as const,
    effect: { state: "unverified" as const, proofRefs: [] as [] },
    cleanup: { scope: "owned" as const, state: "complete" as const,
      resources: resources.map(handle => ({ handle, outcome: "released" as const })) },
    restoration: state === "cancelled" ? "unknown" as const : "not-applicable" as const,
    dispatchAttempts: dispatch === "finished" ? 1 : 0,
  }
}

function nativeStatus(
  wire: NativeExecutionContext,
  execution: "finished" | "cancelled",
  dispatch: "finished" | "none",
) {
  const now = new Date().toISOString()
  return {
    requestId: `native-status:${wire.operationId}`,
    ...generation,
    nativeGeneration,
    highWaterFence: wire.fence,
    acceptedFence: wire.fence,
    operationId: wire.operationId,
    execution,
    dispatch,
    cleanup: "complete" as const,
    targetVerified: dispatch === "finished" ? "verified" as const : "unknown" as const,
    cancellationRequested: execution === "cancelled",
    userInterference: "unknown" as const,
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: execution,
    dispatchAttempts: dispatch === "finished" ? 1 : 0,
    ledgerRevision: 1,
    observer: { state: "unavailable" as const, ...generation, nativeGeneration,
      coverageStartCursor: "cursor:agent-ax", cursor: "cursor:agent-ax", nextSequence: 1,
      startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
      coveredKinds: [], droppedEvents: 0, gapDetected: false, reason: "Fixture observer отключён" },
  }
}
