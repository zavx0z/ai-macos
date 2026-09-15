import { z } from "zod"
import { inflateSync } from "node:zlib"
import {
  authorizeAdapterContext,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type BinaryFramePublisher,
  type TargetResolution,
} from "./adapters.ts"
import {
  browserTargetRefSchema,
  deviceBrowserTargetRefSchema,
  desktopLayoutRefSchema,
  displayRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  operationTargetSchema,
  windowRefSchema,
} from "./identities.ts"
import { type NativeExecutionContext, type RuntimeOperationContext } from "./operations.ts"
import {
  evidenceSchema,
  observationSchema,
  readinessPolicySchema,
  rectSchema,
  type Observation,
  type ReadinessPolicy,
} from "./observations.ts"
import {
  cleanupOutcomeSchema,
  requireAuthorizedResourceHandles,
  type CleanupOutcome,
} from "./resources.ts"
import { canonicalJson, isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const MAX_CAPTURE_PIXELS = 32_000_000
export const MAX_CAPTURE_ENCODED_BYTES = 64 * 1024 * 1024
export const MAX_CAPTURE_DIMENSION_PX = 32_768
export const MAX_CAPTURE_DECODED_BYTES = 128 * 1024 * 1024

export const observationPublicationSchema = z.strictObject({
  observationId: opaqueIdSchema,
  frameRef: opaqueIdSchema,
  source: z.enum(["display-composite", "window-isolated", "browser-viewport", "device-browser-viewport"]),
  captureTarget: operationTargetSchema,
  capturePolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema.optional(),
  expiresAt: isoTimestampSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  cacheScopeRef: opaqueIdSchema,
})
export type ObservationPublication = z.infer<typeof observationPublicationSchema>

export const captureOutputPolicySchema = z.strictObject({
  format: z.literal("image/png"),
  scale: z.number().finite().positive().max(1),
  maxWidthPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
  maxHeightPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
  maxPixels: z.number().int().min(1).max(MAX_CAPTURE_PIXELS),
  maxEncodedBytes: z.number().int().min(1).max(MAX_CAPTURE_ENCODED_BYTES),
})
export type CaptureOutputPolicy = z.infer<typeof captureOutputPolicySchema>

export const captureClipSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("full-target") }),
  z.strictObject({ kind: z.literal("rect"), rect: rectSchema }),
])
export type CaptureClip = z.infer<typeof captureClipSchema>

export const displayCaptureTargetSchema = z.strictObject({
  kind: z.literal("display"),
  target: z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
  nativeDisplayId: z.number().int().min(1).max(0xffffffff),
  mappingEvidence: evidenceSchema,
}).superRefine((target, context) => {
  if (
    target.mappingEvidence.state !== "confirmed"
    || target.mappingEvidence.proof.kind !== "target-resolution"
    || !structurallyEqual(target.mappingEvidence.proof.subject, target.target)
  ) {
    context.addIssue({ code: "custom", path: ["mappingEvidence"], message: "display capture требует authoritative registry resolution" })
  }
})
export type DisplayCaptureTarget = z.infer<typeof displayCaptureTargetSchema>

export const desktopLayoutCaptureTargetSchema = z.strictObject({
  kind: z.literal("desktop-layout"),
  target: z.strictObject({ kind: z.literal("desktop-layout"), ref: desktopLayoutRefSchema }),
  mappingEvidence: evidenceSchema,
  displays: z.array(displayCaptureTargetSchema).min(1).max(64),
}).superRefine((layout, context) => {
  if (
    layout.mappingEvidence.state !== "confirmed"
    || layout.mappingEvidence.proof.kind !== "target-resolution"
    || !structurallyEqual(layout.mappingEvidence.proof.subject, layout.target)
  ) {
    context.addIssue({ code: "custom", path: ["mappingEvidence"], message: "desktop layout требует authoritative registry resolution" })
  }
  const refs = layout.displays.map(display => display.target.ref.displayRef)
  if (new Set(refs).size !== refs.length) {
    context.addIssue({ code: "custom", path: ["displays"], message: "display не должен повторяться" })
  }
  if (layout.displays.some(display => display.target.ref.displayLayoutRevision !== layout.target.ref.displayLayoutRevision)) {
    context.addIssue({ code: "custom", path: ["displays"], message: "display принадлежит другой topology revision" })
  }
  if (layout.displays.some(display => {
    return display.target.ref.runtimeEpoch !== layout.target.ref.runtimeEpoch
      || display.target.ref.loginSessionId !== layout.target.ref.loginSessionId
      || display.target.ref.nativeGeneration !== layout.target.ref.nativeGeneration
  })) {
    context.addIssue({ code: "custom", path: ["displays"], message: "display принадлежит другой layout generation" })
  }
  const nativeIds = layout.displays.map(display => display.nativeDisplayId)
  if (new Set(nativeIds).size !== nativeIds.length) {
    context.addIssue({ code: "custom", path: ["displays"], message: "native display ID не должен повторяться" })
  }
})
export type DesktopLayoutCaptureTarget = z.infer<typeof desktopLayoutCaptureTargetSchema>

