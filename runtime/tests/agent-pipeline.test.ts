import { expect, test } from "bun:test"
import { CAPABILITY_IDS, z } from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { FixtureBrowserDriver } from "./browser-fixture.ts"
import { createBrowserHostComposition } from "../src/browser-host.ts"
import { registerBrowserMethods } from "../src/browser-methods.ts"
import { RuntimeCore } from "../src/core.ts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { pipelineInputSchema, registerAgentPipelineMethods } from "../src/agent-pipeline.ts"
import type { PipelineObservation } from "../src/pipeline-conditions.ts"

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
  driver.readDom = async id => { reads.push(id); return { content: "<main>pipeline fixture</main>", truncated: false } }
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
  registry.register("get_state", method(async () => ({ complete: true, errors: [],
    windows: [{ targetId, pid: 101, focused: String(focused), visibility: "current", hidden: "false", minimized: "false" }],
    applications: [{ pid: 101, bundleId: "com.google.Chrome", axStatus: "ready" }],
  })))
  registry.register("check_input", method(async () => {
    probes++; order.push("probe"); return { inputReady: true, operationId: `operation:probe:${probes}` }
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
    const root = { elementId: `root:${inspections}`, role: "AXWindow", subrole: "AXStandardWindow", title: "Chrome",
      frame: frame(0, 0, 800, 600), actions: [] }
    const web = { elementId: `web:${inspections}`, parentElementId: root.elementId, role: "AXWebArea", subrole: "", title: "Page", frame: frame(0, 0, 800, 600), actions: [] }
    const dialog = { elementId: `dialog:${inspections}`, parentElementId: fakeDialog ? web.elementId : root.elementId,
      role: "AXGroup", subrole: "AXApplicationAlertDialog", title: "Consent fixture", frame: frame(200, 200, 400, 200), actions: [] }
    const button = { elementId: `allow:${inspections}`, parentElementId: dialog.elementId, role: "AXButton", subrole: "", title: "Allow",
      frame: frame(480, 340, 100, 30), actions: ["AXPress"] }
    lastObservation = { targetId, state: "", complete: true, errors: [], elements: [root,
      ...(inspections <= missing ? [] : [...(fakeDialog ? [web] : []), dialog, button])] }
    return lastObservation
  }), frames: value => value.imageId ? ["frame:final"] : [] })
  registry.register("click", { ...method(async value => {
    expect(order.at(-1)).toBe("observe")
    expect(probes).toBeGreaterThan(clicks + shortcuts)
    expect(value.elementId).toBe(lastObservation?.elements.at(-1)?.elementId)
    clicks++; order.push("click")
    if (!partial && !deny) allow()
    return { targetId, operationId: `operation:click:${clicks}`,
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
  const chrome = () => pipelineInputSchema.parse({ ...base, clientRequestId: "pipeline:chrome", steps: [
    { id: "start", kind: "chrome-connect", instance: { ...generation, browserInstanceRef: "chrome:pipeline", transportGeneration: "transport:initial" } },
    { id: "consent", kind: "chrome-consent", when }, { id: "connected", kind: "chrome-wait" },
    { id: "read-one", kind: "chrome-read", url: "https://fixture.invalid/pipeline" },
    { id: "read-two", kind: "chrome-read", url: "https://fixture.invalid/pipeline" },
    { id: "disconnect", kind: "chrome-disconnect" },
  ], final: { chromeDisconnected: true, caption: "Isolated final Chrome frame" } })
  const dispatch = (input: unknown, signal = new AbortController().signal) => {
    externalCalls++; return registry.dispatch(session, "run_pipeline", input, signal)
  }
  return { core, registry, targets, session, targetId, when, native, chrome, dispatch, driver: fixtureDriver, reads, order,
    setFocus(value: boolean) { focused = value }, fakeDialog() { fakeDialog = true }, partial() { partial = true }, deny() { deny = true },
    changeFinal() { finalChanged = true }, replaceTab() { replaceTab = true },
    missing(count: number) { missing = count },
    counts: () => ({ inspections, clicks, shortcuts, captures, externalCalls }),
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
