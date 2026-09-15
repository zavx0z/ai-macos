import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  freezeAdapterHostContext,
  mapObservationPointGeometry,
  observationSchema,
  structurallyEqual,
  type AdapterResult,
  type NativeAdapter,
  type NativeCancelRequest,
  type NativeExecutionContext,
  type NativeStatusRequest,
  type ObservedEvent,
  type ObserverCoverage,
  type Observation,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import type { DesktopInputAdapter } from "@meta/input/adapter"
import { pointerActionPoints, type InputAction, type InputActionResult } from "@meta/input/actions"
import { registerAgentAxMethods } from "../src/agent-ax-methods.ts"
import { AgentOperations } from "../src/agent-operations.ts"
import { registerAgentPointerMethods } from "../src/agent-pointer-methods.ts"
import type { RuntimeAgentMethods } from "../src/agent-methods.ts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { AgentViewBindings } from "../src/agent-view-bindings.ts"
import { AgentViewGuard, type AgentViewObserver } from "../src/agent-view-guard.ts"
import { RuntimeCore } from "../src/core.ts"
import { registerInputMethods } from "../src/input-methods.ts"
import { MethodRegistry } from "../src/method-registry.ts"

const generation = { runtimeEpoch: "runtime:agent-pointer", loginSessionId: "login:agent-pointer" }
const nativeGeneration = "native:agent-pointer"
const target = { kind: "window" as const, ref: { ...generation, nativeGeneration,
  applicationRef: "application:agent-pointer", windowRef: "window:agent-pointer" } }
const displayTarget = { kind: "display" as const, ref: { ...generation, nativeGeneration,
  displayRef: "display:agent-pointer", displayLayoutRevision: 1 } }
const layoutTarget = { kind: "desktop-layout" as const, ref: { ...generation, nativeGeneration,
  layoutRef: "layout:agent-pointer", displayLayoutRevision: 1 } }

test("point click использует исходные image pixels, fresh inventory и тот же observationRef", async () => {
  const fixture = await createFixture()
  const clicked = await fixture.registry.dispatch(fixture.session, "click", {
    targetId: fixture.targetId,
    point: [10, 20],
  }, new AbortController().signal)

  expect(fixture.input.calls).toMatchObject([{ action: {
    kind: "click", point: { x: 10, y: 20 }, button: "left", count: 1,
  }, context: { wire: { inventoryId: "inventory:fresh:20", inventoryRevision: 20,
    observationRef: { observationId: "observation:pointer:10", inventoryRevision: 10 } } } }])
  expect(fixture.input.destinations).toEqual([[{ x: 120, y: 240 }]])
  expect(fixture.views).toMatchObject([{ mode: "ui-action", targetId: fixture.targetId }])
  expect(clicked.data).toMatchObject({ targetId: fixture.targetId,
    outcome: { state: "completed", cleanup: "complete" } })
  expect(fixture.observationReads()).toBe(1)
  expect(fixture.refreshes()).toBe(1)
  expect(fixture.input.admissions).toBe(1)
  await fixture.guard.close()
})

test("scroll сохраняет explicit unit, а drag авторизует from/to по одному frame", async () => {
  const scroll = await createFixture()
  await scroll.registry.dispatch(scroll.session, "scroll", {
    targetId: scroll.targetId,
    anchor: [5, 6],
    dx: 0,
    dy: -3,
    unit: "line",
  }, new AbortController().signal)
  expect(scroll.input.calls[0]?.action).toEqual({
    kind: "scroll", anchor: { x: 5, y: 6 }, dx: 0, dy: -3, unit: "line",
  })
  expect(scroll.input.destinations[0]).toEqual([{ x: 110, y: 212 }])
  await scroll.guard.close()

  const drag = await createFixture()
  await drag.registry.dispatch(drag.session, "drag", {
    targetId: drag.targetId,
    from: [1, 2],
    to: [30, 40],
    button: "middle",
    modifiers: ["shift"],
  }, new AbortController().signal)
  expect(drag.input.calls[0]?.action).toEqual({
    kind: "drag",
    points: [{ x: 1, y: 2 }, { x: 30, y: 40 }],
    durationMs: 300,
    button: "middle",
    modifiers: ["shift"],
  })
  expect(drag.input.destinations[0]).toEqual([{ x: 102, y: 204 }, { x: 160, y: 280 }])
  expect(drag.observationReads()).toBe(1)
  expect(drag.input.admissions).toBe(1)
  await drag.guard.close()
})

