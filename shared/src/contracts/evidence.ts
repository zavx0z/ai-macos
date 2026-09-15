import { z } from "zod"
import {
  displayRefSchema,
  applicationRefSchema,
  applicationBundleRefSchema,
  surfaceRefSchema,
  fenceTokenSchema,
  generationIdSchema,
  nativeOperationTargetSchema,
  opaqueIdSchema,
  windowRefSchema,
} from "./identities.ts"
import {
  type NativeExecutionContext,
  type ObservationRef,
} from "./operations.ts"
import {
  interactionPointProofSchema,
  pointSchema,
  proofRefSchema,
  type InteractionPointProof,
  type Point,
  type ProofRef,
} from "./observations.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const nativeDisplayMappingSchema = z.strictObject({
  nativeDisplayId: z.number().int().min(1).max(0xffffffff),
  ref: displayRefSchema,
})
export type NativeDisplayMapping = z.infer<typeof nativeDisplayMappingSchema>

export const nativeTargetMappingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("display"), display: nativeDisplayMappingSchema }),
  z.strictObject({
    kind: z.literal("window"),
    cgWindowId: z.number().int().min(1).max(0xffffffff),
    ownerPid: z.number().int().min(1).max(0x7fffffff),
    displays: z.array(nativeDisplayMappingSchema).min(1).max(64),
  }),
  z.strictObject({ kind: z.literal("desktop-layout"), displays: z.array(nativeDisplayMappingSchema).min(1).max(64) }),
])
export type NativeTargetMapping = z.infer<typeof nativeTargetMappingSchema>

const nativeEvidenceCommonShape = {
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: isoTimestampSchema,
}

export const nativeEvidenceReportSchema = z.discriminatedUnion("factKind", [
  z.strictObject({
    factKind: z.literal("application-bundle-identity"),
    ...nativeEvidenceCommonShape,
    target: z.strictObject({ kind: z.literal("application-bundle"), ref: applicationBundleRefSchema }),
  }),
  z.strictObject({
    factKind: z.literal("native-target-identity"),
    ...nativeEvidenceCommonShape,
    process: applicationRefSchema,
    target: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("application"), ref: applicationRefSchema }),
      z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
      z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
    ]),
  }),
  z.strictObject({
    factKind: z.literal("target-resolution"),
    ...nativeEvidenceCommonShape,
    target: nativeOperationTargetSchema,
    mapping: nativeTargetMappingSchema,
  }),
  z.strictObject({
    factKind: z.literal("window-cg-ax-correlation"),
    ...nativeEvidenceCommonShape,
    target: z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
    mapping: z.strictObject({
      kind: z.literal("window"),
      cgWindowId: z.number().int().min(1).max(0xffffffff),
      ownerPid: z.number().int().min(1).max(0x7fffffff),
      displays: z.array(nativeDisplayMappingSchema).min(1).max(64),
    }),
    corroboration: z.strictObject({
      axSnapshotRef: opaqueIdSchema,
      cgInventoryRef: opaqueIdSchema,
    }),
  }),
  z.strictObject({
    factKind: z.literal("frame"),
    ...nativeEvidenceCommonShape,
    observationId: opaqueIdSchema,
    frameRef: opaqueIdSchema,
    captureTarget: nativeOperationTargetSchema,
    frameSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    factKind: z.literal("point-hit"),
    ...nativeEvidenceCommonShape,
    observationId: opaqueIdSchema,
    frameRef: opaqueIdSchema,
    regionIndex: z.number().int().safe().min(0).max(63),
    imagePoint: pointSchema,
    interactionTarget: nativeOperationTargetSchema,
    expectedSpace: z.literal("macos-screen"),
  }),
  z.strictObject({
    factKind: z.literal("capture-task-start"),
    ...nativeEvidenceCommonShape,
    operationId: opaqueIdSchema,
    taskRef: opaqueIdSchema,
    acceptedFence: fenceTokenSchema,
    statusRevision: z.number().int().safe().min(0),
    statusEvidenceRef: opaqueIdSchema,
  }),
  z.strictObject({
    factKind: z.literal("capture-task-terminal"),
    ...nativeEvidenceCommonShape,
    operationId: opaqueIdSchema,
    taskRef: opaqueIdSchema,
    acceptedFence: fenceTokenSchema,
    statusRevision: z.number().int().safe().min(0),
    drainedEvidenceRef: opaqueIdSchema,
    terminalReceiptRef: opaqueIdSchema.optional(),
    cleanup: z.enum(["complete", "incomplete", "unknown"]),
    drained: z.boolean(),
  }),
  z.strictObject({
    factKind: z.literal("capture-task-status"),
    ...nativeEvidenceCommonShape,
    operationId: opaqueIdSchema,
    taskRef: opaqueIdSchema,
    acceptedFence: fenceTokenSchema,
    statusRevision: z.number().int().safe().min(0),
    statusEvidenceRef: opaqueIdSchema,
    cleanup: z.enum(["complete", "incomplete", "unknown"]),
    drained: z.boolean(),
  }),
]).superRefine((report, context) => {
  if (report.factKind === "native-target-identity") {
    const target = report.target.ref
    const process = report.process
    if (target.runtimeEpoch !== process.runtimeEpoch || target.loginSessionId !== process.loginSessionId
      || target.nativeGeneration !== process.nativeGeneration || target.applicationRef !== process.applicationRef
      || (report.target.kind === "application" && !structurallyEqual(report.target.ref, process))) {
      context.addIssue({ code: "custom", path: ["target"], message: "Native target не принадлежит подтверждённому process incarnation" })
    }
  }
  if (report.factKind === "target-resolution" && report.mapping.kind === "window") {
    context.addIssue({ code: "custom", path: ["mapping"], message: "window mapping требует window-cg-ax-correlation facts" })
  }
  if (report.factKind === "capture-task-terminal") {
    if (report.cleanup === "complete" && (!report.drained || report.terminalReceiptRef === undefined)) {
      context.addIssue({ code: "custom", message: "complete terminal task facts требуют drained receipt" })
    }
    if (report.cleanup !== "complete" && report.terminalReceiptRef !== undefined) {
      context.addIssue({ code: "custom", path: ["terminalReceiptRef"], message: "неcomplete task не выдаёт terminal receipt" })
    }
  }
})
export type NativeEvidenceReport = z.infer<typeof nativeEvidenceReportSchema>

