import { z } from "zod"
import type { AdapterHostContext, AdapterResult, AdapterServices } from "./adapters.ts"
import { contractErrorSchema } from "./errors.ts"
import {
  applicationRefSchema,
  displayRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  surfaceRefSchema,
  windowRefSchema,
} from "./identities.ts"
import { type AdapterControl, type NativeExecutionContext, type RuntimeOperationContext } from "./operations.ts"
import { proofRefSchema, rectSchema } from "./observations.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const triStateSchema = z.enum(["true", "false", "unknown"])
export type TriState = z.infer<typeof triStateSchema>

export const applicationRecordSchema = z.strictObject({
  ref: applicationRefSchema,
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
export type ApplicationRecord = z.infer<typeof applicationRecordSchema>

export const displayRecordSchema = z.strictObject({
  ref: displayRefSchema,
  nativeDisplayId: z.number().int().min(1).max(0xffffffff),
  bounds: rectSchema,
  usableBounds: rectSchema,
  scale: z.number().finite().positive(),
  rotationDegrees: z.number().finite().min(0).lt(360),
  main: z.boolean(),
})
export type DisplayRecord = z.infer<typeof displayRecordSchema>

export const surfaceRecordSchema = z.strictObject({
  ref: surfaceRefSchema,
  kind: z.enum(["sheet", "popup", "menu", "unknown"]),
  title: z.string().max(4_096),
  role: z.string().max(128),
  frame: rectSchema,
  actionability: z.enum(["ax", "unavailable"]),
  advertisedActions: z.array(z.enum(["raise", "close"])).max(2),
  permittedActions: z.array(z.enum(["raise", "close"])).max(2),
  unavailableReason: z.string().min(1).max(1_024).optional(),
}).superRefine((surface, context) => {
  if (surface.ref.ownerWindowRef === undefined) {
    context.addIssue({ code: "custom", path: ["ref", "ownerWindowRef"], message: "surface требует подтверждённый owner window" })
  }
  if (surface.permittedActions.some(action => !surface.advertisedActions.includes(action))) {
    context.addIssue({ code: "custom", path: ["permittedActions"], message: "permitted surface action должен быть advertised" })
  }
  if (surface.actionability === "unavailable" && (surface.permittedActions.length > 0 || surface.unavailableReason === undefined)) {
    context.addIssue({ code: "custom", path: ["actionability"], message: "unavailable surface требует reason и пустые permitted actions" })
  }
})
export type SurfaceRecord = z.infer<typeof surfaceRecordSchema>

export const windowMappingEvidenceSchema = z.strictObject({
  proof: proofRefSchema,
  cgWindowId: z.number().int().min(1).max(0xffffffff),
  ownerPid: z.number().int().min(1).max(0x7fffffff),
}).refine(mapping => mapping.proof.kind === "cg-ax-correlation", {
  path: ["proof", "kind"],
  message: "window mapping требует cg-ax-correlation proof",
})

export const windowRecordSchema = z.strictObject({
  kind: z.literal("ax-window"),
  ref: windowRefSchema,
  surfaces: z.array(surfaceRecordSchema).max(256),
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  cgWindowId: z.number().int().min(1).max(0xffffffff).optional(),
  title: z.string().max(4_096),
  role: z.string().max(128),
  subrole: z.string().max(128),
  frame: rectSchema,
  applicationHidden: triStateSchema,
  minimized: triStateSchema,
  onScreen: triStateSchema,
  spaceVisibility: z.enum(["current", "not-current", "unknown"]),
  fullscreen: triStateSchema,
  focused: triStateSchema,
  main: triStateSchema,
  mapping: z.enum(["corroborated", "ambiguous", "unavailable"]),
  mappingEvidence: windowMappingEvidenceSchema.optional(),
  mappingReason: z.string().min(1).max(1_024).optional(),
  actionability: z.enum(["ax", "unavailable"]),
  unavailableReason: z.string().min(1).max(1_024).optional(),
  advertisedActions: z.array(z.enum(["raise", "close", "minimize", "move", "resize"])).max(5),
  permittedActions: z.array(z.enum(["raise", "close", "minimize", "move", "resize"])).max(5),
}).superRefine((window, context) => {
  if (
    new Set(window.advertisedActions).size !== window.advertisedActions.length
    || new Set(window.permittedActions).size !== window.permittedActions.length
  ) {
    context.addIssue({ code: "custom", path: ["advertisedActions"], message: "window action не должен повторяться" })
  }
  if (window.permittedActions.some(action => !window.advertisedActions.includes(action))) {
    context.addIssue({ code: "custom", path: ["permittedActions"], message: "permitted action должен быть advertised" })
  }
  if (window.mapping === "corroborated" && (
    window.mappingEvidence === undefined
    || window.cgWindowId !== window.mappingEvidence.cgWindowId
    || window.ownerPid !== window.mappingEvidence.ownerPid
    || !structurallyEqual(window.mappingEvidence.proof.subject, { kind: "window", ref: window.ref })
  )) {
    context.addIssue({ code: "custom", path: ["mappingEvidence"], message: "corroborated mapping требует proof" })
  }
  if (window.cgWindowId === undefined && window.mapping === "corroborated") {
    context.addIssue({ code: "custom", path: ["cgWindowId"], message: "corroborated mapping требует CGWindowID" })
  }
  if (window.mapping !== "corroborated" && window.mappingReason === undefined) {
    context.addIssue({ code: "custom", path: ["mappingReason"], message: "неcorroborated mapping требует reason" })
  }
  if (window.actionability === "unavailable" && window.unavailableReason === undefined) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "unavailable actionability требует reason" })
  }
  if (window.actionability === "unavailable" && window.permittedActions.length > 0) {
    context.addIssue({ code: "custom", path: ["permittedActions"], message: "unavailable window не разрешает действия сейчас" })
  }
})
export type WindowRecord = z.infer<typeof windowRecordSchema>