test("context click и hover проходят production action options без собственного parser", async () => {
  const click = await createFixture()
  await click.registry.dispatch(click.session, "click", {
    targetId: click.targetId,
    point: [10, 20],
    button: "right",
    count: 2,
  }, new AbortController().signal)
  expect(click.input.calls[0]?.action).toEqual({
    kind: "click", point: { x: 10, y: 20 }, button: "right", count: 2,
  })
  await click.guard.close()

  const hover = await createFixture()
  await hover.registry.dispatch(hover.session, "hover", {
    targetId: hover.targetId,
    point: [7, 8],
  }, new AbortController().signal)
  expect(hover.input.calls[0]?.action).toEqual({ kind: "hover", point: { x: 7, y: 8 } })
  expect(hover.input.destinations[0]).toEqual([{ x: 114, y: 216 }])
  await hover.guard.close()
})

test("click требует ровно один semantic element или point и не делает recapture", async () => {
  const fixture = await createFixture()
  await expect(fixture.registry.dispatch(fixture.session, "click", {
    targetId: fixture.targetId,
    elementId: "element:one",
    point: [10, 20],
  }, new AbortController().signal)).rejects.toThrow("ровно один")
  await expect(fixture.registry.dispatch(fixture.session, "click", {
    targetId: fixture.targetId,
  }, new AbortController().signal)).rejects.toThrow("ровно один")
  await expect(fixture.registry.dispatch(fixture.session, "click", {
    targetId: fixture.targetId,
    elementId: "element:one",
    button: "right",
  }, new AbortController().signal)).rejects.toThrow("AX element click")
  await expect(fixture.registry.dispatch(fixture.session, "scroll", {
    targetId: fixture.targetId,
    anchor: [10, 20],
    dy: 1,
  }, new AbortController().signal)).rejects.toThrow()
  expect(fixture.input.calls).toHaveLength(0)
  expect(fixture.observationReads()).toBe(0)
  await fixture.guard.close()
})

test("stale observation и geometry вне исходного clip fail closed без recapture", async () => {
  const stale = await createFixture()
  stale.staleObservation()
  await expect(stale.registry.dispatch(stale.session, "scroll", {
    targetId: stale.targetId,
    anchor: [5, 6],
    dx: 0,
    dy: 1,
    unit: "pixel",
  }, new AbortController().signal)).rejects.toThrow("stale observation")
  expect(stale.input.calls).toHaveLength(0)
  expect(stale.views).toHaveLength(0)
  await stale.guard.close()

  const outside = await createFixture()
  await expect(outside.registry.dispatch(outside.session, "click", {
    targetId: outside.targetId,
    point: [500, 500],
  }, new AbortController().signal)).rejects.toThrow("mouse_click failed")
  const status = await outside.operations.getTargetStatus(outside.session, outside.targetId)
  expect(status.recent).toMatchObject([{ action: "pointer-click", outcome: {
    state: "failed", dispatch: "none", cleanup: "complete",
  } }])
  expect(outside.input.calls).toHaveLength(1)
  expect(outside.observationReads()).toBe(1)
  expect(outside.input.admissions).toBe(1)
  await outside.guard.close()
})

test("cancelled и unknown pointer delivery сохраняются в target status", async () => {
  const cancelled = await createFixture()
  cancelled.input.mode = "cancel"
  const running = cancelled.registry.dispatch(cancelled.session, "drag", {
    targetId: cancelled.targetId,
    from: [1, 2],
    to: [3, 4],
  }, new AbortController().signal)
  await cancelled.input.admitted
  const cancelStatus = await cancelled.operations.cancelTarget(
    cancelled.session,
    cancelled.targetId,
    "cancel pointer drag",
  )
  await expect(running).rejects.toThrow("Method отменён")
  expect(cancelStatus.recent).toMatchObject([{ action: "pointer-drag", outcome: {
    state: "cancelled", cleanup: "complete",
  } }])
  expect(cancelled.input.admissions).toBe(1)
  await cancelled.guard.close()

  const unknown = await createFixture()
  unknown.input.mode = "unknown"
  await expect(unknown.registry.dispatch(unknown.session, "click", {
    targetId: unknown.targetId,
    point: [10, 20],
  }, new AbortController().signal)).rejects.toThrow("mouse_click failed")
  const unknownStatus = await unknown.operations.getTargetStatus(unknown.session, unknown.targetId)
  expect(unknownStatus.recent).toMatchObject([{ action: "pointer-click", outcome: {
    state: "interrupted-unknown", cleanup: "unknown",
  } }])
  await unknown.guard.close()
})