export const verifiedNativeEvidenceReceiptSchema = z.strictObject({
  evidenceReceiptId: opaqueIdSchema,
  adapterInstanceRef: opaqueIdSchema,
  backendBuildId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  sourceResponseRef: opaqueIdSchema,
  sourceResponseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  observedAt: isoTimestampSchema,
  factKind: z.enum([
    "application-bundle-identity",
    "native-target-identity",
    "target-resolution",
    "window-cg-ax-correlation",
    "frame",
    "point-hit",
    "capture-task-start",
    "capture-task-terminal",
    "capture-task-status",
  ]),
  factSha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: isoTimestampSchema,
})
export type VerifiedNativeEvidenceReceipt = z.infer<typeof verifiedNativeEvidenceReceiptSchema>

export interface BoundNativeEvidencePublisher {
  publish(report: NativeEvidenceReport): Promise<VerifiedNativeEvidenceReceipt>
}

export interface EvidenceIssuer {
  issueTargetResolution(request: {
    receipt: VerifiedNativeEvidenceReceipt
    target: z.infer<typeof nativeOperationTargetSchema>
    nativeMapping?: NativeTargetMapping
  }): Promise<ProofRef>

  issueWindowCorrelation(request: {
    receipt: VerifiedNativeEvidenceReceipt
    target: { kind: "window", ref: z.infer<typeof windowRefSchema> }
    nativeMapping: Extract<NativeTargetMapping, { kind: "window" }>
  }): Promise<ProofRef>

  issueFrameFreshness(request: {
    receipt: VerifiedNativeEvidenceReceipt
    observationId: string
    frameRef: string
    captureTarget: z.infer<typeof nativeOperationTargetSchema>
    frameSha256: string
  }): Promise<ProofRef>

  issueInteractionPoint(request: {
    operation: NativeExecutionContext
    receipt: VerifiedNativeEvidenceReceipt
    observationRef: ObservationRef
    interactionTarget: z.infer<typeof nativeOperationTargetSchema>
    imagePoint: Point
    expectedSpace: "macos-screen"
  }): Promise<InteractionPointProof>
}

export interface NativeContinuationRegistrar {
  registerAcceptedTask(request: {
    receipt: VerifiedNativeEvidenceReceipt
    operationId: string
    taskRef: string
    resourceLeaseId: string
    acceptedFence: z.infer<typeof fenceTokenSchema>
    statusRevision: number
    statusEvidenceRef: string
  }): Promise<void>

  advanceVerifiedStatus(request: {
    receipt: VerifiedNativeEvidenceReceipt
    operationId: string
    taskRef: string
    acceptedFence: z.infer<typeof fenceTokenSchema>
    statusRevision: number
    statusEvidenceRef: string
    cleanup: "complete" | "incomplete" | "unknown"
    drained: boolean
  }): Promise<void>

  markVerifiedTerminal(request: {
    receipt: VerifiedNativeEvidenceReceipt
    operationId: string
    taskRef: string
    acceptedFence: z.infer<typeof fenceTokenSchema>
    statusRevision: number
    drainedEvidenceRef: string
    terminalReceiptRef: string
  }): Promise<void>
}

export function evidenceReportMatchesReceipt(
  report: NativeEvidenceReport,
  receipt: VerifiedNativeEvidenceReceipt,
): boolean {
  return report.factKind === receipt.factKind
    && report.sourceResponseRef === receipt.sourceResponseRef
    && report.inventoryId === receipt.inventoryId
    && report.inventoryRevision === receipt.inventoryRevision
    && report.displayLayoutRevision === receipt.displayLayoutRevision
    && report.observedAt === receipt.observedAt
}
