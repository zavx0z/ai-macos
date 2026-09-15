import { z } from "zod"
import { authorizeAdapterContext, type AdapterHostContext, type AdapterResult, type AdapterServices } from "./adapters.ts"
import { contractErrorSchema } from "./errors.ts"
import {
  browserInstanceRefSchema,
  browserTargetRefSchema,
  deviceBrowserInstanceRefSchema,
  deviceBrowserTargetRefSchema,
  deviceRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  runtimeProcessRefSchema,
} from "./identities.ts"
import {
  assertCaptureResultMatchesRequest,
  browserCaptureRequestSchema,
  screenCaptureResultSchema,
} from "./capture.ts"
import {
  type AdapterControl,
  type BrowserExecutionContext,
  type DeviceExecutionContext,
  type RuntimeOperationContext,
} from "./operations.ts"
import { readinessPolicySchema, readinessResultSchema } from "./observations.ts"
import {
  DESKTOP_INPUT_RESOURCE_REF,
  cleanupOutcomeSchema,
  requireAuthorizedResourceHandles,
  sortRuntimeResources,
  type RuntimeResourceRef,
} from "./resources.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const browserProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local-cdp"),
    endpointHost: z.enum(["127.0.0.1", "localhost", "::1"]),
    endpointPort: z.number().int().min(1).max(65_535),
    profilePath: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("external-cdp"),
    endpointRef: opaqueIdSchema,
  }),
])
export type BrowserProvenance = z.infer<typeof browserProvenanceSchema>

export const browserInstanceRecordSchema = z.strictObject({
  ref: browserInstanceRefSchema,
  provenance: browserProvenanceSchema,
  profileLabel: z.string().min(1).max(256).optional(),
  process: runtimeProcessRefSchema.optional(),
  state: z.enum(["connected", "degraded", "disconnected"]),
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((instance, context) => {
  if (instance.state !== "connected" && instance.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "неconnected instance требует reason" })
  }
})
export type BrowserInstanceRecord = z.infer<typeof browserInstanceRecordSchema>

export const browserTargetRecordSchema = z.strictObject({
  ref: browserTargetRefSchema,
  type: z.string().min(1).max(128),
  title: z.string().max(4_096),
  url: z.string().min(1).max(65_536),
})
export type BrowserTargetRecord = z.infer<typeof browserTargetRecordSchema>

const inventoryBaseShape = {
  inventoryId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  capturedAt: isoTimestampSchema,
  complete: z.boolean(),
  errors: z.array(contractErrorSchema).max(1_024),
}

export const browserInstanceSnapshotSchema = z.strictObject({
  ...inventoryBaseShape,
  instances: z.array(browserInstanceRecordSchema).max(128),
}).superRefine((snapshot, context) => {
  assertInventoryCompleteness(snapshot, context)
  if (snapshot.instances.some(instance => !matchesSnapshotGeneration(snapshot, instance.ref))) {
    context.addIssue({ code: "custom", path: ["instances"], message: "browser instance принадлежит другой generation" })
  }
})
export type BrowserInstanceSnapshot = z.infer<typeof browserInstanceSnapshotSchema>

export const browserTargetSnapshotSchema = z.strictObject({
  ...inventoryBaseShape,
  instance: browserInstanceRefSchema,
  targets: z.array(browserTargetRecordSchema).max(4_096),
}).superRefine((snapshot, context) => {
  assertInventoryCompleteness(snapshot, context)
  if (!matchesSnapshotGeneration(snapshot, snapshot.instance)) {
    context.addIssue({ code: "custom", path: ["instance"], message: "browser instance принадлежит другой generation" })
  }
  if (snapshot.targets.some(target => !sameBrowserInstance(target.ref, snapshot.instance))) {
    context.addIssue({ code: "custom", path: ["targets"], message: "target принадлежит другому browser instance" })
  }
})
export type BrowserTargetSnapshot = z.infer<typeof browserTargetSnapshotSchema>

