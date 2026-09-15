import { describe, expect, test } from "bun:test"
import {
  freezeAdapterHostContext,
  type AdapterServices,
  type DeviceBrowserInstanceRef,
  type DeviceExecutionContext,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import { CdpHttp } from "@meta/shared"
import { AdbCommandCleanupError } from "../src/adb.ts"
import { AndroidCdpDriver, ForwardOwnedDeviceBrowserDriver, OwnedAdbForward, RuntimeDeviceBrowserAdapter, type DeviceBrowserDriver } from "../src/adapter.ts"

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch: "runtime:1", loginSessionId: "login:1" },
  runtimeBuildId: "runtime-build:1",
  capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "android-adapter:fixture", capabilities: [] },
})

const services: AdapterServices = {
  clientSessions: { async assertActive() {} },
  resources: { async assertActive() {}, async assertOwnedSet() {} },
  cleanup: { async verify() {} },
  targets: { async resolve(request) { return { target: request.target, resolutionId: "resolution:1", proofRef: "proof:1", inventoryId: request.inventoryId, inventoryRevision: request.inventoryRevision, displayLayoutRevision: 0 } } },
  proofs: { async assertValid() {} },
  evidence: { async issueTargetResolution() { throw new Error("not used") }, async issueWindowCorrelation() { throw new Error("not used") }, async issueInteractionPoint() { throw new Error("not used") }, async issueFrameFreshness() { throw new Error("not used") } },
  frames: { async publish() {} },
  observations: { async resolvePoint() { throw new Error("not used") } },
  continuations: { async issue() { throw new Error("not used") }, async registerAcceptedTask() { throw new Error("not used") }, async advanceVerifiedStatus() { throw new Error("not used") }, async markVerifiedTerminal() { throw new Error("not used") } },
  reservations: { async assertChild() { throw new Error("not used") } },
}

function driver(): DeviceBrowserDriver & { connects: string[] } {
  const connects: string[] = []
  return {
    connects,
    async listDevices() { return [{ serial: "phone-a", state: "device" }] },
    async connect(serial) { connects.push(serial); return { browserVersion: "Chrome/1" } },
    async disconnect() {},
    async listTargets() { return [] },
    async openTarget() { throw new Error("not used") },
    async closeTarget() {},
    async navigateTarget() { throw new Error("not used") },
    async reloadTarget() { throw new Error("not used") },
    async waitTarget(_id, policy) { return { state: "ready", policy, steps: [], timedOut: false } },
    async captureTarget() { throw new Error("not used") },
  }
}

function handle(kind: RuntimeResourceHandle["kind"], resourceRef: string): RuntimeResourceHandle {
  return { kind, resourceRef, leaseId: `lease:${kind}`, leaseGeneration: "lease-gen:1", operationId: "operation:1", clientSessionId: "client:1", principalId: "principal:1", runtimeEpoch: "runtime:1", loginSessionId: "login:1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" }
}