export const cgOnlyWindowRecordSchema = z.strictObject({
  kind: z.literal("cg-only"),
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  cgEntryRef: opaqueIdSchema,
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  cgWindowId: z.number().int().min(1).max(0xffffffff),
  title: z.string().max(4_096),
  frame: rectSchema,
  onScreen: triStateSchema,
  actionability: z.literal("unavailable"),
  reason: z.string().min(1).max(1_024),
})
export type CgOnlyWindowRecord = z.infer<typeof cgOnlyWindowRecordSchema>

export const desktopWindowEntrySchema = z.discriminatedUnion("kind", [
  windowRecordSchema,
  cgOnlyWindowRecordSchema,
])
export type DesktopWindowEntry = z.infer<typeof desktopWindowEntrySchema>

export const desktopInventorySnapshotSchema = z.strictObject({
  inventoryId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  revision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  capturedAt: isoTimestampSchema,
  complete: z.boolean(),
  errors: z.array(contractErrorSchema).max(1_024),
  applications: z.array(applicationRecordSchema).max(4_096),
  windows: z.array(desktopWindowEntrySchema).max(16_384),
  displays: z.array(displayRecordSchema).max(64),
}).superRefine((snapshot, context) => {
  if (!snapshot.complete && snapshot.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "incomplete inventory требует причину" })
  }
  const references = [
    ...snapshot.applications.map(application => application.ref),
    ...snapshot.windows.map(window => window.kind === "ax-window" ? window.ref : window),
    ...snapshot.displays.map(display => display.ref),
  ]
  if (references.some(reference => {
    return reference.runtimeEpoch !== snapshot.runtimeEpoch
      || reference.loginSessionId !== snapshot.loginSessionId
      || reference.nativeGeneration !== snapshot.nativeGeneration
  })) {
    context.addIssue({ code: "custom", message: "inventory содержит ref другого generation" })
  }
  if (snapshot.displays.some(display => display.ref.displayLayoutRevision !== snapshot.displayLayoutRevision)) {
    context.addIssue({ code: "custom", path: ["displays"], message: "display ref содержит другую topology revision" })
  }
  for (const window of snapshot.windows) {
    if (window.kind === "cg-only") continue
    const application = snapshot.applications.find(candidate => candidate.ref.applicationRef === window.ref.applicationRef)
    if (application !== undefined && application.ref.pid !== window.ownerPid) {
      context.addIssue({ code: "custom", path: ["windows"], message: "window ownerPid не совпадает с process incarnation" })
    }
    if (window.mapping === "corroborated" && window.mappingEvidence !== undefined) {
      const proof = window.mappingEvidence.proof
      if (
        proof.inventoryRevision !== snapshot.revision
        || proof.displayLayoutRevision !== snapshot.displayLayoutRevision
        || proof.runtimeEpoch !== snapshot.runtimeEpoch
        || proof.loginSessionId !== snapshot.loginSessionId
        || proof.nativeGeneration !== snapshot.nativeGeneration
      ) {
        context.addIssue({ code: "custom", path: ["windows"], message: "window mapping proof не относится к current inventory" })
      }
    }
  }
})
export type DesktopInventorySnapshot = z.infer<typeof desktopInventorySnapshotSchema>

