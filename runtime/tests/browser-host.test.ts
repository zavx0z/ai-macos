import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  browserOperationResources,
  runtimeOperationIntentSchema,
  type AdapterResult,
  type BrowserOperationResult,
} from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerBrowserMethods } from "../src/browser-methods.ts"
import { createBrowserHostComposition } from "../src/browser-host.ts"
import { FixtureBrowserDriver } from "./browser-fixture.ts"

test("configured existing Chrome не запускается до explicit connect и публикует browser proof", async () => {
  const generation = { runtimeEpoch: "runtime:browser-host", loginSessionId: "login:browser-host" }
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "build:browser-host", nativeGeneration: "native:mixed-host" })
  runtime.updateCapabilities({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:browser-host",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })),
  })
  const fixture = new FixtureBrowserDriver()
  const secondFixture = new FixtureBrowserDriver()
  const driver = fixture as unknown as BrowserDriver
  const composition = createBrowserHostComposition(runtime, {
    chrome: {
      bindingId: "browser",
      instances: [
        {
          browserInstanceRef: "browser:configured",
          initialTransportGeneration: "transport:0",
          endpointHost: "127.0.0.1",
          endpointPort: 9222,
          profilePath: "/configured/existing-profile",
          profileLabel: "Required",
          driver,
        },
        {
          browserInstanceRef: "browser:second-profile",
          initialTransportGeneration: "transport:second:0",
          endpointHost: "127.0.0.1",
          endpointPort: 9333,
          profilePath: "/configured/second-profile",
          profileLabel: "Second",
          driver: secondFixture,
        },
      ],
    },
  })
  expect(fixture.connectCalls).toBe(0)
  expect(secondFixture.connectCalls).toBe(0)
  expect(composition.device).toBeUndefined()
  expect(composition.capabilitySet.capabilities.map(capability => capability.id)).not.toContain("android.chrome")

  const registry = new MethodRegistry(runtime)
  registerBrowserMethods(registry, runtime, composition.bindings)
  const session = runtime.openClient("principal:browser-host").session
  const initial = {
    ...generation,
    browserInstanceRef: "browser:configured",
    transportGeneration: "transport:0",
  }
  const connectRequest = { kind: "connect-instance" as const, instance: initial }
  const connectIntent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "host:connect",
    precondition: { target: { kind: "browser-instance", ref: initial }, inventoryId: "browser-host:browser:browser:configured:initial", inventoryRevision: 0 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(connectRequest),
  })
  const connected = await registry.dispatch(session, "browser_chrome_operation", {
    intent: connectIntent,
    request: connectRequest,
  }, new AbortController().signal)
  expect(connected.data.operation).toMatchObject({ state: "completed" })
  expect(fixture.connectCalls).toBe(1)
  expect(secondFixture.connectCalls).toBe(0)

  const secondInitial = {
    ...generation,
    browserInstanceRef: "browser:second-profile",
    transportGeneration: "transport:second:0",
  }
  const secondConnect = { kind: "connect-instance" as const, instance: secondInitial }
  const secondIntent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "host:connect:second",
    precondition: { target: { kind: "browser-instance", ref: secondInitial }, inventoryId: "browser-host:browser:browser:second-profile:initial", inventoryRevision: 0 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(secondConnect),
  })
  await registry.dispatch(session, "browser_chrome_operation", {
    intent: secondIntent,
    request: secondConnect,
  }, new AbortController().signal)
  expect(secondFixture.connectCalls).toBe(1)

  const instances = await registry.dispatch(session, "browser_chrome_instances", {}, new AbortController().signal)
  const instanceRecords = instances.data.instances as Array<{ ref: typeof initial, state: string }>
  const actual = instanceRecords.find(instance => instance.ref.browserInstanceRef === "browser:configured")!.ref
  const secondActual = instanceRecords.find(instance => instance.ref.browserInstanceRef === "browser:second-profile")!.ref
  driver.listTargets = async () => [{ id: "target:fixture", type: "page", title: "Fixture", url: "https://example.test", webSocketDebuggerUrl: "ws://fixture" }]
  const secondDriver = secondFixture as unknown as BrowserDriver
  secondDriver.listTargets = async () => [{ id: "target:second", type: "page", title: "Second", url: "https://example.test", webSocketDebuggerUrl: "ws://second" }]
  const targets = await registry.dispatch(session, "browser_chrome_targets", { instance: actual }, new AbortController().signal)
  const secondTargets = await registry.dispatch(session, "browser_chrome_targets", { instance: secondActual }, new AbortController().signal)
  const target = (targets.data.targets as Array<{ ref: typeof actual & { targetId: string, resourceRef: string } }>)[0]!.ref
  expect(target).toMatchObject({ ...actual, targetId: "target:fixture" })
  expect((secondTargets.data.targets as Array<{ ref: typeof target }>)[0]!.ref).toMatchObject({
    ...secondActual,
    targetId: "target:second",
  })

  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
  driver.captureTarget = async (_id, request) => ({
    bytes: png,
    width: 1,
    height: 1,
    capturedAt: new Date().toISOString(),
    readiness: { state: "ready", policy: request.readinessPolicy, steps: [], timedOut: false },
  })
  const capture = {
    source: "browser-viewport" as const,
    caption: "Ожидаю browser fixture",
    target: { kind: "browser-target" as const, ref: target },
    clip: { kind: "full-target" as const },
    fullPage: false,
    cursor: "exclude" as const,
    readinessPolicy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
    output: { format: "image/png" as const, scale: 1, maxWidthPx: 10, maxHeightPx: 10, maxPixels: 100, maxEncodedBytes: 1024 },
  }
  const request = { kind: "capture-target" as const, target, capture }
  const inventoryId = String(targets.data.inventoryId)
  const inventoryRevision = Number(targets.data.inventoryRevision)
  const intent = runtimeOperationIntentSchema.parse({
    intent: "read",
    clientRequestId: "host:capture",
    precondition: { target: { kind: "browser-target", ref: target }, inventoryId, inventoryRevision },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: [],
  })
  const captured = await registry.dispatch(session, "browser_chrome_operation", { intent, request }, new AbortController().signal)
  expect(captured.isError).toBe(false)
  expect(captured.frameRefs).toHaveLength(1)
  const result = captured.data.result as AdapterResult<BrowserOperationResult>
  if (!result.ok || result.value.value.kind !== "target-captured") throw new Error("browser capture expected")
  const evidence = result.value.value.capture.observation.captureEvidence
  expect(evidence.state).toBe("confirmed")
  if (evidence.state !== "confirmed") throw new Error("browser proof expected")
  expect(evidence.proof).not.toHaveProperty("nativeGeneration")
  const repeated = await registry.dispatch(session, "browser_chrome_operation", { intent, request }, new AbortController().signal)
  expect(repeated.data.operation).toEqual(captured.data.operation)
  expect(repeated.frameRefs).toEqual(captured.frameRefs)
})