function context(ref: DeviceBrowserInstanceRef, resources: RuntimeResourceHandle[]): RuntimeOperationContext<DeviceExecutionContext> {
  return {
    wire: { kind: "device", operationId: "operation:1", clientRequestId: "request:1", clientSessionId: "client:1", principalId: "principal:1", runtimeEpoch: "runtime:1", loginSessionId: "login:1", inventoryId: "android-inventory:0", inventoryRevision: 0, target: { kind: "device-browser-instance", ref }, deadlineAt: "2099-01-01T00:00:00.000Z" },
    session: { clientSessionId: "client:1", principalId: "principal:1", runtimeEpoch: "runtime:1", loginSessionId: "login:1", authenticationGeneration: "auth:1", authenticatedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" },
    control: { signal: new AbortController().signal, checkpoint() {} },
    resources,
  }
}

describe("RuntimeDeviceBrowserAdapter", () => {
  test("connect использует exact serial и обновляет только browser transport epoch", async () => {
    const fake = driver()
    const adapter = new RuntimeDeviceBrowserAdapter(host, services, [{ serial: "phone-a", localPort: 9223, deviceRef: "device:a", initialDeviceTransportGeneration: "usb:1", browserInstanceRef: "android-chrome:a", initialBrowserTransportGeneration: "cdp:0", driver: fake }], () => "cdp:1", () => new Date("2026-09-15T00:00:00.000Z"))
    const devices = await adapter.listDevices({ signal: new AbortController().signal, checkpoint() {} })
    const instances = await adapter.listInstances(devices.devices[0]!.ref, { signal: new AbortController().signal, checkpoint() {} })
    const ref = instances.instances[0]!.ref
    const result = await adapter.execute(context(ref, [
      handle("cdp-target", ref.browserInstanceRef),
      handle("adb-device", ref.deviceRef),
    ]), { kind: "connect-instance", instance: ref })

    expect(result.ok).toBe(true)
    if (!result.ok || result.value.value.kind !== "instance-connected") throw new Error("Expected connected")
    expect(fake.connects).toEqual(["phone-a"])
    expect(result.value.value.instance.ref.transportGeneration).toBe("usb:1")
    expect(result.value.value.instance.ref.browserTransportGeneration).toBe("cdp:1")
  })

  test("без adb-device lease connect не достигает driver", async () => {
    const fake = driver()
    const adapter = new RuntimeDeviceBrowserAdapter(host, services, [{ serial: "phone-a", localPort: 9223, deviceRef: "device:a", initialDeviceTransportGeneration: "usb:1", browserInstanceRef: "android-chrome:a", initialBrowserTransportGeneration: "cdp:0", driver: fake }])
    const devices = await adapter.listDevices({ signal: new AbortController().signal, checkpoint() {} })
    const ref = (await adapter.listInstances(devices.devices[0]!.ref, { signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const result = await adapter.execute(context(ref, [handle("cdp-target", ref.browserInstanceRef)]), { kind: "connect-instance", instance: ref })
    expect(result.ok).toBe(false)
    expect(fake.connects).toEqual([])
  })
})

describe("OwnedAdbForward", () => {
  test("не заменяет занятый forward и не вызывает remove", async () => {
    let removes = 0
    const owned = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => [{ serial: "phone-b", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }],
      create: async () => { throw new Error("must not create") },
      remove: async () => { removes += 1 },
    })
    await expect(owned.connect()).rejects.toThrow("another process")
    await owned.disconnect()
    expect(removes).toBe(0)
  })

  test("concrete wrapper связывает CDP connect с owned forward lifecycle", async () => {
    const calls: string[] = []
    let records: Array<{ serial: string; local: string; remote: string }> = []
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => records,
      create: async () => {
        calls.push("forward-create")
        records = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
      },
      remove: async () => {
        calls.push("forward-remove")
        records = []
      },
    })
    const delegate = driver()
    const wrapped = new ForwardOwnedDeviceBrowserDriver(forward, delegate)
    await wrapped.connect("phone-a", 9223, new AbortController().signal)
    await wrapped.disconnect("phone-a", 9223)
    expect(calls).toEqual(["forward-create", "forward-remove"])
  })

  test("переназначенный forward отклоняет каждый последующий CDP вызов", async () => {
    let records: Array<{ serial: string; local: string; remote: string }> = []
    let targetReads = 0
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => records,
      create: async () => {
        records = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
      },
      remove: async () => {},
    })
    await forward.connect()
    const delegate = driver()
    delegate.listTargets = async () => {
      targetReads += 1
      records = [{ serial: "phone-b", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
      return []
    }
    const wrapped = new ForwardOwnedDeviceBrowserDriver(forward, delegate)
    await expect(wrapped.listTargets(new AbortController().signal)).rejects.toThrow("changed during")
    expect(targetReads).toBe(1)
  })

  test("abort после create и ошибка remove сохраняют ownership для retry", async () => {
    const controller = new AbortController()
    let removeCalls = 0
    let records: Array<{ serial: string; local: string; remote: string }> = []
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => records,
      create: async () => {
        records = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
        controller.abort()
      },
      remove: async () => {
        removeCalls += 1
        if (removeCalls === 1) throw new Error("remove failed")
        records = []
      },
    })
    await expect(forward.connect(controller.signal)).rejects.toMatchObject({ cleanupUnknown: true })
    await forward.disconnect()
    expect(removeCalls).toBe(2)
  })

  test("ошибка forward inventory не сбрасывает ownership при disconnect", async () => {
    let inventoryFails = false
    let removeCalls = 0
    let records: Array<{ serial: string; local: string; remote: string }> = []
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => {
        if (inventoryFails) throw new Error("forward inventory failed")
        return records
      },
      create: async () => {
        records = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
      },
      remove: async () => {
        removeCalls += 1
        records = []
      },
    })
    await forward.connect()
    inventoryFails = true
    await expect(forward.disconnect()).rejects.toThrow("forward inventory failed")
    inventoryFails = false
    await forward.disconnect()
    expect(removeCalls).toBe(1)
  })

  test("lost create ACK сохраняет attempted ownership для runtime reconciliation", async () => {
    let removes = 0
    let mapping: Array<{ serial: string; local: string; remote: string }> = []
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => mapping,
      create: async () => {
        mapping = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
        throw new Error("reply lost")
      },
      remove: async () => { removes += 1 },
    })
    await expect(forward.connect()).rejects.toMatchObject({ cleanupUnknown: true, phase: "cleanup" })
    await expect(forward.disconnect()).rejects.toMatchObject({ cleanupUnknown: true, phase: "cleanup" })
    expect(removes).toBe(0)
  })

  test("connect retarget внутри delegate не принимается как готовый instance", async () => {
    let records: Array<{ serial: string; local: string; remote: string }> = []
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => records,
      create: async () => { records = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }] },
      remove: async () => {},
    })
    const delegate = driver()
    delegate.connect = async () => {
      records = [{ serial: "phone-b", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
      return { browserVersion: "Foreign/1" }
    }
    const wrapped = new ForwardOwnedDeviceBrowserDriver(forward, delegate)
    const error = await wrapped.connect("phone-a", 9223, new AbortController().signal).catch(caught => caught)
    expect(error.cleanupUnknown).toBe(true)
    expect(error.phase).toBe("cleanup")
  })

  test("unconfirmed create process сохраняет attempted ownership при пустом snapshot", async () => {
    let mapping: Array<{ serial: string; local: string; remote: string }> = []
    let removes = 0
    const forward = new OwnedAdbForward("phone-a", 9223, {
      devices: async () => [{ serial: "phone-a", state: "device" }],
      forwards: async () => mapping,
      create: async () => { throw new AdbCommandCleanupError("process still unknown") },
      remove: async () => { removes += 1 },
    })
    await expect(forward.connect()).rejects.toMatchObject({ cleanupUnknown: true })
    mapping = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }]
    await expect(forward.disconnect()).rejects.toMatchObject({ cleanupUnknown: true, phase: "cleanup" })
    expect(removes).toBe(0)
  })
})

