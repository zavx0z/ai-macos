import { expect, test } from "bun:test"
import { hostname } from "node:os"
import { CAPABILITY_IDS, browserInstanceSnapshotSchema, operationRecordSchema, z } from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { FixtureBrowserDriver } from "./browser-fixture.ts"
import { createBrowserHostComposition } from "../src/browser-host.ts"
import { registerBrowserMethods } from "../src/browser-methods.ts"
import { RuntimeCore } from "../src/core.ts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { pipelineInputSchema, registerAgentPipelineMethods } from "../src/agent-pipeline.ts"
import type { PipelineObservation } from "../src/pipeline-conditions.ts"
import { canonicalJson, sha256 } from "../src/primitives.ts"
import { registerAgentService } from "../src/agent-service.ts"
import { computerActions } from "../src/agent-actions.ts"

function fixture() {
  const generation = { runtimeEpoch: "runtime:pipeline", loginSessionId: "login:pipeline" }
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:pipeline", clientGraceMs: 1, cancelGraceMs: 20 })
  core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "test:pipeline",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
  const registry = new MethodRegistry(core)
  const session = core.openClient("principal:pipeline").session
  const targets = new AgentTargetRegistry({ generation })
  const target = { kind: "window" as const, ref: { ...generation, nativeGeneration: "native:fixture",
    applicationRef: "application:chrome", windowRef: "window:chrome" } }
  const { targetId } = targets.forLineage(core.clients.lineage(session)).registerTarget(target,
    { inventoryId: "native-inventory:1", inventoryRevision: 1 })
  const { targetId: sheetTargetId } = targets.forLineage(core.clients.lineage(session)).registerTarget({
    kind: "surface", ref: { ...generation, nativeGeneration: "native:fixture",
      applicationRef: "application:chrome", surfaceRef: "surface:consent", ownerWindowRef: "window:chrome" },
  }, { inventoryId: "native-inventory:1", inventoryRevision: 1 })
  const ui = { sheet: false, owner: targetId, count: 1, actionable: true, complete: true,
    preexisting: false, replaced: false, duplicateButton: false,
    onObserve: undefined as (() => Promise<void>) | undefined,
    onProbe: undefined as (() => Promise<void>) | undefined }
  let chromePlan = false, preapproved = false
  let focused = true, fakeDialog = false, partial = false, deny = false, missing = 0, finalChanged = false, replaceTab = false
  let inspections = 0, clicks = 0, shortcuts = 0, captures = 0, probes = 0, externalCalls = 0
  let allow!: () => void
  const consent = new Promise<void>(resolve => { allow = resolve })
  const order: string[] = [], reads: string[] = []
  let lastObservation: PipelineObservation | undefined
  const fixtureDriver = new FixtureBrowserDriver()
  const driver: BrowserDriver = fixtureDriver
  driver.connect = async signal => {
    fixtureDriver.connectCalls++
    order.push("connect")
    let abort!: () => void
    try {
      await Promise.race([consent, new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException("connect cancelled", "AbortError"))
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort()
      })])
      signal.throwIfAborted(); fixtureDriver.connected = true
      return { browserVersion: "Chrome/Test" }
    } finally { signal.removeEventListener("abort", abort) }
  }
  driver.listTargets = async () => [{ id: replaceTab && reads.length ? "tab:replacement" : "tab:pipeline", type: "page", title: "Pipeline fixture",
    url: "https://fixture.invalid/pipeline", webSocketDebuggerUrl: "ws://fixture.invalid/not-used" }]
  driver.readDom = async (id, request) => {
    reads.push(id)
    const full = "<main>pipeline fixture</main>"
    const content = full.slice(request.offsetBytes, request.offsetBytes + request.maxBytes)
    const contentBytes = Buffer.byteLength(content)
    const totalBytes = Buffer.byteLength(full)
    const nextOffsetBytes = request.offsetBytes + contentBytes
    return {
      content,
      contentBytes,
      offsetBytes: request.offsetBytes,
      nextOffsetBytes,
      totalBytes,
      snapshotSha256: sha256(full),
      truncated: nextOffsetBytes < totalBytes,
    }
  }
  const composition = createBrowserHostComposition(core, { chrome: { bindingId: "browser:pipeline", instances: [{
    browserInstanceRef: "chrome:pipeline", initialTransportGeneration: "transport:initial",
    connectionMode: "existing-session", userDataDir: "/fixture/no-live-chrome", driver,
  }] } })
  registerBrowserMethods(registry, core, composition.bindings)
  const method = (execute: (value: Record<string, unknown>) => Promise<Record<string, unknown>>) => ({
    title: "Isolated method fixture", description: "No real Native input/capture", input: z.object({}).passthrough(),
    output: z.object({}).passthrough(), readOnly: true, execute: (_context: unknown, value: Record<string, unknown>) => execute(value),
  })
  registry.register("system_health", method(async () => ({ machine: { matchesExpected: true } })))
  // Gateway требует опубликованный receipt-метод, даже когда сам конвейер читает Core напрямую.
  registry.register("get_operation", method(async value => ({
    operation: await core.getOperation(session, String(value.operationId)),
  })))
  const sheetVisible = () => ui.sheet && !preapproved && !fixtureDriver.connected
    && (ui.preexisting || fixtureDriver.connectCalls > 0)
  registry.register("get_state", method(async () => ({ complete: true, errors: [],
    windows: [{ targetId, pid: 101, focused: String(focused && !sheetVisible()), visibility: "current", hidden: "false", minimized: "false" }],
    applications: [{ pid: 101, bundleId: "com.google.Chrome", axStatus: "ready" }],
    surfaces: sheetVisible() ? Array.from({ length: ui.count }, (_, index) => ({
      targetId: index || ui.replaced ? `${sheetTargetId}:replacement:${index}` : sheetTargetId,
      ownerTargetId: ui.owner, kind: "sheet", role: "AXSheet", title: "",
      actionability: ui.actionable ? "ax" : "unavailable",
    })) : [],
  })))
  registry.register("check_input", method(async () => {
    probes++; order.push("probe")
    const hook = ui.onProbe; ui.onProbe = undefined; await hook?.()
    return { inputReady: true, operationId: `operation:probe:${probes}` }
  }))
  registry.register("observe", { ...method(async value => {
    if (value.mode === "screenshot" || value.mode === "both") {
      captures++; order.push("capture")
      const elements = value.mode === "both" ? structuredClone(lastObservation?.elements ?? []) : []
      if (finalChanged && elements.length) elements.at(-1)!.title = "Changed after earlier check"
      return { targetId, state: "", complete: true, errors: [], elements, imageId: "image:final", width: 800, height: 600 }
    }
    inspections++; order.push("observe")
    const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
    const isSheet = value.targetId === sheetTargetId
    const root = { elementId: `root:${inspections}`, role: isSheet ? "AXSheet" : "AXWindow", subrole: isSheet ? "" : "AXStandardWindow", title: "Chrome",
      frame: frame(0, 0, 800, 600), actions: [] }
    const web = { elementId: `web:${inspections}`, parentElementId: root.elementId, role: "AXWebArea", subrole: "", title: "Page", frame: frame(0, 0, 800, 600), actions: [] }
    const dialog = { elementId: `dialog:${inspections}`, parentElementId: fakeDialog ? web.elementId : root.elementId,
      role: "AXGroup", subrole: "AXApplicationAlertDialog", title: "Consent fixture", frame: frame(200, 200, 400, 200), actions: [] }
    const button = { elementId: `allow:${inspections}`, parentElementId: dialog.elementId, role: "AXButton", subrole: "", title: "Allow",
      frame: frame(480, 340, 100, 30), actions: ["AXPress"] }
    const showDialog = inspections > missing && (!chromePlan || !preapproved && (ui.preexisting || fixtureDriver.connectCalls > 0))
      && (!ui.sheet || isSheet)
    lastObservation = { targetId: String(value.targetId), state: "", complete: ui.complete, errors: [], elements: [root,
      ...(showDialog ? [...(fakeDialog ? [web] : []), dialog, button,
        ...(ui.duplicateButton ? [{ ...button, elementId: `allow-duplicate:${inspections}` }] : [])] : [])] }
    if (fixtureDriver.connectCalls > 0) {
      const hook = ui.onObserve; ui.onObserve = undefined; await hook?.()
    }
    return lastObservation
  }), frames: value => value.imageId ? ["frame:final"] : [] })
  registry.register("click", { ...method(async value => {
    expect(order.at(-1)).toBe("observe")
    expect(probes).toBeGreaterThan(clicks + shortcuts)
    expect(value.targetId).toBe(lastObservation?.targetId)
    if (ui.sheet) expect(value.targetId).toBe(sheetTargetId)
    expect(value.elementId).toBe(lastObservation?.elements.at(-1)?.elementId)
    clicks++; order.push("click")
    if (!partial && !deny) allow()
    return { targetId: value.targetId, operationId: `operation:click:${clicks}`,
      outcome: { state: partial ? "interrupted-unknown" : "completed", dispatch: partial ? "unknown" : "finished", cleanup: partial ? "unknown" : "complete" } }
  }), readOnly: false, isError: () => deny })
  registry.register("press_shortcut", { ...method(async () => {
    expect(order.at(-1)).toBe("observe")
    shortcuts++; order.push("keys")
    return { targetId, operationId: `operation:keys:${shortcuts}`, outcome: { state: "completed", dispatch: "finished", cleanup: "complete" } }
  }), readOnly: false })
  registerAgentPipelineMethods(registry, core, targets)
  const when = { anchors: [
    { name: "dialog", selector: { subrole: "AXApplicationAlertDialog", text: "Consent fixture" } },
    { name: "button", within: "dialog", selector: { role: "AXButton", text: "Allow" } },
  ], select: "button", origin: "native-dialog" }
  const base = { runtimeEpoch: generation.runtimeEpoch, targetId, expectedBundleId: "com.google.Chrome",
    final: { condition: when, caption: "Isolated final frame" } }
  const native = (requestId = "pipeline:native") => pipelineInputSchema.parse({ ...base, clientRequestId: requestId,
    steps: [{ id: "keys", kind: "keys", when, sequence: ["cmd+l", "escape"] }] })
  const chrome = () => { chromePlan = true; return pipelineInputSchema.parse({ ...base, clientRequestId: "pipeline:chrome", steps: [
    { id: "start", kind: "chrome-connect", instance: { ...generation, browserInstanceRef: "chrome:pipeline", transportGeneration: "transport:initial" } },
    { id: "consent", kind: "chrome-consent", when }, { id: "connected", kind: "chrome-wait" },
    { id: "read-one", kind: "chrome-read", url: "https://fixture.invalid/pipeline" },
    { id: "read-two", kind: "chrome-read", url: "https://fixture.invalid/pipeline" },
    { id: "disconnect", kind: "chrome-disconnect" },
  ], final: { chromeDisconnected: true, caption: "Isolated final Chrome frame" } }) }
  const dispatch = (input: unknown, signal = new AbortController().signal) => {
    externalCalls++; return registry.dispatch(session, "run_pipeline", input, signal)
  }
  const connection = () => core.getOperationByRequest(session,
    `pipeline-child:${sha256(canonicalJson(["pipeline:chrome", "start"]))}`)
  return { core, registry, targets, session, targetId, sheetTargetId, ui, connection, when, native, chrome, dispatch, driver: fixtureDriver, browserDriver: driver, reads, order,
    setFocus(value: boolean) { focused = value }, fakeDialog() { fakeDialog = true }, partial() { partial = true }, deny() { deny = true },
    changeFinal() { finalChanged = true }, replaceTab() { replaceTab = true },
    approveConnection() { preapproved = true; allow() },
    missing(count: number) { missing = count },
    counts: () => ({ inspections, clicks, shortcuts, captures, probes, externalCalls }),
    async dispose() { allow(); await core.stopOperations(); await core.browserLifetime.shutdownLineage(); await core.closeClientLifecycle() },
  }
}

