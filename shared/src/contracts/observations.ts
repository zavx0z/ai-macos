import { z } from "zod"
import {
  browserTargetRefSchema,
  deviceBrowserTargetRefSchema,
  displayRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  nativeOperationTargetSchema,
  operationTargetSchema,
  sameRuntimeGeneration,
  type OperationTarget,
} from "./identities.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"
import type { NativeExecutionContext, ObservationRef } from "./operations.ts"

export const pointSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
})
export type Point = z.infer<typeof pointSchema>

export const rectSchema = pointSchema.extend({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict()
export type Rect = z.infer<typeof rectSchema>

export const affineTransformSchema = z.strictObject({
  a: z.number().finite(),
  b: z.number().finite(),
  c: z.number().finite(),
  d: z.number().finite(),
  tx: z.number().finite(),
  ty: z.number().finite(),
}).refine(transform => Math.abs(transform.a * transform.d - transform.b * transform.c) >= Number.EPSILON, {
  message: "Affine transform не должен быть вырожденным",
})
export type AffineTransform = z.infer<typeof affineTransformSchema>

export const proofKindSchema = z.enum([
  "target-resolution",
  "pixel-ownership",
  "frame-freshness",
  "effect-readback",
  "cg-ax-correlation",
])

export const proofRefSchema = z.strictObject({
  proofRef: opaqueIdSchema,
  authorityRef: opaqueIdSchema,
  kind: proofKindSchema,
  subject: operationTargetSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema.optional(),
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  issuedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
}).superRefine((proof, context) => {
  if (!sameRuntimeGeneration(proof, proof.subject.ref)) {
    context.addIssue({ code: "custom", path: ["subject"], message: "proof subject принадлежит другой generation" })
  }
  if (Date.parse(proof.expiresAt) <= Date.parse(proof.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "proof expiry должен быть позже issue time" })
  }
})
export type ProofRef = z.infer<typeof proofRefSchema>

const evidenceBase = {
  claim: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  reason: z.string().min(1).max(1_024).optional(),
}

export const evidenceSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("confirmed"), ...evidenceBase, proof: proofRefSchema }),
  z.strictObject({
    state: z.literal("unconfirmed"),
    ...evidenceBase,
    confidence: z.number().finite().min(0).max(0.999999),
  }),
  z.strictObject({ state: z.literal("unknown"), ...evidenceBase, reason: z.string().min(1).max(1_024) }),
])
export type Evidence = z.infer<typeof evidenceSchema>

export const READINESS_STEP_NAMES = [
  "document-ready",
  "fonts",
  "network-idle",
  "images",
  "reflow-stable",
  "animations",
  "final-commit",
  "complete-frame",
  "permission",
  "target",
  "ownership",
] as const
export const readinessStepNameSchema = z.enum(READINESS_STEP_NAMES)
export type ReadinessStepName = z.infer<typeof readinessStepNameSchema>

export const readinessPolicySchema = z.strictObject({
  policyId: opaqueIdSchema,
  requiredSteps: z.array(readinessStepNameSchema).max(READINESS_STEP_NAMES.length),
  disabledSteps: z.array(readinessStepNameSchema).max(READINESS_STEP_NAMES.length),
}).superRefine((policy, context) => {
  if (new Set(policy.requiredSteps).size !== policy.requiredSteps.length) {
    context.addIssue({ code: "custom", path: ["requiredSteps"], message: "required step не должен повторяться" })
  }
  if (new Set(policy.disabledSteps).size !== policy.disabledSteps.length) {
    context.addIssue({ code: "custom", path: ["disabledSteps"], message: "disabled step не должен повторяться" })
  }
  if (policy.requiredSteps.some(step => policy.disabledSteps.includes(step))) {
    context.addIssue({ code: "custom", message: "readiness step не может быть одновременно required и disabled" })
  }
})
export type ReadinessPolicy = z.infer<typeof readinessPolicySchema>

const readinessStepBase = {
  name: readinessStepNameSchema,
  durationMs: z.number().finite().min(0),
}

export const readinessStepSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("reached"), ...readinessStepBase }),
  z.strictObject({ state: z.literal("skipped"), ...readinessStepBase, reason: z.literal("disabled-by-policy") }),
  z.strictObject({ state: z.literal("failed"), ...readinessStepBase, reason: z.string().min(1).max(1_024) }),
  z.strictObject({ state: z.literal("timed-out"), ...readinessStepBase, reason: z.string().min(1).max(1_024) }),
  z.strictObject({ state: z.literal("unavailable"), ...readinessStepBase, reason: z.string().min(1).max(1_024) }),
])
export type ReadinessStep = z.infer<typeof readinessStepSchema>