export const deviceRecordSchema = z.strictObject({
  ref: deviceRefSchema,
  state: z.enum(["connected", "offline", "unauthorized", "disconnected"]),
  forward: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("owned"), localPort: z.number().int().min(1).max(65_535), forwardRef: opaqueIdSchema }),
    z.strictObject({ state: z.literal("foreign"), localPort: z.number().int().min(1).max(65_535), reason: z.string().min(1).max(1_024) }),
    z.strictObject({ state: z.literal("absent") }),
    z.strictObject({ state: z.literal("unavailable"), reason: z.string().min(1).max(1_024) }),
  ]),
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((device, context) => {
  if (device.state !== "connected" && device.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "неconnected device требует reason" })
  }
})
export type DeviceRecord = z.infer<typeof deviceRecordSchema>

export const deviceBrowserInstanceRecordSchema = z.strictObject({
  ref: deviceBrowserInstanceRefSchema,
  state: z.enum(["connected", "degraded", "disconnected"]),
  browserVersion: z.string().min(1).max(256).optional(),
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((instance, context) => {
  if (instance.state !== "connected" && instance.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "неconnected instance требует reason" })
  }
})
export type DeviceBrowserInstanceRecord = z.infer<typeof deviceBrowserInstanceRecordSchema>

export const deviceBrowserTargetRecordSchema = z.strictObject({
  ref: deviceBrowserTargetRefSchema,
  type: z.string().min(1).max(128),
  title: z.string().max(4_096),
  url: z.string().min(1).max(65_536),
})
export type DeviceBrowserTargetRecord = z.infer<typeof deviceBrowserTargetRecordSchema>

export const deviceSnapshotSchema = z.strictObject({
  ...inventoryBaseShape,
  devices: z.array(deviceRecordSchema).max(128),
}).superRefine((snapshot, context) => {
  assertInventoryCompleteness(snapshot, context)
  if (snapshot.devices.some(device => !matchesSnapshotGeneration(snapshot, device.ref))) {
    context.addIssue({ code: "custom", path: ["devices"], message: "device принадлежит другой generation" })
  }
})
export type DeviceSnapshot = z.infer<typeof deviceSnapshotSchema>

export const deviceBrowserInstanceSnapshotSchema = z.strictObject({
  ...inventoryBaseShape,
  device: deviceRefSchema,
  instances: z.array(deviceBrowserInstanceRecordSchema).max(16),
}).superRefine((snapshot, context) => {
  assertInventoryCompleteness(snapshot, context)
  if (!matchesSnapshotGeneration(snapshot, snapshot.device)) {
    context.addIssue({ code: "custom", path: ["device"], message: "device принадлежит другой generation" })
  }
  if (snapshot.instances.some(instance => !sameDevice(instance.ref, snapshot.device))) {
    context.addIssue({ code: "custom", path: ["instances"], message: "browser instance принадлежит другому device/serial" })
  }
})
export type DeviceBrowserInstanceSnapshot = z.infer<typeof deviceBrowserInstanceSnapshotSchema>

export const deviceBrowserTargetSnapshotSchema = z.strictObject({
  ...inventoryBaseShape,
  instance: deviceBrowserInstanceRefSchema,
  targets: z.array(deviceBrowserTargetRecordSchema).max(4_096),
}).superRefine((snapshot, context) => {
  assertInventoryCompleteness(snapshot, context)
  if (!matchesSnapshotGeneration(snapshot, snapshot.instance)) {
    context.addIssue({ code: "custom", path: ["instance"], message: "device browser instance принадлежит другой generation" })
  }
  if (snapshot.targets.some(target => !sameDeviceBrowserInstance(target.ref, snapshot.instance))) {
    context.addIssue({ code: "custom", path: ["targets"], message: "target принадлежит другому device browser instance" })
  }
})
export type DeviceBrowserTargetSnapshot = z.infer<typeof deviceBrowserTargetSnapshotSchema>