test("one external pipeline call: pending connect, local consent, two exact reads, disconnect", async () => {
  const f = fixture()
  try {
    f.missing(1)
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("verified")
    expect(result.data.finalVerified).toBe(true)
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.connected).toBe(false)
    expect(f.reads).toEqual(["tab:pipeline", "tab:pipeline"])
    expect(f.counts()).toMatchObject({ externalCalls: 1, clicks: 1, captures: 1 })
    expect(result.frameRefs).toEqual(["frame:final"])
    expect(f.order.indexOf("connect")).toBeLessThan(f.order.indexOf("click"))
    expect(f.core.activeOperationCount()).toBe(0)
    expect(f.core.resources.quarantinedCount()).toBe(0)
  } finally { await f.dispose() }
})
test("уже разрешённый Chrome: два чтения и receipt без диалога и ввода", async () => {
  const f = fixture()
  try {
    f.approveConnection()
    const input = f.chrome()
    input.steps = input.steps.filter(step => step.kind !== "chrome-consent")
    const result = await f.dispatch(input)
    expect(result.data.state).toBe("verified")
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.reads).toEqual(["tab:pipeline", "tab:pipeline"])
    expect(f.counts()).toMatchObject({ clicks: 0, shortcuts: 0, inspections: 0, captures: 1 })
    const connection = operationRecordSchema.parse(result.data.connectionOperation)
    expect((await f.core.getOperation(f.session, connection.context.operationId))?.state).toBe("completed")
    expect(f.core.activeOperationCount()).toBe(0)
    expect(f.core.resources.quarantinedCount()).toBe(0)
  } finally { await f.dispose() }
})

