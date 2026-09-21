import { expect, test } from "bun:test"
import { browserOperationResources, type OperationTarget } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { BrowserFrameProofAuthority, createBrowserHostComposition } from "../src/browser-host.ts"
import { FixtureBrowserDriver } from "./browser-fixture.ts"

function fixture() {
  let time = Date.now()
  const generation = { runtimeEpoch: "runtime:chrome-ttl", loginSessionId: "login:chrome-ttl" }
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "build:chrome-ttl", clock: { now: () => new Date(time) } })
  const authority = new BrowserFrameProofAuthority(runtime)
  const instance = { ...generation, browserInstanceRef: "chrome:ttl", transportGeneration: "transport:initial" }
  const resolve = (target: OperationTarget, inventoryId = "inventory:1", inventoryRevision = 1) => runtime.targets.resolve({
    ...generation, target, inventoryId, inventoryRevision, deadlineAt: new Date(time + 30_000).toISOString(),
  })
  return { runtime, authority, instance, generation, resolve, advance(ms: number) { time += ms }, now: () => time }
}

for (const kind of ["browser-instance", "browser-target"] as const) {
  test(`Chrome ${kind} сохраняет target между вызовами дольше 5 секунд и истекает через 60`, async () => {
    const f = fixture()
    const target: OperationTarget = kind === "browser-instance"
      ? { kind, ref: f.instance }
      : { kind, ref: { ...f.instance, targetId: "tab:ttl", resourceRef: "cdp:ttl" } }
    f.authority.registerTarget(target, "inventory:1", 1, 0)
    f.advance(5_001)
    await expect(f.resolve(target)).resolves.toMatchObject({ target })
    f.advance(54_998)
    await expect(f.resolve(target)).resolves.toMatchObject({ target })
    f.advance(1)
    await expect(f.resolve(target)).rejects.toThrow("Target stale")
  })
}

test("Chrome TTL не разрешает чужие inventory, target, runtime/login/transport generation", async () => {
  const f = fixture()
  const target: OperationTarget = { kind: "browser-target", ref: { ...f.instance, targetId: "tab:ttl", resourceRef: "cdp:ttl" } }
  f.authority.registerTarget(target, "inventory:1", 1, 0)
  await expect(f.resolve(target, "inventory:other")).rejects.toThrow()
  await expect(f.resolve(target, "inventory:1", 2)).rejects.toThrow()
  for (const field of ["targetId", "resourceRef", "runtimeEpoch", "loginSessionId", "transportGeneration"] as const) {
    await expect(f.resolve({ ...target, ref: { ...target.ref, [field]: "foreign:value" } })).rejects.toThrow()
  }
  f.authority.registerTarget(target, "inventory:2", 2, 0)
  await expect(f.resolve(target)).rejects.toThrow()
  await expect(f.resolve(target, "inventory:2", 2)).resolves.toMatchObject({ target })
})

test("Native и Android сохраняют прежний срок 5 секунд", async () => {
  const f = fixture()
  const native: OperationTarget = { kind: "window", ref: { ...f.generation,
    nativeGeneration: "native:ttl", applicationRef: "app:ttl", windowRef: "window:ttl" } }
  const android: OperationTarget = { kind: "device-browser-instance", ref: { ...f.generation,
    deviceRef: "device:ttl", serial: "phone-ttl", transportGeneration: "usb:ttl",
    browserInstanceRef: "android:ttl", browserTransportGeneration: "cdp:ttl" } }
  f.runtime.targets.register(native, "inventory:1", 1, "resolution:native", "proof:native", 0)
  f.authority.registerTarget(android, "inventory:1", 1, 0)
  f.advance(4_999)
  await expect(f.resolve(native)).resolves.toMatchObject({ target: native })
  await expect(f.resolve(android)).resolves.toMatchObject({ target: android })
  f.advance(1)
  await expect(f.resolve(native)).rejects.toThrow("Target stale")
  await expect(f.resolve(android)).rejects.toThrow("Target stale")
})

test("configured Chrome connect проходит через Core после межвызовной задержки 6 секунд", async () => {
  const f = fixture()
  const driver = new FixtureBrowserDriver()
  const composition = createBrowserHostComposition(f.runtime, { chrome: {
    bindingId: "browser:ttl", instances: [{ ...f.instance,
      initialTransportGeneration: f.instance.transportGeneration,
      connectionMode: "existing-session", userDataDir: "/fixture/chrome-ttl", driver,
    }],
  } })
  const control = { signal: new AbortController().signal, checkpoint() {} }
  const snapshot = await composition.browser!.listInstances(control)
  const instance = snapshot.instances[0]!.ref
  const session = f.runtime.openClient("principal:ttl").session
  const request = { kind: "connect-instance" as const, instance }
  f.advance(6_000)
  try {
    const connected = await f.runtime.browserLifetime.execute(session, "browser:ttl", {
      intent: "mutation", clientRequestId: "ttl:delayed-connect",
      precondition: { target: { kind: "browser-instance", ref: instance },
        inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.inventoryRevision },
      deadlineAt: new Date(f.now() + 30_000).toISOString(), requestedResources: browserOperationResources(request),
    }, request)
    expect(connected.operation.state).toBe("completed")
    expect(connected.result.ok).toBe(true)
    expect(driver.connectCalls).toBe(1)
  } finally {
    await f.runtime.browserLifetime.shutdownLineage()
    await f.runtime.closeClientLifecycle()
  }
})