export const windowTransitionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("show"), target: windowRefSchema }),
  z.strictObject({ kind: z.literal("focus"), target: windowRefSchema }),
  z.strictObject({ kind: z.literal("set-bounds"), target: windowRefSchema, bounds: rectSchema }),
  z.strictObject({ kind: z.literal("minimize"), target: windowRefSchema, minimized: z.boolean() }),
  z.strictObject({ kind: z.literal("close"), target: windowRefSchema }),
])
export type WindowTransitionRequest = z.infer<typeof windowTransitionRequestSchema>

export const windowTransitionResultSchema = z.strictObject({
  target: windowRefSchema,
  requested: windowTransitionRequestSchema,
  actual: windowRecordSchema,
  changed: z.boolean(),
  partial: z.boolean(),
  newSurface: surfaceRefSchema.optional(),
  errors: z.array(contractErrorSchema).max(16),
}).superRefine((result, context) => {
  if (
    !structurallyEqual(result.target, result.requested.target)
    || !structurallyEqual(result.target, result.actual.ref)
  ) {
    context.addIssue({ code: "custom", path: ["target"], message: "transition result содержит другой target" })
  }
  if (result.partial && result.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "partial transition требует причину" })
  }
  if (result.newSurface !== undefined && (
    result.newSurface.runtimeEpoch !== result.target.runtimeEpoch
    || result.newSurface.loginSessionId !== result.target.loginSessionId
    || result.newSurface.nativeGeneration !== result.target.nativeGeneration
    || result.newSurface.applicationRef !== result.target.applicationRef
    || result.newSurface.ownerWindowRef !== result.target.windowRef
  )) {
    context.addIssue({ code: "custom", path: ["newSurface"], message: "new surface не принадлежит исходному window target" })
  }
})
export type WindowTransitionResult = z.infer<typeof windowTransitionResultSchema>

export const axInspectionRequestSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
    z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
  ]),
  depth: z.number().int().min(0).max(12),
  maxNodes: z.number().int().min(1).max(1_500),
  maxBytes: z.number().int().min(1).max(1024 * 1024),
  cursor: opaqueIdSchema.optional(),
})
export type AxInspectionRequest = z.infer<typeof axInspectionRequestSchema>

export const axInspectionResultSchema = z.strictObject({
  snapshotId: opaqueIdSchema,
  target: axInspectionRequestSchema.shape.target,
  complete: z.boolean(),
  nextCursor: opaqueIdSchema.optional(),
  nodeCount: z.number().int().safe().min(0),
  encodedBytes: z.number().int().safe().min(0).max(1024 * 1024),
  errors: z.array(contractErrorSchema).max(128),
})
export type AxInspectionResult = z.infer<typeof axInspectionResultSchema>

export interface WindowAdapter {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly (
    | "desktop.applications"
    | "desktop.windows.all"
    | "desktop.window.identity"
    | "desktop.window.show"
    | "desktop.window.lifecycle"
    | "desktop.displays"
    | "desktop.ax"
  )[]
  inventory(control: AdapterControl): Promise<DesktopInventorySnapshot>
  transition(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: WindowTransitionRequest,
  ): Promise<AdapterResult<WindowTransitionResult>>
  inspect(request: AxInspectionRequest, control: AdapterControl): Promise<AxInspectionResult>
}
