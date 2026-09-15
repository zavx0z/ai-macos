import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  desktopInventorySnapshotSchema,
  freezeAdapterHostContext,
  z,
  type AdapterResult,
  type NativeAdapter,
  type NativeCancelRequest,
  type NativeExecutionContext,
  type NativeStatusRequest,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import type { DesktopInputAdapter } from "@meta/input/adapter"
import type { InputAction, InputActionResult } from "@meta/input/actions"
import { registerAgentActionMethods } from "../src/agent-action-methods.ts"
import { RuntimeAgentMethods } from "../src/agent-methods.ts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { RuntimeCore } from "../src/core.ts"
import { registerInputMethods } from "../src/input-methods.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { AgentViewGuard } from "../src/agent-view-guard.ts"
import { AgentViewBindings } from "../src/agent-view-bindings.ts"

const generation = { runtimeEpoch: "runtime:agent-actions", loginSessionId: "login:agent-actions" }
const nativeGeneration = "native:agent-actions"
const windowRef = {
  ...generation,
  nativeGeneration,
  applicationRef: "application:agent-actions",
  windowRef: "window:agent-actions",
}
const target = { kind: "window" as const, ref: windowRef }
const surfaceTarget = { kind: "surface" as const, ref: { ...generation, nativeGeneration,
  applicationRef: windowRef.applicationRef, surfaceRef: "surface:save", ownerWindowRef: windowRef.windowRef } }

test("keyboard action сохраняет exact Save surface target после generic refresh", async () => {
  const fixture = createFixture({ realView: true })
  const session = fixture.core.openClient("principal:surface").session
  try {
    const state = await fixture.registry.dispatch(session, "get_state", { kind: "window" }, new AbortController().signal)
    const targetId = (state.data.surfaces as Array<{ targetId: string }>)[0]!.targetId
    await fixture.views!.observe(session, targetId, surfaceTarget, async () => true, value => value)
    const result = await fixture.registry.dispatch(session, "type_text", { targetId, text: "Имя файла" }, new AbortController().signal)
    const operation = await fixture.core.getOperation(session, String(result.data.operationId))
    expect(operation?.context.target).toEqual(surfaceTarget)
    expect(operation?.state).toBe("completed")
    expect(fixture.input.actions).toEqual([{ kind: "text", text: "Имя файла", delayMs: 0 }])
  } finally { await fixture.guard?.close(); await fixture.core.closeClientLifecycle() }
})

test("press_shortcut отправляет всю sequence одной tracked Core operation через view binding", async () => {
  const fixture = createFixture({ realView: true })
  const client = fixture.core.openClient("principal:shortcut")
  const targetId = await discoverTarget(fixture, client.session)
  await fixture.views!.observe(client.session, targetId, target, async () => true, result => result)
  try {
  const result = await fixture.registry.dispatch(client.session, "press_shortcut", {
    targetId, sequence: ["cmd+l", "escape"], delayMs: 20,
  }, new AbortController().signal)
  expect(fixture.input.actions).toEqual([{ kind: "shortcut", shortcuts: ["cmd+l", "escape"], delayMs: 20 }])
  expect(result.data).toMatchObject({ targetId, outcome: { state: "completed", effect: "unverified" } })
  expect(fixture.core.operationCount()).toBe(1)
  await expect(fixture.registry.dispatch(client.session, "press_shortcut", { targetId, sequence: ["not-a-real-key"] }, new AbortController().signal)).rejects.toThrow()
  expect(fixture.input.actions).toHaveLength(1)
  await expect(fixture.registry.dispatch(client.session, "press_shortcut", { targetId, sequence: ["escape"] }, new AbortController().signal)).rejects.toThrow("fresh observe")
  } finally { await fixture.guard?.close(); await fixture.core.closeClientLifecycle() }
})

