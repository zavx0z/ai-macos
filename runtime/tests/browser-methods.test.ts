import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  browserOperationResources,
  capturePolicySha256,
  freezeAdapterHostContext,
  runtimeOperationIntentSchema,
  type DeviceBrowserAdapter,
} from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerBrowserMethods, type BrowserCaptureMethodRequest } from "../src/browser-methods.ts"
import { browserFixture } from "./browser-fixture.ts"

test("Chrome methods проходят lifetime coordinator и сохраняют exact lineage", async () => {
  const fixture = browserFixture()
  readyCapabilities(fixture.runtime)
  const registry = new MethodRegistry(fixture.runtime)
  registerBrowserMethods(registry, fixture.runtime, {
    browser: {
      bindingId: "browser",
      adapter: fixture.adapter,
      async reserveCapture() { throw new Error("capture reservation not used") },
    },
  })
  expect(registry.descriptors().tools.map(tool => tool.name).sort()).toEqual([
    "browser_chrome_instances",
    "browser_chrome_operation",
    "browser_chrome_recover",
    "browser_chrome_reservation",
    "browser_chrome_resume",
    "browser_chrome_targets",
  ])
  const publicSchema = JSON.stringify(
    registry.descriptors().tools.find(tool => tool.name === "browser_chrome_operation")!.inputSchema,
  )
  expect(publicSchema).toContain("capture-target")
  expect(publicSchema).not.toContain("publication")
  expect(publicSchema).not.toContain("cacheScopeRef")
  expect(publicSchema).not.toContain("frameRef")

  const session = fixture.credential.session
  const request = { kind: "connect-instance" as const, instance: fixture.initial }
  const intent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "method:connect",
    precondition: { target: { kind: "browser-instance", ref: fixture.initial }, inventoryId: "inventory:1", inventoryRevision: 1 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(request),
  })
  const connected = await registry.dispatch(session, "browser_chrome_operation", { intent, request }, new AbortController().signal)
  expect(connected.isError).toBe(false)
  expect(connected.data.operation).toMatchObject({ state: "completed" })
  const value = connected.data.result as { ok: boolean, value?: { value: { kind: string, instance: { ref: typeof fixture.initial } } } }
  if (!value.ok || value.value?.value.kind !== "instance-connected") throw new Error("Expected connected instance")
  const actual = value.value.value.instance.ref
  fixture.register(actual, 2)

  const reservation = await registry.dispatch(session, "browser_chrome_reservation", {
    target: { kind: "browser-instance", ref: actual },
  }, new AbortController().signal)
  expect(reservation.data.reservation).toMatchObject({ state: "active", target: { ref: actual } })

  const foreign = fixture.runtime.openClient("principal:foreign").session
  await expect(registry.dispatch(foreign, "browser_chrome_reservation", {
    target: { kind: "browser-instance", ref: actual },
  }, new AbortController().signal)).rejects.toThrow("lineage")
})

test("Android catalogue остаётся opt-in и capability-gated", () => {
  const fixture = browserFixture()
  readyCapabilities(fixture.runtime)
  const registry = new MethodRegistry(fixture.runtime)
  registerBrowserMethods(registry, fixture.runtime, {})
  expect(registry.descriptors().tools).toHaveLength(0)

  const host = freezeAdapterHostContext({
    generation: fixture.runtime.generation,
    runtimeBuildId: "runtime:device-method-test",
    capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "device:fixture", capabilities: [] },
  })
  const device = {
    host,
    services: fixture.runtime.services,
    capabilities: ["android.chrome"] as const,
    async listDevices() { throw new Error("not used") },
    async listInstances() { throw new Error("not used") },
    async listTargets() { throw new Error("not used") },
    async execute() { throw new Error("not used") },
  } satisfies DeviceBrowserAdapter
  registerBrowserMethods(registry, fixture.runtime, {
    device: {
      bindingId: "android",
      adapter: device,
      async reserveCapture() { throw new Error("not used") },
    },
  })
  expect(registry.descriptors().tools.map(tool => tool.name).sort()).toEqual([
    "android_chrome_devices",
    "android_chrome_instances",
    "android_chrome_operation",
    "android_chrome_recover",
    "android_chrome_reservation",
    "android_chrome_resume",
    "android_chrome_targets",
  ])
  const publicSchema = JSON.stringify(
    registry.descriptors().tools.find(tool => tool.name === "android_chrome_operation")!.inputSchema,
  )
  expect(publicSchema).not.toContain("publication")
  expect(publicSchema).not.toContain("cacheScopeRef")
  expect(publicSchema).not.toContain("frameRef")
})

test("pre-aborted method не достигает lifetime coordinator", async () => {
  const fixture = browserFixture()
  readyCapabilities(fixture.runtime)
  const registry = new MethodRegistry(fixture.runtime)
  registerBrowserMethods(registry, fixture.runtime, {
    browser: { bindingId: "browser", adapter: fixture.adapter, async reserveCapture() { throw new Error("not used") } },
  })
  const controller = new AbortController()
  controller.abort()
  await expect(registry.dispatch(fixture.credential.session, "browser_chrome_instances", {}, controller.signal)).rejects.toThrow("отменён")
  expect(fixture.driver.connectCalls).toBe(0)
})