const navigationUrlSchema = z.url().max(65_536).refine(url => {
  const protocol = new URL(url).protocol
  return ["http:", "https:", "about:", "file:"].includes(protocol)
}, "URL protocol не разрешён")

export const browserOperationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("connect-instance"), instance: browserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("disconnect-instance"), instance: browserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("open-target"), instance: browserInstanceRefSchema, url: navigationUrlSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("close-target"), target: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("activate-visible-target"), target: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("navigate-target"), target: browserTargetRefSchema, url: navigationUrlSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("reload-target"), target: browserTargetRefSchema, ignoreCache: z.boolean(), policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("wait-target"), target: browserTargetRefSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("capture-target"), target: browserTargetRefSchema, capture: browserCaptureRequestSchema }),
  z.strictObject({ kind: z.literal("read-console"), target: browserTargetRefSchema, maxEvents: z.number().int().min(1).max(1_000), maxBytes: z.number().int().min(1).max(1024 * 1024) }),
  z.strictObject({ kind: z.literal("read-dom"), target: browserTargetRefSchema, maxBytes: z.number().int().min(1).max(1024 * 1024) }),
  z.strictObject({ kind: z.literal("read-accessibility"), target: browserTargetRefSchema, maxNodes: z.number().int().min(1).max(1_500), maxBytes: z.number().int().min(1).max(1024 * 1024) }),
])
export type BrowserOperationRequest = z.infer<typeof browserOperationRequestSchema>

export const deviceBrowserOperationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("connect-instance"), instance: deviceBrowserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("disconnect-instance"), instance: deviceBrowserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("open-target"), instance: deviceBrowserInstanceRefSchema, url: navigationUrlSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("close-target"), target: deviceBrowserTargetRefSchema }),
  z.strictObject({ kind: z.literal("navigate-target"), target: deviceBrowserTargetRefSchema, url: navigationUrlSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("reload-target"), target: deviceBrowserTargetRefSchema, ignoreCache: z.boolean(), policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("wait-target"), target: deviceBrowserTargetRefSchema, policy: readinessPolicySchema, timeoutMs: z.number().int().min(1).max(30_000) }),
  z.strictObject({ kind: z.literal("capture-target"), target: deviceBrowserTargetRefSchema, capture: browserCaptureRequestSchema }),
])
export type DeviceBrowserOperationRequest = z.infer<typeof deviceBrowserOperationRequestSchema>

export const browserConsoleEntrySchema = z.strictObject({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string().max(65_536),
  timestamp: isoTimestampSchema,
})

const browserOperationValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instance-connected"), instance: browserInstanceRecordSchema }),
  z.strictObject({ kind: z.literal("instance-disconnected"), instance: browserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("target-opened"), target: browserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-closed"), target: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("target-activated"), target: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("target-navigated"), target: browserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-reloaded"), target: browserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-ready"), target: browserTargetRefSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-captured"), target: browserTargetRefSchema, capture: screenCaptureResultSchema }),
  z.strictObject({
    kind: z.literal("console-read"),
    target: browserTargetRefSchema,
    entries: z.array(browserConsoleEntrySchema).max(1_000),
    serializedBytes: z.number().int().min(0).max(1024 * 1024),
    droppedEvents: z.number().int().safe().min(0),
    truncated: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("dom-read"), target: browserTargetRefSchema, content: z.string().max(1024 * 1024), contentBytes: z.number().int().min(0).max(1024 * 1024), truncated: z.boolean() }),
  z.strictObject({ kind: z.literal("accessibility-read"), target: browserTargetRefSchema, content: z.string().max(1024 * 1024), contentBytes: z.number().int().min(0).max(1024 * 1024), nodeCount: z.number().int().min(0).max(1_500), truncated: z.boolean() }),
])