test("type_text и press_key используют private request IDs и возвращают только короткий outcome", async () => {
  const fixture = createFixture()
  const client = fixture.core.openClient("principal:actions")
  const targetId = await discoverTarget(fixture, client.session)
  const typed = await fixture.registry.dispatch(client.session, "type_text", {
    targetId,
    text: "секретный текст",
  }, new AbortController().signal)
  const pressed = await fixture.registry.dispatch(client.session, "press_key", {
    targetId,
    key: "l",
    modifiers: ["cmd"],
  }, new AbortController().signal)
  const status = await fixture.registry.dispatch(client.session, "get_target_status", { targetId }, new AbortController().signal)

  expect(fixture.input.actions).toEqual([
    { kind: "text", text: "секретный текст", delayMs: 0 },
    { kind: "key", key: "l", modifiers: ["cmd"] },
  ])
  expect((typed.data as any).operationId).not.toBe((pressed.data as any).operationId)
  expect(typed.data).toMatchObject({ targetId, outcome: { state: "completed", cleanup: "complete" } })
  expect(JSON.stringify(typed.data)).not.toContain("секретный текст")
  expect(JSON.stringify(typed.data)).not.toContain("windowRef")
  expect((status.data.recent as unknown[])).toHaveLength(2)
  expect(JSON.stringify(status.data)).not.toContain("секретный текст")
  expect(fixture.readinessCalls()).toBe(0)
  await expect(fixture.registry.dispatch(client.session, "press_key", {
    targetId,
    key: "CMD+ENTER",
  }, new AbortController().signal)).rejects.toThrow("неподдерживаемая клавиша")
  await expect(fixture.registry.dispatch(client.session, "press_key", {
    targetId,
    key: "l",
    modifiers: ["hyper"],
  }, new AbortController().signal)).rejects.toThrow("неподдерживаемый modifier")
  expect(fixture.input.actions).toHaveLength(2)
})

test("cancel_target отменяет выполняющийся typing и сохраняет authoritative cleanup", async () => {
  const fixture = createFixture()
  fixture.input.cancelMode = true
  const client = fixture.core.openClient("principal:cancel")
  const targetId = await discoverTarget(fixture, client.session)
  const running = fixture.registry.dispatch(client.session, "type_text", {
    targetId,
    text: "длинный ввод",
  }, new AbortController().signal)
  await fixture.input.started
  const cancelled = await fixture.registry.dispatch(client.session, "cancel_target", {
    targetId,
    reason: "user cancelled typing",
  }, new AbortController().signal)

  await expect(running).rejects.toThrow("Method отменён")
  expect(cancelled.data).toMatchObject({ targetId, active: [], recent: [{
    action: "type-text",
    phase: "terminal",
    outcome: { state: "cancelled", cleanup: "complete" },
  }] })
  expect(fixture.native.cancelCalls).toBe(1)
})

test("foreign lineage не использует чужой targetId", async () => {
  const fixture = createFixture()
  const first = fixture.core.openClient("principal:first")
  const foreign = fixture.core.openClient("principal:foreign")
  const targetId = await discoverTarget(fixture, first.session)

  await expect(fixture.registry.dispatch(foreign.session, "press_key", {
    targetId,
    key: "enter",
  }, new AbortController().signal)).rejects.toThrow("client lineage")
  await expect(fixture.registry.dispatch(foreign.session, "get_target_status", {
    targetId,
  }, new AbortController().signal)).rejects.toThrow("client lineage")
  expect(fixture.input.actions).toHaveLength(0)
})

test("expired action запрещена, но control status остаётся доступен", async () => {
  let now = Date.now()
  const fixture = createFixture({ targetNow: () => new Date(now), actionTtlMs: 25, controlRetentionMs: 1_000 })
  const client = fixture.core.openClient("principal:expired")
  const targetId = await discoverTarget(fixture, client.session)
  now += 50

  await expect(fixture.registry.dispatch(client.session, "type_text", {
    targetId,
    text: "не отправлять",
  }, new AbortController().signal)).rejects.toThrow("TTL истёк")
  const status = await fixture.registry.dispatch(client.session, "get_target_status", { targetId }, new AbortController().signal)
  expect(status.data).toMatchObject({ targetId, targetState: "active", active: [], recent: [] })
  expect(fixture.input.actions).toHaveLength(0)
})