test("waiting repeats observations, not key sequences; native guard order retained", async () => {
  const f = fixture()
  try {
    f.missing(2)
    const result = await f.dispatch(f.native())
    expect(result.data.state).toBe("verified")
    expect(f.counts()).toMatchObject({ shortcuts: 1, clicks: 0, inspections: 4, captures: 1 })
    expect(f.order).toEqual(["probe", "observe", "observe", "observe", "keys", "observe", "capture"])
  } finally { await f.dispose() }
})
test("same request returns same receipt without replay; different payload rejected", async () => {
  const f = fixture()
  try {
    const input = f.native()
    const [first, duplicate] = await Promise.all([f.dispatch(input), f.dispatch(input)])
    expect(first.data).toEqual(duplicate.data)
    expect(f.counts().shortcuts).toBe(1)
    await expect(f.dispatch({ ...input, final: { ...input.final, caption: "changed" } })).rejects.toThrow("payload")
    expect(f.counts().shortcuts).toBe(1)
  } finally { await f.dispose() }
})
test("unexpected focused window stops input", async () => {
  const f = fixture()
  try {
    f.setFocus(false)
    const result = await f.dispatch(f.native())
    expect(result.data.state).toBe("stopped")
    expect(result.data.failure).toContain("focus")
    expect(f.counts().shortcuts).toBe(0)
  } finally { await f.dispose() }
})
test("web imitation never receives consent; own pending connect is cancelled, not replayed", async () => {
  const f = fixture()
  try {
    f.fakeDialog()
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("stopped")
    expect(result.data.failure).toContain("ownership")
    expect(f.counts().clicks).toBe(0)
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.connected).toBe(false)
    expect(f.reads).toEqual([])
    expect(f.core.activeOperationCount()).toBe(0)
  } finally { await f.dispose() }
})
test("partial input stops all dependent actions and retains its operation id", async () => {
  const f = fixture()
  try {
    f.partial()
    const input = f.native()
    const result = await f.dispatch({ ...input, steps: [{ id: "press", kind: "press", when: f.when }, ...input.steps] })
    expect(result.data.state).toBe("stopped")
    expect(f.counts()).toMatchObject({ clicks: 1, shortcuts: 0 })
    expect((result.data.steps as Array<{ operationIds: string[] }>)[0]!.operationIds).toContain("operation:click:1")
  } finally { await f.dispose() }
})
test("failure reply retains failed child operation instead of losing it at the envelope", async () => {
  const f = fixture()
  try {
    f.deny()
    const result = await f.dispatch({ ...f.native(), steps: [{ id: "press", kind: "press", when: f.when }] })
    expect(result.data.state).toBe("stopped")
    expect((result.data.steps as Array<{ operationIds: string[] }>)[0]!.operationIds).toContain("operation:click:1")
  } finally { await f.dispose() }
})
test("wrong epoch or another lineage cannot execute an existing pipeline target", async () => {
  const f = fixture()
  try {
    await expect(f.dispatch({ ...f.native(), runtimeEpoch: "runtime:old" })).rejects.toThrow("epoch")
    const foreign = f.core.openClient("principal:foreign").session
    await expect(f.registry.dispatch(foreign, "run_pipeline", f.native(), new AbortController().signal)).rejects.toThrow("lineage")
    expect(f.counts().shortcuts).toBe(0)
  } finally { await f.dispose() }
})
test("deadline stops a missing condition without sending any key", async () => {
  const f = fixture()
  try {
    f.missing(10_000)
    const input = f.native()
    await expect(f.dispatch(input, AbortSignal.timeout(30))).rejects.toThrow()
    const receipt = await f.dispatch(input)
    expect(receipt.data.state).toBe("stopped")
    expect(f.counts().shortcuts).toBe(0)
  } finally { await f.dispose() }
})
test("arbitrary nested methods, key grammar errors and consent bypass rejected before execution", async () => {
  const f = fixture()
  try {
    await expect(f.dispatch({ ...f.native(), steps: [{ id: "script", kind: "evaluate", code: "1" }] })).rejects.toThrow()
    await expect(f.dispatch({ ...f.native(), steps: [{ id: "keys", kind: "keys", when: f.when, sequence: ["not-a-key"] }] })).rejects.toThrow()
    const input = f.chrome()
    await expect(f.dispatch({ ...input, steps: [input.steps[0], { id: "unsafe", kind: "keys", when: f.when, sequence: ["enter"] }, ...input.steps.slice(2)] })).rejects.toThrow()
    expect(f.driver.connectCalls).toBe(0)
    expect(f.counts().shortcuts).toBe(0)
  } finally { await f.dispose() }
})