export const readinessResultSchema = z.strictObject({
  state: z.enum(["ready", "partial", "unavailable"]),
  policy: readinessPolicySchema,
  steps: z.array(readinessStepSchema).max(READINESS_STEP_NAMES.length),
  timedOut: z.boolean(),
}).superRefine((result, context) => {
  const names = result.steps.map(step => step.name)
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", path: ["steps"], message: "readiness step не должен повторяться" })
  }
  for (const required of result.policy.requiredSteps) {
    if (!names.includes(required)) context.addIssue({ code: "custom", path: ["steps"], message: `отсутствует required step ${required}` })
  }
  for (const step of result.steps) {
    if (step.state === "skipped" && !result.policy.disabledSteps.includes(step.name)) {
      context.addIssue({ code: "custom", path: ["steps"], message: `${step.name} skipped без disabled policy` })
    }
  }
  const requiredStates = result.policy.requiredSteps.map(name => result.steps.find(step => step.name === name)?.state)
  if (result.state === "ready" && requiredStates.some(state => state !== "reached")) {
    context.addIssue({ code: "custom", path: ["state"], message: "ready требует reached для каждого required step" })
  }
  if (result.state === "ready" && result.timedOut) {
    context.addIssue({ code: "custom", path: ["timedOut"], message: "ready несовместим с timeout" })
  }
  if (result.timedOut !== result.steps.some(step => step.state === "timed-out")) {
    context.addIssue({ code: "custom", path: ["timedOut"], message: "timedOut должен совпадать с timed-out step" })
  }
  if (result.state === "partial" && !result.steps.some(step => ["failed", "timed-out"].includes(step.state))) {
    context.addIssue({ code: "custom", path: ["state"], message: "partial требует failed или timed-out step" })
  }
  if (result.state === "unavailable" && !result.steps.some(step => step.state === "unavailable")) {
    context.addIssue({ code: "custom", path: ["state"], message: "unavailable требует unavailable step" })
  }
})
export type ReadinessResult = z.infer<typeof readinessResultSchema>

export const observationSpaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("macos-screen"), display: displayRefSchema }),
  z.strictObject({ kind: z.literal("browser-viewport"), target: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("device-browser-viewport"), target: deviceBrowserTargetRefSchema }),
])
export type ObservationSpace = z.infer<typeof observationSpaceSchema>

export const interactionPointProofSchema = z.strictObject({
  proof: proofRefSchema,
  observationId: opaqueIdSchema,
  frameRef: opaqueIdSchema,
  regionIndex: z.number().int().safe().min(0).max(63),
  space: observationSpaceSchema,
  coverage: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("point"), point: pointSchema, tolerancePx: z.number().finite().min(0).max(8) }),
    z.strictObject({ kind: z.literal("rect"), rect: rectSchema }),
  ]),
}).refine(value => value.proof.kind === "pixel-ownership", {
  path: ["proof", "kind"],
  message: "interaction proof должен иметь kind pixel-ownership",
})
export type InteractionPointProof = z.infer<typeof interactionPointProofSchema>

export const observationRegionSchema = z.strictObject({
  space: observationSpaceSchema,
  imageRect: rectSchema,
  destinationRect: rectSchema,
  imageToDestination: affineTransformSchema,
  frameTimestamp: isoTimestampSchema,
  frameStatus: z.enum(["complete", "stale", "unavailable"]),
}).superRefine((region, context) => {
  if (!transformMatchesRects(region.imageToDestination, region.imageRect, region.destinationRect, 1)) {
    context.addIssue({ code: "custom", path: ["imageToDestination"], message: "transform не соответствует bounds регионов" })
  }
})
export type ObservationRegion = z.infer<typeof observationRegionSchema>