export const windowCaptureTargetSchema = z.strictObject({
  kind: z.literal("window"),
  target: z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  cgWindowId: z.number().int().min(1).max(0xffffffff),
  ownerPid: z.number().int().min(1).max(0x7fffffff),
  mappingEvidence: evidenceSchema,
}).superRefine((target, context) => {
  if (
    target.mappingEvidence.state !== "confirmed"
    || target.mappingEvidence.proof.kind !== "cg-ax-correlation"
  ) {
    context.addIssue({ code: "custom", path: ["mappingEvidence"], message: "window capture требует authoritative CG-AX proof" })
  }
})
export type WindowCaptureTarget = z.infer<typeof windowCaptureTargetSchema>

export const nativeCaptureTargetSchema = z.discriminatedUnion("kind", [
  displayCaptureTargetSchema,
  desktopLayoutCaptureTargetSchema,
  windowCaptureTargetSchema,
])
export type NativeCaptureTarget = z.infer<typeof nativeCaptureTargetSchema>

export const screenCaptureRequestSchema = z.strictObject({
  source: z.enum(["display-composite", "window-isolated"]),
  caption: z.string().min(1).max(2_048),
  publication: observationPublicationSchema,
  target: nativeCaptureTargetSchema,
  clip: captureClipSchema,
  fullPage: z.literal(false),
  cursor: z.enum(["include", "exclude"]),
  readinessPolicy: readinessPolicySchema,
  output: captureOutputPolicySchema,
}).superRefine((request, context) => {
  if (request.source === "window-isolated" && request.target.kind !== "window") {
    context.addIssue({ code: "custom", path: ["target"], message: "window-isolated требует window target" })
  }
  if (request.source === "display-composite" && request.target.kind === "window") {
    context.addIssue({ code: "custom", path: ["target"], message: "display-composite требует display/layout target" })
  }
  const targetRevision = request.target.kind === "desktop-layout"
    ? request.target.target.ref.displayLayoutRevision
    : request.target.kind === "display"
      ? request.target.target.ref.displayLayoutRevision
      : request.target.mappingEvidence.state === "confirmed"
        ? request.target.mappingEvidence.proof.displayLayoutRevision
        : -1
  if (targetRevision !== request.publication.displayLayoutRevision) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication и target имеют разные topology revisions" })
  }
  const target = captureOperationTarget(request.target)
  const targetNativeGeneration = request.target.target.ref.nativeGeneration
  if (
    request.publication.runtimeEpoch !== target.ref.runtimeEpoch
    || request.publication.loginSessionId !== target.ref.loginSessionId
  ) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication принадлежит другой target generation" })
  }
  if (
    request.publication.nativeGeneration === undefined
    || request.publication.nativeGeneration !== targetNativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["publication", "nativeGeneration"], message: "native capture требует текущую native generation" })
  }
  if (request.target.kind === "window" && request.target.mappingEvidence.state === "confirmed") {
    const proof = request.target.mappingEvidence.proof
    if (
      proof.inventoryRevision !== request.publication.inventoryRevision
      || proof.displayLayoutRevision !== request.publication.displayLayoutRevision
      || !structurallyEqual(proof.subject, request.target.target)
    ) {
      context.addIssue({ code: "custom", path: ["target", "mappingEvidence"], message: "mapping proof не связан с publication/target" })
    }
  }
  if (request.target.kind === "desktop-layout" && request.target.mappingEvidence.state === "confirmed") {
    const proof = request.target.mappingEvidence.proof
    if (
      proof.inventoryRevision !== request.publication.inventoryRevision
      || proof.displayLayoutRevision !== request.publication.displayLayoutRevision
    ) {
      context.addIssue({ code: "custom", path: ["target", "mappingEvidence"], message: "layout proof не связан с publication" })
    }
  }
  if (
    request.publication.source !== request.source
    || !structurallyEqual(request.publication.captureTarget, captureOperationTarget(request.target))
    || request.publication.capturePolicySha256 !== capturePolicySha256(request)
  ) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication не резервирует exact source/target/capture policy" })
  }
  const displayMappings = request.target.kind === "display"
    ? [request.target]
    : request.target.kind === "desktop-layout" ? request.target.displays : []
  for (const display of displayMappings) {
    if (display.mappingEvidence.state !== "confirmed" || (
      display.mappingEvidence.proof.inventoryRevision !== request.publication.inventoryRevision
      || display.mappingEvidence.proof.displayLayoutRevision !== request.publication.displayLayoutRevision
    )) {
      context.addIssue({ code: "custom", path: ["target"], message: "display mapping proof не связан с publication" })
    }
  }
})
export type ScreenCaptureRequest = z.infer<typeof screenCaptureRequestSchema>