export const browserOperationResultSchema = z.strictObject({
  value: browserOperationValueSchema,
  cleanup: cleanupOutcomeSchema,
})
export type BrowserOperationResult = z.infer<typeof browserOperationResultSchema>

const deviceBrowserOperationValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instance-connected"), instance: deviceBrowserInstanceRecordSchema }),
  z.strictObject({ kind: z.literal("instance-disconnected"), instance: deviceBrowserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("target-opened"), target: deviceBrowserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-closed"), target: deviceBrowserTargetRefSchema }),
  z.strictObject({ kind: z.literal("target-navigated"), target: deviceBrowserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-reloaded"), target: deviceBrowserTargetRecordSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-ready"), target: deviceBrowserTargetRefSchema, readiness: readinessResultSchema }),
  z.strictObject({ kind: z.literal("target-captured"), target: deviceBrowserTargetRefSchema, capture: screenCaptureResultSchema }),
])

export const deviceBrowserOperationResultSchema = z.strictObject({
  value: deviceBrowserOperationValueSchema,
  cleanup: cleanupOutcomeSchema,
})
export type DeviceBrowserOperationResult = z.infer<typeof deviceBrowserOperationResultSchema>

export interface BrowserAdapter {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly (
    | "browser.instances"
    | "browser.targets"
    | "browser.observe"
    | "browser.readiness"
    | "browser.resources"
  )[]
  listInstances(control: AdapterControl): Promise<BrowserInstanceSnapshot>
  listTargets(instance: z.infer<typeof browserInstanceRefSchema>, control: AdapterControl): Promise<BrowserTargetSnapshot>
  execute(
    context: RuntimeOperationContext<BrowserExecutionContext>,
    request: BrowserOperationRequest,
  ): Promise<AdapterResult<BrowserOperationResult>>
}

export interface DeviceBrowserAdapter {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly ["android.chrome"]
  listDevices(control: AdapterControl): Promise<DeviceSnapshot>
  listInstances(device: z.infer<typeof deviceRefSchema>, control: AdapterControl): Promise<DeviceBrowserInstanceSnapshot>
  listTargets(instance: z.infer<typeof deviceBrowserInstanceRefSchema>, control: AdapterControl): Promise<DeviceBrowserTargetSnapshot>
  execute(
    context: RuntimeOperationContext<DeviceExecutionContext>,
    request: DeviceBrowserOperationRequest,
  ): Promise<AdapterResult<DeviceBrowserOperationResult>>
}

export function browserOperationResources(request: BrowserOperationRequest): RuntimeResourceRef[] {
  const targetRef = "instance" in request ? request.instance.browserInstanceRef : request.target.resourceRef
  const resources: RuntimeResourceRef[] = [{ kind: "cdp-target", resourceRef: targetRef }]
  if (request.kind === "activate-visible-target") {
    resources.push({ kind: "desktop-input", resourceRef: DESKTOP_INPUT_RESOURCE_REF })
  }
  if (request.kind === "capture-target") {
    resources.push({ kind: "capture-stream", resourceRef: request.capture.publication.observationId })
  }
  return sortRuntimeResources(resources)
}

export function deviceBrowserOperationResources(request: DeviceBrowserOperationRequest): RuntimeResourceRef[] {
  const instance = "instance" in request ? request.instance : request.target
  const targetRef = "instance" in request ? request.instance.browserInstanceRef : request.target.resourceRef
  const resources: RuntimeResourceRef[] = [
    { kind: "cdp-target", resourceRef: targetRef },
    { kind: "adb-device", resourceRef: instance.deviceRef },
  ]
  if (request.kind === "capture-target") {
    resources.push({ kind: "capture-stream", resourceRef: request.capture.publication.observationId })
  }
  return sortRuntimeResources(resources)
}