test("AndroidCdpDriver создаёт target по exact ID diff после intent на serial", async () => {
  let opened = false
  const intents: Array<{ serial: string; url: string }> = []
  const oldTarget = { id: "old", type: "page", title: "old", url: "https://same.test", webSocketDebuggerUrl: "ws://fixture/old" }
  const newTarget = { id: "new", type: "page", title: "new", url: "https://same.test", webSocketDebuggerUrl: "ws://fixture/new" }
  const http = new CdpHttp("fixture", 9223, {
    fetch: async () => Response.json(opened ? [oldTarget, newTarget] : [oldTarget]),
  })
  const driver = new AndroidCdpDriver(
    "phone-a",
    9223,
    http,
    async (serial, url) => {
      intents.push({ serial, url })
      opened = true
    },
    async () => {},
  )
  const created = await driver.openTarget("phone-a", "https://same.test", new AbortController().signal)
  expect(created.id).toBe("new")
  expect(intents).toEqual([{ serial: "phone-a", url: "https://same.test" }])
})

test("device loss и reappearance меняют device и browser generations", async () => {
  const fake = driver()
  const states = ["device", "missing", "device"]
  fake.listDevices = async () => {
    const state = states.shift()!
    return state === "missing" ? [] : [{ serial: "phone-a", state }]
  }
  const browserGenerations = ["cdp:2", "cdp:3"]
  const deviceGenerations = ["usb:2", "usb:3"]
  const adapter = new RuntimeDeviceBrowserAdapter(
    host,
    services,
    [{ serial: "phone-a", localPort: 9223, deviceRef: "device:a", initialDeviceTransportGeneration: "usb:1", browserInstanceRef: "android-chrome:a", initialBrowserTransportGeneration: "cdp:1", driver: fake }],
    () => browserGenerations.shift()!,
    () => new Date("2026-09-15T00:00:00.000Z"),
    () => deviceGenerations.shift()!,
  )
  const control = { signal: new AbortController().signal, checkpoint() {} }
  const connected = await adapter.listDevices(control)
  const missing = await adapter.listDevices(control)
  const reappeared = await adapter.listDevices(control)
  expect(connected.devices[0]!.ref.transportGeneration).toBe("usb:1")
  expect(missing.devices[0]!.ref.transportGeneration).toBe("usb:2")
  expect(reappeared.devices[0]!.ref.transportGeneration).toBe("usb:3")
})