test("explicit display pointer сохраняет broad target, а foreign layout не получает window fallback", async () => {
  const display = await createFixture({ operationTarget: displayTarget,
    observation: capturedObservation(displayTarget) })
  await display.registry.dispatch(display.session, "click", {
    targetId: display.targetId,
    point: [10, 20],
  }, new AbortController().signal)
  expect(display.input.calls[0]?.context.wire.target).toEqual(displayTarget)
  expect(display.input.destinations[0]).toEqual([{ x: 120, y: 240 }])
  await display.guard.close()

  const layout = await createFixture({ operationTarget: layoutTarget,
    observation: capturedObservation(layoutTarget) })
  await layout.registry.dispatch(layout.session, "hover", {
    targetId: layout.targetId,
    point: [4, 5],
  }, new AbortController().signal)
  expect(layout.input.calls[0]?.context.wire.target).toEqual(layoutTarget)
  await layout.guard.close()

  const foreignLayout = await createFixture({ operationTarget: layoutTarget,
    observation: capturedObservation(displayTarget) })
  await expect(foreignLayout.registry.dispatch(foreignLayout.session, "click", {
    targetId: foreignLayout.targetId,
    point: [10, 20],
  }, new AbortController().signal)).rejects.toThrow("другому exact target")
  expect(foreignLayout.input.calls).toHaveLength(0)
  await foreignLayout.guard.close()
})

async function createFixture(options: {
  operationTarget?: typeof target | typeof displayTarget | typeof layoutTarget
  observation?: Observation
} = {}) {
  const operationTarget = options.operationTarget ?? target
  const native = new FixtureNative()
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:agent-pointer", nativeGeneration,
    native: native as unknown as NativeAdapter, cancelGraceMs: 20 })
  core.updateCapabilities(capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:agent-pointer",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })),
  }))
  core.targets.register(operationTarget, "inventory:fresh:20", 20,
    "resolution:agent-pointer", "proof:agent-pointer", 1, undefined, 120_000)
  const targets = new AgentTargetRegistry({ generation })
  const client = core.openClient("principal:agent-pointer")
  const scope = targets.forLineage(core.clients.lineage(client.session))
  const handle = scope.registerTarget(operationTarget, { inventoryId: "inventory:capture:10", inventoryRevision: 10 })
  const operations = new AgentOperations({ runtime: core, targets })
  const observation = options.observation ?? capturedObservation(operationTarget)
  let observationReads = 0
  let refreshes = 0
  let stale = false
  const views: Array<{ targetId: string, clientRequestId: string, mode: string }> = []
  const observer = new FixtureObserver()
  const guard = new AgentViewGuard({
    generation: { ...generation, nativeGeneration },
    observer,
    resolveTarget: (lineageId, targetId) => targets.forLineage(lineageId).resolveAction(targetId),
  })
  const viewBindings = new AgentViewBindings(core, guard)
  const authorizeView = core.bindNativeViewAdmission(viewBindings.authorizeNative)
  await viewBindings.observe(client.session, handle.targetId, operationTarget, async () => observation, () => true)
  const methods = {
    operations,
    async refreshNativeAction(_session: unknown, targetId: string) {
      refreshes++
      scope.registerTarget(operationTarget, { inventoryId: "inventory:fresh:20", inventoryRevision: 20 })
      return scope.resolveAction(targetId)
    },
    async getLatestObservation() {
      observationReads++
      if (stale) throw new Error("stale observation")
      if (!structurallyEqual(observation.captureTarget, operationTarget)) {
        throw new Error("Latest owned screenshot относится к другому exact target")
      }
      return { imageId: "image:pointer:10", observation: structuredClone(observation) }
    },
    async withViewAction<T>(_session: unknown, targetId: string, clientRequestId: string,
      mode: "ui-action" | "keyboard", action: () => Promise<T>) {
      views.push({ targetId, clientRequestId, mode })
      return viewBindings.run(client.session, targetId, clientRequestId, mode, action)
    },
  } as unknown as RuntimeAgentMethods
  const registry = new MethodRegistry(core)
  const input = new FixtureInput(native, observation, authorizeView)
  registerInputMethods(registry, core, input as unknown as DesktopInputAdapter)
  const pointer = registerAgentPointerMethods(registry, methods, operations)
  registerAgentAxMethods(registry, core, targets, methods, operations, pointer)
  return {
    core,
    guard,
    input,
    methods,
    native,
    observationReads: () => observationReads,
    operations,
    refreshes: () => refreshes,
    registry,
    session: client.session,
    staleObservation() { stale = true },
    targetId: handle.targetId,
    views,
  }
}