export const browserCaptureRequestSchema = z.strictObject({
  source: z.enum(["browser-viewport", "device-browser-viewport"]),
  caption: z.string().min(1).max(2_048),
  publication: observationPublicationSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("browser-target"), ref: browserTargetRefSchema }),
    z.strictObject({ kind: z.literal("device-browser-target"), ref: deviceBrowserTargetRefSchema }),
  ]),
  clip: captureClipSchema,
  fullPage: z.boolean(),
  cursor: z.literal("exclude"),
  readinessPolicy: readinessPolicySchema,
  output: captureOutputPolicySchema,
}).superRefine((request, context) => {
  if (
    (request.source === "browser-viewport" && request.target.kind !== "browser-target")
    || (request.source === "device-browser-viewport" && request.target.kind !== "device-browser-target")
  ) {
    context.addIssue({ code: "custom", path: ["target"], message: "capture source и target domain не совпадают" })
  }
  if (request.publication.nativeGeneration !== undefined) {
    context.addIssue({ code: "custom", path: ["publication", "nativeGeneration"], message: "browser publication не зависит от native generation" })
  }
  if (
    request.publication.runtimeEpoch !== request.target.ref.runtimeEpoch
    || request.publication.loginSessionId !== request.target.ref.loginSessionId
  ) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication принадлежит другой browser target generation" })
  }
  if (request.fullPage && request.clip.kind !== "full-target") {
    context.addIssue({ code: "custom", path: ["clip"], message: "fullPage capture не принимает дополнительный rect clip" })
  }
  if (
    request.publication.source !== request.source
    || !structurallyEqual(request.publication.captureTarget, request.target)
    || request.publication.capturePolicySha256 !== capturePolicySha256(request)
  ) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication не резервирует exact browser source/target/policy" })
  }
})
export type BrowserCaptureRequest = z.infer<typeof browserCaptureRequestSchema>