export const observationImageSchema = z.strictObject({
  frameRef: opaqueIdSchema,
  widthPx: z.number().int().min(1).max(32_768),
  heightPx: z.number().int().min(1).max(32_768),
  mime: z.literal("image/png"),
  byteLength: z.number().int().min(1).max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(image => image.widthPx * image.heightPx <= 32_000_000, {
  message: "image превышает предел 32 мегапикселя",
})
export type ObservationImage = z.infer<typeof observationImageSchema>

export const observationSchema = z.strictObject({
  observationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema.optional(),
  captureTarget: operationTargetSchema,
  caption: z.string().min(1).max(2_048),
  backend: z.strictObject({ name: z.string().min(1).max(128), buildId: opaqueIdSchema }),
  capturedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  source: z.enum(["display-composite", "window-isolated", "browser-viewport", "device-browser-viewport"]),
  image: observationImageSchema,
  cursor: z.enum(["included", "excluded", "unknown"]),
  clip: rectSchema,
  captureEvidence: evidenceSchema,
  occlusion: evidenceSchema,
  readiness: readinessResultSchema,
  synchronization: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("single-frame") }),
    z.strictObject({ kind: z.literal("stitched"), maxSkewMs: z.number().finite().min(0) }),
  ]),
  regions: z.array(observationRegionSchema).min(1).max(64),
  unavailableReasons: z.array(z.string().min(1).max(1_024)).max(128),
}).superRefine((observation, context) => {
  if (!sameRuntimeGeneration(observation, observation.captureTarget.ref)) {
    context.addIssue({ code: "custom", path: ["captureTarget"], message: "observation capture target принадлежит другой generation" })
  }
  if (Date.parse(observation.expiresAt) <= Date.parse(observation.capturedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "observation expiry должен быть позже capture" })
  }
  if (!rectInside({ x: 0, y: 0, width: observation.image.widthPx, height: observation.image.heightPx }, observation.clip)) {
    context.addIssue({ code: "custom", path: ["clip"], message: "clip должен находиться внутри image" })
  }
  if (observation.regions.some(region => !rectInside(observation.clip, region.imageRect))) {
    context.addIssue({ code: "custom", path: ["regions"], message: "region imageRect должен находиться внутри clip" })
  }
  const nativeSource = observation.source === "display-composite" || observation.source === "window-isolated"
  if (nativeSource && observation.nativeGeneration === undefined) {
    context.addIssue({ code: "custom", path: ["nativeGeneration"], message: "native source требует native generation" })
  }
  const expectedSpace = nativeSource
    ? "macos-screen"
    : observation.source === "browser-viewport" ? "browser-viewport" : "device-browser-viewport"
  if (observation.regions.some(region => region.space.kind !== expectedSpace)) {
    context.addIssue({ code: "custom", path: ["regions"], message: "coordinate space не соответствует observation source" })
  }
  const targetKindMatches = nativeSource
    ? ["application", "window", "surface", "element", "display", "desktop-layout"].includes(observation.captureTarget.kind)
    : observation.source === "browser-viewport"
      ? observation.captureTarget.kind === "browser-target"
      : observation.captureTarget.kind === "device-browser-target"
  if (!targetKindMatches) {
    context.addIssue({ code: "custom", path: ["captureTarget"], message: "capture target domain не соответствует observation source" })
  }
  for (const region of observation.regions) {
    if (
      region.space.kind === "browser-viewport"
      && (observation.captureTarget.kind !== "browser-target" || !sameTarget(region.space.target, observation.captureTarget.ref))
    ) {
      context.addIssue({ code: "custom", path: ["regions"], message: "browser region принадлежит другому exact target" })
    }
    if (
      region.space.kind === "device-browser-viewport"
      && (observation.captureTarget.kind !== "device-browser-target" || !sameTarget(region.space.target, observation.captureTarget.ref))
    ) {
      context.addIssue({ code: "custom", path: ["regions"], message: "device region принадлежит другому exact target" })
    }
    if (
      region.space.kind === "macos-screen"
      && observation.nativeGeneration !== undefined
      && region.space.display.nativeGeneration !== observation.nativeGeneration
    ) {
      context.addIssue({ code: "custom", path: ["regions"], message: "display region принадлежит другой native generation" })
    }
  }
  if (observation.captureEvidence.state === "confirmed") {
    const proof = observation.captureEvidence.proof
    if (
      proof.kind !== "frame-freshness"
      || proof.proofRef === ""
      || proof.inventoryRevision !== observation.inventoryRevision
      || proof.displayLayoutRevision !== observation.displayLayoutRevision
      || !sameTarget(proof.subject, observation.captureTarget)
    ) {
      context.addIssue({ code: "custom", path: ["captureEvidence"], message: "capture proof не связан с observation" })
    }
  }
  const timestamps = observation.regions.map(region => Date.parse(region.frameTimestamp))
  const actualSkewMs = Math.max(...timestamps) - Math.min(...timestamps)
  if (observation.synchronization.kind === "single-frame" && actualSkewMs !== 0) {
    context.addIssue({ code: "custom", path: ["synchronization"], message: "single-frame regions должны иметь один timestamp" })
  }
  if (
    observation.synchronization.kind === "stitched"
    && (observation.regions.length < 2 || Math.abs(observation.synchronization.maxSkewMs - actualSkewMs) > 1)
  ) {
    context.addIssue({ code: "custom", path: ["synchronization"], message: "maxSkewMs должен быть выведен из region timestamps" })
  }
})
export type Observation = z.infer<typeof observationSchema>

