import {
  MAX_NATIVE_ENVELOPE_BYTES,
  axInspectionRequestSchema,
  captureClipSchema,
  createNativeMutationRequestEnvelopeSchema,
  createNativeCleanupRequestSchema,
  createNativeReadRequestEnvelopeSchema,
  createNativeResponseEnvelopeSchema,
  contractErrorSchema,
  heldInputLedgerAckSchema,
  heldInputLedgerSnapshotSchema,
  nativeCancelAckSchema,
  nativeCancelRequestSchema,
  nativeCleanupAckSchema,
  nativeDrainAckSchema,
  nativeDrainRequestSchema,
  nativeHandshakeRequestSchema,
  nativeHandshakeResponseSchema,
  nativeHeartbeatAckSchema,
  nativeHeartbeatRequestSchema,
  nativeOperationStatusSchema,
  nativeOperationTargetSchema,
  nativeResponseBaseSchema,
  nativeTargetMappingSchema,
  fenceTokenSchema,
  generationIdSchema,
  nativeStatusRequestSchema,
  nativeTextChunkSchema,
  observedEventSchema,
  opaqueIdSchema,
  parseWireJson,
  screenCaptureRequestSchema,
  triStateSchema,
  windowTransitionRequestSchema,
  z,
} from "@meta/shared/contracts"
import { nativeClipboardRequestSchema, nativeClipboardResponseSchema, NATIVE_CLIPBOARD_WIRE_BYTES } from "./clipboard-protocol.ts"
export * from "./clipboard-protocol.ts"
import { nativePermissionsRequestSchema, nativePermissionsResponseSchema } from "./permissions-protocol.ts"
export * from "./permissions-protocol.ts"
import { nativeStartupPermissionsRequestSchema, nativeStartupPermissionsResponseSchema } from "./permissions-request-protocol.ts"
export * from "./permissions-request-protocol.ts"
import { nativeHeldRecoveryRequestSchema, nativeHeldRecoveryResponseSchema } from "./recovery-protocol.ts"
export * from "./recovery-protocol.ts"
import { nativeDomainRecoveryRequestSchema, nativeDomainRecoveryResponseSchema } from "./domain-recovery-protocol.ts"
export * from "./domain-recovery-protocol.ts"
import { nativeObserverRequestSchema, nativeObserverResponseSchema, nativeObserverEventEnvelopeSchema, nativeObserverGapEnvelopeSchema } from "./observer-protocol.ts"
export * from "./observer-protocol.ts"
import { nativeHitTestRequestSchema, nativeHitTestResponseSchema } from "./hit-test-protocol.ts"
export * from "./hit-test-protocol.ts"
import { nativeInputReadinessRequestSchema, nativeInputReadinessResponseSchema } from "./readiness-protocol.ts"
export * from "./readiness-protocol.ts"
import { nativeAxPressRequestSchema, nativeAxPressResponseSchema } from "./ax-actions/protocol.ts"
export * from "./ax-actions/protocol.ts"
import { nativeCursorDisplayRequestSchema, nativeCursorDisplayResponseSchema } from "./cursor-display-protocol.ts"
export * from "./cursor-display-protocol.ts"
import {
  nativeApplicationResolveRequestSchema, nativeApplicationResolveResponseSchema,
  nativeApplicationLaunchRequestSchema, nativeApplicationLaunchResponseSchema,
  nativeApplicationQuitRequestSchema, nativeApplicationQuitResponseSchema,
} from "./applications-protocol.ts"
export * from "./applications-protocol.ts"

export const NATIVE_FRAME_HEADER_BYTES = 4
export const NATIVE_CLIPBOARD_FRAME_FLAG = 0x80000000

function decodeMessage(bytes: Uint8Array, clipboardProfile: boolean): NativeTransportResponseFrame {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const frame = parseWireJson(nativeTransportResponseFrameSchema, text, {
    maxBytes: clipboardProfile ? NATIVE_CLIPBOARD_WIRE_BYTES : MAX_NATIVE_ENVELOPE_BYTES, maxDepth: 32,
  })
  if (clipboardProfile && frame.channel !== "clipboard") throw new Error("Clipboard frame profile содержит другой channel")
  return frame
}

const nativeRectSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
})

export const nativeApplicationRecordSchema = z.strictObject({
  applicationRef: opaqueIdSchema,
  registrationNonce: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  pid: z.number().int().min(1).max(0x7fffffff),
  launchedAt: z.iso.datetime({ offset: true }),
  name: z.string().min(1).max(256),
  bundleId: z.string().min(1).max(256).optional(),
  hidden: triStateSchema,
  axStatus: z.enum(["ready", "no-windows", "timed-out", "denied", "unavailable", "failed"]),
  axReason: z.string().min(1).max(1_024).optional(),
  windowCount: z.number().int().safe().min(0),
}).superRefine((application, context) => {
  if (!["ready", "no-windows"].includes(application.axStatus) && application.axReason === undefined) {
    context.addIssue({ code: "custom", path: ["axReason"], message: "AX failure требует reason" })
  }
})

export const nativeSurfaceRecordSchema = z.strictObject({
  kind: z.enum(["sheet", "popup", "menu", "unknown"]),
  surfaceRef: opaqueIdSchema,
  applicationRef: opaqueIdSchema,
  ownerWindowRef: opaqueIdSchema,
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  title: z.string().max(4_096),
  role: z.string().max(128),
  subrole: z.string().max(128),
  frame: nativeRectSchema,
  focused: triStateSchema,
  advertisedActions: z.array(z.enum(["raise", "close", "minimize", "move", "resize"])).max(5),
})