function createFixture(options: {
  targetNow?: () => Date
  actionTtlMs?: number
  controlRetentionMs?: number
  realView?: boolean
} = {}) {
  const native = new FixtureNative()
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:agent-actions",
    nativeGeneration,
    native: native as unknown as NativeAdapter,
  })
  core.updateCapabilities(capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:agent-actions",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })),
  }))
  core.targets.register(target, "inventory:agent-actions", 1,
    "resolution:agent-actions", "proof:agent-actions", 1)
  core.targets.register(surfaceTarget, "inventory:agent-actions", 1, "resolution:surface", "proof:surface", 1)
  const registry = new MethodRegistry(core)
  let readinessCalls = 0
  registry.register("system_health", method(async () => ({
    machine: { matchesExpected: true },
    runtime: { draining: false, admissionSealed: false },
  })))
  registry.register("list_windows", method(async () => inventory(), undefined, desktopInventorySnapshotSchema))
  registry.register("input_readiness", method(async () => {
    readinessCalls++
    return { inputReady: true }
  }))
  const input = new FixtureInput(native)
  registerInputMethods(registry, core, input as unknown as DesktopInputAdapter)
  const targets = new AgentTargetRegistry({
    generation,
    ...(options.targetNow === undefined ? {} : { clock: { now: options.targetNow } }),
    ...(options.actionTtlMs === undefined ? {} : { actionTtlMs: options.actionTtlMs }),
    ...(options.controlRetentionMs === undefined ? {} : { controlRetentionMs: options.controlRetentionMs }),
  })
  const guard = options.realView ? new AgentViewGuard({ generation: { ...generation, nativeGeneration },
    resolveTarget: (lineage, targetId) => targets.forLineage(lineage).resolveAction(targetId),
    observer: {
      observerInstanceRef: "observer:shortcut",
      async coverage() {
        const now = new Date().toISOString()
        return { state: "ready", ...generation, nativeGeneration, coverageStartCursor: "cursor:shortcut", cursor: "cursor:shortcut",
          nextSequence: 1, startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
          coveredKinds: ["input", "focus", "window-structure", "lifecycle"], droppedEvents: 0, gapDetected: false }
      },
      async *subscribe(options = {}) {
        const signal = options.signal
        if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
    },
  }) : undefined
  const views = guard === undefined ? undefined : new AgentViewBindings(core, guard)
  if (views !== undefined) input.authorizeView = core.bindNativeViewAdmission(views.authorizeNative)
  const methods = new RuntimeAgentMethods(registry, core, targets, { views: views ?? {
    observe: (_session, _targetId, _target, capture) => capture(),
    run: async (session, _targetId, requestId, mode, action) => {
      await core.clients.assertActive(session, new Date())
      expect(requestId).toMatch(/^agent-request:/)
      expect(mode).toBe("keyboard")
      return action()
    },
  } })
  methods.register()
  registerAgentActionMethods(registry, methods)
  return { core, input, native, guard, views, readinessCalls: () => readinessCalls, registry }
}

