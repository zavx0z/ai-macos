import {
  capabilitySetSchema,
  capturePolicySha256,
  freezeAdapterHostContext,
  structurallyEqual,
  type AdapterResult,
  type BrowserAdapter,
  type BrowserOperationRequest,
  type BrowserOperationResult,
  type DeviceBrowserAdapter,
  type DeviceBrowserOperationRequest,
  type DeviceBrowserOperationResult,
  type OperationTarget,
  type RuntimeOperationIntent,
} from "@meta/shared/contracts"
import { RuntimeBrowserAdapter, type BrowserDriver } from "@meta/chrome/adapter"
import {
  AndroidCdpDriver,
  ForwardOwnedDeviceBrowserDriver,
  OwnedAdbForward,
  RuntimeDeviceBrowserAdapter,
  type AdbForwardDeps,
  type DeviceBrowserDriver,
} from "@meta/android/adapter"
import type { RuntimeCore } from "./core.ts"
import type { BrowserCaptureMethodRequest, BrowserMethodBindings, DeviceCaptureMethodRequest } from "./browser-methods.ts"
import { lifetimeConfigFingerprint } from "./lifetime-state.ts"
import { chromeDriver, chromeProvenance, chromePersistence, type ChromeInstanceConfig } from "./chrome-host-config.ts"
export type { ChromeInstanceConfig } from "./chrome-host-config.ts"

export type ChromeHostConfig = {
  bindingId: string
  instances: readonly ChromeInstanceConfig[]
}

export type AndroidHostConfig = {
  bindingId: string
  serial: string
  localPort: number
  deviceRef: string
  initialDeviceTransportGeneration: string
  browserInstanceRef: string
  initialBrowserTransportGeneration: string
  driver?: DeviceBrowserDriver
  forwardDeps?: AdbForwardDeps
}

export type BrowserHostConfig = {
  chrome?: ChromeHostConfig
  android?: AndroidHostConfig
}

export type BrowserHostComposition = {
  bindings: BrowserMethodBindings
  browser?: BrowserAdapter
  device?: DeviceBrowserAdapter
  capabilitySet: ReturnType<typeof capabilitySetSchema.parse>
}