test("final screenshot and condition must agree; earlier match is not recycled", async () => {
  const f = fixture()
  try {
    f.changeFinal()
    const result = await f.dispatch(f.native())
    expect(result.data.state).toBe("stopped")
    expect(result.data.finalVerified).toBe(false)
    expect(result.data.failure).toContain("Final observation")
    expect(f.counts()).toMatchObject({ shortcuts: 1, captures: 1 })
  } finally { await f.dispose() }
})

test("replaced tab is not selected by URL again; known own connection cleaned once", async () => {
  const f = fixture()
  try {
    f.replaceTab()
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("stopped")
    expect(f.reads).toEqual(["tab:pipeline"])
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(result.data.cleanupOperationIds).toHaveLength(1)
    expect(f.driver.connected).toBe(false)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("second different pipeline cannot interleave on the same exact window", async () => {
  const f = fixture()
  try {
    f.missing(2)
    const first = f.dispatch(f.native("pipeline:first"))
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(f.dispatch(f.native("pipeline:second"))).rejects.toThrow("already")
    expect((await first).data.state).toBe("verified")
    expect(f.counts().shortcuts).toBe(1)
  } finally { await f.dispose() }
})

test("consent regression: same plan skips consent for an already approved connection", async () => {
  const f = fixture()
  try {
    f.approveConnection()
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("verified")
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.counts()).toMatchObject({ clicks: 0, shortcuts: 0, probes: 0, captures: 1 })
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.reads).toEqual(["tab:pipeline", "tab:pipeline"])
  } finally { await f.dispose() }
})

test("consent regression: owned AXSheet is the action target while parent is unfocused", async () => {
  const f = fixture()
  try {
    f.ui.sheet = true
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("verified")
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.counts()).toMatchObject({ clicks: 1, shortcuts: 0, probes: 1, captures: 1 })
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.reads).toEqual(["tab:pipeline", "tab:pipeline"])
    expect(f.core.activeOperationCount()).toBe(0)
    expect(f.core.resources.quarantinedCount()).toBe(0)
  } finally { await f.dispose() }
})

