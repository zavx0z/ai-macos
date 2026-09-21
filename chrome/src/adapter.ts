import { CdpHttp, CdpTransportError, withSession, type CdpTarget } from "@meta/shared"
import {
  authorizeBrowserOperation,
  assertBrowserResultMatchesRequest,
  assertCleanupOwnsExactHandles,
  browserOperationResultSchema,
  browserInstanceSnapshotSchema,
  browserTargetSnapshotSchema,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type BrowserAdapter,
  type BrowserCaptureRequest,
  type BrowserExecutionContext,
  type BrowserInstanceRecord,
  type BrowserInstanceSnapshot,
  type BrowserOperationRequest,
  type BrowserOperationResult,
  type BrowserProvenance,
  type BrowserTargetRecord,
  type BrowserTargetSnapshot,
  type CleanupOutcome,
  type ContractError,
  type OperationOutcome,
  type ReadinessPolicy,
  type ReadinessResult,
  type RuntimeOperationContext,
  type RuntimeProcessRef,
  type RuntimeResourceHandle,
  verifyAndPublishBinaryFrame,
  structurallyEqual,
} from "@meta/shared/contracts"
import {
  cdpCaptureScreenshot,
  cdpConsoleListen,
  cdpEval,
  cdpNavigate,
  cdpReload,
  cdpWaitReady,
} from "./cdp-mode.ts"
import type { WaitReadyOptions, WaitReadyResult } from "./wait-ready.ts"

export type BrowserDriverCapture = {
  bytes: Uint8Array
  width: number
  height: number
  capturedAt: string
  readiness: ReadinessResult
}

export type BrowserDomReadRequest = {
  offsetBytes: number
  maxBytes: number
  expectedSnapshotSha256?: string
}

export type BrowserDomReadChunk = {
  content: string
  contentBytes: number
  offsetBytes: number
  nextOffsetBytes: number
  totalBytes: number
  snapshotSha256: string
  truncated: boolean
}

export type BrowserResourceReadRequest = {
  url: string
  offsetBytes: number
  maxBytes: number
  expectedSnapshotSha256?: string
}

export type BrowserResourceReadResult = {
  url: string
  status: number
  contentType: string
  body: string
  bodyBytes: number
  offsetBytes: number
  nextOffsetBytes: number
  totalBytes: number
  snapshotSha256: string
  truncated: boolean
}