export function createBrowserHostComposition(
  runtime: RuntimeCore,
  config: BrowserHostConfig,
): BrowserHostComposition {
  const bindings: BrowserMethodBindings = {}
  const capabilities: Array<{ id: "browser.instances" | "browser.targets" | "browser.observe" | "browser.readiness" | "browser.resources" | "android.chrome", state: "ready" }> = []
  let browser: BrowserAdapter | undefined
  let device: DeviceBrowserAdapter | undefined

  if (config.chrome !== undefined) {
    const chrome = config.chrome
    if (chrome.instances.length < 1 || chrome.instances.length > 128) throw new Error("Chrome host requires 1..128 configured instances")
    const drivers = new Map(chrome.instances.map(item => [item.browserInstanceRef, chromeDriver(item)]))
    const rawBrowser = new RuntimeBrowserAdapter(adapterHost(runtime, "browser:host", [
      "browser.instances", "browser.targets", "browser.observe", "browser.readiness", "browser.resources",
    ]), runtime.services, chrome.instances.map(item => ({
      browserInstanceRef: item.browserInstanceRef,
      initialTransportGeneration: item.initialTransportGeneration,
      provenance: chromeProvenance(item),
      ...(item.profileLabel === undefined ? {} : { profileLabel: item.profileLabel }),
      ...(item.process === undefined ? {} : { process: item.process }),
      driver: drivers.get(item.browserInstanceRef)!,
    })))
    const proof = new BrowserFrameProofAuthority(runtime)
    for (const item of chrome.instances) {
      proof.registerTarget({ kind: "browser-instance", ref: {
        ...runtime.generation,
        browserInstanceRef: item.browserInstanceRef,
        transportGeneration: item.initialTransportGeneration,
      } }, `browser-host:${chrome.bindingId}:${item.browserInstanceRef}:initial`, 0, 0)
    }
    browser = authoritativeBrowserAdapter(rawBrowser, proof)
    runtime.browserLifetime.configure(chrome.bindingId, {
      domain: "browser",
      adapter: browser,
      verifier: verifier(rawBrowser, drivers, proof),
      persistence: chrome.instances.map(chromePersistence),
    })
    bindings.browser = {
      bindingId: chrome.bindingId,
      adapter: browser,
      reserveCapture: (session, intent, request) => reserveBrowserCapture(runtime, session, intent, request),
    }
    capabilities.push(
      { id: "browser.instances", state: "ready" },
      { id: "browser.targets", state: "ready" },
      { id: "browser.observe", state: "ready" },
      { id: "browser.readiness", state: "ready" },
      { id: "browser.resources", state: "ready" },
    )
  }

  if (config.android !== undefined) {
    const item = config.android
    const driver = item.driver ?? (() => {
      const forward = new OwnedAdbForward(item.serial, item.localPort, item.forwardDeps)
      return new ForwardOwnedDeviceBrowserDriver(
        forward,
        new AndroidCdpDriver(item.serial, item.localPort),
      )
    })()
    const rawDevice = new RuntimeDeviceBrowserAdapter(adapterHost(runtime, "android:host", ["android.chrome"]), runtime.services, [{
      serial: item.serial,
      localPort: item.localPort,
      deviceRef: item.deviceRef,
      initialDeviceTransportGeneration: item.initialDeviceTransportGeneration,
      browserInstanceRef: item.browserInstanceRef,
      initialBrowserTransportGeneration: item.initialBrowserTransportGeneration,
      driver,
    }])
    const proof = new BrowserFrameProofAuthority(runtime)
    proof.registerTarget({ kind: "device-browser-instance", ref: {
      ...runtime.generation,
      deviceRef: item.deviceRef,
      serial: item.serial,
      transportGeneration: item.initialDeviceTransportGeneration,
      browserInstanceRef: item.browserInstanceRef,
      browserTransportGeneration: item.initialBrowserTransportGeneration,
    } }, `android-host:${item.bindingId}:initial`, 0, 0)
    device = authoritativeDeviceAdapter(rawDevice, proof)
    runtime.browserLifetime.configure(item.bindingId, {
      domain: "device",
      adapter: device,
      verifier: deviceVerifier(rawDevice, driver, proof, item.serial, item.localPort),
      persistence: [{
        owner: {
          kind: "device-browser",
          deviceRef: item.deviceRef,
          serial: item.serial,
          browserInstanceRef: item.browserInstanceRef,
        },
        configFingerprint: lifetimeConfigFingerprint({
          serial: item.serial,
          localPort: item.localPort,
          remoteSocket: "localabstract:chrome_devtools_remote",
        }),
        physicalOwnershipKey: {
          kind: "android-forward",
          serial: item.serial,
          localPort: item.localPort,
          remoteSocket: "localabstract:chrome_devtools_remote",
        },
      }],
    })
    bindings.device = {
      bindingId: item.bindingId,
      adapter: device,
      reserveCapture: (session, intent, request) => reserveDeviceCapture(runtime, session, intent, request),
    }
    capabilities.push({ id: "android.chrome", state: "ready" })
  }

  return {
    bindings,
    ...(browser === undefined ? {} : { browser }),
    ...(device === undefined ? {} : { device }),
    capabilitySet: capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "browser-host",
      capabilities,
    }),
  }
}

export class BrowserFrameProofAuthority {
  constructor(private readonly runtime: RuntimeCore) {}

  verify(result: AdapterResult<BrowserOperationResult | DeviceBrowserOperationResult>): void {
    if (!result.ok || result.value.value.kind !== "target-captured") return
    const capture = result.value.value.capture
    if (!this.runtime.frames.hasVerified(capture.frame.frameRef, capture.frame.sha256)) {
      throw new Error("Browser frame bytes не подтверждены runtime FrameStore")
    }
    const proof = this.runtime.proofs.issue({
      kind: "frame-freshness",
      subject: capture.observation.captureTarget,
      inventoryRevision: capture.observation.inventoryRevision,
      displayLayoutRevision: capture.observation.displayLayoutRevision,
      ttlMs: Math.max(1, Math.min(60_000, Date.parse(capture.observation.expiresAt) - Date.now())),
    })
    capture.observation.captureEvidence = {
      state: "confirmed",
      claim: "frame-freshness",
      source: "browser-proof-authority",
      proof,
    }
  }