for (const fault of ["foreign-owner", "ambiguous-surfaces", "unavailable-surface", "web-imitation", "incomplete-observation", "duplicate-button"] as const) {
  test(`consent safety: ${fault} cannot receive input`, async () => {
    const f = fixture()
    try {
      f.ui.sheet = true
      if (fault === "foreign-owner") f.ui.owner = "target:foreign-window"
      if (fault === "ambiguous-surfaces") f.ui.count = 2
      if (fault === "unavailable-surface") f.ui.actionable = false
      if (fault === "web-imitation") f.fakeDialog()
      if (fault === "incomplete-observation") f.ui.onObserve = async () => { f.ui.complete = false }
      if (fault === "duplicate-button") f.ui.duplicateButton = true
      const result = await f.dispatch(f.chrome())
      expect(result.data.state).toBe("stopped")
      expect(f.counts().clicks).toBe(0)
      expect(f.reads).toEqual([])
      expect(f.driver.connectCalls).toBe(1)
      expect(f.core.activeOperationCount()).toBe(0)
      // A cancelled pending connect is not proof of physical disconnection.
      // Preserve the Core receipt/quarantine instead of manufacturing clean success.
      const connection = operationRecordSchema.parse(result.data.connectionOperation)
      expect(result.data.connectionCleanup).toBe("unconfirmed")
      expect(connection.state).not.toBe("completed")
      expect(connection.outcome.cleanup.state).not.toBe("pending")
      expect(f.core.resources.quarantinedCount()).toBe(connection.outcome.cleanup.resources
        .filter(resource => resource.outcome === "quarantined").length)
      if (fault === "foreign-owner") console.log("ISOLATED_CONSENT_REFUSAL=" + JSON.stringify({
        failure: result.data.failure, connectionState: connection.state,
        cleanup: connection.outcome.cleanup, error: connection.error,
      }))
    } finally { await f.dispose() }
  })
}

for (const sheet of [false, true]) {
  test(`consent safety: pre-existing ${sheet ? "sheet" : "window dialog"} is not attributed to a new connection`, async () => {
    const f = fixture()
    try {
      f.ui.sheet = sheet; f.ui.preexisting = true
      const result = await f.dispatch(f.chrome())
      expect(result.data.state).toBe("stopped")
      expect(f.driver.connectCalls).toBe(0)
      expect(f.counts()).toMatchObject({ clicks: 0, probes: 0 })
    } finally { await f.dispose() }
  })
}

for (const fault of ["owner-changed", "surface-replaced", "connection-cancelled", "connection-expired"] as const) {
  test(`consent safety: ${fault} during readiness is rechecked before the click`, async () => {
    const f = fixture()
    const getOperation = f.core.getOperation.bind(f.core)
    try {
      f.ui.sheet = true
      f.ui.onProbe = async () => {
        if (fault === "owner-changed") f.ui.owner = "target:foreign-window"
        if (fault === "surface-replaced") f.ui.replaced = true
        const record = await f.connection()
        expect(record).toBeDefined()
        if (fault === "connection-cancelled") await f.core.cancelOperation(f.session, record!.context.operationId, "isolated consent cancellation")
        if (fault === "connection-expired") {
          f.core.getOperation = async (...args) => {
            const value = await getOperation(...args)
            return value && value.context.operationId === record!.context.operationId
              ? { ...value, context: { ...value.context, deadlineAt: new Date(0).toISOString() } } : value
          }
        }
      }
      const result = await f.dispatch(f.chrome())
      expect(result.data.state).toBe("stopped")
      expect(f.counts()).toMatchObject({ probes: 1, clicks: 0 })
      expect(f.reads).toEqual([])
      expect(f.driver.connectCalls).toBe(1)
      expect(f.core.activeOperationCount()).toBe(0)
    } finally { f.core.getOperation = getOperation; await f.dispose() }
  })
}

async function approveAndSettle(f: ReturnType<typeof fixture>) {
  f.approveConnection()
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await f.connection())?.state === "completed") return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error("Isolated connection did not settle")
}
for (const moment of ["observation", "readiness"] as const) {
  test(`consent safety: connection completing during ${moment} never receives a late click`, async () => {
    const f = fixture()
    try {
      f.ui.sheet = true
      if (moment === "observation") f.ui.onObserve = () => approveAndSettle(f)
      else f.ui.onProbe = () => approveAndSettle(f)
      const result = await f.dispatch(f.chrome())
      expect(result.data.state).toBe("verified")
      expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
      expect(f.counts()).toMatchObject({ clicks: 0, probes: moment === "observation" ? 0 : 1 })
      expect(f.driver.connectCalls).toBe(1)
      expect(f.driver.disconnectCalls).toBe(1)
      expect(f.reads).toEqual(["tab:pipeline", "tab:pipeline"])
    } finally { await f.dispose() }
  })
}