export interface BrowserDriver {
  connect(signal: AbortSignal): Promise<{ browserVersion: string }>
  disconnect(): Promise<void>
  listTargets(signal: AbortSignal): Promise<CdpTarget[]>
  openTarget(url: string, signal: AbortSignal): Promise<CdpTarget>
  closeTarget(targetId: string, signal: AbortSignal): Promise<void>
  activateTarget(targetId: string, signal: AbortSignal): Promise<void>
  navigateTarget(targetId: string, url: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult>
  reloadTarget(targetId: string, ignoreCache: boolean, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult>
  waitTarget(targetId: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal): Promise<ReadinessResult>
  captureTarget(targetId: string, request: BrowserCaptureRequest, signal: AbortSignal): Promise<BrowserDriverCapture>
  readConsole(targetId: string, maxEvents: number, maxBytes: number, signal: AbortSignal): Promise<{ entries: Array<{ level: "log" | "info" | "warn" | "error" | "debug", text: string, timestamp: string }>, droppedEvents: number }>
  readDom(targetId: string, request: BrowserDomReadRequest, signal: AbortSignal): Promise<BrowserDomReadChunk>
  readResource(targetId: string, request: BrowserResourceReadRequest, signal: AbortSignal): Promise<BrowserResourceReadResult>
  readAccessibility(targetId: string, maxNodes: number, maxBytes: number, signal: AbortSignal): Promise<{ content: string, nodeCount: number, truncated: boolean }>
}

export type ConfiguredBrowserInstance = {
  browserInstanceRef: string
  initialTransportGeneration: string
  provenance: BrowserProvenance
  profileLabel?: string
  process?: RuntimeProcessRef
  driver: BrowserDriver
}

type InstanceState = ConfiguredBrowserInstance & {
  ref: BrowserInstanceRecord["ref"]
  state: BrowserInstanceRecord["state"]
  reason?: string
}

type DispatchStage = "not-sent" | "sent" | "acknowledged" | "reconciled"
type DispatchTracker = { stage: DispatchStage }

export class RuntimeBrowserAdapter implements BrowserAdapter {
  readonly capabilities = [
    "browser.instances",
    "browser.targets",
    "browser.observe",
    "browser.readiness",
    "browser.resources",
  ] as const
  private readonly instances = new Map<string, InstanceState>()
  private inventoryRevision = 0
  private inventorySequence = 0
  private readonly targetFingerprints = new Map<string, string>()
  private readonly recoveredRefs = new Set<string>()

  constructor(
    readonly host: AdapterHostContext,
    readonly services: AdapterServices,
    configured: readonly ConfiguredBrowserInstance[],
    private readonly generationId: () => string = () => `cdp:${crypto.randomUUID()}`,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (configured.length > 128) throw new Error("Browser configured instance count exceeds 128")
    for (const item of configured) {
      if (this.instances.has(item.browserInstanceRef)) throw new Error(`Duplicate browser instance ${item.browserInstanceRef}`)
      this.instances.set(item.browserInstanceRef, {
        ...item,
        ref: {
          ...host.generation,
          browserInstanceRef: item.browserInstanceRef,
          transportGeneration: item.initialTransportGeneration,
        },
        state: "disconnected",
        reason: "explicit-connect-required",
      })
    }
  }

  async listInstances(control: BrowserExecutionContext extends never ? never : RuntimeOperationContext["control"]): Promise<BrowserInstanceSnapshot> {
    await control.checkpoint("browser-inventory")
    return browserInstanceSnapshotSchema.parse({
      ...this.snapshotBase(),
      instances: [...this.instances.values()].map(instance => this.instanceRecord(instance)),
    })
  }

  async listTargets(instanceRef: BrowserInstanceRecord["ref"], control: RuntimeOperationContext["control"]): Promise<BrowserTargetSnapshot> {
    await control.checkpoint("browser-target-inventory")
    const instance = this.requireInstance(instanceRef, true)
    try {
      const targets = await instance.driver.listTargets(control.signal)
      this.observeTargetInventory(instance.ref.browserInstanceRef, targets)
      if (targets.length > 4_096) throw new Error("Browser target inventory exceeds 4096")
      return browserTargetSnapshotSchema.parse({
        ...this.snapshotBase(),
        instance: instance.ref,
        targets: targets.filter(target => target.type === "page").map(target => this.targetRecord(instance, target)),
      })
    } catch (error) {
      return browserTargetSnapshotSchema.parse({
        ...this.snapshotBase(),
        complete: false,
        errors: [contractError(error, error instanceof CdpTransportError)],
        instance: instance.ref,
        targets: [],
      })
    }
  }

  async execute(
    context: RuntimeOperationContext<BrowserExecutionContext>,
    request: BrowserOperationRequest,
  ): Promise<AdapterResult<BrowserOperationResult>> {
    const dispatch: DispatchTracker = { stage: "not-sent" }
    try {
      await authorizeBrowserOperation(this, context, request, this.now())
      await context.control.checkpoint(`browser:${request.kind}:authorized`)
      const value = await this.executeAuthorized(context, request, dispatch)
      dispatch.stage = "reconciled"
      const cleanup = releasedCleanup(context.resources)
      const result = browserOperationResultSchema.parse({ value, cleanup })
      assertBrowserResultMatchesRequest(request, result)
      await assertCleanupOwnsExactHandles(this.services.resources, context.wire.operationId, context.resources, cleanup)
      return {
        ok: true,
        value: result,
        outcome: successOutcome(request, cleanup),
      }
    } catch (error) {
      const transportUnknown = error instanceof CdpTransportError
        && ["command-timeout", "connect-timeout", "disconnected"].includes(error.code)
      const deliveryUnknown = dispatch.stage === "sent"
      if (transportUnknown) this.invalidateRequestInstance(request, error.message)
      const cleanup = deliveryUnknown ? quarantinedCleanup(context.resources, String(error)) : releasedCleanup(context.resources)
      return {
        ok: false,
        error: contractError(error, deliveryUnknown || transportUnknown),
        outcome: failureOutcome(cleanup, dispatch.stage),
      }
    }
  }

  async recoverDisconnected(
    reference: BrowserInstanceRecord["ref"],
    verifyPhysicalDisconnect: () => Promise<void>,
  ): Promise<void> {
    const instance = this.instances.get(reference.browserInstanceRef)
    if (!instance) throw new Error("Browser recovery instance not configured")
    await verifyPhysicalDisconnect()
    instance.state = "disconnected"
    instance.reason = "recovered-physical-disconnect"
    this.recoveredRefs.add(JSON.stringify(reference))
    this.inventoryRevision += 1
  }

  assertConnectedExact(reference: BrowserInstanceRecord["ref"]): void {
    const instance = this.instances.get(reference.browserInstanceRef)
    if (!instance || !structurallyEqual(instance.ref, reference) || instance.state !== "connected") {
      throw new Error("Exact Browser instance is not connected")
    }
  }

  assertDisconnectedExact(reference: BrowserInstanceRecord["ref"]): void {
    if (this.recoveredRefs.has(JSON.stringify(reference))) return
    const instance = this.instances.get(reference.browserInstanceRef)
    if (!instance || !structurallyEqual(instance.ref, reference) || instance.state === "connected") {
      throw new Error("Exact Browser instance physical disconnect is not verified")
    }
  }

  private async executeAuthorized(
    context: RuntimeOperationContext<BrowserExecutionContext>,
    request: BrowserOperationRequest,
    dispatch: DispatchTracker,
  ): Promise<BrowserOperationResult["value"]> {
    if (request.kind === "connect-instance") {
      const instance = this.requireInstance(request.instance, false)
      const transportGeneration = this.generationId()
      if (transportGeneration === instance.ref.transportGeneration) throw new Error("Browser transport generation must advance")
      dispatch.stage = "sent"
      await instance.driver.connect(context.control.signal)
      dispatch.stage = "acknowledged"
      instance.ref = { ...instance.ref, transportGeneration }
      instance.state = "connected"
      delete instance.reason
      this.inventoryRevision += 1
      return { kind: "instance-connected", instance: this.instanceRecord(instance) }
    }
    if (request.kind === "disconnect-instance") {
      const instance = this.requireInstance(request.instance, true)
      dispatch.stage = "sent"
      await instance.driver.disconnect()
      dispatch.stage = "acknowledged"
      instance.state = "disconnected"
      instance.reason = "explicitly-disconnected"
      this.inventoryRevision += 1
      return { kind: "instance-disconnected", instance: instance.ref }
    }
    if (request.kind === "open-target") {
      const instance = this.requireInstance(request.instance, true)
      dispatch.stage = "sent"
      const opened = await instance.driver.openTarget(request.url, context.control.signal)
      dispatch.stage = "acknowledged"
      const readiness = await instance.driver.waitTarget(opened.id, request.policy, request.timeoutMs, context.control.signal)
      this.inventoryRevision += 1
      return { kind: "target-opened", target: this.targetRecord(instance, opened), readiness }
    }

    const targetRef = request.target
    const instance = this.requireInstance(targetRef, true)
    const target = await this.requireTarget(instance, targetRef.targetId, context.control.signal)
    await context.control.checkpoint(`browser:${request.kind}:target-verified`)

    switch (request.kind) {
      case "close-target":
        dispatch.stage = "sent"
        await instance.driver.closeTarget(target!.id, context.control.signal)
        dispatch.stage = "acknowledged"
        if ((await instance.driver.listTargets(context.control.signal)).some(candidate => candidate.id === target!.id)) {
          throw new Error(`CDP target remained after close: ${target!.id}`)
        }
        this.inventoryRevision += 1
        return { kind: "target-closed", target: request.target }
      case "activate-visible-target":
        dispatch.stage = "sent"
        await instance.driver.activateTarget(target!.id, context.control.signal)
        dispatch.stage = "acknowledged"
        return { kind: "target-activated", target: request.target }
      case "navigate-target": {
        dispatch.stage = "sent"
        const readiness = await instance.driver.navigateTarget(target!.id, request.url, request.policy, request.timeoutMs, context.control.signal, () => { dispatch.stage = "acknowledged" })
        return { kind: "target-navigated", target: this.targetRecord(instance, await this.requireTarget(instance, target!.id, context.control.signal)), readiness }
      }
      case "reload-target": {
        dispatch.stage = "sent"
        const readiness = await instance.driver.reloadTarget(target!.id, request.ignoreCache, request.policy, request.timeoutMs, context.control.signal, () => { dispatch.stage = "acknowledged" })
        return { kind: "target-reloaded", target: this.targetRecord(instance, await this.requireTarget(instance, target!.id, context.control.signal)), readiness }
      }
      case "wait-target":
        return { kind: "target-ready", target: request.target, readiness: await instance.driver.waitTarget(target!.id, request.policy, request.timeoutMs, context.control.signal) }
      case "capture-target": {
        const captured = await instance.driver.captureTarget(target!.id, request.capture, context.control.signal)
        const capture = await buildCaptureResult(this.host, this.services, request.capture, request.target, captured)
        return { kind: "target-captured", target: request.target, capture }
      }
      case "read-console": {
        const read = await instance.driver.readConsole(target!.id, request.maxEvents, request.maxBytes, context.control.signal)
        const bounded = boundConsole(read.entries, request.maxEvents, request.maxBytes)
        return { kind: "console-read", target: request.target, ...bounded, droppedEvents: read.droppedEvents + bounded.droppedEvents }
      }
      case "read-dom": {
        const read = await instance.driver.readDom(target!.id, {
          offsetBytes: request.offsetBytes ?? 0,
          maxBytes: request.maxBytes,
          ...(request.expectedSnapshotSha256 === undefined
            ? {}
            : { expectedSnapshotSha256: request.expectedSnapshotSha256 }),
        }, context.control.signal)
        return { kind: "dom-read", target: request.target, ...read }
      }
      case "read-resource": {
        const read = await instance.driver.readResource(target!.id, {
          url: request.url,
          offsetBytes: request.offsetBytes ?? 0,
          maxBytes: request.maxBytes,
          ...(request.expectedSnapshotSha256 === undefined
            ? {}
            : { expectedSnapshotSha256: request.expectedSnapshotSha256 }),
        }, context.control.signal)
        return { kind: "resource-read", target: request.target, ...read }
      }
      case "read-accessibility": {
        const read = await instance.driver.readAccessibility(target!.id, request.maxNodes, request.maxBytes, context.control.signal)
        const bounded = boundText(read.content, request.maxBytes)
        return { kind: "accessibility-read", target: request.target, content: bounded.text, contentBytes: bounded.bytes, nodeCount: Math.min(read.nodeCount, request.maxNodes), truncated: read.truncated || bounded.truncated || read.nodeCount > request.maxNodes }
      }
    }
  }

  private requireInstance(reference: BrowserInstanceRecord["ref"], connected: boolean): InstanceState {
    const instance = this.instances.get(reference.browserInstanceRef)
    if (!instance) throw new Error(`Browser instance not found: ${reference.browserInstanceRef}`)
    if (reference.runtimeEpoch !== this.host.generation.runtimeEpoch || reference.loginSessionId !== this.host.generation.loginSessionId) {
      throw new Error("Browser instance belongs to another runtime generation")
    }
    if (reference.transportGeneration !== instance.ref.transportGeneration) throw new Error("Browser transport generation is stale")
    if (connected && instance.state !== "connected") throw new Error("Browser instance is not connected")
    return instance
  }

  private async requireTarget(instance: InstanceState, targetId: string, signal: AbortSignal): Promise<CdpTarget> {
    const target = (await instance.driver.listTargets(signal)).find(candidate => candidate.id === targetId)
    if (!target) throw new Error(`CDP target not found: ${targetId}`)
    return target
  }

  private targetRecord(instance: InstanceState, target: CdpTarget): BrowserTargetRecord {
    return {
      ref: { ...instance.ref, targetId: target.id, resourceRef: targetResourceRef(instance.ref.browserInstanceRef, target.id) },
      type: target.type,
      title: target.title,
      url: target.url,
    }
  }

  private instanceRecord(instance: InstanceState): BrowserInstanceRecord {
    return {
      ref: instance.ref,
      provenance: instance.provenance,
      ...(instance.profileLabel === undefined ? {} : { profileLabel: instance.profileLabel }),
      ...(instance.process === undefined ? {} : { process: instance.process }),
      state: instance.state,
      ...(instance.reason === undefined ? {} : { reason: instance.reason }),
    }
  }

  private snapshotBase() {
    this.inventorySequence += 1
    this.inventoryRevision += 1
    return {
      inventoryId: `browser-inventory:${this.inventorySequence}`,
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

  private invalidateRequestInstance(request: BrowserOperationRequest, reason: string): void {
    const ref = "instance" in request ? request.instance : request.target
    const instance = this.instances.get(ref.browserInstanceRef)
    if (!instance) return
    instance.ref = { ...instance.ref, transportGeneration: this.generationId() }
    instance.state = "degraded"
    instance.reason = `transport-invalidated: ${reason}`
    this.inventoryRevision += 1
  }
}

export class CdpBrowserDriver implements BrowserDriver {
  constructor(private readonly http: CdpHttp) {}

  async connect(signal: AbortSignal): Promise<{ browserVersion: string }> {
    const version = await this.http.version(signal)
    return { browserVersion: version.Browser }
  }

  async disconnect(): Promise<void> {}

  async listTargets(signal: AbortSignal): Promise<CdpTarget[]> {
    return await this.http.list(signal)
  }

  async openTarget(url: string, signal: AbortSignal): Promise<CdpTarget> {
    return await this.http.newTab(url, signal)
  }

  async closeTarget(targetId: string, signal: AbortSignal): Promise<void> {
    await this.http.closeTab(targetId, signal)
  }

  async activateTarget(targetId: string, signal: AbortSignal): Promise<void> {
    await this.http.activateTab(targetId, signal)
  }

  async navigateTarget(targetId: string, url: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult> {
    const target = await this.target(targetId, signal)
    const result = await cdpNavigate(target, url, true, waitOptions(policy, timeoutMs), signal, onDispatched)
    return readiness(policy, result.ready!)
  }

  async reloadTarget(targetId: string, ignoreCache: boolean, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal, onDispatched: () => void): Promise<ReadinessResult> {
    const target = await this.target(targetId, signal)
    const result = await cdpReload(target, ignoreCache, true, waitOptions(policy, timeoutMs), signal, onDispatched)
    return readiness(policy, result.ready!)
  }

  async waitTarget(targetId: string, policy: ReadinessPolicy, timeoutMs: number, signal: AbortSignal): Promise<ReadinessResult> {
    return readiness(policy, await cdpWaitReady(await this.target(targetId, signal), waitOptions(policy, timeoutMs), signal))
  }

  async captureTarget(targetId: string, request: BrowserCaptureRequest, signal: AbortSignal): Promise<BrowserDriverCapture> {
    const ready = await this.waitTarget(targetId, request.readinessPolicy, 30_000, signal)
    const capture = await cdpCaptureScreenshot(await this.target(targetId, signal), {
      format: "png",
      fullPage: request.fullPage,
      clip: request.clip.kind === "rect" ? request.clip.rect : undefined,
      scale: request.output.scale,
      maxWidth: request.output.maxWidthPx,
      maxHeight: request.output.maxHeightPx,
      maxPixels: request.output.maxPixels,
      maxBytes: request.output.maxEncodedBytes,
    }, signal)
    const capturedAt = new Date().toISOString()
    return {
      bytes: Buffer.from(capture.data, "base64"),
      width: capture.width,
      height: capture.height,
      capturedAt,
      readiness: withCompleteFrame(ready),
    }
  }

  async readConsole(targetId: string, maxEvents: number, _maxBytes: number, signal: AbortSignal): Promise<{ entries: Array<{ level: "log" | "info" | "warn" | "error" | "debug", text: string, timestamp: string }>, droppedEvents: number }> {
    let droppedEvents = 0
    const raw = await cdpConsoleListen(await this.target(targetId, signal), 250, true, signal, {
      maxEvents,
      maxBytes: _maxBytes,
      onDrop: () => { droppedEvents += 1 },
    })
    const entries = raw.slice(0, maxEvents).map(entry => ({
      level: entry.level === "verbose" ? "debug" : entry.level,
      text: entry.text,
      timestamp: new Date(entry.timestamp > 10_000_000_000 ? entry.timestamp : entry.timestamp * 1_000).toISOString(),
    }))
    return { entries, droppedEvents: droppedEvents + Math.max(0, raw.length - entries.length) }
  }

  async readDom(targetId: string, request: BrowserDomReadRequest, signal: AbortSignal): Promise<BrowserDomReadChunk> {
    const expectedSnapshot = request.expectedSnapshotSha256 ?? null
    const result = await cdpEval(await this.target(targetId, signal), `
      const offsetBytes = ${request.offsetBytes};
      const maxBytes = ${request.maxBytes};
      const expectedSnapshotSha256 = ${JSON.stringify(expectedSnapshot)};
      const value = document.documentElement.outerHTML;
      const bytes = new TextEncoder().encode(value);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const snapshotSha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");

      if (expectedSnapshotSha256 !== null && snapshotSha256 !== expectedSnapshotSha256) {
        throw new Error("DOM_SNAPSHOT_CHANGED expected=" + expectedSnapshotSha256 + " actual=" + snapshotSha256);
      }
      if (offsetBytes > bytes.byteLength) {
        throw new Error("DOM_OFFSET_OUT_OF_RANGE offset=" + offsetBytes + " total=" + bytes.byteLength);
      }
      if (offsetBytes < bytes.byteLength && (bytes[offsetBytes] & 0xc0) === 0x80) {
        throw new Error("DOM_OFFSET_NOT_UTF8_BOUNDARY offset=" + offsetBytes);
      }

      let end = Math.min(bytes.byteLength, offsetBytes + maxBytes);
      while (end > offsetBytes && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
      if (end === offsetBytes && offsetBytes < bytes.byteLength) {
        throw new Error("DOM_MAX_BYTES_TOO_SMALL maxBytes=" + maxBytes);
      }

      const contentBytes = end - offsetBytes;
      return {
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offsetBytes, end)),
        contentBytes,
        offsetBytes,
        nextOffsetBytes: end,
        totalBytes: bytes.byteLength,
        snapshotSha256,
        truncated: end < bytes.byteLength,
      };
    `, signal)
    return JSON.parse(result) as BrowserDomReadChunk
  }

  async readResource(targetId: string, request: BrowserResourceReadRequest, signal: AbortSignal): Promise<BrowserResourceReadResult> {
    const target = await this.target(targetId, signal)
    let pageUrl: URL
    let resourceUrl: URL
    try {
      pageUrl = new URL(target.url)
      resourceUrl = new URL(request.url, pageUrl)
    } catch {
      throw new Error("Browser resource read requires a valid same-origin URL")
    }
    if (!["http:", "https:"].includes(pageUrl.protocol) || resourceUrl.origin !== pageUrl.origin
      || resourceUrl.username !== "" || resourceUrl.password !== "") {
      throw new Error("Browser resource read requires same-origin http(s) URL")
    }

    const resolvedUrl = resourceUrl.href
    const maxResourceBytes = 16 * 1024 * 1024
    const expectedSnapshot = request.expectedSnapshotSha256 ?? null
    const result = await cdpEval(target, `
      const resolvedUrl = ${JSON.stringify(resolvedUrl)};
      const expectedOrigin = ${JSON.stringify(pageUrl.origin)};
      if (location.origin !== expectedOrigin || new URL(resolvedUrl, location.href).origin !== location.origin) {
        throw new Error("RESOURCE_ORIGIN_CHANGED");
      }
      const offsetBytes = ${request.offsetBytes};
      const maxBytes = ${request.maxBytes};
      const maxResourceBytes = ${maxResourceBytes};
      const expectedSnapshotSha256 = ${JSON.stringify(expectedSnapshot)};
      const response = await fetch(resolvedUrl, {
        method: "GET",
        mode: "same-origin",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!(
        contentType.startsWith("text/")
        || contentType.includes("json")
        || contentType.includes("javascript")
        || contentType.includes("xml")
      )) {
        throw new Error("BROWSER_RESOURCE_NOT_TEXT contentType=" + contentType);
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let rawBytes = 0;

      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const value = next.value;
          if (!value || value.byteLength === 0) continue;
          if (rawBytes + value.byteLength > maxResourceBytes) {
            await reader.cancel();
            throw new Error("BROWSER_RESOURCE_TOO_LARGE limit=" + maxResourceBytes);
          }
          chunks.push(value);
          rawBytes += value.byteLength;
        }
      }

      const bytes = new Uint8Array(rawBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const snapshotSha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      if (expectedSnapshotSha256 !== null && snapshotSha256 !== expectedSnapshotSha256) {
        throw new Error("RESOURCE_SNAPSHOT_CHANGED expected=" + expectedSnapshotSha256 + " actual=" + snapshotSha256);
      }
      if (offsetBytes > bytes.byteLength) {
        throw new Error("RESOURCE_OFFSET_OUT_OF_RANGE offset=" + offsetBytes + " total=" + bytes.byteLength);
      }
      if (offsetBytes < bytes.byteLength && (bytes[offsetBytes] & 0xc0) === 0x80) {
        throw new Error("RESOURCE_OFFSET_NOT_UTF8_BOUNDARY offset=" + offsetBytes);
      }

      let end = Math.min(bytes.byteLength, offsetBytes + maxBytes);
      while (end > offsetBytes && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
      if (end === offsetBytes && offsetBytes < bytes.byteLength) {
        throw new Error("RESOURCE_MAX_BYTES_TOO_SMALL maxBytes=" + maxBytes);
      }

      const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offsetBytes, end));
      const encoder = new TextEncoder();
      const bodyBytes = encoder.encode(body).byteLength;
      if (bodyBytes !== end - offsetBytes) {
        throw new Error("BROWSER_RESOURCE_UTF8_INVALID");
      }
      return {
        url: resolvedUrl,
        status: response.status,
        contentType,
        body,
        bodyBytes,
        offsetBytes,
        nextOffsetBytes: end,
        totalBytes: bytes.byteLength,
        snapshotSha256,
        truncated: end < bytes.byteLength,
      };
    `, signal)
    return JSON.parse(result) as BrowserResourceReadResult
  }

  async readAccessibility(targetId: string, maxNodes: number, maxBytes: number, signal: AbortSignal): Promise<{ content: string, nodeCount: number, truncated: boolean }> {
    const target = await this.target(targetId, signal)
    return await withSession(target, async session => {
      await session.send("Accessibility.enable")
      type AxNode = { nodeId?: string; childIds?: string[]; [key: string]: unknown }
      const root = await session.send<{ node: AxNode }>("Accessibility.getRootAXNode")
      const nodes: AxNode[] = [root.node]
      const queue = [...(root.node.childIds ?? [])]
      let truncated = false
      while (queue.length > 0 && nodes.length < maxNodes) {
        const nodeId = queue.shift()!
        const response = await session.send<{ nodes?: AxNode[] }>("Accessibility.getChildAXNodes", { id: nodeId })
        for (const node of response.nodes ?? []) {
          if (nodes.length >= maxNodes) { truncated = true; break }
          const candidate = JSON.stringify([...nodes, node])
          if (Buffer.byteLength(candidate) > maxBytes) { truncated = true; break }
          nodes.push(node)
          queue.push(...(node.childIds ?? []))
        }
        if (truncated) break
      }
      if (queue.length > 0) truncated = true
      return { content: JSON.stringify(nodes), nodeCount: nodes.length, truncated }
    }, { signal })
  }

  private async target(targetId: string, signal?: AbortSignal): Promise<CdpTarget> {
    const target = (await this.http.list(signal)).find(candidate => candidate.id === targetId)
    if (!target) throw new Error(`CDP target not found: ${targetId}`)
    return target
  }
}

function targetResourceRef(instanceRef: string, targetId: string): string {
  const value = `cdp:${instanceRef}:${targetId}`
  if (value.length > 127) throw new Error("CDP target resource ref exceeds contract limit")
  return value
}

function releasedCleanup(handles: readonly RuntimeResourceHandle[]): CleanupOutcome {
  if (handles.length === 0) return { scope: "none", state: "complete", resources: [] }
  return { scope: "owned", state: "complete", resources: handles.map(handle => ({ handle, outcome: "released" })) }
}

function quarantinedCleanup(handles: readonly RuntimeResourceHandle[], reason: string): CleanupOutcome {
  if (handles.length === 0) return { scope: "none", state: "complete", resources: [] }
  return { scope: "owned", state: "unknown", resources: handles.map(handle => ({ handle, outcome: "quarantined" })), reason }
}

function successOutcome(request: BrowserOperationRequest, cleanup: CleanupOutcome): OperationOutcome {
  const read = ["wait-target", "capture-target", "read-console", "read-dom", "read-resource", "read-accessibility"].includes(request.kind)
  return {
    dispatch: read ? "none" : "finished",
    targetVerified: "verified",
    userInterference: "unknown",
    observation: request.kind === "capture-target" ? "available" : "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: read ? 0 : 1,
  }
}

function failureOutcome(cleanup: CleanupOutcome, stage: DispatchStage): OperationOutcome {
  const dispatch = stage === "not-sent" ? "none" : stage === "sent" ? "unknown" : "finished"
  return {
    dispatch,
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: stage === "not-sent" ? 0 : 1,
  }
}

function contractError(error: unknown, unknown: boolean): ContractError {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("DOM_SNAPSHOT_CHANGED")) {
    return {
      code: "observation-stale",
      message,
      stage: "browser-adapter",
      retryable: true,
      recoveryAction: "retry-read-only",
      replayAllowed: true,
    }
  }
  if (message.includes("RESOURCE_SNAPSHOT_CHANGED")) {
    return {
      code: "observation-stale",
      message,
      stage: "browser-adapter",
      retryable: true,
      recoveryAction: "retry-read-only",
      replayAllowed: true,
    }
  }
  if (message.includes("Browser resource read requires")) {
    return {
      code: "invalid-request",
      message,
      stage: "browser-adapter",
      retryable: false,
      recoveryAction: "none",
      replayAllowed: false,
    }
  }
  return {
    code: unknown ? "deadline-exceeded" : message.includes("stale") || message.includes("not found") ? "target-stale" : "internal-error",
    message,
    stage: "browser-adapter",
    retryable: !unknown,
    recoveryAction: unknown ? "get-operation" : "refresh-inventory",
    replayAllowed: false,
  }
}

function waitOptions(policy: ReadinessPolicy, timeoutMs: number): WaitReadyOptions {
  const required = new Set<string>(policy.requiredSteps)
  return {
    readyState: required.has("document-ready"),
    fonts: required.has("fonts"),
    networkIdle: required.has("network-idle"),
    images: required.has("images"),
    reflowStable: required.has("reflow-stable"),
    animations: required.has("animations"),
    finalCommit: required.has("final-commit"),
    maxMs: timeoutMs,
    stepMs: Math.min(5_000, timeoutMs),
  }
}

function readiness(policy: ReadinessPolicy, result: WaitReadyResult): ReadinessResult {
  const name = (legacy: string) => ({
    readyState: "document-ready",
    fonts: "fonts",
    networkIdle: "network-idle",
    images: "images",
    reflowStable: "reflow-stable",
    animations: "animations",
    finalCommit: "final-commit",
  } as const)[legacy as keyof ReturnType<typeof readinessNameMap>]
  const legacyByName = new Map<string, WaitReadyResult["steps"][number]>(
    result.steps.flatMap(step => {
      const mapped = name(step.name)
      return mapped === undefined ? [] : [[mapped, step]]
    }),
  )
  const steps: ReadinessResult["steps"] = [
    ...policy.requiredSteps.map(required => {
      const step = legacyByName.get(required)
      if (!step && required === "target") {
        return { name: required, state: "reached" as const, durationMs: 0 }
      }
      if (!step && required === "ownership") {
        return { name: required, state: "unavailable" as const, durationMs: 0, reason: "runtime point-bound ownership proof required" }
      }
      if (step?.ok) return { name: required, state: "reached" as const, durationMs: step.durationMs }
      return {
        name: required,
        state: result.timedOut ? "timed-out" as const : "failed" as const,
        durationMs: step?.durationMs ?? 0,
        reason: step?.error ?? "readiness predicate failed",
      }
    }),
    ...policy.disabledSteps.map(disabled => ({ name: disabled, state: "skipped" as const, durationMs: 0, reason: "disabled-by-policy" as const })),
  ]
  const unavailable = steps.some(step => step.state === "unavailable")
  const failed = steps.some(step => step.state === "failed" || step.state === "timed-out")
  return { state: unavailable ? "unavailable" : failed ? "partial" : "ready", policy, steps, timedOut: steps.some(step => step.state === "timed-out") }
}

function withCompleteFrame(result: ReadinessResult): ReadinessResult {
  if (!result.policy.requiredSteps.includes("complete-frame")) return result
  const steps = result.steps.map(step => step.name === "complete-frame"
    ? { name: "complete-frame" as const, state: "reached" as const, durationMs: step.durationMs }
    : step)
  const failed = steps.some(step => step.state === "failed" || step.state === "timed-out" || step.state === "unavailable")
  return {
    ...result,
    state: failed ? result.state : "ready",
    steps,
    timedOut: steps.some(step => step.state === "timed-out"),
  }
}

function readinessNameMap() {
  return {
    readyState: "document-ready",
    fonts: "fonts",
    networkIdle: "network-idle",
    images: "images",
    reflowStable: "reflow-stable",
    animations: "animations",
    finalCommit: "final-commit",
  } as const
}

export async function buildCaptureResult(
  host: AdapterHostContext,
  services: AdapterServices,
  request: BrowserCaptureRequest,
  target: BrowserCaptureRequest["target"]["ref"],
  captured: BrowserDriverCapture,
) {
  const bytes = captured.bytes
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const frameRef = request.publication.frameRef
  const imageRect = { x: 0, y: 0, width: captured.width, height: captured.height }
  const destination = {
    x: request.clip.kind === "rect" ? request.clip.rect.x : 0,
    y: request.clip.kind === "rect" ? request.clip.rect.y : 0,
    width: captured.width / request.output.scale,
    height: captured.height / request.output.scale,
  }
  const frame = {
    frameRef,
    observationId: request.publication.observationId,
    ...host.generation,
    source: request.source,
    target: request.target,
    capturedAt: captured.capturedAt,
    widthPx: captured.width,
    heightPx: captured.height,
    byteLength: bytes.byteLength,
    sha256,
    mime: "image/png" as const,
  }
  const cleanup = { scope: "none" as const, state: "complete" as const, resources: [] as [] }
  const observation = {
    observationId: request.publication.observationId,
    ...host.generation,
    captureTarget: request.target,
    caption: request.caption,
    backend: { name: "cdp", buildId: host.runtimeBuildId },
    capturedAt: captured.capturedAt,
    expiresAt: request.publication.expiresAt,
    inventoryRevision: request.publication.inventoryRevision,
    displayLayoutRevision: request.publication.displayLayoutRevision,
    source: request.source,
    image: { frameRef, widthPx: captured.width, heightPx: captured.height, mime: "image/png" as const, byteLength: bytes.byteLength, sha256 },
    cursor: "excluded" as const,
    clip: imageRect,
    captureEvidence: { state: "unknown" as const, claim: "frame-freshness", source: "cdp", reason: "runtime proof publication pending" },
    occlusion: { state: "unknown" as const, claim: "occlusion", source: "cdp", reason: "browser viewport has no desktop occlusion" },
    readiness: captured.readiness,
    synchronization: { kind: "single-frame" as const },
    regions: [{
      space: request.source === "browser-viewport"
        ? { kind: "browser-viewport" as const, target: target as BrowserTargetRecord["ref"] }
        : { kind: "device-browser-viewport" as const, target: target as Extract<BrowserCaptureRequest["target"], { kind: "device-browser-target" }>["ref"] },
      imageRect,
      destinationRect: destination,
      imageToDestination: { a: 1 / request.output.scale, b: 0, c: 0, d: 1 / request.output.scale, tx: destination.x, ty: destination.y },
      frameTimestamp: captured.capturedAt,
      frameStatus: "complete" as const,
    }],
    unavailableReasons: [],
  }
  const result = browserOperationResultSchema.shape.value.options.find(option => option.shape.kind.value === "target-captured")
  void result
  const capture = {
    publication: request.publication,
    observation,
    frame,
    effective: {
      clip: request.clip,
      fullPage: request.fullPage,
      cursor: "excluded" as const,
      scale: request.output.scale,
      widthPx: captured.width,
      heightPx: captured.height,
      pixelCount: captured.width * captured.height,
      encodedBytes: bytes.byteLength,
      readinessPolicy: request.readinessPolicy,
    },
    cleanup,
  }
  await verifyAndPublishBinaryFrame(services.frames, request, capture, bytes)
  return capture
}

function boundText(value: string, maxBytes: number): { text: string, bytes: number, truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, bytes: encoder.encode(value).byteLength, truncated: false }
  let text = value
  while (text.length > 0 && encoder.encode(text).byteLength > maxBytes) text = text.slice(0, Math.max(0, text.length - 256))
  return { text, bytes: encoder.encode(text).byteLength, truncated: true }
}

function boundConsole(entries: Array<{ level: "log" | "info" | "warn" | "error" | "debug", text: string, timestamp: string }>, maxEvents: number, maxBytes: number) {
  const accepted = entries.slice(0, maxEvents)
  while (accepted.length > 0 && new TextEncoder().encode(JSON.stringify(accepted)).byteLength > maxBytes) accepted.pop()
  return {
    entries: accepted,
    serializedBytes: new TextEncoder().encode(JSON.stringify(accepted)).byteLength,
    droppedEvents: entries.length - accepted.length,
    truncated: accepted.length < entries.length,
  }
}