export async function authorizeBrowserOperation(
  adapter: BrowserAdapter,
  context: RuntimeOperationContext<BrowserExecutionContext>,
  request: BrowserOperationRequest,
  now: Date,
): Promise<void> {
  const wire = context.wire
  await authorizeAdapterContext(adapter.host, adapter.services, context, now)
  const expectedTarget = "instance" in request
    ? { kind: "browser-instance" as const, ref: request.instance }
    : { kind: "browser-target" as const, ref: request.target }
  if (!structurallyEqual(wire.target, expectedTarget)) throw new Error("Browser context содержит другой exact target")
  const resolution = await adapter.services.targets.resolve({
    target: expectedTarget,
    inventoryId: wire.inventoryId,
    inventoryRevision: wire.inventoryRevision,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    deadlineAt: wire.deadlineAt,
  })
  if (!structurallyEqual(resolution.target, expectedTarget)) throw new Error("Target authority вернул другой browser target")
  if (request.kind !== "connect-instance") {
    await adapter.services.reservations.assertChild({ session: context.session, context, target: expectedTarget })
  }
  await requireAuthorizedResourceHandles(adapter.services.resources, context.resources, {
    operationId: wire.operationId,
    clientSessionId: wire.clientSessionId,
    principalId: wire.principalId,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    now,
  }, browserOperationResources(request))
}

export async function authorizeDeviceBrowserOperation(
  adapter: DeviceBrowserAdapter,
  context: RuntimeOperationContext<DeviceExecutionContext>,
  request: DeviceBrowserOperationRequest,
  now: Date,
): Promise<void> {
  const wire = context.wire
  await authorizeAdapterContext(adapter.host, adapter.services, context, now)
  const expectedTarget = "instance" in request
    ? { kind: "device-browser-instance" as const, ref: request.instance }
    : { kind: "device-browser-target" as const, ref: request.target }
  if (!structurallyEqual(wire.target, expectedTarget)) throw new Error("Device context содержит другой exact target")
  const resolution = await adapter.services.targets.resolve({
    target: expectedTarget,
    inventoryId: wire.inventoryId,
    inventoryRevision: wire.inventoryRevision,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    deadlineAt: wire.deadlineAt,
  })
  if (!structurallyEqual(resolution.target, expectedTarget)) throw new Error("Target authority вернул другой device target")
  if (request.kind !== "connect-instance") {
    await adapter.services.reservations.assertChild({ session: context.session, context, target: expectedTarget })
  }
  await requireAuthorizedResourceHandles(adapter.services.resources, context.resources, {
    operationId: wire.operationId,
    clientSessionId: wire.clientSessionId,
    principalId: wire.principalId,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    now,
  }, deviceBrowserOperationResources(request))
}

