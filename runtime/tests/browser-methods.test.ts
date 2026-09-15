import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  browserOperationResources,
  freezeAdapterHostContext,
  runtimeOperationIntentSchema,
  type DeviceBrowserAdapter,
} from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerBrowserMethods } from "../src/browser-methods.ts"
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
  fixture.runtime.sealAdmission()
  expect(registry.descriptors().tools.map(tool => tool.name)).toEqual(["browser_chrome_recover"])
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
  fixture.runtime.sealAdmission()
  expect(registry.descriptors().tools.map(tool => tool.name)).toEqual(["android_chrome_recover"])
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

function readyCapabilities(runtime: ReturnType<typeof browserFixture>["runtime"]): void {
  runtime.updateCapabilities({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:browser-method-test",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })),
  })
}