export type MappedObservationPoint = {
  observationId: string
  captureTarget: OperationTarget
  regionIndex: number
  space: ObservationSpace
  imagePoint: Point
  destinationPoint: Point
  frameTimestamp: string
}

export type ObservationAuthorityContext = {
  expectedCaptureTarget: OperationTarget
  interactionTarget: OperationTarget
  interactionProof: InteractionPointProof
  expectedSpace: ObservationSpace["kind"]
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration?: string
  inventoryRevision: number
  displayLayoutRevision: number
  deadlineAt: string
  maxFrameAgeMs: number
  now: Date
}

export interface ProofAuthority {
  assertValid(proof: ProofRef, context: ObservationAuthorityContext): Promise<void>
}

export type ResolveObservationPointRequest = ObservationAuthorityContext & {
  observation: Observation
  imagePoint: Point
}

export type AuthorizedObservationPoint = MappedObservationPoint & {
  authorized: true
  interactionTarget: OperationTarget
  ownershipProofRef: string
}

export interface ObservationResolver {
  resolvePoint(request: ResolveStoredObservationPointRequest): Promise<AuthorizedObservationPoint>
}

export type ResolveStoredObservationPointRequest = {
  operation: NativeExecutionContext
  observationRef: ObservationRef
  interactionTarget: z.infer<typeof nativeOperationTargetSchema>
  imagePoint: Point
  expectedSpace: "macos-screen"
}

export const MAX_OBSERVATION_POINT_CAPTURE_AGE_MS = 120_000

export async function authorizeObservationPoint(
  proofs: ProofAuthority,
  request: ResolveObservationPointRequest,
): Promise<AuthorizedObservationPoint> {
  assertObservationFreshness(request.observation, request)
  const mapped = mapObservationPointGeometry(request.observation, request.imagePoint)
  if (mapped.space.kind !== request.expectedSpace) throw new Error("Observation point принадлежит другой coordinate space")
  const captureAgeLimit = Math.min(request.maxFrameAgeMs, MAX_OBSERVATION_POINT_CAPTURE_AGE_MS)
  if (!Number.isFinite(captureAgeLimit) || captureAgeLimit <= 0
    || Date.parse(mapped.frameTimestamp) < request.now.getTime() - captureAgeLimit) {
    throw new Error("Observation region старше разрешённого capture provenance age")
  }
  const ownership = interactionPointProofSchema.parse(request.interactionProof)
  if (
    ownership.observationId !== request.observation.observationId
    || ownership.frameRef !== request.observation.image.frameRef
    || ownership.regionIndex !== mapped.regionIndex
    || !sameTarget(ownership.space, mapped.space)
    || !sameTarget(ownership.proof.subject, request.interactionTarget)
    || !proofCoversPoint(ownership, request.imagePoint)
  ) {
    throw new Error("Interaction proof не связан с observation/frame/region/point/target")
  }
  if (
    request.now.getTime() >= Date.parse(ownership.proof.expiresAt)
    || Date.parse(ownership.proof.issuedAt) > request.now.getTime() + 1_000
  ) {
    throw new Error("Ownership proof истёк или выпущен в будущем")
  }
  await proofs.assertValid(ownership.proof, request)
  return {
    ...mapped,
    authorized: true,
    interactionTarget: request.interactionTarget,
    ownershipProofRef: ownership.proof.proofRef,
  }
}

export function applyAffineTransform(transform: AffineTransform, point: Point): Point {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.tx,
    y: transform.b * point.x + transform.d * point.y + transform.ty,
  }
}