test("consent safety: partial sheet click stops dependent reads without replay", async () => {
  const f = fixture()
  try {
    f.ui.sheet = true; f.partial()
    const result = await f.dispatch(f.chrome())
    expect(result.data.state).toBe("stopped")
    expect(f.counts()).toMatchObject({ clicks: 1, probes: 1 })
    expect(f.reads).toEqual([])
    expect(f.driver.connectCalls).toBe(1)
    expect((result.data.steps as Array<{ operationIds: string[] }>)[1]!.operationIds).toContain("operation:click:1")
    expect(f.core.activeOperationCount()).toBe(0)
  } finally { await f.dispose() }
})

// Только подставной BrowserDriver: сеть, установленный Runtime и Native не вызываются.
function chunkSource(f: ReturnType<typeof fixture>, full: string) {
  type Request = Parameters<BrowserDriver["readDom"]>[1]
  const requests: Request[] = []
  const bytes = Buffer.from(full, "utf8")
  f.browserDriver.readDom = async (id, request) => {
    f.reads.push(id)
    requests.push({ ...request })
    let end = Math.min(bytes.length, request.offsetBytes + request.maxBytes)
    while (end > request.offsetBytes && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    const content = bytes.subarray(request.offsetBytes, end).toString("utf8")
    return { content, contentBytes: Buffer.byteLength(content), offsetBytes: request.offsetBytes,
      nextOffsetBytes: end, totalBytes: bytes.length, snapshotSha256: sha256(full), truncated: end < bytes.length }
  }
  f.browserDriver.readResource = async (id, request, signal) => {
    const { content, contentBytes, ...chunk } = await f.browserDriver.readDom(id, request, signal)
    return { ...chunk, body: content, bodyBytes: contentBytes,
      url: new URL(request.url, "https://fixture.invalid/pipeline").href, status: 200, contentType: "application/json; charset=utf-8" }
  }
  return requests
}

function chunkPlan(f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) {
  const plan = f.chrome()
  return { ...plan, steps: plan.steps.filter(step => step.id !== "read-two")
    .map(step => step.id === "read-one" ? { ...step, ...options } : step) }
}

test("порционное чтение: прежний однократный шаг теперь возвращает сам текст", async () => {
  const f = fixture()
  try {
    const result = await f.dispatch(chunkPlan(f))
    expect(result.data.state).toBe("verified")
    expect(result.data.reads).toMatchObject([{ content: "<main>pipeline fixture</main>", truncated: false }])
  } finally { await f.dispose() }
})

test("порционное чтение: два последовательных UTF-8 блока, BOM и полный hash", async () => {
  const f = fixture()
  try {
    f.ui.sheet = true
    const full = "\uFEFFА🌌БZ"
    const requests = chunkSource(f, full)
    const input = chunkPlan(f, { maxBytes: 7, maxChunks: 2 })
    const result = await f.dispatch(input)
    expect(result.data.state).toBe("verified")
    expect(requests).toEqual([
      { offsetBytes: 0, maxBytes: 7 },
      { offsetBytes: 5, maxBytes: 7, expectedSnapshotSha256: sha256(full) },
    ])
    expect(result.data.reads).toMatchObject([{ stepId: "read-one", content: full, contentBytes: 12,
      offsetBytes: 0, nextOffsetBytes: 12, totalBytes: 12, snapshotSha256: sha256(full),
      sha256: sha256(full), truncated: false, chunks: [
        { offsetBytes: 0, nextOffsetBytes: 5, contentBytes: 5 },
        { offsetBytes: 5, nextOffsetBytes: 12, contentBytes: 7 },
      ] }])
    const steps = result.data.steps as Array<{ id: string, operationIds: string[] }>
    expect(new Set(steps.find(step => step.id === "read-one")!.operationIds).size).toBe(2)
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.counts().clicks).toBe(1)
    expect((await f.dispatch(input)).data).toEqual(result.data)
    expect(requests).toHaveLength(2)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("порционное чтение: ограниченный префикс и явное продолжение с его cursor/hash", async () => {
  const f = fixture()
  try {
    const full = "0123456789"
    const requests = chunkSource(f, full)
    const first = await f.dispatch(chunkPlan(f, { maxBytes: 4, maxChunks: 2 }))
    expect(first.data.reads).toMatchObject([{ content: "01234567", contentBytes: 8,
      nextOffsetBytes: 8, totalBytes: 10, truncated: true, snapshotSha256: sha256(full) }])
    const prefix = (first.data.reads as Array<{ nextOffsetBytes: number, snapshotSha256: string }>)[0]!
    f.approveConnection()
    const inventory = await f.registry.dispatch(f.session, "browser_chrome_instances", {}, new AbortController().signal)
    const instance = (inventory.data.instances as Array<{ ref: unknown }>)[0]!.ref
    const next = chunkPlan(f, { maxBytes: 4, maxChunks: 2,
      offsetBytes: prefix.nextOffsetBytes, expectedSnapshotSha256: prefix.snapshotSha256 })
    const second = await f.dispatch({ ...next, clientRequestId: "pipeline:continuation",
      steps: next.steps.map(step => step.kind === "chrome-connect" ? { ...step, instance } : step) })
    expect(second.data.state).toBe("verified")
    expect(second.data.reads).toMatchObject([{ content: "89", contentBytes: 2, offsetBytes: 8,
      nextOffsetBytes: 10, totalBytes: 10, truncated: false, snapshotSha256: sha256(full) }])
    expect(requests.map(request => request.offsetBytes)).toEqual([0, 4, 8])
    expect(second.data.connectionCleanup).toBe("confirmed-disconnected")
  } finally { await f.dispose() }
})

for (const fault of ["hash", "total", "offset", "bytes", "no-progress", "full-hash"] as const) {
  test(`порционное чтение: ${fault} останавливает шаг без выдачи склеенного текста`, async () => {
    const f = fixture()
    try {
      const requests = chunkSource(f, "0123456789")
      const read = f.browserDriver.readDom.bind(f.browserDriver)
      f.browserDriver.readDom = async (...args) => {
        const chunk = await read(...args)
        if (fault === "full-hash") chunk.snapshotSha256 = "aa".repeat(32)
        if (requests.length === 2) {
          if (fault === "hash") chunk.snapshotSha256 = "bb".repeat(32)
          if (fault === "total") chunk.totalBytes++
          if (fault === "offset") chunk.offsetBytes--
          if (fault === "bytes") chunk.contentBytes++
          if (fault === "no-progress") {
            chunk.content = ""
            chunk.contentBytes = 0
            chunk.nextOffsetBytes = chunk.offsetBytes
          }
        }
        return chunk
      }
      const input = chunkPlan(f, { maxBytes: 4, maxChunks: 3 })
      const result = await f.dispatch(input)
      expect(result.data.state).toBe("stopped")
      expect(result.data.reads).toEqual([])
      const adapterRejected = !["total", "full-hash"].includes(fault)
      // Прежний coordinator карантинирует lifetime при отказе adapter.
      // Конвейер не вправе обходить этот карантин обычным disconnect.
      if (adapterRejected) {
        expect(result.data.connectionCleanup).toBe("unconfirmed")
        expect(result.data.cleanupError).toContain("active reservation")
        expect(f.driver.disconnectCalls).toBe(0)
        const snapshot = browserInstanceSnapshotSchema.parse((await f.registry.dispatch(f.session,
          "browser_chrome_instances", {}, new AbortController().signal)).data)
        const reservation = await f.core.reservations.inspect(f.session, { kind: "browser-instance", ref: snapshot.instances[0]!.ref })
        expect(reservation?.state).toBe("quarantined")
      } else {
        expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
        expect(f.driver.disconnectCalls).toBe(1)
      }
      expect(requests).toHaveLength(fault === "full-hash" ? 3 : 2)
      expect((await f.dispatch(input)).data).toEqual(result.data)
      expect(f.driver.connectCalls).toBe(1)
      expect(f.core.activeOperationCount()).toBe(0)
    } finally { await f.dispose() }
  })
}

test("порционное чтение: смена точной вкладки между блоками не подменяется тем же URL", async () => {
  const f = fixture()
  try {
    const requests = chunkSource(f, "0123456789")
    f.replaceTab()
    const result = await f.dispatch(chunkPlan(f, { maxBytes: 4, maxChunks: 3 }))
    expect(result.data.state).toBe("stopped")
    expect(result.data.reads).toEqual([])
    expect(requests).toHaveLength(1)
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    expect(f.driver.disconnectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("порционное чтение: same-origin ресурс возвращает тело и HTTP-метаданные", async () => {
  const f = fixture()
  try {
    const full = "{\"ok\":true}"
    const requests = chunkSource(f, full)
    const result = await f.dispatch(chunkPlan(f, { mode: "resource", resourceUrl: "/data.json", maxBytes: 6, maxChunks: 3 }))
    expect(result.data.state).toBe("verified")
    expect(requests.map(request => request.offsetBytes)).toEqual([0, 6])
    expect(result.data.reads).toMatchObject([{ content: full, contentBytes: 11, truncated: false,
      snapshotSha256: sha256(full), resource: { url: "https://fixture.invalid/data.json", status: 200,
        contentType: "application/json; charset=utf-8" } }])
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
  } finally { await f.dispose() }
})

for (const fault of ["status", "type", "url", "metadata-changed"] as const) {
  test(`порционное чтение ресурса: ${fault} не выдаёт успешный источник`, async () => {
    const f = fixture()
    try {
      const requests = chunkSource(f, "{\"ok\":true}")
      const read = f.browserDriver.readResource.bind(f.browserDriver)
      f.browserDriver.readResource = async (...args) => {
        const chunk = await read(...args)
        if (fault === "status") chunk.status = 403
        if (fault === "type") chunk.contentType = "image/png"
        if (fault === "url") chunk.url = "https://foreign.invalid/data.json"
        if (fault === "metadata-changed" && requests.length === 2) chunk.contentType = "text/plain"
        return chunk
      }
      const result = await f.dispatch(chunkPlan(f, { mode: "resource", resourceUrl: "/data.json", maxBytes: 6, maxChunks: 3 }))
      expect(result.data.state).toBe("stopped")
      expect(result.data.reads).toEqual([])
      if (fault === "status") expect(result.data.failure).toContain("HTTP 403")
      expect(requests).toHaveLength(fault === "metadata-changed" ? 2 : 1)
      expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
    } finally { await f.dispose() }
  })
}

test("порционное чтение: пустой снимок завершается одним чтением", async () => {
  const f = fixture()
  try {
    const requests = chunkSource(f, "")
    const result = await f.dispatch(chunkPlan(f, { maxBytes: 4, maxChunks: 8 }))
    expect(result.data.state).toBe("verified")
    expect(requests).toHaveLength(1)
    expect(result.data.reads).toMatchObject([{ content: "", contentBytes: 0, totalBytes: 0,
      nextOffsetBytes: 0, snapshotSha256: sha256(""), truncated: false }])
  } finally { await f.dispose() }
})

test("порционное чтение: недопустимые параметры и общий бюджет отвергаются до connect", async () => {
  const f = fixture()
  try {
    for (const options of [
      { offsetBytes: 1 }, { maxChunks: 9 }, { maxChunks: 0 }, { maxBytes: 32769 },
      { maxBytes: 32768, maxChunks: 3 }, { expectedSnapshotSha256: "bad" },
      { mode: "accessibility", maxChunks: 2 }, { mode: "accessibility", offsetBytes: 1, expectedSnapshotSha256: "aa".repeat(32) },
      { mode: "resource" }, { resourceUrl: "/data.json" },
      { mode: "resource", resourceUrl: "https://foreign.invalid/data.json" },
      { mode: "resource", resourceUrl: "https://user:pass@fixture.invalid/data.json" },
    ]) await expect(f.dispatch(chunkPlan(f, options))).rejects.toThrow()
    const multi = f.chrome()
    await expect(f.dispatch({ ...multi, steps: multi.steps.map(step => step.id === "read-one"
      ? { ...step, maxChunks: 2 } : step) })).rejects.toThrow("бюджет")
    expect(f.driver.connectCalls).toBe(0)
    expect(f.counts().clicks).toBe(0)
  } finally { await f.dispose() }
})

test("порционное чтение: восемь частей и 64 KiB текста с JSON-экранированием", async () => {
  const f = fixture()
  try {
    const full = "\u0000".repeat(65_536)
    const requests = chunkSource(f, full)
    const result = await f.dispatch(chunkPlan(f, { maxBytes: 8192, maxChunks: 8 }))
    expect(result.data.state).toBe("verified")
    expect(requests.map(request => request.offsetBytes)).toEqual([0, 8192, 16384, 24576, 32768, 40960, 49152, 57344])
    expect(result.data.reads).toMatchObject([{ content: full, contentBytes: 65_536,
      nextOffsetBytes: 65_536, sha256: sha256(full), truncated: false }])
    const steps = result.data.steps as Array<{ id: string, operationIds: string[] }>
    expect(new Set(steps.find(step => step.id === "read-one")!.operationIds).size).toBe(8)
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(1024 * 1024)
    expect(result.data.connectionCleanup).toBe("confirmed-disconnected")
  } finally { await f.dispose() }
})

test("порционное чтение: отмена на второй части не повторяет чтение или connect", async () => {
  const f = fixture()
  try {
    const requests = chunkSource(f, "0123456789")
    const controller = new AbortController()
    const read = f.browserDriver.readDom.bind(f.browserDriver)
    f.browserDriver.readDom = async (...args) => {
      const chunk = await read(...args)
      if (requests.length === 2) controller.abort(new Error("Отмена изолированного чтения"))
      return chunk
    }
    const input = chunkPlan(f, { maxBytes: 4, maxChunks: 3 })
    await expect(f.dispatch(input, controller.signal)).rejects.toThrow()
    const result = await f.dispatch(input)
    expect(result.data.state).toBe("stopped")
    expect(result.data.reads).toEqual([])
    expect(requests).toHaveLength(2)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("порционное чтение проходит реальный agent gateway, но не расширяет разрешения клиента", async () => {
  const f = fixture()
  try {
    const full = "{\"ok\":true}"
    const requests = chunkSource(f, full)
    registerAgentService(f.registry, f.core, { expectedHostname: hostname() })
    const input = { node: "computer", action: "run_pipeline",
      input: chunkPlan(f, { mode: "resource", resourceUrl: "/data.json", maxBytes: 6, maxChunks: 3 }) }
    await expect(f.registry.dispatch(f.session, "agent_request", { ...input,
      allowedActions: computerActions.filter(action => action !== "browser_chrome_operation") },
      new AbortController().signal)).rejects.toThrow("browser_chrome_operation")
    expect(f.driver.connectCalls).toBe(0)
    expect(requests).toHaveLength(0)
    const response = await f.registry.dispatch(f.session, "agent_request", input, new AbortController().signal)
    expect(response.isError).not.toBe(true)
    expect(response.data.payload).toMatchObject({ state: "verified", connectionCleanup: "confirmed-disconnected",
      reads: [{ content: full, nextOffsetBytes: 11, totalBytes: 11, snapshotSha256: sha256(full) }] })
    expect(requests).toHaveLength(2)
    expect(f.driver.connectCalls).toBe(1)
    expect(f.driver.disconnectCalls).toBe(1)
  } finally { await f.dispose() }
})
