import { expect, test } from "bun:test"
import { NativeBrokerAdapter } from "@meta/native/adapter"
import { CAPABILITY_IDS, type RuntimeResourceHandle } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerWindowMethods, type RuntimeWindowAdapter } from "../src/window-methods.ts"

const generation = { runtimeEpoch: "runtime:window-methods", loginSessionId: "login:window-methods", nativeGeneration: "native:window-methods" }
const target = { ...generation, applicationRef: "app:1", windowRef: "window:1" }
function fixture() {
  const runtimeGeneration = { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId }
  const native = new NativeBrokerAdapter({ adapterInstanceRef: "adapter:fixture",
    host: { generation: runtimeGeneration, runtimeBuildId: "build:fixture", capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "fixture", capabilities: [] } },
    transport: { async send() { throw new Error("fixture transport unavailable") }, async *packets() {}, async close() {} },
    ledgerSink: { async persist() { throw new Error("fixture has no native events") } },
    bindEvidence() { throw new Error("fixture has no evidence events") },
  })
  const core = new RuntimeCore({ generation: runtimeGeneration, runtimeBuildId: "build:fixture", native,
    nativeGeneration: generation.nativeGeneration, cancelGraceMs: 1 })
  core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "fixture",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
  core.targets.register({ kind: "window", ref: target }, "inventory:1", 1, "resolution:1", "proof:identity", 1)
  let calls = 0
  let inspected = 0
  let presses = 0
  let resources: readonly RuntimeResourceHandle[] = []
  const windows: RuntimeWindowAdapter = {
    host: native.host, services: core.services, capabilities: [],
    async inventory() {
      const now = new Date().toISOString()
      return { ...generation, inventoryId: "inventory:1", revision: 1, displayLayoutRevision: 1,
        capturedAt: now, complete: true, errors: [], displays: [],
        applications: [1, 2].map(id => ({ ref: { ...generation, applicationRef: `app:${id}`, pid: id,
          launchedAt: now, registrationNonce: `process:${id}` }, name: "Google Chrome", hidden: "true", axStatus: "ready", windowCount: 1 })),
        windows: [1, 2].map(id => ({ kind: "cg-only", ...generation, cgEntryRef: `cg:${id}`, ownerPid: id, cgWindowId: id,
          title: "Одинаковый заголовок", frame: { x: 0, y: 0, width: 10, height: 10 }, onScreen: "false",
          actionability: "unavailable", reason: "Нет AX mapping" })),
      }
    },
    async transition(context) { calls++; resources = context.resources; throw new Error("Ответ после возможного dispatch потерян") },
    async inspect(request) { inspected++; return { target: request.target, snapshotId: "snapshot:1", complete: true,
      nodes: [], nodeCount: 0, encodedBytes: 2, errors: [] } },
    async press(context) { presses++; resources = context.resources; throw new Error("Ответ AXPress потерян") },
  }
  const registry = new MethodRegistry(core)
  registerWindowMethods(registry, core, windows)
  const session = core.openClient("principal:fixture").session
  return { core, registry, session, calls: () => calls, inspected: () => inspected,
    presses: () => presses, resources: () => resources }
}

test("фильтр PID различает два одноимённых Chrome без подмены окна", async () => {
  const { registry, session } = fixture()
  const result = await registry.dispatch(session, "list_windows", { app: "Google Chrome", pid: 2 }, new AbortController().signal)
  expect(result.data.applications).toMatchObject([{ ref: { pid: 2 } }])
  expect(result.data.windows).toMatchObject([{ ownerPid: 2 }])
  expect(result.data.complete).toBe(true)
})

test("unknown transition сохраняет operation и не повторяет действие по clientRequestId", async () => {
  const f = fixture()
  const input = { inventoryId: "inventory:1", inventoryRevision: 1, clientRequestId: "request:show",
    request: { kind: "show", target } }
  const first = await f.registry.dispatch(f.session, "window_transition", input, new AbortController().signal)
  const repeated = await f.registry.dispatch(f.session, "window_transition", input, new AbortController().signal)
  expect(first.isError).toBe(true)
  expect(repeated.data).toEqual(first.data)
  expect(f.calls()).toBe(1)
  expect(f.resources()).toMatchObject([{ kind: "desktop-input", resourceRef: "desktop", principalId: "principal:fixture" }])
})