test("in-flight method cancellation достигает browser driver", async () => {
  const fixture = browserFixture()
  readyCapabilities(fixture.runtime)
  const session = fixture.credential.session
  const connected = await fixture.invoke(session, "cancel:connect", {
    kind: "connect-instance",
    instance: fixture.initial,
  }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  fixture.register(instance, 2)
  let started = () => {}
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  let driverAborted = false
  const driver = fixture.driver as unknown as BrowserDriver
  driver.openTarget = async (_url, signal): Promise<never> => {
    started()
    await new Promise<never>((_, reject) => {
      const onAbort = () => {
        driverAborted = true
        reject(new DOMException("fixture aborted", "AbortError"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    throw new Error("unreachable")
  }
  const registry = new MethodRegistry(fixture.runtime)
  registerBrowserMethods(registry, fixture.runtime, {
    browser: { bindingId: "browser", adapter: fixture.adapter, async reserveCapture() { throw new Error("not used") } },
  })
  const request = { kind: "open-target" as const, instance, url: "https://example.test", policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] }, timeoutMs: 5_000 }
  const intent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "cancel:open",
    precondition: { target: { kind: "browser-instance", ref: instance }, inventoryId: "inventory:2", inventoryRevision: 2 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(request),
  })
  const controller = new AbortController()
  const pending = registry.dispatch(session, "browser_chrome_operation", { intent, request }, controller.signal)
  await startedPromise
  controller.abort()
  await expect(pending).rejects.toThrow("отменён")
  await Bun.sleep(0)
  expect(driverAborted).toBe(true)
})

test("capture retry использует одну runtime publication по lineage и clientRequestId", async () => {
  const fixture = browserFixture()
  readyCapabilities(fixture.runtime)
  const publications = new Map<string, ReturnType<typeof publication>>()
  const registry = new MethodRegistry(fixture.runtime)
  registerBrowserMethods(registry, fixture.runtime, {
    browser: {
      bindingId: "browser",
      adapter: fixture.adapter,
      async reserveCapture(session, intent, request) {
        const key = `${fixture.runtime.clients.lineage(session)}:${intent.clientRequestId}`
        let reserved = publications.get(key)
        if (reserved === undefined) {
          reserved = publication(fixture.runtime.generation, request, key)
          publications.set(key, reserved)
          fixture.runtime.frames.registerPublication(reserved)
        }
        return { ...request, capture: { ...request.capture, publication: reserved } }
      },
    },
  })
  const session = fixture.credential.session
  const connectRequest = { kind: "connect-instance" as const, instance: fixture.initial }
  const connectIntent = runtimeOperationIntentSchema.parse({
    intent: "mutation", clientRequestId: "capture:connect",
    precondition: { target: { kind: "browser-instance", ref: fixture.initial }, inventoryId: "inventory:1", inventoryRevision: 1 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(), requestedResources: browserOperationResources(connectRequest),
  })
  const connected = await registry.dispatch(session, "browser_chrome_operation", { intent: connectIntent, request: connectRequest }, new AbortController().signal)
  const connectResult = connected.data.result as { ok: boolean, value?: { value: { instance: { ref: typeof fixture.initial } } } }
  if (!connectResult.ok || !connectResult.value) throw new Error("connect failed")
  const instance = connectResult.value.value.instance.ref
  fixture.register(instance, 2)
  const target = { ...instance, targetId: "target:capture", resourceRef: "target-resource:capture" }
  fixture.runtime.targets.register({ kind: "browser-target", ref: target }, "inventory:3", 3, "resolution:3", "proof:3", 0)
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
  const driver = fixture.driver as unknown as BrowserDriver
  driver.listTargets = async () => [{ id: target.targetId, type: "page", title: "Capture", url: "https://example.test", webSocketDebuggerUrl: "ws://fixture" }]
  driver.captureTarget = async (_id, request) => ({ bytes: png, width: 1, height: 1, capturedAt: new Date().toISOString(), readiness: { state: "ready", policy: request.readinessPolicy, steps: [], timedOut: false } })
  const capture = {
    source: "browser-viewport" as const,
    caption: "Ожидаю fixture capture",
    target: { kind: "browser-target" as const, ref: target },
    clip: { kind: "full-target" as const },
    fullPage: false,
    cursor: "exclude" as const,
    readinessPolicy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
    output: { format: "image/png" as const, scale: 1, maxWidthPx: 10, maxHeightPx: 10, maxPixels: 100, maxEncodedBytes: 1024 },
  }
  const request = { kind: "capture-target" as const, target, capture }
  const intent = runtimeOperationIntentSchema.parse({
    intent: "read", clientRequestId: "capture:retry",
    precondition: { target: { kind: "browser-target", ref: target }, inventoryId: "inventory:3", inventoryRevision: 3 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(), requestedResources: [],
  })
  const first = await registry.dispatch(session, "browser_chrome_operation", { intent, request }, new AbortController().signal)
  const second = await registry.dispatch(session, "browser_chrome_operation", { intent, request }, new AbortController().signal)
  expect(second.data.operation).toEqual(first.data.operation)
  expect(second.frameRefs).toEqual(first.frameRefs)
  expect(publications).toHaveLength(1)
})

function publication(
  generation: { runtimeEpoch: string, loginSessionId: string },
  request: BrowserCaptureMethodRequest,
  key: string,
) {
  const capturePolicy = {
    clip: request.capture.clip,
    fullPage: request.capture.fullPage,
    cursor: request.capture.cursor,
    readinessPolicy: request.capture.readinessPolicy,
    output: request.capture.output,
  }
  return {
    observationId: `observation:${Bun.hash(key)}`,
    frameRef: `frame:${Bun.hash(key)}`,
    source: request.capture.source,
    captureTarget: request.capture.target,
    capturePolicySha256: capturePolicySha256(capturePolicy as Parameters<typeof capturePolicySha256>[0]),
    ...generation,
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    inventoryId: "inventory:3",
    inventoryRevision: 3,
    displayLayoutRevision: 0,
    cacheScopeRef: key.split(":capture:retry")[0]!,
  }
}

function readyCapabilities(runtime: ReturnType<typeof browserFixture>["runtime"]): void {
  runtime.updateCapabilities({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:browser-method-test",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })),
  })
}
