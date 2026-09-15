import {
  authorizeDeviceBrowserOperation,
  assertCleanupOwnsExactHandles,
  assertDeviceBrowserResultMatchesRequest,
  deviceBrowserOperationResultSchema,
  deviceBrowserInstanceSnapshotSchema,
  deviceBrowserTargetSnapshotSchema,
  deviceSnapshotSchema,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type BrowserCaptureRequest,
  type CleanupOutcome,
  type ContractError,
  type DeviceBrowserAdapter,
  type DeviceBrowserInstanceRecord,
  type DeviceBrowserInstanceSnapshot,
  type DeviceBrowserOperationRequest,
  type DeviceBrowserOperationResult,
  type DeviceBrowserTargetRecord,
  type DeviceBrowserTargetSnapshot,
  type DeviceExecutionContext,
  type DeviceRecord,
  type DeviceSnapshot,
  type OperationOutcome,
  type ReadinessPolicy,
  type ReadinessResult,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
  verifyAndPublishBinaryFrame,
  structurallyEqual,
} from "@meta/shared/contracts"
import { CdpHttp, type CdpTarget } from "@meta/shared"
import { CdpBrowserDriver } from "@meta/chrome/adapter"
import {
  adbDevices,
  AdbCommandCleanupError,
  adbForward,
  adbForwardList,
  adbOpenUrl,
  adbRemoveForward,
  type AdbDevice,
  type AdbForwardRecord,
} from "./adb.ts"
import { selectCreatedTarget } from "./target-identity.ts"

export type DeviceDriverCapture = {
  bytes: Uint8Array
  width: number
  height: number
  capturedAt: string
  readiness: ReadinessResult
}