test("stale AX inventory и чужой target не доходят до backend", async () => {
  const f = fixture()
  const input = { inventoryId: "inventory:1", inventoryRevision: 1, request: {
    target: { kind: "window", ref: target }, depth: 2, maxNodes: 20, maxBytes: 1000 } }
  await expect(f.registry.dispatch(f.session, "inspect_accessibility", { ...input, inventoryRevision: 0 }, new AbortController().signal)).rejects.toThrow("stale")
  await expect(f.registry.dispatch(f.session, "inspect_accessibility", { ...input,
    request: { ...input.request, target: { kind: "window", ref: { ...target, windowRef: "window:other" } } } }, new AbortController().signal)).rejects.toThrow("не зарегистрирован")
  expect(f.inspected()).toBe(0)
  const result = await f.registry.dispatch(f.session, "inspect_accessibility", input, new AbortController().signal)
  expect(result.data.snapshotId).toBe("snapshot:1")
})

test("AXPress связывает retained element с exact parent и сохраняет unknown operation без replay", async () => {
  const f = fixture()
  const element = { ...generation, applicationRef: target.applicationRef,
    snapshotId: "snapshot:1", elementRef: "element:save" }
  const input = {
    clientRequestId: "request:ax-press",
    precondition: { target: { kind: "window", ref: target }, inventoryId: "inventory:1", inventoryRevision: 1 },
    request: { element },
  } as const
  await expect(f.registry.dispatch(f.session, "press_accessibility", {
    ...input,
    request: { element: { ...element, applicationRef: "app:other" } },
  }, new AbortController().signal)).rejects.toThrow("exact parent window")
  await expect(f.registry.dispatch(f.session, "press_accessibility", {
    ...input,
    precondition: { ...input.precondition, inventoryRevision: 0 },
  }, new AbortController().signal)).rejects.toThrow("stale")
  const first = await f.registry.dispatch(f.session, "press_accessibility", input, new AbortController().signal)
  const repeated = await f.registry.dispatch(f.session, "press_accessibility", input, new AbortController().signal)
  expect(first).toMatchObject({ isError: true, data: { operation: {
    state: "interrupted-unknown",
    context: { target: { kind: "window", ref: target } },
    outcome: { cleanup: { state: "unknown" } },
  } } })
  expect(repeated.data).toEqual(first.data)
  expect(f.presses()).toBe(1)
  expect(f.resources()).toMatchObject([{ kind: "desktop-input", resourceRef: "desktop" }])
})

test("AXPress принимает exact surface parent, не расширяя target до owner window", async () => {
  const f = fixture()
  const surface = { kind: "surface" as const, ref: { ...generation, applicationRef: target.applicationRef,
    surfaceRef: "surface:save", ownerWindowRef: target.windowRef } }
  f.core.targets.register(surface, "inventory:1", 1, "resolution:surface", "proof:surface", 1)
  const input = { clientRequestId: "request:surface-press", precondition: { target: surface, inventoryId: "inventory:1", inventoryRevision: 1 },
    request: { element: { ...generation, applicationRef: target.applicationRef, snapshotId: "snapshot:surface", elementRef: "element:save" } } }
  await expect(f.registry.dispatch(f.session, "press_accessibility", {
    ...input, request: { element: { ...input.request.element, applicationRef: "app:foreign" } },
  }, new AbortController().signal)).rejects.toThrow("exact parent")
  const result = await f.registry.dispatch(f.session, "press_accessibility", input, new AbortController().signal)
  expect(result.data).toMatchObject({ operation: { context: { target: surface }, state: "interrupted-unknown" } })
  expect(f.presses()).toBe(1)
})