export const nativeAXWindowRecordSchema = z.strictObject({
  kind: z.literal("ax-window"),
  windowRef: opaqueIdSchema,
  applicationRef: opaqueIdSchema,
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  cgWindowId: z.number().int().min(1).max(0xffffffff).optional(),
  title: z.string().max(4_096),
  role: z.string().max(128),
  subrole: z.string().max(128),
  frame: nativeRectSchema,
  applicationHidden: triStateSchema,
  minimized: triStateSchema,
  onScreen: triStateSchema,
  spaceVisibility: z.enum(["current", "not-current", "unknown"]),
  fullscreen: triStateSchema,
  focused: triStateSchema,
  main: triStateSchema,
  mapping: z.enum(["corroborated", "ambiguous", "unavailable"]),
  axSnapshotRef: opaqueIdSchema.optional(),
  cgInventoryRef: opaqueIdSchema.optional(),
  mappingReason: z.string().min(1).max(1_024).optional(),
  actionability: z.enum(["ax", "unavailable"]),
  unavailableReason: z.string().min(1).max(1_024).optional(),
  advertisedActions: z.array(z.enum(["raise", "close", "minimize", "move", "resize"])).max(5),
  surfaces: z.array(nativeSurfaceRecordSchema).max(256),
}).superRefine((window, context) => {
  if (window.mapping !== "corroborated" && window.mappingReason === undefined) {
    context.addIssue({ code: "custom", path: ["mappingReason"], message: "неcorroborated mapping требует reason" })
  }
  if (window.mapping === "corroborated" && window.cgWindowId === undefined) {
    context.addIssue({ code: "custom", path: ["cgWindowId"], message: "corroborated mapping требует CGWindowID" })
  }
  if (window.mapping === "corroborated" && (
    window.axSnapshotRef === undefined
    || window.cgInventoryRef === undefined
  )) {
    context.addIssue({ code: "custom", message: "corroborated mapping требует AX/CG source refs" })
  }
  if (window.actionability === "unavailable" && window.unavailableReason === undefined) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "unavailable window требует reason" })
  }
})

export const nativeCGWindowRecordSchema = z.strictObject({
  kind: z.literal("cg-only"),
  applicationRef: opaqueIdSchema.optional(),
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  cgWindowId: z.number().int().min(1).max(0xffffffff),
  title: z.string().max(4_096),
  frame: nativeRectSchema,
  onScreen: triStateSchema,
  spaceVisibility: z.enum(["current", "not-current", "unknown"]),
  unavailableReason: z.string().min(1).max(1_024),
})

export const nativeWindowRecordSchema = z.discriminatedUnion("kind", [
  nativeAXWindowRecordSchema,
  nativeCGWindowRecordSchema,
])

export const nativeDisplayRecordSchema = z.strictObject({
  displayRef: opaqueIdSchema,
  nativeDisplayId: z.number().int().min(1).max(0xffffffff),
  bounds: nativeRectSchema,
  usableBounds: nativeRectSchema,
  scale: z.number().finite().positive(),
  rotationDegrees: z.number().finite().min(0).lt(360),
  main: z.boolean(),
})

export const nativeInventoryResultSchema = z.strictObject({
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  layoutRef: opaqueIdSchema,
  revision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  capturedAt: z.iso.datetime({ offset: true }),
  complete: z.boolean(),
  errors: z.array(z.string().min(1).max(2_048)).max(1_024),
  applications: z.array(nativeApplicationRecordSchema).max(4_096),
  windows: z.array(nativeWindowRecordSchema).max(16_384),
  displays: z.array(nativeDisplayRecordSchema).max(64),
}).superRefine((inventory, context) => {
  if (!inventory.complete && inventory.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "incomplete inventory требует reason" })
  }
})

export const nativeWindowTransitionResultSchema = z.strictObject({
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  displays: z.array(nativeDisplayRecordSchema).max(64),
  targetRef: opaqueIdSchema,
  actual: z.discriminatedUnion("kind", [
    nativeAXWindowRecordSchema,
    z.strictObject({ kind: z.literal("closed"), windowRef: opaqueIdSchema, applicationRef: opaqueIdSchema,
      ownerPid: z.number().int().min(1).max(0x7fffffff), absence: z.literal("confirmed") }),
    z.strictObject({ kind: z.literal("unknown"), windowRef: opaqueIdSchema, applicationRef: opaqueIdSchema,
      ownerPid: z.number().int().min(1).max(0x7fffffff), reason: z.string().min(1).max(1024) }),
  ]),
  changed: z.boolean(),
  partial: z.boolean(),
  newSurface: nativeSurfaceRecordSchema.optional(),
  errors: z.array(z.string().min(1).max(2_048)).max(16),
  status: nativeOperationStatusSchema,
}).superRefine((result, context) => {
  if (result.targetRef !== result.actual.windowRef) {
    context.addIssue({ code: "custom", path: ["actual"], message: "transition вернул другой target" })
  }
  if (result.actual.kind === "closed" && (result.partial || !result.changed || result.errors.length > 0 || result.newSurface !== undefined)) {
    context.addIssue({ code: "custom", path: ["actual"], message: "Закрытое окно требует подтверждённого полного результата без sheet" })
  }
  if (result.actual.kind === "unknown" && !result.partial) {
    context.addIssue({ code: "custom", path: ["partial"], message: "Unknown window readback требует partial" })
  }
  if (result.partial && result.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "partial transition требует reason" })
  }
})

export const nativeAxInspectionResultSchema = z.strictObject({
  snapshotId: opaqueIdSchema,
  complete: z.boolean(),
  nextCursor: opaqueIdSchema.optional(),
  nodeCount: z.number().int().safe().min(0).max(1_500),
  encodedBytes: z.number().int().safe().min(0).max(1024 * 1024),
  nodes: z.array(z.strictObject({
    elementRef: opaqueIdSchema,
    parentElementRef: opaqueIdSchema.optional(),
    role: z.string().max(128),
    subrole: z.string().max(128),
    title: z.string().max(4_096),
    identifier: z.string().max(4_096).optional(),
    description: z.string().max(4_096).optional(),
    value: z.union([
      z.string().max(4_096),
      z.number().finite(),
      z.boolean(),
    ]).optional(),
    valueRedacted: z.literal(true).optional(),
    frame: nativeRectSchema.optional(),
    actions: z.array(z.string().min(1).max(128)).max(64),
  }).superRefine((node, context) => {
    if (node.valueRedacted && node.value !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Redacted AX value не публикуется вместе с value",
      })
    }
  })).max(1_500),
  errors: z.array(z.string().min(1).max(2_048)).max(128),
})

const nativePointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() })

const nativeModifierNames = ["cmd", "shift", "alt", "ctrl", "fn"] as const
const nativeModifierFlags = {
  cmd: 0x0010_0000,
  shift: 0x0002_0000,
  alt: 0x0008_0000,
  ctrl: 0x0004_0000,
  fn: 0x0080_0000,
} as const
const nativeModifierStateSchema = z.strictObject({
  names: z.array(z.enum(nativeModifierNames)).max(nativeModifierNames.length),
  flags: z.number().int().safe().min(0),
}).superRefine((modifiers, context) => {
  const canonical = [...new Set(modifiers.names)].sort((left, right) => {
    return nativeModifierNames.indexOf(left) - nativeModifierNames.indexOf(right)
  })
  if (canonical.length !== modifiers.names.length || canonical.some((name, index) => name !== modifiers.names[index])) {
    context.addIssue({ code: "custom", path: ["names"], message: "modifiers должны быть уникальны и в canonical order" })
  }
  const expectedFlags = canonical.reduce((flags, name) => flags | nativeModifierFlags[name], 0)
  if (expectedFlags !== modifiers.flags) {
    context.addIssue({ code: "custom", path: ["flags"], message: "modifier flags не совпадают с canonical names" })
  }
})

export const NATIVE_EVENT_TEXT_UTF16_LIMIT = 10_000

const nativeDragPointSchema = z.strictObject({
  point: nativePointSchema,
  atMs: z.number().int().min(0).max(5_000),
})

const nativeKeyStrokeSchema = z.strictObject({
  keyCode: z.number().int().min(0).max(0xffff),
  flags: z.number().int().safe().min(0),
})

export const nativeInputActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hover"), point: nativePointSchema, modifiers: nativeModifierStateSchema }),
  z.strictObject({
    kind: z.literal("click"),
    button: z.enum(["left", "right", "middle"]),
    point: nativePointSchema,
    count: z.number().int().min(1).max(3),
    modifiers: nativeModifierStateSchema,
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    anchor: nativePointSchema,
    dx: z.number().finite(),
    dy: z.number().finite(),
    unit: z.enum(["line", "pixel"]),
    modifiers: nativeModifierStateSchema,
  }).refine(action => action.dx !== 0 || action.dy !== 0, {
    message: "scroll требует ненулевой delta",
  }),
  z.strictObject({
    kind: z.literal("drag"),
    button: z.enum(["left", "right", "middle"]),
    modifiers: nativeModifierStateSchema,
    durationMs: z.number().int().min(1).max(5_000),
    trajectory: z.array(nativeDragPointSchema).min(2).max(512),
  }).superRefine((action, context) => {
    const final = action.trajectory.at(-1)
    if (action.trajectory[0]?.atMs !== 0 || final?.atMs !== action.durationMs) {
      context.addIssue({ code: "custom", path: ["trajectory"], message: "drag trajectory должна покрывать весь duration" })
    }
    if (action.trajectory.some((point, index) => index > 0 && point.atMs < (action.trajectory[index - 1]?.atMs ?? 0))) {
      context.addIssue({ code: "custom", path: ["trajectory"], message: "drag timestamps должны быть монотонными" })
    }
  }),
  z.strictObject({
    kind: z.literal("text"),
    utf16Units: z.number().int().min(1).max(NATIVE_EVENT_TEXT_UTF16_LIMIT),
    clusters: z.array(z.strictObject({
      ...nativeTextChunkSchema.shape,
      atMs: z.number().int().min(0).max(30_000),
    })).min(1).max(NATIVE_EVENT_TEXT_UTF16_LIMIT),
  }).superRefine((action, context) => {
    const combined = action.clusters.map(cluster => cluster.text).join("")
    if (combined.length !== action.utf16Units) {
      context.addIssue({ code: "custom", path: ["utf16Units"], message: "text clusters не совпадают с общей UTF-16 длиной" })
    }
    if (action.clusters.length > 0 && action.clusters[0]?.atMs !== 0) {
      context.addIssue({ code: "custom", path: ["clusters", 0, "atMs"], message: "первый text cluster должен начинаться с offset 0" })
    }
    if (action.clusters.some((cluster, index) => index > 0 && cluster.atMs < (action.clusters[index - 1]?.atMs ?? 0))) {
      context.addIssue({ code: "custom", path: ["clusters"], message: "text cluster offsets должны быть монотонными" })
    }
  }),
  z.strictObject({
    kind: z.literal("key"),
    stroke: nativeKeyStrokeSchema,
  }),
  z.strictObject({
    kind: z.literal("shortcut"),
    strokes: z.array(nativeKeyStrokeSchema).min(1).max(64),
    delayMs: z.number().int().min(0).max(5_000),
  }),
])

export const nativeInputExecutionPayloadSchema = z.strictObject({
  actionDeadlineAt: z.iso.datetime({ offset: true }),
  action: nativeInputActionSchema,
})

export const nativeInputExecutionResultSchema = z.strictObject({
  completedSteps: z.number().int().safe().min(0),
  totalSteps: z.number().int().safe().min(1).max(20_000),
  dispatchAttempts: z.number().int().safe().min(0),
  ledgerRevision: z.number().int().safe().min(0),
  status: nativeOperationStatusSchema,
}).superRefine((result, context) => {
  if (result.completedSteps > result.totalSteps) {
    context.addIssue({ code: "custom", path: ["completedSteps"], message: "completedSteps не может превышать totalSteps" })
  }
  if (result.dispatchAttempts !== result.status.dispatchAttempts) {
    context.addIssue({ code: "custom", path: ["dispatchAttempts"], message: "dispatchAttempts расходится с NativeOperationStatus" })
  }
  if (result.ledgerRevision !== result.status.ledgerRevision) {
    context.addIssue({ code: "custom", path: ["ledgerRevision"], message: "ledgerRevision расходится с NativeOperationStatus" })
  }
})