  assertVerified(result: AdapterResult<BrowserOperationResult | DeviceBrowserOperationResult>): void {
    if (!result.ok || result.value.value.kind !== "target-captured") return
    const evidence = result.value.value.capture.observation.captureEvidence
    if (evidence.state !== "confirmed" || !this.runtime.proofs.hasIssued(evidence.proof)) {
      throw new Error("Browser capture не содержит runtime-issued frame proof")
    }
  }

  registerTarget(
    target: OperationTarget,
    inventoryId: string,
    inventoryRevision: number,
    displayLayoutRevision: number,
  ): void {
    const proof = this.runtime.proofs.issue({
      kind: "target-resolution",
      subject: target,
      inventoryRevision,
      displayLayoutRevision,
      ttlMs: 60_000,
    })
    this.runtime.targets.register(
      target,
      inventoryId,
      inventoryRevision,
      `browser-evidence:${proof.proofRef}`,
      proof.proofRef,
      displayLayoutRevision,
    )
  }
}

function authoritativeBrowserAdapter(inner: BrowserAdapter, proof: BrowserFrameProofAuthority): BrowserAdapter {
  return {
    host: inner.host,
    services: inner.services,
    capabilities: inner.capabilities,
    async listInstances(control) {
      const snapshot = await inner.listInstances(control)
      for (const instance of snapshot.instances) {
        proof.registerTarget({ kind: "browser-instance", ref: instance.ref }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      }
      return snapshot
    },
    async listTargets(instance, control) {
      const snapshot = await inner.listTargets(instance, control)
      proof.registerTarget({ kind: "browser-instance", ref: snapshot.instance }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      for (const target of snapshot.targets) {
        proof.registerTarget({ kind: "browser-target", ref: target.ref }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      }
      return snapshot
    },
    async execute(context, request) {
      const result = await inner.execute(context, request)
      proof.verify(result)
      return result
    },
  }
}

function authoritativeDeviceAdapter(inner: DeviceBrowserAdapter, proof: BrowserFrameProofAuthority): DeviceBrowserAdapter {
  return {
    host: inner.host,
    services: inner.services,
    capabilities: inner.capabilities,
    async listDevices(control) {
      const snapshot = await inner.listDevices(control)
      for (const device of snapshot.devices) {
        proof.registerTarget({ kind: "device", ref: device.ref }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      }
      return snapshot
    },
    async listInstances(device, control) {
      const snapshot = await inner.listInstances(device, control)
      proof.registerTarget({ kind: "device", ref: snapshot.device }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      for (const instance of snapshot.instances) {
        proof.registerTarget({ kind: "device-browser-instance", ref: instance.ref }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      }
      return snapshot
    },
    async listTargets(instance, control) {
      const snapshot = await inner.listTargets(instance, control)
      proof.registerTarget({ kind: "device-browser-instance", ref: snapshot.instance }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      for (const target of snapshot.targets) {
        proof.registerTarget({ kind: "device-browser-target", ref: target.ref }, snapshot.inventoryId, snapshot.inventoryRevision, 0)
      }
      return snapshot
    },
    async execute(context, request) {
      const result = await inner.execute(context, request)
      proof.verify(result)
      return result
    },
  }
}

function verifier(
  adapter: RuntimeBrowserAdapter,
  drivers: ReadonlyMap<string, BrowserDriver>,
  proof: BrowserFrameProofAuthority,
) {
  return {
    async verifyConnected(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "browser-instance") throw new Error("Browser instance expected")
      control(signal).checkpoint()
      adapter.assertConnectedExact(target.ref)
    },
    async verifyRemoved(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "browser-instance") throw new Error("Browser instance expected")
      control(signal).checkpoint()
      adapter.assertDisconnectedExact(target.ref)
    },
    async verifyCompletion(_request: BrowserOperationRequest, result: AdapterResult<BrowserOperationResult>) {
      proof.assertVerified(result)
    },
    async recoverRemoval(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "browser-instance") throw new Error("Browser instance expected")
      const driver = drivers.get(target.ref.browserInstanceRef)
      if (driver === undefined) throw new Error("Chrome recovery driver not configured")
      await adapter.recoverDisconnected(target.ref, async () => {
        control(signal).checkpoint()
        await driver.disconnect()
        control(signal).checkpoint()
      })
    },
  }
}

function deviceVerifier(
  adapter: RuntimeDeviceBrowserAdapter,
  driver: DeviceBrowserDriver,
  proof: BrowserFrameProofAuthority,
  serial: string,
  localPort: number,
) {
  return {
    async verifyConnected(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "device-browser-instance") throw new Error("Device browser instance expected")
      control(signal).checkpoint()
      adapter.assertConnectedExact(target.ref)
      const forward = await driver.forwardStatus?.(signal)
      if (forward?.state !== "owned") throw new Error("Android forward ownership не подтверждено")
    },
    async verifyRemoved(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "device-browser-instance") throw new Error("Device browser instance expected")
      control(signal).checkpoint()
      adapter.assertDisconnectedExact(target.ref)
      const forward = await driver.forwardStatus?.(signal)
      if (forward?.state !== "absent") throw new Error("Android forward removal не подтверждено")
    },
    async verifyCompletion(_request: DeviceBrowserOperationRequest, result: AdapterResult<DeviceBrowserOperationResult>) {
      proof.assertVerified(result)
    },
    async recoverRemoval(target: OperationTarget, signal: AbortSignal) {
      if (target.kind !== "device-browser-instance") throw new Error("Device browser instance expected")
      await adapter.recoverDisconnected(target.ref, async () => {
        control(signal).checkpoint()
        await driver.disconnect(serial, localPort)
        control(signal).checkpoint()
        const forward = await driver.forwardStatus?.(signal)
        if (forward?.state !== "absent") throw new Error("Android recovery требует доказанно отсутствующий forward")
      })
    },
  }
}

async function reserveBrowserCapture(
  runtime: RuntimeCore,
  session: Parameters<RuntimeCore["reserveCapturePublication"]>[0],
  intent: RuntimeOperationIntent,
  request: BrowserCaptureMethodRequest,
): Promise<Extract<BrowserOperationRequest, { kind: "capture-target" }>> {
  const publication = await reservePublication(runtime, session, intent, request.capture)
  return { ...request, capture: { ...request.capture, publication } }
}

async function reserveDeviceCapture(
  runtime: RuntimeCore,
  session: Parameters<RuntimeCore["reserveCapturePublication"]>[0],
  intent: RuntimeOperationIntent,
  request: DeviceCaptureMethodRequest,
): Promise<Extract<DeviceBrowserOperationRequest, { kind: "capture-target" }>> {
  const publication = await reservePublication(runtime, session, intent, request.capture)
  return { ...request, capture: { ...request.capture, publication } }
}

async function reservePublication(
  runtime: RuntimeCore,
  session: Parameters<RuntimeCore["reserveCapturePublication"]>[0],
  intent: RuntimeOperationIntent,
  capture: BrowserCaptureMethodRequest["capture"] | DeviceCaptureMethodRequest["capture"],
) {
  const publication = await runtime.reserveCapturePublication(session, {
    clientRequestId: intent.clientRequestId,
    source: capture.source,
    captureTarget: capture.target,
    capturePolicySha256: capturePolicySha256(capture),
    inventoryId: intent.precondition.inventoryId,
    inventoryRevision: intent.precondition.inventoryRevision,
    displayLayoutRevision: 0,
  })
  return publication
}

function adapterHost(runtime: RuntimeCore, producerRef: string, capabilities: Array<"browser.instances" | "browser.targets" | "browser.observe" | "browser.readiness" | "browser.resources" | "android.chrome">) {
  return freezeAdapterHostContext({
    generation: runtime.generation,
    runtimeBuildId: producerRef,
    capabilities: {
      schemaVersion: "1",
      scope: "adapter",
      producerRef,
      capabilities: capabilities.map(id => ({ id, state: "ready" as const })),
    },
  })
}

function control(signal: AbortSignal) {
  return {
    signal,
    checkpoint() {
      if (signal.aborted) throw new DOMException("Browser host verification aborted", "AbortError")
    },
  }
}