export function assertBrowserResultMatchesRequest(
  request: BrowserOperationRequest,
  result: BrowserOperationResult,
): void {
  const expectedKinds: Record<BrowserOperationRequest["kind"], BrowserOperationResult["value"]["kind"]> = {
    "connect-instance": "instance-connected",
    "disconnect-instance": "instance-disconnected",
    "open-target": "target-opened",
    "close-target": "target-closed",
    "activate-visible-target": "target-activated",
    "navigate-target": "target-navigated",
    "reload-target": "target-reloaded",
    "wait-target": "target-ready",
    "capture-target": "target-captured",
    "read-console": "console-read",
    "read-dom": "dom-read",
    "read-accessibility": "accessibility-read",
  }
  if (result.value.kind !== expectedKinds[request.kind]) throw new Error("Browser result kind не соответствует request")
  if (request.kind === "connect-instance" || request.kind === "disconnect-instance" || request.kind === "open-target") {
    const actualInstance = result.value.kind === "instance-connected"
      ? result.value.instance.ref
      : result.value.kind === "instance-disconnected"
        ? result.value.instance
        : result.value.kind === "target-opened"
          ? result.value.target.ref
          : undefined
    const sameStableInstance = actualInstance !== undefined
      && matchesSnapshotGeneration(actualInstance, request.instance)
      && actualInstance.browserInstanceRef === request.instance.browserInstanceRef
    const validTransport = request.kind === "connect-instance"
      ? actualInstance?.transportGeneration !== request.instance.transportGeneration
      : actualInstance?.transportGeneration === request.instance.transportGeneration
    if (!sameStableInstance || !validTransport) {
      throw new Error("Browser result принадлежит другому instance")
    }
    if (request.kind === "open-target" && result.value.kind === "target-opened") {
      assertReadinessMatchesPolicy(request.policy, result.value.readiness.policy)
    }
    return
  }
  const actualTarget = "target" in result.value
    ? ("ref" in result.value.target ? result.value.target.ref : result.value.target)
    : undefined
  if (actualTarget === undefined || !structurallyEqual(actualTarget, request.target)) {
    throw new Error("Browser result содержит другой exact target")
  }
  if (request.kind === "capture-target" && result.value.kind === "target-captured") {
    assertCaptureResultMatchesRequest(request.capture, result.value.capture)
    assertNestedCleanupDisjoint(result.cleanup, result.value.capture.cleanup)
  }
  if (
    (request.kind === "navigate-target" || request.kind === "reload-target" || request.kind === "wait-target")
    && (result.value.kind === "target-navigated" || result.value.kind === "target-reloaded" || result.value.kind === "target-ready")
  ) {
    assertReadinessMatchesPolicy(request.policy, result.value.readiness.policy)
  }
  if (request.kind === "read-console" && result.value.kind === "console-read") {
    const actualBytes = new TextEncoder().encode(JSON.stringify(result.value.entries)).byteLength
    if (
      result.value.entries.length > request.maxEvents
      || result.value.serializedBytes !== actualBytes
      || result.value.serializedBytes > request.maxBytes
      || (result.value.droppedEvents > 0 && !result.value.truncated)
      || (result.value.droppedEvents === 0
        && result.value.entries.length < request.maxEvents
        && result.value.serializedBytes < request.maxBytes
        && result.value.truncated)
    ) {
      throw new Error("Console result нарушает requested limits/truncated semantics")
    }
  }
  if (request.kind === "read-dom" && result.value.kind === "dom-read") {
    assertContentBudget(result.value.content, result.value.contentBytes, request.maxBytes, result.value.truncated)
  }
  if (request.kind === "read-accessibility" && result.value.kind === "accessibility-read") {
    assertContentBudget(result.value.content, result.value.contentBytes, request.maxBytes, result.value.truncated)
    if (result.value.nodeCount > request.maxNodes) throw new Error("Accessibility result превышает requested node budget")
  }
}

export function assertDeviceBrowserResultMatchesRequest(
  request: DeviceBrowserOperationRequest,
  result: DeviceBrowserOperationResult,
): void {
  const expectedKinds: Record<DeviceBrowserOperationRequest["kind"], DeviceBrowserOperationResult["value"]["kind"]> = {
    "connect-instance": "instance-connected",
    "disconnect-instance": "instance-disconnected",
    "open-target": "target-opened",
    "close-target": "target-closed",
    "navigate-target": "target-navigated",
    "reload-target": "target-reloaded",
    "wait-target": "target-ready",
    "capture-target": "target-captured",
  }
  if (result.value.kind !== expectedKinds[request.kind]) throw new Error("Device browser result kind не соответствует request")
  if (request.kind === "capture-target" && result.value.kind === "target-captured") {
    if (!structurallyEqual(result.value.target, request.target)) throw new Error("Device capture вернул другой target")
    assertCaptureResultMatchesRequest(request.capture, result.value.capture)
    assertNestedCleanupDisjoint(result.cleanup, result.value.capture.cleanup)
  }
  if (
    (request.kind === "open-target" || request.kind === "navigate-target" || request.kind === "reload-target" || request.kind === "wait-target")
    && (result.value.kind === "target-opened" || result.value.kind === "target-navigated" || result.value.kind === "target-reloaded" || result.value.kind === "target-ready")
  ) {
    assertReadinessMatchesPolicy(request.policy, result.value.readiness.policy)
  }
  const expectedInstance = "instance" in request ? request.instance : request.target
  const actual = "instance" in result.value
    ? ("ref" in result.value.instance ? result.value.instance.ref : result.value.instance)
    : "target" in result.value
      ? ("ref" in result.value.target ? result.value.target.ref : result.value.target)
      : undefined
  const sameStableInstance = actual !== undefined
    && sameDevice(actual, expectedInstance)
    && actual.browserInstanceRef === expectedInstance.browserInstanceRef
  const validTransport = request.kind === "connect-instance"
    ? actual?.browserTransportGeneration !== expectedInstance.browserTransportGeneration
    : actual?.browserTransportGeneration === expectedInstance.browserTransportGeneration
  if (!sameStableInstance || !validTransport) {
    throw new Error("Device result принадлежит другому device/browser instance")
  }
  if (!("instance" in request) && !structurallyEqual(actual, request.target)) {
    throw new Error("Device result содержит другой exact target")
  }
}