export const nativeCaptureExecutionResultSchema = z.strictObject({
  captureTaskRef: opaqueIdSchema,
  operationId: opaqueIdSchema,
  acceptedFence: fenceTokenSchema,
  sourceResponseRef: opaqueIdSchema,
  observationId: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  drainedEvidenceRef: opaqueIdSchema.optional(),
  terminalReceiptRef: opaqueIdSchema.optional(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "timed-out"]),
  cleanup: z.enum(["complete", "unknown"]),
  errorCode: z.enum([
    "none",
    "invalid-request",
    "permission-denied",
    "target-unavailable",
    "target-changed",
    "frame-unavailable",
    "frame-stale",
    "budget-exceeded",
    "encoding-failed",
    "stream-failed",
    "cancelled",
    "timed-out",
  ]),
  errorMessage: z.string().min(1).max(2_048).optional(),
  source: z.enum(["display-composite", "window-isolated"]),
  caption: z.string().min(1).max(2_048),
  target: nativeOperationTargetSchema,
  nativeMapping: nativeTargetMappingSchema,
  clip: captureClipSchema,
  cursor: z.enum(["included", "excluded"]),
  scale: z.number().finite().positive().max(1),
  backend: z.strictObject({
    name: z.string().min(1).max(128),
    buildId: opaqueIdSchema,
  }),
  targetEvidence: z.strictObject({
    shareableTargetMatched: z.boolean(),
    beforeTargetMatched: z.boolean(),
    afterTargetMatched: z.boolean(),
    boundsUnchanged: z.boolean(),
    auxiliarySurfacesExcluded: z.boolean(),
  }),
  readinessFacts: z.array(z.strictObject({
    name: z.string().min(1).max(128),
    state: z.enum(["reached", "failed", "timed-out", "unavailable"]),
    durationMs: z.number().finite().min(0),
    reason: z.string().min(1).max(1_024).optional(),
  })).max(64),
  frame: z.strictObject({
    binaryToken: opaqueIdSchema,
    frameRef: opaqueIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    widthPx: z.number().int().min(1).max(32_768),
    heightPx: z.number().int().min(1).max(32_768),
    encodedBytes: z.number().int().safe().min(1).max(64 * 1024 * 1024),
    capturedAt: z.iso.datetime({ offset: true }),
    frameStatus: z.literal("complete"),
    contentRect: nativeRectSchema.optional(),
    screenRect: nativeRectSchema.optional(),
    contentScale: z.number().finite().positive().optional(),
    scaleFactor: z.number().finite().positive().optional(),
    regions: z.array(z.strictObject({
      nativeDisplayId: z.number().int().min(1).max(0xffffffff),
      displayBounds: nativeRectSchema,
      imageRect: nativeRectSchema,
      destinationRect: nativeRectSchema,
      imageToDestination: z.strictObject({
        a: z.number().finite(),
        b: z.number().finite(),
        c: z.number().finite(),
        d: z.number().finite(),
        tx: z.number().finite(),
        ty: z.number().finite(),
      }),
      rotationDegrees: z.number().finite().min(0).lt(360),
      frameOrientation: z.literal("display-oriented"),
      backingScaleX: z.number().finite().positive(),
      backingScaleY: z.number().finite().positive(),
      frameTimestamp: z.iso.datetime({ offset: true }),
    })).min(1).max(64),
  }).optional(),
  statusRevision: z.number().int().safe().min(1),
}).superRefine((result, context) => {
  if (result.outcome === "succeeded" && result.frame === undefined) {
    context.addIssue({ code: "custom", path: ["frame"], message: "успешный capture требует frame" })
  }
  if (result.outcome === "succeeded" && (result.errorCode !== "none" || result.errorMessage !== undefined)) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "успешный capture не может содержать error" })
  }
  if (result.outcome !== "succeeded" && (
    result.errorCode === "none"
    || result.errorMessage === undefined
    || result.frame !== undefined
  )) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "неуспешный capture требует error и запрещает frame" })
  }
  if (result.cleanup === "complete" && (
    result.drainedEvidenceRef === undefined
    || result.terminalReceiptRef === undefined
  )) {
    context.addIssue({ code: "custom", message: "complete capture cleanup требует terminal evidence refs" })
  }
  if (result.frame !== undefined && result.frame.widthPx * result.frame.heightPx > 32_000_000) {
    context.addIssue({ code: "custom", path: ["frame"], message: "capture frame превышает pixel budget" })
  }
})

export const nativeCaptureTaskStatusSchema = z.strictObject({
  captureTaskRef: opaqueIdSchema,
  revision: z.number().int().safe().min(1),
  completionDelivered: z.boolean(),
  stopRequested: z.boolean(),
  stopCallInFlight: z.boolean(),
  stopAttemptCount: z.number().int().safe().min(0).max(2),
  startPending: z.boolean(),
  streamStarted: z.boolean(),
  streamStopped: z.boolean(),
  encodingInFlight: z.boolean(),
  cleanup: z.enum(["pending", "complete", "unknown"]),
  drained: z.boolean(),
}).superRefine((status, context) => {
  if (status.drained && (status.cleanup !== "complete" || status.encodingInFlight || !status.streamStopped)) {
    context.addIssue({ code: "custom", message: "drained capture требует complete physical cleanup" })
  }
})

const nativeCaptureTaskPayloadSchema = z.strictObject({ captureTaskRef: opaqueIdSchema })

