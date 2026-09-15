import { expect, test } from "bun:test"
import {
  deviceBrowserOperationRequestSchema, deviceBrowserOperationResources, freezeAdapterHostContext,
  runtimeOperationIntentSchema, type DeviceBrowserOperationRequest, type DeviceBrowserInstanceRef,
} from "@meta/shared/contracts"
import { OwnedAdbForward, ForwardOwnedDeviceBrowserDriver, RuntimeDeviceBrowserAdapter, type DeviceBrowserDriver } from "@meta/android/adapter"
import { RuntimeCore } from "../src/core.ts"

test("Android coordinator владеет connect/child/unknown/recovery и exact ADB forward", async () => {
  const generation = { runtimeEpoch: "runtime:android", loginSessionId: "login:android" }
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "build:android" })
  let forwards: Array<{ serial: string, local: string, remote: string }> = []
  let creates = 0
  let removes = 0
  let failOpen = false
  const forward = new OwnedAdbForward("phone-a", 9223, {
    devices: async () => [{ serial: "phone-a", state: "device" }],
    forwards: async () => forwards,
    create: async () => { creates++; forwards = [{ serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" }] },
    remove: async () => { removes++; forwards = [] },
  })
  const delegate: DeviceBrowserDriver = {
    async listDevices() { return [{ serial: "phone-a", state: "device" }] },
    async connect() { return { browserVersion: "Chrome/Fixture" } },
    async disconnect() {},
    async listTargets() { return [] },
    async openTarget(_serial, url) {
      if (failOpen) throw new Error("USB target inventory unavailable")
      return { id: "target:a", type: "page", title: "A", url, webSocketDebuggerUrl: "ws://fixture" }
    },
    async closeTarget() {},
    async navigateTarget(): Promise<never> { throw new Error("unused") },
    async reloadTarget(): Promise<never> { throw new Error("unused") },
    async waitTarget(_target, policy) { return { state: "ready", policy, steps: [], timedOut: false } },
    async captureTarget(): Promise<never> { throw new Error("unused") },
  }
  const driver = new ForwardOwnedDeviceBrowserDriver(forward, delegate)
  const host = freezeAdapterHostContext({ generation, runtimeBuildId: "build:android", capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "android:fixture", capabilities: [] } })
  const adapter = new RuntimeDeviceBrowserAdapter(host, runtime.services, [{
    serial: "phone-a", localPort: 9223, deviceRef: "device:a", initialDeviceTransportGeneration: "usb:0",
    browserInstanceRef: "android:a", initialBrowserTransportGeneration: "cdp:0", driver,
  }], () => "cdp:1")
  runtime.browserLifetime.configure("android", {
    domain: "device", adapter,
    verifier: {
      async verifyConnected(target) {
        if (target.kind !== "device-browser-instance" || target.ref.serial !== "phone-a" || forwards[0]?.serial !== "phone-a") throw new Error("Owned forward не подтверждён")
      },
      async verifyRemoved() { if (forwards.length > 0) throw new Error("Forward ещё присутствует") },
      async verifyCompletion() {},
      async recoverRemoval(target) {
        if (target.kind !== "device-browser-instance" || target.ref.serial !== "phone-a") throw new Error("Foreign device")
        await driver.disconnect(target.ref.serial, 9223)
      },
    },
  })
  const control = { signal: new AbortController().signal, checkpoint() {} }
  const device = (await adapter.listDevices(control)).devices[0]!
  const initial = (await adapter.listInstances(device.ref, control)).instances[0]!.ref
  const session = runtime.openClient("principal:android").session
  const register = (ref: DeviceBrowserInstanceRef, revision: number) => runtime.targets.register({ kind: "device-browser-instance", ref }, `inventory:${revision}`, revision, `resolution:${revision}`, `proof:${revision}`, 0)
  register(initial, 1)
  const invoke = (id: string, request: DeviceBrowserOperationRequest, revision: number) => {
    const parsed = deviceBrowserOperationRequestSchema.parse(request)
    if (!("instance" in parsed)) throw new Error("fixture uses instance operations")
    return runtime.browserLifetime.execute(session, "android", runtimeOperationIntentSchema.parse({
      intent: "mutation", clientRequestId: id,
      precondition: { target: { kind: "device-browser-instance", ref: parsed.instance }, inventoryId: `inventory:${revision}`, inventoryRevision: revision },
      deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: deviceBrowserOperationResources(parsed),
    }), parsed)
  }
  const connected = await invoke("connect", { kind: "connect-instance", instance: initial }, 1)
  expect(connected.operation.state).toBe("completed")
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  if (!("serial" in instance)) throw new Error("device expected")
  register(instance, 2)
  const duplicate = await invoke("connect:second", { kind: "connect-instance", instance }, 2)
  expect(duplicate.operation.state).toBe("rejected")
  expect(creates).toBe(1)
  const open: DeviceBrowserOperationRequest = { kind: "open-target", instance, url: "https://example.com", policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] }, timeoutMs: 1000 }
  expect((await invoke("open", open, 2)).operation.state).toBe("completed")
  failOpen = true
  const failed = await invoke("open:failed", open, 2)
  expect(failed.result.ok).toBe(false)
  const target = { kind: "device-browser-instance" as const, ref: instance }
  expect((await runtime.reservations.inspect(session, target))?.state).toBe("quarantined")
  const recovery = runtimeOperationIntentSchema.parse({
    intent: "admin", clientRequestId: "recover", precondition: { target, inventoryId: "inventory:2", inventoryRevision: 2 },
    deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [],
  })
  const recovered = await runtime.browserLifetime.recover(session, "android", recovery)
  expect(recovered.operation.state).toBe("completed")
  expect(removes).toBe(1)
  expect(forwards).toEqual([])
  expect((await runtime.reservations.inspect(session, target))?.state).toBe("released")
  expect(runtime.resources.handlesForOperation(failed.operation.context.operationId)).toHaveLength(0)
})
