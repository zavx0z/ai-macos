import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { browserOperationResources, deviceBrowserOperationResources } from "@meta/shared/contracts"
import type { DeviceBrowserDriver } from "@meta/android/adapter"
import { createRuntimeHost } from "../src/host.ts"
import { FileLifetimeStore } from "../src/lifetime-state.ts"
import { sha256 } from "../src/primitives.ts"
import { FixtureBrowserDriver } from "./browser-fixture.ts"

test("RuntimeHost восстанавливает durable lifetime и запрещает повторный connect после restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-lifetime-"))
  const driver = new FixtureBrowserDriver()
  const loginSessionId = "login:host-lifetime"
  const options = {
    socketPath: join(directory, "runtime.sock"),
    credentialPath: join(directory, "credential.json"),
    stateDirectory: join(directory, "state"),
    runtimeBuildId: "build:host-lifetime",
    expectedNativeBuildId: "build:unused",
    expectedHostname: hostname(),
    loginSessionId,
    browser: { chrome: { bindingId: "browser", instances: [{
      browserInstanceRef: "browser:durable",
      initialTransportGeneration: "transport:initial",
      endpointHost: "127.0.0.1" as const,
      endpointPort: 9222,
      profilePath: "/fixture/durable-profile",
      driver,
    }] } },
  }
  const store = new FileLifetimeStore(join(options.stateDirectory, `login-${sha256(loginSessionId)}`, "lifetimes"))
  let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
  try {
    host = await createRuntimeHost(options)
    const original = await host.core.openClientDurable("principal:durable")
    const connect = (current: NonNullable<typeof host>, session: typeof original.session, clientRequestId: string) => {
      const instance = { ...current.core.generation, browserInstanceRef: "browser:durable", transportGeneration: "transport:initial" }
      const request = { kind: "connect-instance" as const, instance }
      return current.catalog.dispatch(session, "browser_chrome_operation", {
        intent: {
          intent: "mutation", clientRequestId,
          precondition: {
            target: { kind: "browser-instance", ref: instance },
            inventoryId: "browser-host:browser:browser:durable:initial", inventoryRevision: 0,
          },
          deadlineAt: new Date(Date.now() + 5_000).toISOString(),
          requestedResources: browserOperationResources(request),
        },
        request,
      }, new AbortController().signal)
    }
    const connected = await connect(host, original.session, "connect:first")
    expect(connected.data.operation).toMatchObject({ state: "completed" })
    const [persisted] = await store.loadAll()
    expect(persisted?.state).toBe("active")
    expect(driver.connectCalls).toBe(1)
    await host.close()
    host = undefined

    host = await createRuntimeHost(options)
    const resumed = await host.core.resumeClientDurable(original.resumptionToken)
    expect((await store.loadAll())[0]?.state).toBe("quarantined")
    expect(await host.core.reservations.inspect(resumed.session, persisted!.target)).toMatchObject({ state: "quarantined" })
    expect(driver.connectCalls).toBe(1)
    expect(driver.disconnectCalls).toBe(0)
    const repeated = await connect(host, resumed.session, "connect:after-restart")
    expect(repeated.data.operation).toMatchObject({ state: "rejected" })
    expect(driver.connectCalls).toBe(1)
    expect((await store.loadAll())[0]?.state).toBe("quarantined")
  } finally {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("client grace после runtime epoch restart освобождает old Chrome slot и разрешает current connect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-lifetime-recovery-"))
  const driver = new FixtureBrowserDriver()
  const loginSessionId = "login:host-lifetime-recovery"
  const options = {
    socketPath: join(directory, "runtime.sock"),
    credentialPath: join(directory, "credential.json"),
    stateDirectory: join(directory, "state"),
    runtimeBuildId: "build:host-lifetime-recovery",
    expectedNativeBuildId: "build:unused",
    expectedHostname: hostname(),
    loginSessionId,
    browser: { chrome: { bindingId: "browser", instances: [{
      browserInstanceRef: "browser:durable-recovery",
      initialTransportGeneration: "transport:initial",
      endpointHost: "127.0.0.1" as const,
      endpointPort: 9222,
      profilePath: "/fixture/durable-recovery-profile",
      driver,
    }] } },
  }
  const lifetimeStore = new FileLifetimeStore(join(options.stateDirectory, `login-${sha256(loginSessionId)}`, "lifetimes"))
  let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
  try {
    host = await createRuntimeHost(options)
    const oldClient = await host.core.openClientDurable("mcp:old")
    const oldLineage = host.core.clients.lineage(oldClient.session)
    const invokeConnect = (
      current: NonNullable<typeof host>,
      session: typeof oldClient.session,
      clientRequestId: string,
    ) => {
      const instance = {
        ...current.core.generation,
        browserInstanceRef: "browser:durable-recovery",
        transportGeneration: "transport:initial",
      }
      const request = { kind: "connect-instance" as const, instance }
      return current.catalog.dispatch(session, "browser_chrome_operation", {
        intent: {
          intent: "mutation",
          clientRequestId,
          precondition: {
            target: { kind: "browser-instance", ref: instance },
            inventoryId: "browser-host:browser:browser:durable-recovery:initial",
            inventoryRevision: 0,
          },
          deadlineAt: new Date(Date.now() + 5_000).toISOString(),
          requestedResources: browserOperationResources(request),
        },
        request,
      }, new AbortController().signal)
    }
    expect((await invokeConnect(host, oldClient.session, "connect:old")).data.operation).toMatchObject({ state: "completed" })
    const oldEpoch = host.core.generation.runtimeEpoch
    await host.close()
    host = undefined

    host = await createRuntimeHost(options)
    expect(host.core.generation.runtimeEpoch).not.toBe(oldEpoch)
    expect((await lifetimeStore.loadAll())[0]?.state).toBe("quarantined")
    host.core.disconnectClient(oldClient.session.clientSessionId)
    await host.core.browserLifetime.shutdownLineage(oldLineage)
    expect(driver.disconnectCalls).toBe(1)
    expect((await lifetimeStore.loadAll())[0]?.state).toBe("released")

    const currentClient = await host.core.openClientDurable("mcp:current")
    const current = await invokeConnect(host, currentClient.session, "connect:current")
    expect(current.data.operation).toMatchObject({ state: "completed" })
    expect(driver.connectCalls).toBe(2)
    expect(host.core.clients.lineage(currentClient.session)).not.toBe(oldLineage)
  } finally {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Android restart recovery принимает absent forward, но не matching foreign tuple", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-android-lifetime-recovery-"))
  let forward: "absent" | "owned" | "foreign" = "absent"
  let connectCalls = 0
  let disconnectCalls = 0
  const driver: DeviceBrowserDriver = {
    async listDevices() { return [{ serial: "phone-a", state: "device" }] },
    async connect() { connectCalls += 1; forward = "owned"; return { browserVersion: "Chrome/Test" } },
    async disconnect() {
      disconnectCalls += 1
      if (forward === "owned") forward = "absent"
    },
    async forwardStatus() {
      return forward === "owned"
        ? { state: "owned", localPort: 9223, forwardRef: "forward:phone-a" }
        : forward === "foreign"
          ? { state: "foreign", localPort: 9223, reason: "matching tuple без runtime ownership" }
          : { state: "absent" }
    },
    async listTargets() { return [] },
    async openTarget(): Promise<never> { throw new Error("not used") },
    async closeTarget() {},
    async navigateTarget(): Promise<never> { throw new Error("not used") },
    async reloadTarget(): Promise<never> { throw new Error("not used") },
    async waitTarget(): Promise<never> { throw new Error("not used") },
    async captureTarget(): Promise<never> { throw new Error("not used") },
  }
  const loginSessionId = "login:host-android-lifetime-recovery"
  const options = {
    socketPath: join(directory, "runtime.sock"),
    credentialPath: join(directory, "credential.json"),
    stateDirectory: join(directory, "state"),
    runtimeBuildId: "build:host-android-lifetime-recovery",
    expectedNativeBuildId: "build:unused",
    expectedHostname: hostname(),
    loginSessionId,
    browser: { android: {
      bindingId: "android",
      serial: "phone-a",
      localPort: 9223,
      deviceRef: "device:phone-a",
      initialDeviceTransportGeneration: "usb:initial",
      browserInstanceRef: "android-browser:phone-a",
      initialBrowserTransportGeneration: "android-cdp:initial",
      driver,
    } },
  }
  const lifetimeStore = new FileLifetimeStore(join(options.stateDirectory, `login-${sha256(loginSessionId)}`, "lifetimes"))
  let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
  try {
    host = await createRuntimeHost(options)
    const oldClient = await host.core.openClientDurable("mcp:android-old")
    const oldLineage = host.core.clients.lineage(oldClient.session)
    const connect = (
      current: NonNullable<typeof host>,
      session: typeof oldClient.session,
      clientRequestId: string,
    ) => {
      const instance = {
        ...current.core.generation,
        deviceRef: "device:phone-a",
        serial: "phone-a",
        transportGeneration: "usb:initial",
        browserInstanceRef: "android-browser:phone-a",
        browserTransportGeneration: "android-cdp:initial",
      }
      const request = { kind: "connect-instance" as const, instance }
      return current.catalog.dispatch(session, "android_chrome_operation", {
        intent: {
          intent: "mutation",
          clientRequestId,
          precondition: {
            target: { kind: "device-browser-instance", ref: instance },
            inventoryId: "android-host:android:initial",
            inventoryRevision: 0,
          },
          deadlineAt: new Date(Date.now() + 5_000).toISOString(),
          requestedResources: deviceBrowserOperationResources(request),
        },
        request,
      }, new AbortController().signal)
    }
    expect((await connect(host, oldClient.session, "android:connect-old")).data.operation).toMatchObject({ state: "completed" })
    await host.close()
    host = undefined

    forward = "foreign"
    host = await createRuntimeHost(options)
    expect((await lifetimeStore.loadAll())[0]?.state).toBe("quarantined")
    host.core.disconnectClient(oldClient.session.clientSessionId)
    await expect(host.core.browserLifetime.shutdownLineage(oldLineage)).rejects.toThrow("доказанно отсутствующий forward")
    expect((await lifetimeStore.loadAll())[0]?.state).toBe("quarantined")

    forward = "absent"
    await host.core.browserLifetime.shutdownLineage(oldLineage)
    expect((await lifetimeStore.loadAll())[0]?.state).toBe("released")
    const currentClient = await host.core.openClientDurable("mcp:android-current")
    expect((await connect(host, currentClient.session, "android:connect-current")).data.operation).toMatchObject({ state: "completed" })
    expect(connectCalls).toBe(2)
    expect(disconnectCalls).toBe(2)
  } finally {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