export const nativeBinaryFrameHeaderSchema = z.strictObject({
  frameRef: opaqueIdSchema,
  observationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema.optional(),
  source: z.enum(["display-composite", "window-isolated", "browser-viewport", "device-browser-viewport"]),
  target: operationTargetSchema,
  capturedAt: isoTimestampSchema,
  widthPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
  heightPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
  byteLength: z.number().int().min(1).max(MAX_CAPTURE_ENCODED_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.literal("image/png"),
}).superRefine((frame, context) => {
  if (frame.widthPx * frame.heightPx > MAX_CAPTURE_PIXELS) {
    context.addIssue({ code: "custom", message: "binary frame превышает pixel budget" })
  }
  const nativeSource = frame.source === "display-composite" || frame.source === "window-isolated"
  if (nativeSource && frame.nativeGeneration === undefined) {
    context.addIssue({ code: "custom", path: ["nativeGeneration"], message: "native frame требует native generation" })
  }
  if (
    frame.target.ref.runtimeEpoch !== frame.runtimeEpoch
    || frame.target.ref.loginSessionId !== frame.loginSessionId
  ) {
    context.addIssue({ code: "custom", path: ["target"], message: "binary frame target принадлежит другой generation" })
  }
  const targetMatchesSource = nativeSource
    ? ["application", "window", "surface", "element", "display", "desktop-layout"].includes(frame.target.kind)
    : frame.source === "browser-viewport"
      ? frame.target.kind === "browser-target"
      : frame.target.kind === "device-browser-target"
  if (!targetMatchesSource) {
    context.addIssue({ code: "custom", path: ["target"], message: "binary frame target domain не соответствует source" })
  }
})
export type NativeBinaryFrameHeader = z.infer<typeof nativeBinaryFrameHeaderSchema>

export const screenCaptureResultSchema = z.strictObject({
  publication: observationPublicationSchema,
  observation: observationSchema,
  frame: nativeBinaryFrameHeaderSchema,
  effective: z.strictObject({
    clip: captureClipSchema,
    fullPage: z.boolean(),
    cursor: z.enum(["included", "excluded"]),
    scale: z.number().finite().positive().max(1),
    widthPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
    heightPx: z.number().int().min(1).max(MAX_CAPTURE_DIMENSION_PX),
    pixelCount: z.number().int().min(1).max(MAX_CAPTURE_PIXELS),
    encodedBytes: z.number().int().min(1).max(MAX_CAPTURE_ENCODED_BYTES),
    readinessPolicy: readinessPolicySchema,
  }),
  cleanup: cleanupOutcomeSchema,
}).superRefine((result, context) => {
  if (
    result.effective.widthPx !== result.observation.image.widthPx
    || result.effective.heightPx !== result.observation.image.heightPx
    || result.effective.pixelCount !== result.effective.widthPx * result.effective.heightPx
    || result.effective.encodedBytes !== result.observation.image.byteLength
  ) {
    context.addIssue({ code: "custom", path: ["effective"], message: "effective extent не совпадает с observation image" })
  }
})
export type ScreenCaptureResult = z.infer<typeof screenCaptureResultSchema>

export interface ScreenAdapter {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly ("capture.desktop" | "capture.window" | "capture.observation")[]
  capture(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: ScreenCaptureRequest,
  ): Promise<AdapterResult<ScreenCaptureResult>>
}

export function assertCaptureResultMatchesRequest(
  request: ScreenCaptureRequest | BrowserCaptureRequest,
  result: ScreenCaptureResult,
  resolution?: TargetResolution,
): void {
  const observation = result.observation
  if (!structurallyEqual(result.publication, request.publication)) throw new Error("Capture result содержит другую publication")
  if (observation.observationId !== request.publication.observationId) throw new Error("Capture result содержит другой observationId")
  if (observation.image.frameRef !== request.publication.frameRef) throw new Error("Capture result содержит невыданный frameRef")
  if (observation.runtimeEpoch !== request.publication.runtimeEpoch) throw new Error("Capture result принадлежит другой runtime epoch")
  if (observation.loginSessionId !== request.publication.loginSessionId) throw new Error("Capture result принадлежит другой login session")
  if (!structurallyEqual(observation.captureTarget, captureOperationTarget(request.target))) throw new Error("Capture result содержит другой capture target")
  if (observation.caption !== request.caption || observation.source !== request.source) throw new Error("Capture result потерял caption/source")
  if (!structurallyEqual(observation.readiness.policy, request.readinessPolicy)) {
    throw new Error("Capture result использует другую readiness policy")
  }
  if (
    !structurallyEqual(result.effective.clip, request.clip)
    || result.effective.fullPage !== request.fullPage
    || result.effective.scale !== request.output.scale
    || result.effective.widthPx > request.output.maxWidthPx
    || result.effective.heightPx > request.output.maxHeightPx
    || result.effective.pixelCount > request.output.maxPixels
    || result.effective.encodedBytes > request.output.maxEncodedBytes
    || !structurallyEqual(result.effective.readinessPolicy, request.readinessPolicy)
  ) {
    throw new Error("Capture result нарушает requested capture policy/budget")
  }
  if (request.source === "display-composite" || request.source === "window-isolated") {
    if (resolution === undefined) throw new Error("Native capture result требует single authoritative TargetResolution")
    const resolvedDisplays = resolution.nativeMapping?.kind === "display"
      ? [resolution.nativeMapping.display]
      : resolution.nativeMapping?.kind === "window" || resolution.nativeMapping?.kind === "desktop-layout"
        ? resolution.nativeMapping.displays
        : []
    const expectedRefs = new Set(resolvedDisplays.map(display => canonicalJson(display.ref)))
    const actualRefs = new Set(result.observation.regions.map(region => {
      if (region.space.kind !== "macos-screen") throw new Error("Native capture содержит non-macOS region")
      return canonicalJson(region.space.display)
    }))
    if (
      expectedRefs.size === 0
      || expectedRefs.size !== actualRefs.size
      || [...expectedRefs].some(displayRef => !actualRefs.has(displayRef))
    ) {
      throw new Error("Capture regions не совпадают с snapshot-bound covered display set")
    }
  }
  const expectedCursor = request.cursor === "include" ? "included" : "excluded"
  if (result.effective.cursor !== expectedCursor || observation.cursor !== expectedCursor) {
    throw new Error("Capture result нарушает requested cursor policy")
  }
  if (
    observation.expiresAt !== request.publication.expiresAt
    || observation.inventoryRevision !== request.publication.inventoryRevision
    || observation.displayLayoutRevision !== request.publication.displayLayoutRevision
  ) {
    throw new Error("Capture result содержит другие revisions/expiry")
  }
  if (
    result.frame.frameRef !== observation.image.frameRef
    || result.frame.observationId !== observation.observationId
    || result.frame.byteLength !== observation.image.byteLength
    || result.frame.sha256 !== observation.image.sha256
    || result.frame.widthPx !== observation.image.widthPx
    || result.frame.heightPx !== observation.image.heightPx
    || result.frame.source !== observation.source
    || result.frame.runtimeEpoch !== observation.runtimeEpoch
    || result.frame.loginSessionId !== observation.loginSessionId
    || result.frame.nativeGeneration !== observation.nativeGeneration
    || result.frame.capturedAt !== observation.capturedAt
    || result.frame.mime !== observation.image.mime
    || !structurallyEqual(result.frame.target, observation.captureTarget)
  ) {
    throw new Error("Binary frame header не совпадает с observation")
  }
}

export async function authorizeScreenCapture(
  adapter: ScreenAdapter,
  context: RuntimeOperationContext<NativeExecutionContext>,
  request: ScreenCaptureRequest,
  now: Date,
): Promise<import("./adapters.ts").TargetResolution> {
  const wire = context.wire
  await authorizeAdapterContext(adapter.host, adapter.services, context, now)
  const expectedTarget = captureOperationTarget(request.target)
  if (!structurallyEqual(wire.target, expectedTarget)) throw new Error("Capture context содержит другой exact target")
  if (
    wire.inventoryId !== request.publication.inventoryId
    || wire.inventoryRevision !== request.publication.inventoryRevision
  ) {
    throw new Error("Capture context содержит другую inventory")
  }
  const resolution = await adapter.services.targets.resolve({
    target: expectedTarget,
    inventoryId: wire.inventoryId,
    inventoryRevision: wire.inventoryRevision,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    nativeGeneration: wire.nativeGeneration,
    deadlineAt: wire.deadlineAt,
  })
  if (
    resolution.inventoryId !== request.publication.inventoryId
    || resolution.inventoryRevision !== request.publication.inventoryRevision
    || resolution.displayLayoutRevision !== request.publication.displayLayoutRevision
    || resolution.nativeGeneration !== wire.nativeGeneration
  ) {
    throw new Error("Target resolution относится к другой inventory/topology/native generation")
  }
  const resolvedDisplays = resolution.nativeMapping?.kind === "display"
    ? [resolution.nativeMapping.display]
    : resolution.nativeMapping?.kind === "window" || resolution.nativeMapping?.kind === "desktop-layout"
      ? resolution.nativeMapping.displays
      : []
  const nativeDisplayIds = resolvedDisplays.map(display => display.nativeDisplayId)
  if (
    resolvedDisplays.length === 0
    || new Set(nativeDisplayIds).size !== nativeDisplayIds.length
    || resolvedDisplays.some(display => {
      return display.ref.runtimeEpoch !== wire.runtimeEpoch
        || display.ref.loginSessionId !== wire.loginSessionId
        || display.ref.nativeGeneration !== wire.nativeGeneration
        || display.ref.displayLayoutRevision !== request.publication.displayLayoutRevision
    })
  ) {
    throw new Error("Target resolution содержит foreign или неоднозначный display mapping")
  }
  const expectedMapping = request.target.kind === "display"
    ? {
        kind: "display" as const,
        display: { nativeDisplayId: request.target.nativeDisplayId, ref: request.target.target.ref },
      }
    : request.target.kind === "window"
      ? {
          kind: "window" as const,
          cgWindowId: request.target.cgWindowId,
          ownerPid: request.target.ownerPid,
          displays: resolution.nativeMapping?.kind === "window" ? resolution.nativeMapping.displays : [],
        }
      : {
          kind: "desktop-layout" as const,
          displays: request.target.displays.map(display => ({
            nativeDisplayId: display.nativeDisplayId,
            ref: display.target.ref,
          })),
        }
  if (!structurallyEqual(resolution.nativeMapping, expectedMapping)) {
    throw new Error("Target authority не подтвердил requested native capture mapping")
  }
  const expectedProofRef = request.target.mappingEvidence.state === "confirmed"
    ? request.target.mappingEvidence.proof.proofRef
    : ""
  if (resolution.proofRef !== expectedProofRef) {
    throw new Error("Target authority вернул другой mapping proof")
  }
  await requireAuthorizedResourceHandles(adapter.services.resources, context.resources, {
    operationId: wire.operationId,
    clientSessionId: wire.clientSessionId,
    principalId: wire.principalId,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    now,
  }, [{ kind: "capture-stream", resourceRef: request.publication.observationId }])
  return resolution
}

export async function verifyAndPublishBinaryFrame(
  publisher: BinaryFramePublisher,
  request: ScreenCaptureRequest | BrowserCaptureRequest,
  result: ScreenCaptureResult,
  bytes: Uint8Array,
  resolution?: TargetResolution,
): Promise<void> {
  assertCaptureResultMatchesRequest(request, result, resolution)
  assertBinaryFrameBytes(result.frame, bytes)
  await publisher.publish({
    frameRef: result.frame.frameRef,
    observationId: result.frame.observationId,
    runtimeEpoch: result.frame.runtimeEpoch,
    loginSessionId: result.frame.loginSessionId,
    ...(result.frame.nativeGeneration === undefined ? {} : { nativeGeneration: result.frame.nativeGeneration }),
    source: result.frame.source,
    target: result.frame.target,
    capturedAt: result.frame.capturedAt,
    widthPx: result.frame.widthPx,
    heightPx: result.frame.heightPx,
    mime: result.frame.mime,
    expectedByteLength: result.frame.byteLength,
    expectedSha256: result.frame.sha256,
    bytes,
  })
}

export function assertBinaryFrameBytes(frame: NativeBinaryFrameHeader, bytes: Uint8Array): void {
  if (bytes.byteLength !== frame.byteLength) throw new Error("Binary frame length не совпадает с header")
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (pngSignature.some((byte, index) => bytes[index] !== byte)) throw new Error("Binary frame не содержит PNG signature")
  const dimensions = validatePng(bytes)
  if (dimensions.width !== frame.widthPx || dimensions.height !== frame.heightPx) {
    throw new Error("Фактические PNG dimensions не совпадают с header")
  }
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (digest !== frame.sha256) throw new Error("Binary frame checksum не совпадает с header")
}

export function readPngDimensions(bytes: Uint8Array): { width: number, height: number } {
  return validatePng(bytes)
}

export function validatePng(
  bytes: Uint8Array,
  maxDecodedBytes = MAX_CAPTURE_DECODED_BYTES,
): { width: number, height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.byteLength < 8 || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("PNG signature отсутствует")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let sawHeader = false
  let sawPalette = false
  let sawImageData = false
  let sawEnd = false
  const imageData: Uint8Array[] = []
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("PNG chunk header обрезан")
    const length = view.getUint32(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.byteLength) throw new Error("PNG chunk data обрезан")
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = String.fromCharCode(...typeBytes)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = view.getUint32(offset + 8 + length)
    if (crc32(typeBytes, data) !== expectedCrc) throw new Error(`PNG chunk ${type} имеет неверный CRC`)
    if (!sawHeader && type !== "IHDR") throw new Error("PNG IHDR должен быть первым chunk")
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("PNG содержит повторный или invalid IHDR")
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? -1
      const compression = data[10]
      const filter = data[11]
      const interlace = data[12]
      if (width < 1 || height < 1) throw new Error("PNG IHDR содержит пустые dimensions")
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("PNG использует неподдерживаемые compression/filter/interlace параметры")
      }
      if (!validPngBitDepth(colorType, bitDepth)) throw new Error("PNG color type и bit depth несовместимы")
      sawHeader = true
    } else if (type === "PLTE") {
      if (sawImageData || length === 0 || length % 3 !== 0 || length > 768) throw new Error("PNG PLTE invalid")
      sawPalette = true
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) throw new Error("PNG IDAT находится вне image stream")
      sawImageData = true
      imageData.push(data)
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData) throw new Error("PNG IEND invalid или отсутствует IDAT")
      sawEnd = true
      offset = chunkEnd
      if (offset !== bytes.byteLength) throw new Error("PNG содержит trailing bytes после IEND")
      break
    } else if ((typeBytes[0] ?? 0) >= 65 && (typeBytes[0] ?? 0) <= 90) {
      throw new Error(`PNG содержит неизвестный critical chunk ${type}`)
    }
    offset = chunkEnd
  }
  if (!sawHeader || !sawImageData || !sawEnd) throw new Error("PNG stream не содержит полный IHDR/IDAT/IEND")
  if (colorType === 3 && !sawPalette) throw new Error("Indexed PNG не содержит PLTE")
  const channels = pngChannels(colorType)
  const rowBytes = Math.ceil(width * channels * bitDepth / 8)
  const expectedDecodedBytes = (rowBytes + 1) * height
  if (!Number.isSafeInteger(expectedDecodedBytes) || expectedDecodedBytes > maxDecodedBytes) {
    throw new Error("PNG decoded extent превышает memory budget")
  }
  const compressedBytes = imageData.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const compressed = new Uint8Array(compressedBytes)
  let compressedOffset = 0
  for (const chunk of imageData) {
    compressed.set(chunk, compressedOffset)
    compressedOffset += chunk.byteLength
  }
  let decoded: Uint8Array
  try {
    decoded = inflateSync(compressed, { maxOutputLength: expectedDecodedBytes + 1 })
  } catch (error) {
    throw new Error(`PNG IDAT zlib stream invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (decoded.byteLength !== expectedDecodedBytes) throw new Error("PNG decoded extent не совпадает с IHDR")
  for (let row = 0; row < height; row++) {
    const filterByte = decoded[row * (rowBytes + 1)]
    if (filterByte === undefined || filterByte > 4) throw new Error("PNG scanline содержит invalid filter")
  }
  return { width, height }
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  const allowed: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }
  return allowed[colorType]?.includes(bitDepth) === true
}

function pngChannels(colorType: number): number {
  const channels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const value = channels[colorType]
  if (value === undefined) throw new Error("PNG color type неизвестен")
  return value
}

function crc32(type: Uint8Array, data: Uint8Array): number {
  let crc = 0xffffffff
  for (const chunk of [type, data]) {
    for (const byte of chunk) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function captureOperationTarget(
  target: NativeCaptureTarget | BrowserCaptureRequest["target"],
): z.infer<typeof operationTargetSchema> {
  if (target.kind === "browser-target" || target.kind === "device-browser-target") return target
  return target.target
}

export type CapturePolicyDigestInput = {
  readonly clip: CaptureClip
  readonly fullPage: boolean
  readonly cursor: "include" | "exclude"
  readonly readinessPolicy: {
    readonly policyId: string
    readonly requiredSteps: readonly ReadinessPolicy["requiredSteps"][number][]
    readonly disabledSteps: readonly ReadinessPolicy["disabledSteps"][number][]
  }
  readonly output: CaptureOutputPolicy
}

export function capturePolicySha256(request: CapturePolicyDigestInput): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson({
    clip: request.clip,
    fullPage: request.fullPage,
    cursor: request.cursor,
    readinessPolicy: request.readinessPolicy,
    output: request.output,
  })).digest("hex")
}