export const nativeCaptureStartResultSchema = z.strictObject({
  captureTaskRef: opaqueIdSchema,
  operationId: opaqueIdSchema,
  acceptedFence: fenceTokenSchema,
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  statusEvidenceRef: opaqueIdSchema,
  acceptedAt: z.iso.datetime({ offset: true }),
  status: nativeCaptureTaskStatusSchema,
}).superRefine((result, context) => {
  if (result.status.captureTaskRef !== result.captureTaskRef) {
    context.addIssue({ code: "custom", path: ["status"], message: "capture start status содержит другой taskRef" })
  }
  if (result.status.completionDelivered) {
    context.addIssue({ code: "custom", path: ["status"], message: "start ACK должен предшествовать completion" })
  }
})

export const nativeCapturePollResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("pending"),
    captureTaskRef: opaqueIdSchema,
    status: nativeCaptureTaskStatusSchema,
  }),
  z.strictObject({
    state: z.literal("completed"),
    captureTaskRef: opaqueIdSchema,
    status: nativeCaptureTaskStatusSchema,
    result: nativeCaptureExecutionResultSchema,
  }),
]).superRefine((poll, context) => {
  if (poll.status.captureTaskRef !== poll.captureTaskRef) {
    context.addIssue({ code: "custom", path: ["status"], message: "capture poll status содержит другой taskRef" })
  }
  if (poll.state === "completed" && (
    !poll.status.completionDelivered
    || poll.result.captureTaskRef !== poll.captureTaskRef
  )) {
    context.addIssue({ code: "custom", path: ["result"], message: "terminal capture result не связан с task status" })
  }
})

export const nativeCaptureReleaseResultSchema = z.strictObject({
  captureTaskRef: opaqueIdSchema,
  released: z.boolean(),
  cleanup: z.enum(["complete", "unknown"]),
})

export const nativeCaptureCleanupRequestSchema = createNativeCleanupRequestSchema(
  nativeCaptureTaskPayloadSchema.extend({ waitForCompletion: z.boolean().optional() }),
).superRefine((request, context) => {
  if (request.payload.waitForCompletion && request.control.purpose !== "result") {
    context.addIssue({ code: "custom", path: ["payload", "waitForCompletion"], message: "Ожидание допустимо только для capture result" })
  }
})

export const nativeCaptureTerminalEvidenceSchema = z.strictObject({
  operationId: opaqueIdSchema,
  acceptedFence: fenceTokenSchema,
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  drainedEvidenceRef: opaqueIdSchema,
  terminalReceiptRef: opaqueIdSchema,
})

export const nativeCaptureStatusEvidenceSchema = z.strictObject({
  operationId: opaqueIdSchema,
  acceptedFence: fenceTokenSchema,
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  statusEvidenceRef: opaqueIdSchema,
})

export const nativeCaptureCleanupResponseSchema = z.discriminatedUnion("purpose", [
  z.strictObject({
    purpose: z.literal("result"),
    ack: nativeCleanupAckSchema,
    statusEvidence: nativeCaptureStatusEvidenceSchema,
    poll: nativeCapturePollResultSchema,
  }),
  z.strictObject({
    purpose: z.literal("status"),
    ack: nativeCleanupAckSchema,
    statusEvidence: nativeCaptureStatusEvidenceSchema,
    status: nativeCaptureTaskStatusSchema,
    terminal: nativeCaptureTerminalEvidenceSchema.optional(),
  }).superRefine((response, context) => {
    if (response.status.drained && response.status.cleanup === "complete" && response.terminal === undefined) {
      context.addIssue({ code: "custom", path: ["terminal"], message: "drained status требует terminal tombstone" })
    }
  }),
  z.strictObject({
    purpose: z.literal("release"),
    ack: nativeCleanupAckSchema,
    alreadyReleased: z.boolean(),
  }),
])

export const nativeCaptureStartPayloadSchema = z.strictObject({
  request: screenCaptureRequestSchema,
  nativeMapping: nativeTargetMappingSchema,
  captureTimeoutMs: z.number().int().min(1).max(10_000),
  stopTimeoutMs: z.number().int().min(1).max(1_000),
})

export const nativeInventoryRequestSchema = createNativeReadRequestEnvelopeSchema(
  "window.inventory",
  z.strictObject({
    priority: z.strictObject({
      app: z.string().min(1).max(1_024).optional(),
      pid: z.number().int().min(1).max(0x7fffffff).optional(),
      applicationRef: opaqueIdSchema.optional(),
    }).superRefine((priority, context) => {
      if (priority.app === undefined && priority.pid === undefined
        && priority.applicationRef === undefined) {
        context.addIssue({ code: "custom", message: "Inventory priority требует хотя бы один hint" })
      }
    }).optional(),
  }),
)
export const nativeInventoryResponseSchema = createNativeResponseEnvelopeSchema(nativeInventoryResultSchema)

export const nativeWindowTransitionRequestSchema = createNativeMutationRequestEnvelopeSchema(
  "window.transition",
  windowTransitionRequestSchema,
)
export const nativeWindowTransitionResponseSchema = createNativeResponseEnvelopeSchema(nativeWindowTransitionResultSchema)

export const nativeStatusErrorSchema = z.strictObject({
  kind: z.literal("status-error"),
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  operationId: opaqueIdSchema.optional(),
  error: contractErrorSchema,
})
export type NativeStatusError = z.infer<typeof nativeStatusErrorSchema>

export const nativeStatusResponseSchema = z.union([
  nativeOperationStatusSchema,
  nativeStatusErrorSchema,
])

export function nativeStatusErrorMatchesRequest(
  request: z.infer<typeof nativeStatusRequestSchema>,
  response: NativeStatusError,
): boolean {
  return request.requestId === response.requestId
    && request.runtimeEpoch === response.runtimeEpoch
    && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration
    && request.operationId === response.operationId
}

export const nativeAxInspectionRequestSchema = createNativeReadRequestEnvelopeSchema(
  "ax.inspect",
  axInspectionRequestSchema,
)
export const nativeAxInspectionResponseSchema = createNativeResponseEnvelopeSchema(nativeAxInspectionResultSchema)