class FixtureInput {
  readonly calls: Array<{ context: { wire: NativeExecutionContext }, action: InputAction }> = []
  readonly destinations: Array<Array<{ x: number, y: number }>> = []
  mode: "success" | "cancel" | "unknown" = "success"
  admissions = 0
  #started!: () => void
  started = new Promise<void>(resolve => { this.#started = resolve })
  #admitted!: () => void
  admitted = new Promise<void>(resolve => { this.#admitted = resolve })

  constructor(
    private readonly native: FixtureNative,
    private readonly observation: Observation,
    private readonly authorizeView: ReturnType<RuntimeCore["bindNativeViewAdmission"]>,
  ) {}

  async execute(
    context: RuntimeOperationContext<NativeExecutionContext>,
    action: InputAction,
  ): Promise<AdapterResult<InputActionResult>> {
    this.calls.push({ context: { wire: structuredClone(context.wire) }, action: structuredClone(action) })
    this.#started()
    if (!["hover", "click", "scroll", "drag"].includes(action.kind)) throw new Error("Fixture требует pointer action")
    await this.authorizeView(context.wire, { method: "input.execute", actionKind: action.kind })
    this.admissions++
    this.#admitted()
    const points = pointerActionPoints(action as Extract<InputAction, { kind: "hover" | "click" | "scroll" | "drag" }>)
    let destinations: Array<{ x: number, y: number }>
    try {
      destinations = points.map(point => mapObservationPointGeometry(this.observation, point).destinationPoint)
    } catch (error) {
      const status = nativeStatus(context.wire, "failed", "none")
      this.native.lastStatus = status
      return {
        ok: false,
        error: { code: "point-not-owned", message: error instanceof Error ? error.message : "invalid point",
          stage: "fixture-point", retryable: false, replayAllowed: false, recoveryAction: "capture-new-observation" },
        outcome: outcome(context.resources, "none", "failed"),
        nativeStatus: status,
      }
    }
    this.destinations.push(destinations)
    if (this.mode === "cancel") {
      await new Promise<void>(resolve => {
        if (context.control.signal.aborted) return resolve()
        context.control.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      const status = nativeStatus(context.wire, "cancelled", "none")
      this.native.lastStatus = status
      return {
        ok: false,
        error: { code: "cancelled", message: "fixture pointer cancelled", stage: "fixture-pointer",
          retryable: false, replayAllowed: false, recoveryAction: "none" },
        outcome: outcome(context.resources, "none", "cancelled"),
        nativeStatus: status,
      }
    }
    if (this.mode === "unknown") throw new Error("fixture pointer reply lost")
    const status = nativeStatus(context.wire, "finished", "finished")
    this.native.lastStatus = status
    return {
      ok: true,
      value: { kind: action.kind, dispatchedUnits: points.length,
        destinationPoints: destinations, ownershipProofRefs: ["proof:point"] },
      outcome: outcome(context.resources, "finished", "completed"),
      nativeStatus: status,
    }
  }
}

class FixtureNative {
  readonly adapterInstanceRef = "native-adapter:agent-pointer"
  readonly loadedBuildId = "native-build:agent-pointer"
  readonly host = freezeAdapterHostContext({ generation, runtimeBuildId: "build:agent-pointer",
    capabilities: capabilitySetSchema.parse({ schemaVersion: "1", scope: "adapter",
      producerRef: "native-adapter:agent-pointer", capabilities: [{ id: "runtime.identity", state: "ready" }] }) })
  readonly generation = { ...generation, nativeGeneration }
  readonly ledgerSink = { async persist() { throw new Error("not used") } }
  readonly evidencePublisher = { async publish() { throw new Error("not used") } }
  lastStatus: ReturnType<typeof nativeStatus> | undefined

  async status(request: NativeStatusRequest) {
    if (this.lastStatus === undefined) throw new Error("Fixture native status отсутствует")
    return { ...this.lastStatus, requestId: request.requestId }
  }

  async cancel(request: NativeCancelRequest) {
    return { requestId: request.requestId, operationId: request.operationId,
      runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId,
      nativeGeneration: request.nativeGeneration, fence: request.fence,
      acknowledged: true, stopped: true, cleanup: "complete" as const,
      ledgerRevision: 1, lastCheckpoint: "cancelled", quarantined: false }
  }
}

class FixtureObserver implements AgentViewObserver {
  readonly observerInstanceRef = "observer:agent-pointer"
  readonly #coverage: ObserverCoverage

  constructor() {
    const now = new Date().toISOString()
    this.#coverage = {
      state: "ready",
      ...generation,
      nativeGeneration,
      coverageStartCursor: "cursor:agent-pointer:start",
      cursor: "cursor:agent-pointer:start",
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

function capturedObservation(operationTarget: typeof target | typeof displayTarget | typeof layoutTarget = target): Observation {
  const capturedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 120_000).toISOString()
  const display = { ...generation, nativeGeneration, displayRef: "display:pointer", displayLayoutRevision: 1 }
  const source = operationTarget.kind === "window" ? "window-isolated" as const : "display-composite" as const
  return observationSchema.parse({
    observationId: "observation:pointer:10",
    ...generation,
    nativeGeneration,
    captureTarget: operationTarget,
    caption: "Ожидаю pointer fixture",
    backend: { name: "fixture", buildId: "build:pointer-capture" },
    capturedAt,
    expiresAt,
    inventoryRevision: 10,
    displayLayoutRevision: 1,
    source,
    image: { frameRef: "frame:pointer:10", widthPx: 100, heightPx: 100,
      mime: "image/png", byteLength: 10, sha256: "a".repeat(64) },
    cursor: "excluded",
    clip: { x: 0, y: 0, width: 100, height: 100 },
    captureEvidence: { state: "confirmed", claim: "frame-freshness", source: "fixture", proof: {
      proofRef: "proof:capture:pointer", authorityRef: "authority:capture:pointer", kind: "frame-freshness",
      subject: operationTarget, ...generation, nativeGeneration, inventoryRevision: 10, displayLayoutRevision: 1,
      issuedAt: capturedAt, expiresAt,
    } },
    occlusion: { state: "unknown", claim: "occlusion", source: "fixture", reason: "isolated" },
    readiness: { state: "ready", policy: { policyId: "pointer-ready", requiredSteps: [], disabledSteps: [] },
      steps: [], timedOut: false },
    synchronization: { kind: "single-frame" },
    regions: [{ space: { kind: "macos-screen", display },
      imageRect: { x: 0, y: 0, width: 100, height: 100 },
      destinationRect: { x: 100, y: 200, width: 200, height: 200 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: 100, ty: 200 },
      frameTimestamp: capturedAt, frameStatus: "complete" }],
    unavailableReasons: [],
  })
}

function outcome(
  resources: readonly RuntimeResourceHandle[],
  dispatch: "none" | "finished",
  state: "completed" | "cancelled" | "failed",
) {
  return {
    dispatch,
    targetVerified: dispatch === "finished" ? "verified" as const : "unknown" as const,
    userInterference: "none-observed" as const,
    observation: dispatch === "finished" ? "available" as const : "failed" as const,
    effect: { state: "unverified" as const, proofRefs: [] as [] },
    cleanup: { scope: "owned" as const, state: "complete" as const,
      resources: resources.map(handle => ({ handle, outcome: "released" as const })) },
    restoration: state === "cancelled" ? "unknown" as const : "not-applicable" as const,
    dispatchAttempts: dispatch === "finished" ? 1 : 0,
  }
}

function nativeStatus(
  wire: NativeExecutionContext,
  execution: "finished" | "cancelled" | "failed",
  dispatch: "finished" | "none",
) {
  const now = new Date().toISOString()
  return { requestId: `native-status:${wire.operationId}`, ...generation, nativeGeneration,
    highWaterFence: wire.fence, acceptedFence: wire.fence, operationId: wire.operationId,
    execution, dispatch, cleanup: "complete" as const,
    targetVerified: dispatch === "finished" ? "verified" as const : "unknown" as const,
    cancellationRequested: execution === "cancelled", userInterference: "unknown" as const,
    restorationAllowed: false, quarantined: false, heldCount: 0, lastCheckpoint: execution,
    dispatchAttempts: dispatch === "finished" ? 1 : 0, ledgerRevision: 1,
    observer: { state: "unavailable" as const, ...generation, nativeGeneration,
      coverageStartCursor: "cursor:pointer", cursor: "cursor:pointer", nextSequence: 1,
      startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
      coveredKinds: [], droppedEvents: 0, gapDetected: false, reason: "Fixture observer отключён" } }
}