async function discoverTarget(fixture: ReturnType<typeof createFixture>, session: ReturnType<RuntimeCore["openClient"]>["session"]) {
  const state = await fixture.registry.dispatch(session, "get_state", { kind: "window" }, new AbortController().signal)
  return (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
}

class FixtureInput {
  authorizeView?: ReturnType<RuntimeCore["bindNativeViewAdmission"]>
  readonly actions: InputAction[] = []
  cancelMode = false
  #started!: () => void
  started = new Promise<void>(resolve => { this.#started = resolve })

  constructor(private readonly native: FixtureNative) {}

  async execute(
    context: RuntimeOperationContext<NativeExecutionContext>,
    action: InputAction,
  ): Promise<AdapterResult<InputActionResult>> {
    await this.authorizeView?.(context.wire, { method: "input.execute", actionKind: action.kind })
    this.actions.push(structuredClone(action))
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
        error: { code: "cancelled", message: "fixture typing cancelled", stage: "fixture-input",
          retryable: false, replayAllowed: false, recoveryAction: "none" },
        outcome: outcome(context.resources, "none", "cancelled"),
        nativeStatus: status,
      }
    }
    const status = nativeStatus(context.wire, "finished", "finished")
    this.native.lastStatus = status
    return {
      ok: true,
      value: { kind: action.kind, dispatchedUnits: 1, destinationPoints: [], ownershipProofRefs: [] },
      outcome: outcome(context.resources, "finished", "completed"),
      nativeStatus: status,
    }
  }
}

class FixtureNative {
  readonly adapterInstanceRef = "native-adapter:agent-actions"
  readonly loadedBuildId = "native-build:agent-actions"
  readonly host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "runtime-build:agent-actions",
    capabilities: capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "native-adapter:agent-actions",
      capabilities: [{ id: "runtime.identity", state: "ready" }],
    }),
  })
  readonly generation = { ...generation, nativeGeneration }
  readonly ledgerSink = { async persist() { throw new Error("not used") } }
  readonly evidencePublisher = { async publish() { throw new Error("not used") } }
  lastStatus: ReturnType<typeof nativeStatus> | undefined
  cancelCalls = 0

  async status(request: NativeStatusRequest) {
    if (this.lastStatus === undefined) throw new Error("Fixture native status отсутствует")
    return { ...this.lastStatus, requestId: request.requestId }
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
    cleanup: resources.length === 0
      ? { scope: "none" as const, state: "complete" as const, resources: [] as [] }
      : { scope: "owned" as const, state: "complete" as const,
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
    observer: {
      state: "unavailable" as const,
      ...generation,
      nativeGeneration,
      coverageStartCursor: "cursor:agent-actions",
      cursor: "cursor:agent-actions",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "Fixture observer отключён",
    },
  }
}

function inventory() {
  return desktopInventorySnapshotSchema.parse({
    inventoryId: "inventory:agent-actions",
    ...generation,
    nativeGeneration,
    revision: 1,
    displayLayoutRevision: 1,
    capturedAt: new Date().toISOString(),
    complete: true,
    errors: [],
    applications: [{
      ref: { ...generation, nativeGeneration, applicationRef: windowRef.applicationRef, pid: 101,
        launchedAt: "2026-09-15T10:00:00.000Z", registrationNonce: "registration:agent-actions" },
      name: "Fixture App",
      bundleId: "com.meta.fixture",
      hidden: "false",
      axStatus: "ready",
      windowCount: 1,
    }],
    windows: [{
      kind: "ax-window",
      ref: windowRef,
      surfaces: [{ ref: surfaceTarget.ref, kind: "sheet", title: "Save", role: "AXSheet",
        frame: { x: 10, y: 10, width: 300, height: 200 }, actionability: "ax", advertisedActions: ["raise", "close"], permittedActions: ["raise", "close"] }],
      ownerPid: 101,
      cgWindowId: 77,
      title: "Fixture",
      role: "AXWindow",
      subrole: "AXStandardWindow",
      frame: { x: 0, y: 0, width: 640, height: 480 },
      applicationHidden: "false",
      minimized: "false",
      onScreen: "true",
      spaceVisibility: "current",
      fullscreen: "false",
      focused: "true",
      main: "true",
      mapping: "corroborated",
      mappingEvidence: {
        cgWindowId: 77,
        ownerPid: 101,
        proof: { proofRef: "proof:window-actions", authorityRef: "authority:window-actions",
          kind: "cg-ax-correlation", subject: target, ...generation, nativeGeneration,
          inventoryRevision: 1, displayLayoutRevision: 1,
          issuedAt: "2026-09-15T10:00:00.000Z", expiresAt: "2099-09-15T10:00:00.000Z" },
      },
      actionability: "ax",
      advertisedActions: ["raise"],
      permittedActions: ["raise"],
    }],
    displays: [],
  })
}

function method(
  execute: (context: any, input: any) => Promise<Record<string, unknown>>,
  input: z.ZodType = z.object({}).passthrough(),
  output: z.ZodType = z.object({}).passthrough(),
) {
  return { title: "fixture", description: "fixture", input, output, readOnly: true, execute }
}