function sameBrowserInstance(
  left: z.infer<typeof browserInstanceRefSchema>,
  right: z.infer<typeof browserInstanceRefSchema>,
): boolean {
  return left.runtimeEpoch === right.runtimeEpoch
    && left.loginSessionId === right.loginSessionId
    && left.browserInstanceRef === right.browserInstanceRef
    && left.transportGeneration === right.transportGeneration
}

function matchesSnapshotGeneration(
  snapshot: { runtimeEpoch: string, loginSessionId: string },
  reference: { runtimeEpoch: string, loginSessionId: string },
): boolean {
  return snapshot.runtimeEpoch === reference.runtimeEpoch && snapshot.loginSessionId === reference.loginSessionId
}

function sameDevice(
  left: z.infer<typeof deviceRefSchema>,
  right: z.infer<typeof deviceRefSchema>,
): boolean {
  return matchesSnapshotGeneration(left, right)
    && left.deviceRef === right.deviceRef
    && left.serial === right.serial
    && left.transportGeneration === right.transportGeneration
}

function sameDeviceBrowserInstance(
  left: z.infer<typeof deviceBrowserInstanceRefSchema>,
  right: z.infer<typeof deviceBrowserInstanceRefSchema>,
): boolean {
  return sameDevice(left, right)
    && left.browserInstanceRef === right.browserInstanceRef
    && left.browserTransportGeneration === right.browserTransportGeneration
}

function assertInventoryCompleteness(
  snapshot: { complete: boolean, errors: readonly unknown[] },
  context: z.RefinementCtx,
): void {
  if (!snapshot.complete && snapshot.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "incomplete inventory требует причину" })
  }
}

function assertNestedCleanupDisjoint(
  outer: z.infer<typeof cleanupOutcomeSchema>,
  nested: z.infer<typeof cleanupOutcomeSchema>,
): void {
  if (outer.scope === "none" || nested.scope === "none") return
  const outerLeases = new Set(outer.resources.map(resource => resource.handle.leaseId))
  if (nested.resources.some(resource => outerLeases.has(resource.handle.leaseId))) {
    throw new Error("Browser target cleanup и nested capture cleanup пересекаются")
  }
}

function assertReadinessMatchesPolicy(
  requested: z.infer<typeof readinessPolicySchema>,
  actual: z.infer<typeof readinessPolicySchema>,
): void {
  if (!structurallyEqual(requested, actual)) throw new Error("Readiness result использует другую policy")
}

function assertContentBudget(content: string, declaredBytes: number, maxBytes: number, truncated: boolean): void {
  const actualBytes = new TextEncoder().encode(content).byteLength
  if (declaredBytes !== actualBytes || actualBytes > maxBytes) throw new Error("Document result нарушает requested byte budget")
  if (actualBytes < maxBytes && truncated) throw new Error("Document result объявил необъяснённое truncation")
}