export function invertAffineTransform(transform: AffineTransform): AffineTransform {
  const determinant = transform.a * transform.d - transform.b * transform.c
  if (Math.abs(determinant) < Number.EPSILON) throw new Error("Нельзя обратить вырожденное преобразование")
  return {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    tx: (transform.c * transform.ty - transform.d * transform.tx) / determinant,
    ty: (transform.b * transform.tx - transform.a * transform.ty) / determinant,
  }
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x
    && point.y >= rect.y
    && point.x < rect.x + rect.width
    && point.y < rect.y + rect.height
}

export function mapObservationPointGeometry(observation: Observation, imagePoint: Point): MappedObservationPoint {
  if (!rectContainsPoint(observation.clip, imagePoint)) throw new Error("Точка находится вне clip observation")
  const matching = observation.regions
    .map((region, regionIndex) => ({ region, regionIndex }))
    .filter(({ region }) => rectContainsPoint(region.imageRect, imagePoint))
  if (matching.length !== 1) throw new Error("Точка не принадлежит ровно одному observation region")
  const selected = matching[0]
  if (selected === undefined || selected.region.frameStatus !== "complete") {
    throw new Error("Observation region не содержит complete frame")
  }
  const destinationPoint = applyAffineTransform(selected.region.imageToDestination, imagePoint)
  if (!rectContainsPoint(selected.region.destinationRect, destinationPoint)) {
    throw new Error("Преобразованная точка находится вне destination region")
  }
  return {
    observationId: observation.observationId,
    captureTarget: observation.captureTarget,
    regionIndex: selected.regionIndex,
    space: selected.region.space,
    imagePoint,
    destinationPoint,
    frameTimestamp: selected.region.frameTimestamp,
  }
}

export function assertObservationFreshness(
  observation: Observation,
  authority: ObservationAuthorityContext,
  maxFutureSkewMs = 1_000,
): void {
  const nowMs = authority.now.getTime()
  if (nowMs >= Date.parse(observation.expiresAt) || nowMs >= Date.parse(authority.deadlineAt)) {
    throw new Error("Observation или operation deadline истёк")
  }
  if (
    observation.runtimeEpoch !== authority.runtimeEpoch
    || observation.loginSessionId !== authority.loginSessionId
    || observation.displayLayoutRevision !== authority.displayLayoutRevision
    || !sameTarget(observation.captureTarget, authority.expectedCaptureTarget)
  ) {
    throw new Error("Observation provenance не совпадает с generations/layout/target")
  }
  if (Date.parse(observation.capturedAt) > nowMs + maxFutureSkewMs) throw new Error("Observation capturedAt находится в будущем")
  if (authority.nativeGeneration !== undefined && observation.nativeGeneration !== authority.nativeGeneration) {
    throw new Error("Observation принадлежит другой native generation")
  }
  for (const region of observation.regions) {
    if (Date.parse(region.frameTimestamp) > nowMs + maxFutureSkewMs) throw new Error("Region timestamp находится в будущем")
  }
  if (observation.readiness.state !== "ready") throw new Error("Observation readiness не подтверждена")
}

function sameTarget(left: unknown, right: unknown): boolean {
  return structurallyEqual(left, right)
}

function proofCoversPoint(proof: InteractionPointProof, point: Point): boolean {
  if (proof.coverage.kind === "rect") return rectContainsPoint(proof.coverage.rect, point)
  return Math.hypot(proof.coverage.point.x - point.x, proof.coverage.point.y - point.y) <= proof.coverage.tolerancePx
}

function rectInside(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
}

function transformMatchesRects(
  transform: AffineTransform,
  source: Rect,
  destination: Rect,
  tolerance: number,
): boolean {
  const corners = [
    { x: source.x, y: source.y },
    { x: source.x + source.width, y: source.y },
    { x: source.x, y: source.y + source.height },
    { x: source.x + source.width, y: source.y + source.height },
  ].map(point => applyAffineTransform(transform, point))
  const bounds = {
    x: Math.min(...corners.map(point => point.x)),
    y: Math.min(...corners.map(point => point.y)),
    width: Math.max(...corners.map(point => point.x)) - Math.min(...corners.map(point => point.x)),
    height: Math.max(...corners.map(point => point.y)) - Math.min(...corners.map(point => point.y)),
  }
  return Math.abs(bounds.x - destination.x) <= tolerance
    && Math.abs(bounds.y - destination.y) <= tolerance
    && Math.abs(bounds.width - destination.width) <= tolerance
    && Math.abs(bounds.height - destination.height) <= tolerance
}