test("Android host binding создаётся только из exact opt-in config", () => {
  const runtime = new RuntimeCore({
    generation: { runtimeEpoch: "runtime:android-host", loginSessionId: "login:android-host" },
    runtimeBuildId: "build:android-host",
  })
  const driver = {
    async listDevices() { return [{ serial: "phone-a", state: "device" }] },
    async connect() { return { browserVersion: "Chrome/Test" } },
    async disconnect() {},
    async listTargets() { return [] },
    async openTarget(): Promise<never> { throw new Error("not used") },
    async closeTarget() {},
    async navigateTarget(): Promise<never> { throw new Error("not used") },
    async reloadTarget(): Promise<never> { throw new Error("not used") },
    async waitTarget(): Promise<never> { throw new Error("not used") },
    async captureTarget(): Promise<never> { throw new Error("not used") },
  }
  const composition = createBrowserHostComposition(runtime, {
    android: {
      bindingId: "android",
      serial: "phone-a",
      localPort: 9223,
      deviceRef: "device:phone-a",
      initialDeviceTransportGeneration: "usb:0",
      browserInstanceRef: "android-browser:phone-a",
      initialBrowserTransportGeneration: "android-cdp:0",
      driver,
    },
  })
  expect(composition.browser).toBeUndefined()
  expect(composition.device).toBeDefined()
  expect(composition.capabilitySet.capabilities).toEqual([{ id: "android.chrome", state: "ready" }])
})