const nativeInputExecutionRequestBaseSchema = createNativeMutationRequestEnvelopeSchema(
  "input.execute",
  nativeInputExecutionPayloadSchema,
)
export const nativeInputExecutionRequestSchema = nativeInputExecutionRequestBaseSchema.superRefine((request, context) => {
  const pointerAction = ["hover", "click", "scroll", "drag"].includes(request.payload.action.kind)
  if (pointerAction && request.operation.observationRef === undefined) {
    context.addIssue({ code: "custom", path: ["operation", "observationRef"], message: "pointer action требует авторизованное observation" })
  }
  if (pointerAction && !["window", "surface", "element", "display", "desktop-layout"].includes(request.operation.target.kind)) {
    context.addIssue({ code: "custom", path: ["operation", "target"], message: "pointer action требует macOS target" })
  }
  if (Date.parse(request.payload.actionDeadlineAt) > Date.parse(request.deadlineAt)) {
    context.addIssue({ code: "custom", path: ["payload", "actionDeadlineAt"], message: "action deadline не может быть позже operation deadline" })
  }
  const action = request.payload.action
  const knownDelay = action.kind === "shortcut"
    ? action.delayMs * Math.max(0, action.strokes.length - 1)
    : action.kind === "text" ? action.clusters.at(-1)?.atMs ?? 0 : 0
  const budget = action.kind === "text" ? 30_000 : 5_000
  if (knownDelay > budget) {
    context.addIssue({ code: "custom", path: ["payload", "action"], message: "известная длительность action превышает native budget" })
  }
})
export const nativeInputExecutionResponseSchema = z.discriminatedUnion("ok", [
  nativeResponseBaseSchema.extend({
    ok: z.literal(true),
    result: nativeInputExecutionResultSchema,
  }).strict(),
  nativeResponseBaseSchema.extend({
    ok: z.literal(false),
    error: contractErrorSchema,
    nativeStatus: nativeOperationStatusSchema.optional(),
  }).strict(),
])
  .superRefine((response, context) => {
    if (response.ok && (
      response.result.status.requestId !== response.requestId
      || response.result.status.operationId !== response.operationId
    )) {
      context.addIssue({ code: "custom", path: ["result", "status"], message: "inline status не коррелирует с response" })
    }
    if (!response.ok && response.error.stage === "native-execute" && response.nativeStatus === undefined) {
      context.addIssue({ code: "custom", path: ["nativeStatus"], message: "execution failure требует NativeOperationStatus" })
    }
  })

export const nativeCaptureStartRequestSchema = createNativeMutationRequestEnvelopeSchema(
  "capture.start",
  nativeCaptureStartPayloadSchema,
)
export const nativeCaptureStartResponseSchema = z.discriminatedUnion("ok", [
  nativeResponseBaseSchema.extend({
    ok: z.literal(true),
    result: nativeCaptureStartResultSchema,
  }).strict(),
  nativeResponseBaseSchema.extend({
    ok: z.literal(false),
    error: contractErrorSchema,
    nativeStatus: nativeOperationStatusSchema.optional(),
    startDisposition: z.literal("rejected-before-start").optional(),
  }).strict(),
]).superRefine((response, context) => {
  if (!response.ok && response.startDisposition === "rejected-before-start" &&
      response.nativeStatus !== undefined) {
    context.addIssue({ code: "custom", path: ["nativeStatus"], message: "Pre-start rejection не может содержать dispatched native status" })
  }
  if (!response.ok && response.nativeStatus !== undefined && (
    response.operationId === undefined
    || response.nativeStatus.requestId !== response.requestId
    || response.nativeStatus.operationId !== response.operationId
    || response.nativeStatus.runtimeEpoch !== response.runtimeEpoch
    || response.nativeStatus.loginSessionId !== response.loginSessionId
    || response.nativeStatus.nativeGeneration !== response.nativeGeneration
  )) {
    context.addIssue({ code: "custom", path: ["nativeStatus"], message: "Capture start failure status относится к другой operation" })
  }
})
export const nativeCaptureExecutionRequestSchema = nativeCaptureStartRequestSchema
export const nativeCaptureExecutionResponseSchema = nativeCaptureStartResponseSchema

export const nativeCaptureResultRequestSchema = createNativeReadRequestEnvelopeSchema(
  "capture.result",
  nativeCaptureTaskPayloadSchema,
)
export const nativeCaptureResultResponseSchema = createNativeResponseEnvelopeSchema(nativeCapturePollResultSchema)

export const nativeCaptureStatusRequestSchema = createNativeReadRequestEnvelopeSchema(
  "capture.status",
  nativeCaptureTaskPayloadSchema,
)
export const nativeCaptureStatusResponseSchema = createNativeResponseEnvelopeSchema(nativeCaptureTaskStatusSchema)

export const nativeCaptureCancelRequestSchema = createNativeMutationRequestEnvelopeSchema(
  "capture.cancel",
  nativeCaptureTaskPayloadSchema,
)
export const nativeCaptureCancelResponseSchema = createNativeResponseEnvelopeSchema(nativeCaptureTaskStatusSchema)

export const nativeCaptureReleaseRequestSchema = createNativeMutationRequestEnvelopeSchema(
  "capture.release",
  nativeCaptureTaskPayloadSchema,
)
export const nativeCaptureReleaseResponseSchema = createNativeResponseEnvelopeSchema(nativeCaptureReleaseResultSchema)

export const nativeMethodRequestSchema = z.union([
  nativeCursorDisplayRequestSchema,
  nativeAxPressRequestSchema,
  nativeInputReadinessRequestSchema,
  nativeHitTestRequestSchema,
  nativeApplicationResolveRequestSchema,
  nativeApplicationLaunchRequestSchema,
  nativeApplicationQuitRequestSchema,
  nativeInventoryRequestSchema,
  nativeWindowTransitionRequestSchema,
  nativeAxInspectionRequestSchema,
  nativeInputExecutionRequestSchema,
  nativeCaptureStartRequestSchema,
  nativeCaptureResultRequestSchema,
  nativeCaptureStatusRequestSchema,
  nativeCaptureCancelRequestSchema,
  nativeCaptureReleaseRequestSchema,
])