export interface DeviceBrowserDriver {
  listDevices(signal: AbortSignal): Promise<AdbDevice[]>
  connect(serial: string, localPort: number, signal: AbortSignal): Promise<{ browserVersion: string }>
  disconnect(serial: string, localPort: number): Promise<void>
  listTargets(signal: AbortSignal): Promise<CdpTarget[]>
  openTarget(serial: string, url: string, signal: AbortSignal): Promise<CdpTarget>
  closeTarget(targetId: string, signal: AbortSignal): Promise<void>
  navigateTarget(targetId: string, url: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult>
  reloadTarget(targetId: string, ignoreCache: boolean, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult>
  waitTarget(targetId: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal): Promise<ReadinessResult>
  captureTarget(targetId: string, request: BrowserCaptureRequest, signal: AbortSignal): Promise<DeviceDriverCapture>
  forwardStatus?(signal: AbortSignal): Promise<DeviceRecord["forward"]>
}

export type ConfiguredDeviceBrowser = {
  serial: string
  localPort: number
  deviceRef: string
  initialDeviceTransportGeneration: string
  browserInstanceRef: string
  initialBrowserTransportGeneration: string
  driver: DeviceBrowserDriver
}

type DeviceState = ConfiguredDeviceBrowser & {
  device: DeviceRecord["ref"]
  instance: DeviceBrowserInstanceRecord["ref"]
  state: DeviceBrowserInstanceRecord["state"]
  browserVersion?: string
  reason?: string
  observedDeviceState?: string
}

type DispatchStage = "not-sent" | "sent" | "acknowledged" | "reconciled"
type DispatchTracker = { stage: DispatchStage }

export class RuntimeDeviceBrowserAdapter implements DeviceBrowserAdapter {
  readonly capabilities = ["android.chrome"] as const
  private readonly configured = new Map<string, DeviceState>()
  private inventoryRevision = 0
  private inventorySequence = 0
  private readonly targetFingerprints = new Map<string, string>()
  private readonly recoveredRefs = new Set<string>()

  constructor(
    readonly host: AdapterHostContext,
    readonly services: AdapterServices,
    items: readonly ConfiguredDeviceBrowser[],
    private readonly nextBrowserGeneration: () => string = () => `android-cdp:${crypto.randomUUID()}`,
    private readonly now: () => Date = () => new Date(),
    private readonly nextDeviceGeneration: () => string = () => `usb:${crypto.randomUUID()}`,
  ) {
    if (items.length > 128) throw new Error("Android configured device count exceeds 128")
    for (const item of items) {
      if (this.configured.has(item.serial)) throw new Error(`Duplicate Android serial ${item.serial}`)
      const device = {
        ...host.generation,
        deviceRef: item.deviceRef,
        serial: item.serial,
        transportGeneration: item.initialDeviceTransportGeneration,
      }
      this.configured.set(item.serial, {
        ...item,
        device,
        instance: {
          ...device,
          browserInstanceRef: item.browserInstanceRef,
          browserTransportGeneration: item.initialBrowserTransportGeneration,
        },
        state: "disconnected",
        reason: "explicit-connect-required",
      })
    }
  }

  async listDevices(control: RuntimeOperationContext["control"]): Promise<DeviceSnapshot> {
    await control.checkpoint("android-device-inventory")
    const devices: DeviceRecord[] = []
    const errors: ContractError[] = []
    for (const configured of this.configured.values()) {
      try {
        const observed = (await configured.driver.listDevices(control.signal)).find(item => item.serial === configured.serial)
        this.observeDeviceState(configured, observed?.state ?? "missing")
        const state = observed?.state === "device" ? "connected"
          : observed?.state === "offline" ? "offline"
          : observed?.state === "unauthorized" ? "unauthorized"
          : "disconnected"
        const forward = configured.driver.forwardStatus
          ? await configured.driver.forwardStatus(control.signal)
          : { state: "unavailable" as const, reason: "authoritative forward state unavailable" }
        devices.push({
          ref: configured.device,
          state,
          forward,
          ...(state === "connected" ? {} : { reason: observed ? `adb-${observed.state}` : "device-not-found" }),
        })
      } catch (error) {
        errors.push(deviceError(error, false))
      }
    }
    return deviceSnapshotSchema.parse({ ...this.snapshotBase(), complete: errors.length === 0, errors, devices })
  }

  async listInstances(device: DeviceRecord["ref"], control: RuntimeOperationContext["control"]): Promise<DeviceBrowserInstanceSnapshot> {
    await control.checkpoint("android-browser-inventory")
    const configured = this.requireDevice(device)
    return deviceBrowserInstanceSnapshotSchema.parse({
      ...this.snapshotBase(),
      device: configured.device,
      instances: [this.instanceRecord(configured)],
    })
  }

  async listTargets(instance: DeviceBrowserInstanceRecord["ref"], control: RuntimeOperationContext["control"]): Promise<DeviceBrowserTargetSnapshot> {
    await control.checkpoint("android-target-inventory")
    const configured = this.requireInstance(instance, true)
    try {
      const targets = await configured.driver.listTargets(control.signal)
      this.observeTargetInventory(configured.instance.browserInstanceRef, targets)
      if (targets.length > 4_096) throw new Error("Android target inventory exceeds 4096")
      return deviceBrowserTargetSnapshotSchema.parse({
        ...this.snapshotBase(),
        instance: configured.instance,
        targets: targets.filter(target => target.type === "page").map(target => this.targetRecord(configured, target)),
      })
    } catch (error) {
      if (error instanceof AdbForwardOwnershipError) this.invalidateConfigured(configured, error.message, true)
      return deviceBrowserTargetSnapshotSchema.parse({
        ...this.snapshotBase(),
        complete: false,
        errors: [deviceError(error, false)],
        instance: configured.instance,
        targets: [],
      })
    }
  }

  async execute(
    context: RuntimeOperationContext<DeviceExecutionContext>,
    request: DeviceBrowserOperationRequest,
  ): Promise<AdapterResult<DeviceBrowserOperationResult>> {
    const dispatch: DispatchTracker = { stage: "not-sent" }
    try {
      await authorizeDeviceBrowserOperation(this, context, request, this.now())
      await context.control.checkpoint(`android:${request.kind}:authorized`)
      const value = await this.executeAuthorized(context, request, dispatch)
      dispatch.stage = "reconciled"
      const cleanup = released(context.resources)
      const result = deviceBrowserOperationResultSchema.parse({ value, cleanup })
      assertDeviceBrowserResultMatchesRequest(request, result)
      await assertCleanupOwnsExactHandles(this.services.resources, context.wire.operationId, context.resources, cleanup)
      return { ok: true, value: result, outcome: succeeded(request, cleanup) }
    } catch (error) {
      const transportUnknown = String(error).includes("timed out") || String(error).includes("disconnect")
        || error instanceof AdbForwardOwnershipError
      const ownershipPost = error instanceof AdbForwardOwnershipError && error.phase === "post"
      const deliveryUnknown = dispatch.stage === "sent" || ownershipPost
      if (transportUnknown) this.invalidateRequestInstance(request, String(error))
      const cleanup = deliveryUnknown ? quarantined(context.resources, error instanceof Error ? error.message : String(error)) : released(context.resources)
      return { ok: false, error: deviceError(error, deliveryUnknown || transportUnknown), outcome: failed(cleanup, ownershipPost ? "sent" : dispatch.stage) }
    }
  }

  async recoverDisconnected(
    reference: DeviceBrowserInstanceRecord["ref"],
    verifyPhysicalDisconnect: () => Promise<void>,
  ): Promise<void> {
    const configured = this.configured.get(reference.serial)
    if (!configured || configured.instance.browserInstanceRef !== reference.browserInstanceRef) {
      throw new Error("Android recovery instance not configured")
    }
    await verifyPhysicalDisconnect()
    configured.state = "disconnected"
    configured.reason = "recovered-physical-disconnect"
    this.recoveredRefs.add(JSON.stringify(reference))
    this.inventoryRevision += 1
  }

  assertConnectedExact(reference: DeviceBrowserInstanceRecord["ref"]): void {
    const configured = this.configured.get(reference.serial)
    if (!configured || !structurallyEqual(configured.instance, reference) || configured.state !== "connected") {
      throw new Error("Exact Android browser instance is not connected")
    }
  }

  assertDisconnectedExact(reference: DeviceBrowserInstanceRecord["ref"]): void {
    if (this.recoveredRefs.has(JSON.stringify(reference))) return
    const configured = this.configured.get(reference.serial)
    if (!configured || !structurallyEqual(configured.instance, reference) || configured.state === "connected") {
      throw new Error("Exact Android browser physical disconnect is not verified")
    }
  }

  private async executeAuthorized(
    context: RuntimeOperationContext<DeviceExecutionContext>,
    request: DeviceBrowserOperationRequest,
    dispatch: DispatchTracker,
  ): Promise<DeviceBrowserOperationResult["value"]> {
    if (request.kind === "connect-instance") {
      const configured = this.requireInstance(request.instance, false)
      const browserTransportGeneration = this.nextBrowserGeneration()
      if (browserTransportGeneration === configured.instance.browserTransportGeneration) {
        throw new Error("Android browser transport generation must advance")
      }
      dispatch.stage = "sent"
      const connected = await configured.driver.connect(configured.serial, configured.localPort, context.control.signal)
      dispatch.stage = "acknowledged"
      configured.instance = { ...configured.instance, browserTransportGeneration }
      configured.state = "connected"
      configured.browserVersion = connected.browserVersion
      delete configured.reason
      this.inventoryRevision += 1
      return { kind: "instance-connected", instance: this.instanceRecord(configured) }
    }
    if (request.kind === "disconnect-instance") {
      const configured = this.requireInstance(request.instance, true)
      dispatch.stage = "sent"
      await configured.driver.disconnect(configured.serial, configured.localPort)
      dispatch.stage = "acknowledged"
      configured.state = "disconnected"
      configured.reason = "explicitly-disconnected"
      this.inventoryRevision += 1
      return { kind: "instance-disconnected", instance: configured.instance }
    }
    if (request.kind === "open-target") {
      const configured = this.requireInstance(request.instance, true)
      dispatch.stage = "sent"
      const opened = await configured.driver.openTarget(configured.serial, request.url, context.control.signal)
      dispatch.stage = "acknowledged"
      const readiness = await configured.driver.waitTarget(opened.id, request.policy, request.timeoutMs, context.control.signal)
      this.inventoryRevision += 1
      return { kind: "target-opened", target: this.targetRecord(configured, opened), readiness }
    }

    const configured = this.requireInstance(request.target, true)
    const target = await this.requireTarget(configured, request.target.targetId, context.control.signal)
    await context.control.checkpoint(`android:${request.kind}:target-verified`)
    switch (request.kind) {
      case "close-target":
        dispatch.stage = "sent"
        await configured.driver.closeTarget(target.id, context.control.signal)
        dispatch.stage = "acknowledged"
        if ((await configured.driver.listTargets(context.control.signal)).some(candidate => candidate.id === target.id)) {
          throw new Error(`Android target remained after close: ${target.id}`)
        }
        this.inventoryRevision += 1
        return { kind: "target-closed", target: request.target }
      case "navigate-target": {
        dispatch.stage = "sent"
        const readiness = await configured.driver.navigateTarget(target.id, request.url, request.policy, request.timeoutMs, context.control.signal, () => { dispatch.stage = "acknowledged" })
        return { kind: "target-navigated", target: this.targetRecord(configured, await this.requireTarget(configured, target.id, context.control.signal)), readiness }
      }
      case "reload-target": {
        dispatch.stage = "sent"
        const readiness = await configured.driver.reloadTarget(target.id, request.ignoreCache, request.policy, request.timeoutMs, context.control.signal, () => { dispatch.stage = "acknowledged" })
        return { kind: "target-reloaded", target: this.targetRecord(configured, await this.requireTarget(configured, target.id, context.control.signal)), readiness }
      }
      case "wait-target":
        return { kind: "target-ready", target: request.target, readiness: await configured.driver.waitTarget(target.id, request.policy, request.timeoutMs, context.control.signal) }
      case "capture-target": {
        const captured = await configured.driver.captureTarget(target.id, request.capture, context.control.signal)
        const capture = await deviceCaptureResult(this.host, this.services, request.capture, request.target, captured)
        return { kind: "target-captured", target: request.target, capture }
      }
    }
  }

  private requireDevice(ref: DeviceRecord["ref"]): DeviceState {
    const configured = this.configured.get(ref.serial)
    if (!configured || JSON.stringify(configured.device) !== JSON.stringify(ref)) throw new Error("Android device ref is stale")
    return configured
  }

  private requireInstance(ref: DeviceBrowserInstanceRecord["ref"], connected: boolean): DeviceState {
    const configured = this.configured.get(ref.serial)
    if (!configured || JSON.stringify(configured.instance) !== JSON.stringify(ref)) throw new Error("Android browser instance ref is stale")
    if (connected && configured.state !== "connected") throw new Error("Android browser instance is not connected")
    return configured
  }

  private async requireTarget(configured: DeviceState, targetId: string, signal: AbortSignal): Promise<CdpTarget> {
    const target = (await configured.driver.listTargets(signal)).find(candidate => candidate.id === targetId)
    if (!target) throw new Error(`Android target not found: ${targetId}`)
    return target
  }

  private targetRecord(configured: DeviceState, target: CdpTarget): DeviceBrowserTargetRecord {
    return {
      ref: { ...configured.instance, targetId: target.id, resourceRef: deviceTargetResource(configured.instance.browserInstanceRef, target.id) },
      type: target.type,
      title: target.title,
      url: target.url,
    }
  }

  private instanceRecord(configured: DeviceState): DeviceBrowserInstanceRecord {
    return {
      ref: configured.instance,
      state: configured.state,
      ...(configured.browserVersion === undefined ? {} : { browserVersion: configured.browserVersion }),
      ...(configured.reason === undefined ? {} : { reason: configured.reason }),
    }
  }

  private snapshotBase() {
    this.inventorySequence += 1
    this.inventoryRevision += 1
    return {
      inventoryId: `android-inventory:${this.inventorySequence}`,
      inventoryRevision: this.inventoryRevision,
      ...this.host.generation,
      capturedAt: this.now().toISOString(),
      complete: true,
      errors: [],
    }
  }

  private observeTargetInventory(instanceRef: string, targets: readonly CdpTarget[]): void {
    const fingerprint = JSON.stringify(targets.map(target => [target.id, target.type, target.title, target.url]).sort())
    if (this.targetFingerprints.get(instanceRef) !== fingerprint) {
      this.targetFingerprints.set(instanceRef, fingerprint)
      this.inventoryRevision += 1
    }
  }

  private invalidateRequestInstance(request: DeviceBrowserOperationRequest, reason: string): void {
    const ref = "instance" in request ? request.instance : request.target
    const configured = this.configured.get(ref.serial)
    if (!configured) return
    this.invalidateConfigured(configured, reason, errorIsForwardMismatch(reason))
  }

  private invalidateConfigured(configured: DeviceState, reason: string, deviceToo: boolean): void {
    if (deviceToo) configured.device = { ...configured.device, transportGeneration: this.nextDeviceGeneration() }
    configured.instance = { ...configured.instance, ...configured.device, browserTransportGeneration: this.nextBrowserGeneration() }
    configured.state = "degraded"
    configured.reason = `transport-invalidated: ${reason}`
    this.inventoryRevision += 1
  }

  private observeDeviceState(configured: DeviceState, observed: string): void {
    const previous = configured.observedDeviceState
    configured.observedDeviceState = observed
    if (previous === undefined || previous === observed) return
    this.invalidateConfigured(configured, `device-state:${previous}->${observed}`, true)
    this.targetFingerprints.delete(configured.instance.browserInstanceRef)
  }
}

export type AdbForwardDeps = {
  devices(signal?: AbortSignal): Promise<AdbDevice[]>
  forwards(signal?: AbortSignal): Promise<AdbForwardRecord[]>
  create(localPort: number, serial: string, signal?: AbortSignal): Promise<void>
  remove(localPort: number, serial: string, signal?: AbortSignal): Promise<void>
}

export class AdbForwardOwnershipError extends Error {
  constructor(
    message: string,
    readonly cleanupUnknown = false,
    readonly phase: "pre" | "post" | "cleanup" = "pre",
  ) {
    super(message)
    this.name = "AdbForwardOwnershipError"
  }
}

export class OwnedAdbForward {
  private ownership: "none" | "owned" | "attempted-unknown" = "none"

  constructor(
    readonly serial: string,
    readonly localPort: number,
    private readonly deps: AdbForwardDeps = {
      devices: adbDevices,
      forwards: signal => adbForwardList(undefined, signal),
      create: adbForward,
      remove: adbRemoveForward,
    },
  ) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("ADB forward connect aborted", "AbortError")
    const device = (await this.deps.devices(signal)).find(candidate => candidate.serial === this.serial)
    if (!device) throw new Error(`Android device not found: ${this.serial}`)
    if (device.state !== "device") throw new Error(`Android device ${this.serial} is ${device.state}`)
    const local = `tcp:${this.localPort}`
    if ((await this.deps.forwards(signal)).some(forward => forward.local === local)) {
      throw new Error(`ADB forward ${local} is already owned by another process`)
    }
    if (signal?.aborted) throw new DOMException("ADB forward connect aborted", "AbortError")
    try {
      await this.deps.create(this.localPort, this.serial, signal)
      this.ownership = "owned"
    } catch (error) {
      await this.reconcileFailedCreate(error)
    }
    if (signal?.aborted) {
      try {
        await this.disconnect()
      } catch (error) {
        throw new AdbForwardOwnershipError(
          `ADB forward created, abort cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        )
      }
      throw new DOMException("ADB forward connect aborted", "AbortError")
    }
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("ADB forward check aborted", "AbortError")
    if (this.ownership !== "owned") {
      throw new AdbForwardOwnershipError(
        this.ownership === "attempted-unknown" ? "ADB forward create outcome is unknown" : "ADB forward is not owned",
        this.ownership === "attempted-unknown",
      )
    }
    const local = `tcp:${this.localPort}`
    const current = (await this.deps.forwards(signal)).find(forward => forward.local === local)
    if (!current) throw new AdbForwardOwnershipError(`Owned ADB forward ${local} disappeared`)
    if (current.serial !== this.serial || current.remote !== "localabstract:chrome_devtools_remote") {
      throw new AdbForwardOwnershipError(`Owned ADB forward ${local} was replaced; foreign mapping preserved`)
    }
    if (signal?.aborted) throw new DOMException("ADB forward check aborted", "AbortError")
  }

  async status(signal?: AbortSignal): Promise<DeviceRecord["forward"]> {
    if (signal?.aborted) throw new DOMException("ADB forward status aborted", "AbortError")
    const local = `tcp:${this.localPort}`
    const current = (await this.deps.forwards(signal)).find(forward => forward.local === local)
    if (!current) return { state: "absent" }
    if (this.ownership === "owned" && current.serial === this.serial && current.remote === "localabstract:chrome_devtools_remote") {
      return { state: "owned", localPort: this.localPort, forwardRef: `forward:${this.serial}:${this.localPort}` }
    }
    return { state: "foreign", localPort: this.localPort, reason: `forward belongs to ${current.serial}` }
  }

  async disconnect(): Promise<void> {
    if (this.ownership === "none") return
    if (this.ownership === "attempted-unknown") {
      throw new AdbForwardOwnershipError("ADB forward create outcome requires runtime reconciliation", true, "cleanup")
    }
    const local = `tcp:${this.localPort}`
    const current = (await this.deps.forwards()).find(forward => forward.local === local)
    if (!current) {
      this.ownership = "none"
      return
    }
    if (current.serial !== this.serial || current.remote !== "localabstract:chrome_devtools_remote") {
      throw new AdbForwardOwnershipError(`ADB forward ${local} ownership changed; foreign forward preserved`, true)
    }
    await this.deps.remove(this.localPort, this.serial)
    this.ownership = "none"
  }

  private async reconcileFailedCreate(originalError: unknown): Promise<never> {
    if (originalError instanceof AdbCommandCleanupError && originalError.cleanupUnknown) {
      this.ownership = "attempted-unknown"
      let observed = "inventory unavailable"
      try {
        const local = `tcp:${this.localPort}`
        const current = (await this.deps.forwards()).find(forward => forward.local === local)
        observed = current ? `${current.serial} ${current.local} ${current.remote}` : "no current mapping"
      } catch (error) {
        observed = `inventory failed: ${error instanceof Error ? error.message : String(error)}`
      }
      throw new AdbForwardOwnershipError(
        `ADB create process cleanup is unknown; ${observed}; runtime reconciliation required`,
        true,
        "cleanup",
      )
    }
    try {
      const local = `tcp:${this.localPort}`
      const current = (await this.deps.forwards()).find(forward => forward.local === local)
      if (!current) {
        this.ownership = "none"
        throw originalError
      }
      this.ownership = "attempted-unknown"
      const mapping = `${current.serial} ${current.local} ${current.remote}`
      throw new AdbForwardOwnershipError(
        `ADB forward create ACK lost; observed mapping preserved for runtime reconciliation: ${mapping}`,
        true,
        "cleanup",
      )
    } catch (reconcileError) {
      if (reconcileError === originalError || reconcileError instanceof AdbForwardOwnershipError) throw reconcileError
      this.ownership = "attempted-unknown"
      throw new AdbForwardOwnershipError(
        `ADB forward create failed and reconciliation is unavailable: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
        true,
        "cleanup",
      )
    }
  }
}

export class ForwardOwnedDeviceBrowserDriver implements DeviceBrowserDriver {
  constructor(
    private readonly forward: OwnedAdbForward,
    private readonly delegate: DeviceBrowserDriver,
  ) {}

  listDevices(signal: AbortSignal) {
    return this.delegate.listDevices(signal)
  }

  async connect(serial: string, localPort: number, signal: AbortSignal): Promise<{ browserVersion: string }> {
    if (serial !== this.forward.serial || localPort !== this.forward.localPort) {
      throw new Error("Android connect does not match owned forward identity")
    }
    if (signal.aborted) throw new DOMException("Android connect aborted", "AbortError")
    await this.forward.connect(signal)
    try {
      const result = await this.delegate.connect(serial, localPort, signal)
      if (signal.aborted) throw new DOMException("Android connect aborted", "AbortError")
      await this.assertAfter(signal)
      return result
    } catch (error) {
      try {
        await this.forward.disconnect()
      } catch (cleanupError) {
        throw new AdbForwardOwnershipError(
          `Android connect failed and forward cleanup is unknown: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          true,
          "cleanup",
        )
      }
      throw error
    }
  }

  async disconnect(serial: string, localPort: number): Promise<void> {
    if (serial !== this.forward.serial || localPort !== this.forward.localPort) {
      throw new Error("Android disconnect does not match owned forward identity")
    }
    let delegateError: unknown
    try {
      await this.delegate.disconnect(serial, localPort)
    } catch (error) {
      delegateError = error
    }
    await this.forward.disconnect()
    if (delegateError) throw delegateError
  }

  async listTargets(signal: AbortSignal) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.listTargets(signal)
    await this.assertAfter(signal)
    return result
  }

  forwardStatus(signal: AbortSignal) {
    return this.forward.status(signal)
  }

  async openTarget(serial: string, url: string, signal: AbortSignal) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.openTarget(serial, url, signal)
    await this.assertAfter(signal)
    return result
  }

  async closeTarget(targetId: string, signal: AbortSignal) {
    await this.forward.assertCurrent(signal)
    await this.delegate.closeTarget(targetId, signal)
    await this.assertAfter(signal)
  }

  async navigateTarget(
    targetId: string,
    url: string,
    policy: ReadinessPolicy,
    timeoutMs: number,
    signal: AbortSignal,
    onDispatched: () => void,
  ) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.navigateTarget(targetId, url, policy, timeoutMs, signal, onDispatched)
    await this.assertAfter(signal)
    return result
  }

  async reloadTarget(
    targetId: string,
    ignoreCache: boolean,
    policy: ReadinessPolicy,
    timeoutMs: number,
    signal: AbortSignal,
    onDispatched: () => void,
  ) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.reloadTarget(targetId, ignoreCache, policy, timeoutMs, signal, onDispatched)
    await this.assertAfter(signal)
    return result
  }

  async waitTarget(
    targetId: string,
    policy: ReadinessPolicy,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.waitTarget(targetId, policy, timeoutMs, signal)
    await this.assertAfter(signal)
    return result
  }

  async captureTarget(
    targetId: string,
    request: BrowserCaptureRequest,
    signal: AbortSignal,
  ) {
    await this.forward.assertCurrent(signal)
    const result = await this.delegate.captureTarget(targetId, request, signal)
    await this.assertAfter(signal)
    return result
  }

  private async assertAfter(signal: AbortSignal): Promise<void> {
    try {
      await this.forward.assertCurrent(signal)
    } catch (error) {
      throw new AdbForwardOwnershipError(
        `ADB forward changed during CDP operation: ${error instanceof Error ? error.message : String(error)}`,
        true,
        "post",
      )
    }
  }
}

export class AndroidCdpDriver implements DeviceBrowserDriver {
  private readonly browser: CdpBrowserDriver

  constructor(
    private readonly serial: string,
    localPort: number,
    private readonly http = new CdpHttp("localhost", localPort),
    private readonly openUrl: (serial: string, url: string, signal?: AbortSignal) => Promise<void> = adbOpenUrl,
    private readonly delay: (ms: number) => Promise<void> = Bun.sleep,
  ) {
    this.browser = new CdpBrowserDriver(http)
  }

  listDevices(signal: AbortSignal) {
    return adbDevices(signal)
  }

  connect(serial: string, _localPort: number, signal: AbortSignal) {
    this.assertSerial(serial)
    return this.browser.connect(signal)
  }

  disconnect() {
    return this.browser.disconnect()
  }

  listTargets(signal: AbortSignal) {
    return this.browser.listTargets(signal)
  }

  async openTarget(serial: string, url: string, signal: AbortSignal): Promise<CdpTarget> {
    this.assertSerial(serial)
    const before = new Set((await this.http.list(signal)).filter(target => target.type === "page").map(target => target.id))
    if (signal.aborted) throw new DOMException("Android target creation aborted", "AbortError")
    await this.openUrl(serial, url, signal)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException("Android target creation aborted", "AbortError")
      const created = selectCreatedTarget(before, await this.http.list(signal))
      if (created) return created
      await this.delay(50)
    }
    throw new Error(`Android target creation timed out for serial=${serial}`)
  }

  closeTarget(targetId: string, signal: AbortSignal) {
    return this.browser.closeTarget(targetId, signal)
  }

  navigateTarget(
    targetId: string,
    url: string,
    policy: ReadinessPolicy,
    timeoutMs: number,
    signal: AbortSignal,
    onDispatched: () => void,
  ) {
    return this.browser.navigateTarget(targetId, url, policy, timeoutMs, signal, onDispatched)
  }

  reloadTarget(
    targetId: string,
    ignoreCache: boolean,
    policy: ReadinessPolicy,
    timeoutMs: number,
    signal: AbortSignal,
    onDispatched: () => void,
  ) {
    return this.browser.reloadTarget(targetId, ignoreCache, policy, timeoutMs, signal, onDispatched)
  }

  waitTarget(targetId: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal) {
    return this.browser.waitTarget(targetId, policy, timeoutMs, signal)
  }

  captureTarget(targetId: string, request: BrowserCaptureRequest, signal: AbortSignal) {
    return this.browser.captureTarget(targetId, request, signal)
  }

  private assertSerial(serial: string): void {
    if (serial !== this.serial) throw new Error(`Android driver serial mismatch: ${serial}`)
  }
}

export type AndroidAdapterComposition = Omit<ConfiguredDeviceBrowser, "driver"> & {
  forwardDeps?: AdbForwardDeps
  http?: CdpHttp
}

export function createAndroidChromeAdapter(
  host: AdapterHostContext,
  services: AdapterServices,
  composition: AndroidAdapterComposition,
  nextBrowserGeneration?: () => string,
  now?: () => Date,
  nextDeviceGeneration?: () => string,
): RuntimeDeviceBrowserAdapter {
  const forward = new OwnedAdbForward(composition.serial, composition.localPort, composition.forwardDeps)
  const cdp = new AndroidCdpDriver(composition.serial, composition.localPort, composition.http)
  const driver = new ForwardOwnedDeviceBrowserDriver(forward, cdp)
  return new RuntimeDeviceBrowserAdapter(host, services, [{ ...composition, driver }], nextBrowserGeneration, now, nextDeviceGeneration)
}

function errorIsForwardMismatch(reason: string): boolean {
  return reason.includes("ADB forward") || reason.includes("forward ownership")
}

function deviceTargetResource(instance: string, target: string): string {
  const value = `android-cdp:${instance}:${target}`
  if (value.length > 127) throw new Error("Android target resource ref exceeds contract limit")
  return value
}

function released(handles: readonly RuntimeResourceHandle[]): CleanupOutcome {
  if (handles.length === 0) return { scope: "none", state: "complete", resources: [] }
  return { scope: "owned", state: "complete", resources: handles.map(handle => ({ handle, outcome: "released" })) }
}

function quarantined(handles: readonly RuntimeResourceHandle[], reason: string): CleanupOutcome {
  if (handles.length === 0) return { scope: "none", state: "complete", resources: [] }
  return { scope: "owned", state: "unknown", resources: handles.map(handle => ({ handle, outcome: "quarantined" })), reason }
}

function succeeded(request: DeviceBrowserOperationRequest, cleanup: CleanupOutcome): OperationOutcome {
  const read = request.kind === "wait-target" || request.kind === "capture-target"
  return { dispatch: read ? "none" : "finished", targetVerified: "verified", userInterference: "unknown", observation: request.kind === "capture-target" ? "available" : "unavailable", effect: { state: "unverified", proofRefs: [] }, cleanup, restoration: "not-applicable", dispatchAttempts: read ? 0 : 1 }
}

function failed(cleanup: CleanupOutcome, stage: DispatchStage): OperationOutcome {
  const dispatch = stage === "not-sent" ? "none" : stage === "sent" ? "unknown" : "finished"
  return { dispatch, targetVerified: "unknown", userInterference: "unknown", observation: "unavailable", effect: { state: "unverified", proofRefs: [] }, cleanup, restoration: "not-applicable", dispatchAttempts: stage === "not-sent" ? 0 : 1 }
}

function deviceError(error: unknown, unknown: boolean): ContractError {
  return { code: unknown ? "deadline-exceeded" : String(error).includes("stale") || String(error).includes("not found") ? "target-stale" : "internal-error", message: error instanceof Error ? error.message : String(error), stage: "device-browser-adapter", retryable: !unknown, replayAllowed: false, recoveryAction: unknown ? "get-operation" : "refresh-inventory" }
}

async function deviceCaptureResult(
  host: AdapterHostContext,
  services: AdapterServices,
  request: BrowserCaptureRequest,
  target: DeviceBrowserTargetRecord["ref"],
  captured: DeviceDriverCapture,
) {
  const sha256 = new Bun.CryptoHasher("sha256").update(captured.bytes).digest("hex")
  const frameRef = request.publication.frameRef
  const imageRect = { x: 0, y: 0, width: captured.width, height: captured.height }
  const destination = { x: request.clip.kind === "rect" ? request.clip.rect.x : 0, y: request.clip.kind === "rect" ? request.clip.rect.y : 0, width: captured.width / request.output.scale, height: captured.height / request.output.scale }
  const frame = { frameRef, observationId: request.publication.observationId, ...host.generation, source: "device-browser-viewport" as const, target: request.target, capturedAt: captured.capturedAt, widthPx: captured.width, heightPx: captured.height, byteLength: captured.bytes.byteLength, sha256, mime: "image/png" as const }
  const cleanup = { scope: "none" as const, state: "complete" as const, resources: [] as [] }
  const observation = {
    observationId: request.publication.observationId,
    ...host.generation,
    captureTarget: request.target,
    caption: request.caption,
    backend: { name: "android-cdp", buildId: host.runtimeBuildId },
    capturedAt: captured.capturedAt,
    expiresAt: request.publication.expiresAt,
    inventoryRevision: request.publication.inventoryRevision,
    displayLayoutRevision: request.publication.displayLayoutRevision,
    source: "device-browser-viewport" as const,
    image: { frameRef, widthPx: captured.width, heightPx: captured.height, mime: "image/png" as const, byteLength: captured.bytes.byteLength, sha256 },
    cursor: "excluded" as const,
    clip: imageRect,
    captureEvidence: { state: "unknown" as const, claim: "frame-freshness", source: "android-cdp", reason: "runtime proof publication pending" },
    occlusion: { state: "unknown" as const, claim: "occlusion", source: "android-cdp", reason: "device viewport has no desktop occlusion" },
    readiness: captured.readiness,
    synchronization: { kind: "single-frame" as const },
    regions: [{ space: { kind: "device-browser-viewport" as const, target }, imageRect, destinationRect: destination, imageToDestination: { a: 1 / request.output.scale, b: 0, c: 0, d: 1 / request.output.scale, tx: destination.x, ty: destination.y }, frameTimestamp: captured.capturedAt, frameStatus: "complete" as const }],
    unavailableReasons: [],
  }
  const capture = { publication: request.publication, observation, frame, effective: { clip: request.clip, fullPage: request.fullPage, cursor: "excluded" as const, scale: request.output.scale, widthPx: captured.width, heightPx: captured.height, pixelCount: captured.width * captured.height, encodedBytes: captured.bytes.byteLength, readinessPolicy: request.readinessPolicy }, cleanup }
  await verifyAndPublishBinaryFrame(services.frames, request, capture, captured.bytes)
  return capture
}