export const nativeMethodResponseSchema = z.union([
  nativeCursorDisplayResponseSchema,
  nativeAxPressResponseSchema,
  nativeInputReadinessResponseSchema,
  nativeHitTestResponseSchema,
  nativeApplicationResolveResponseSchema,
  nativeApplicationLaunchResponseSchema,
  nativeApplicationQuitResponseSchema,
  nativeInventoryResponseSchema,
  nativeWindowTransitionResponseSchema,
  nativeAxInspectionResponseSchema,
  nativeInputExecutionResponseSchema,
  nativeCaptureStartResponseSchema,
  nativeCaptureResultResponseSchema,
  nativeCaptureStatusResponseSchema,
  nativeCaptureCancelResponseSchema,
  nativeCaptureReleaseResponseSchema,
])

export const nativeTransportRequestFrameSchema = z.discriminatedUnion("channel", [
  z.strictObject({ channel: z.literal("permissions-request"), payload: nativeStartupPermissionsRequestSchema }),
  z.strictObject({ channel: z.literal("domain-recovery"), payload: nativeDomainRecoveryRequestSchema }),
  z.strictObject({ channel: z.literal("held-recovery"), payload: nativeHeldRecoveryRequestSchema }),
  z.strictObject({ channel: z.literal("observer"), payload: nativeObserverRequestSchema }),
  z.strictObject({ channel: z.literal("permissions"), payload: nativePermissionsRequestSchema }),
  z.strictObject({ channel: z.literal("clipboard"), payload: nativeClipboardRequestSchema }),
  z.strictObject({ channel: z.literal("handshake"), payload: nativeHandshakeRequestSchema }),
  z.strictObject({ channel: z.literal("request"), payload: nativeMethodRequestSchema }),
  z.strictObject({ channel: z.literal("status"), payload: nativeStatusRequestSchema }),
  z.strictObject({ channel: z.literal("heartbeat"), payload: nativeHeartbeatRequestSchema }),
  z.strictObject({ channel: z.literal("cancel"), payload: nativeCancelRequestSchema }),
  z.strictObject({ channel: z.literal("drain"), payload: nativeDrainRequestSchema }),
  z.strictObject({ channel: z.literal("ledger-ack"), payload: heldInputLedgerAckSchema }),
  z.strictObject({ channel: z.literal("cleanup"), payload: nativeCaptureCleanupRequestSchema }),
])

export const nativeTransportResponseFrameSchema = z.discriminatedUnion("channel", [
  z.strictObject({ channel: z.literal("permissions-request"), payload: nativeStartupPermissionsResponseSchema }),
  z.strictObject({ channel: z.literal("domain-recovery"), payload: nativeDomainRecoveryResponseSchema }),
  z.strictObject({ channel: z.literal("held-recovery"), payload: nativeHeldRecoveryResponseSchema }),
  z.strictObject({ channel: z.literal("observer"), payload: nativeObserverResponseSchema }),
  z.strictObject({ channel: z.literal("permissions"), payload: nativePermissionsResponseSchema }),
  z.strictObject({ channel: z.literal("clipboard"), payload: nativeClipboardResponseSchema }),
  z.strictObject({ channel: z.literal("handshake"), payload: nativeHandshakeResponseSchema }),
  z.strictObject({ channel: z.literal("response"), payload: nativeMethodResponseSchema }),
  z.strictObject({ channel: z.literal("status"), payload: nativeStatusResponseSchema }),
  z.strictObject({ channel: z.literal("heartbeat"), payload: nativeHeartbeatAckSchema }),
  z.strictObject({ channel: z.literal("cancel"), payload: nativeCancelAckSchema }),
  z.strictObject({ channel: z.literal("drain"), payload: nativeDrainAckSchema }),
  z.strictObject({ channel: z.literal("event"), payload: z.union([nativeObserverEventEnvelopeSchema, nativeObserverGapEnvelopeSchema, observedEventSchema]) }),
  z.strictObject({ channel: z.literal("cleanup"), payload: nativeCaptureCleanupResponseSchema }),
  z.strictObject({
    channel: z.literal("ledger-persist"),
    payload: z.strictObject({
      requestId: opaqueIdSchema,
      snapshot: heldInputLedgerSnapshotSchema,
    }),
  }),
  z.strictObject({
    channel: z.literal("binary"),
    payload: z.strictObject({
      binaryToken: opaqueIdSchema,
      byteLength: z.number().int().min(1).max(64 * 1024 * 1024),
    }),
  }),
])

export type NativeTransportRequestFrame = z.infer<typeof nativeTransportRequestFrameSchema>
export type NativeTransportResponseFrame = z.infer<typeof nativeTransportResponseFrameSchema>
export type NativeInventoryResult = z.infer<typeof nativeInventoryResultSchema>
export type NativeWindowTransitionResult = z.infer<typeof nativeWindowTransitionResultSchema>
export type NativeInputExecutionPayload = z.infer<typeof nativeInputExecutionPayloadSchema>
export type NativeCaptureStartResult = z.infer<typeof nativeCaptureStartResultSchema>
export type NativeCapturePollResult = z.infer<typeof nativeCapturePollResultSchema>
export type NativeCaptureTaskStatus = z.infer<typeof nativeCaptureTaskStatusSchema>

export function encodeNativeFrame(value: unknown): Uint8Array {
  const clipboardProfile = typeof value === "object" && value !== null && "channel" in value && value.channel === "clipboard"
  const payload = new TextEncoder().encode(JSON.stringify(value))
  const maximum = clipboardProfile ? NATIVE_CLIPBOARD_WIRE_BYTES : MAX_NATIVE_ENVELOPE_BYTES
  if (payload.byteLength > maximum) {
    throw new Error(`native frame превышает ${maximum} байт`)
  }
  const frame = new Uint8Array(NATIVE_FRAME_HEADER_BYTES + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, (payload.byteLength | (clipboardProfile ? NATIVE_CLIPBOARD_FRAME_FLAG : 0)) >>> 0, false)
  frame.set(payload, NATIVE_FRAME_HEADER_BYTES)
  return frame
}

export function parseNativeRequestFrame(text: string): NativeTransportRequestFrame {
  return parseWireJson(nativeTransportRequestFrameSchema, text)
}

export class NativeFrameDecoder {
  #clipboardProfile = false
  readonly #header = new Uint8Array(NATIVE_FRAME_HEADER_BYTES)
  #headerLength = 0
  #payload: Uint8Array | undefined
  #payloadLength = 0

  push(chunk: Uint8Array): NativeTransportResponseFrame[] {
    const frames: NativeTransportResponseFrame[] = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.#payload === undefined) {
        const copied = Math.min(NATIVE_FRAME_HEADER_BYTES - this.#headerLength, chunk.byteLength - offset)
        this.#header.set(chunk.subarray(offset, offset + copied), this.#headerLength)
        this.#headerLength += copied
        offset += copied
        if (this.#headerLength < NATIVE_FRAME_HEADER_BYTES) continue
        const encodedLength = new DataView(this.#header.buffer).getUint32(0, false)
        this.#clipboardProfile = (encodedLength & NATIVE_CLIPBOARD_FRAME_FLAG) !== 0
        const length = encodedLength & 0x7fffffff
        const maximum = this.#clipboardProfile ? NATIVE_CLIPBOARD_WIRE_BYTES : MAX_NATIVE_ENVELOPE_BYTES
        if (length === 0 || length > maximum) {
          throw new Error("native frame length превышает предел или пуст")
        }
        this.#payload = new Uint8Array(length)
        this.#payloadLength = 0
      }
      const copied = Math.min(this.#payload.byteLength - this.#payloadLength, chunk.byteLength - offset)
      this.#payload.set(chunk.subarray(offset, offset + copied), this.#payloadLength)
      this.#payloadLength += copied
      offset += copied
      if (this.#payloadLength !== this.#payload.byteLength) continue
      frames.push(decodeMessage(this.#payload, this.#clipboardProfile))
      this.#headerLength = 0
      this.#payload = undefined
      this.#payloadLength = 0
    }
    return frames
  }

  finish(): void {
    if (this.#headerLength !== 0 || this.#payload !== undefined) {
      throw new Error("native transport завершился с неполным frame")
    }
  }
}

export type NativeTransportPacket =
  | { kind: "message", frame: NativeTransportResponseFrame, bytes?: Uint8Array }
  | { kind: "binary", binaryToken: string, bytes: Uint8Array }

export class NativeTransportStreamDecoder {
  #clipboardProfile = false
  readonly #header = new Uint8Array(NATIVE_FRAME_HEADER_BYTES)
  #headerLength = 0
  #message: Uint8Array | undefined
  #messageLength = 0
  #pendingBinary: { binaryToken: string, byteLength: number } | undefined
  #binary: Uint8Array | undefined
  #binaryLength = 0

  push(chunk: Uint8Array): NativeTransportPacket[] {
    const packets: NativeTransportPacket[] = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.#pendingBinary !== undefined) {
        if (this.#binary === undefined) {
          this.#binary = new Uint8Array(this.#pendingBinary.byteLength)
          this.#binaryLength = 0
        }
        const copied = Math.min(this.#binary.byteLength - this.#binaryLength, chunk.byteLength - offset)
        this.#binary.set(chunk.subarray(offset, offset + copied), this.#binaryLength)
        this.#binaryLength += copied
        offset += copied
        if (this.#binaryLength !== this.#binary.byteLength) continue
        packets.push({
          kind: "binary",
          binaryToken: this.#pendingBinary.binaryToken,
          bytes: this.#binary,
        })
        this.#pendingBinary = undefined
        this.#binary = undefined
        this.#binaryLength = 0
        continue
      }
      if (this.#message === undefined) {
        const copied = Math.min(NATIVE_FRAME_HEADER_BYTES - this.#headerLength, chunk.byteLength - offset)
        this.#header.set(chunk.subarray(offset, offset + copied), this.#headerLength)
        this.#headerLength += copied
        offset += copied
        if (this.#headerLength < NATIVE_FRAME_HEADER_BYTES) continue
        const encodedLength = new DataView(this.#header.buffer).getUint32(0, false)
        this.#clipboardProfile = (encodedLength & NATIVE_CLIPBOARD_FRAME_FLAG) !== 0
        const length = encodedLength & 0x7fffffff
        const maximum = this.#clipboardProfile ? NATIVE_CLIPBOARD_WIRE_BYTES : MAX_NATIVE_ENVELOPE_BYTES
        if (length === 0 || length > maximum) {
          throw new Error("native frame length превышает предел или пуст")
        }
        this.#message = new Uint8Array(length)
        this.#messageLength = 0
      }
      const copied = Math.min(this.#message.byteLength - this.#messageLength, chunk.byteLength - offset)
      this.#message.set(chunk.subarray(offset, offset + copied), this.#messageLength)
      this.#messageLength += copied
      offset += copied
      if (this.#messageLength !== this.#message.byteLength) continue
      const messageBytes = this.#message
      const frame = decodeMessage(messageBytes, this.#clipboardProfile)
      this.#headerLength = 0
      this.#message = undefined
      this.#messageLength = 0
      if (frame.channel === "binary") {
        this.#pendingBinary = frame.payload
      } else {
        packets.push({ kind: "message", frame, bytes: messageBytes })
      }
    }
    return packets
  }

  finish(): void {
    if (
      this.#pendingBinary !== undefined
      || this.#binary !== undefined
      || this.#headerLength !== 0
      || this.#message !== undefined
    ) {
      throw new Error("native transport завершился с неполным frame или binary payload")
    }
  }
}
