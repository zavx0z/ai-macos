import { createNativeReadRequestEnvelopeSchema, createNativeResponseEnvelopeSchema, displayRefSchema, desktopLayoutRefSchema,
  nativeExecutionContextSchema, observationRefSchema, opaqueIdSchema, pointSchema, structurallyEqual, surfaceRefSchema, windowRefSchema, z } from "@meta/shared/contracts"

const windowTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
])
const displayTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
  z.strictObject({ kind: z.literal("desktop-layout"), ref: desktopLayoutRefSchema }),
])
const target = z.union([windowTarget, displayTarget])

export const nativeHitTestRequestSchema = createNativeReadRequestEnvelopeSchema("input.hit-test", z.strictObject({
  observationRef: observationRefSchema,
  frameRef: opaqueIdSchema,
  imagePoint: pointSchema,
  interactionTarget: target,
  expectedRegionIndex: z.number().int().min(0).max(63),
  expectedDestinationPoint: pointSchema,
})).safeExtend({ operation: nativeExecutionContextSchema }).superRefine((request, context) => {
  if (!structurallyEqual(request.operation.observationRef, request.payload.observationRef)
    || !structurallyEqual(request.operation.target, request.payload.interactionTarget)
    || request.operation.runtimeEpoch !== request.runtimeEpoch || request.operation.loginSessionId !== request.loginSessionId
    || request.operation.nativeGeneration !== request.nativeGeneration || request.operation.deadlineAt !== request.deadlineAt) {
    context.addIssue({ code: "custom", path: ["operation"], message: "Hit-test использует тот же operation/observation/target без нового fence" })
  }
})

const confirmed = { status: z.literal("confirmed"), sourceResponseRef: opaqueIdSchema, operationId: opaqueIdSchema,
    inventoryId: opaqueIdSchema, inventoryRevision: z.number().int().safe().min(0), displayLayoutRevision: z.number().int().safe().min(0),
    observedAt: z.iso.datetime({ offset: true }), observationId: opaqueIdSchema, frameRef: opaqueIdSchema,
    regionIndex: z.number().int().min(0).max(63), imagePoint: pointSchema, destinationPoint: pointSchema,
    space: z.strictObject({ kind: z.literal("macos-screen"), display: displayRefSchema }), frameTimestamp: z.iso.datetime({ offset: true }),
    topologyUnchanged: z.literal(true),
}
export const nativeHitTestResultSchema = z.union([
  z.strictObject({ ...confirmed, scope: z.literal("window"),
    // Публичный owner AX hit; дочерний AX element не получает выдуманный ElementRef.
    interactionTarget: windowTarget, hitOwnerTarget: windowTarget, focusedTarget: windowTarget,
    hitRelation: z.enum(["exact", "owned-descendant"]), focusRelation: z.literal("target"),
    frameUnchanged: z.literal(true),
  }),
  z.strictObject({ ...confirmed, scope: z.literal("display"), interactionTarget: displayTarget, hitOwnerTarget: displayTarget,
    hitRelation: z.literal("display-contained"), focusRelation: z.literal("not-required-display-focus") }),
  z.strictObject({ status: z.enum(["observation-stale", "inventory-stale", "target-mismatch", "focus-mismatch", "ax-unavailable", "cancelled"]),
    reason: z.string().min(1).max(1024) }),
]).superRefine((result, context) => {
  if (result.status !== "confirmed") return
  if (!structurallyEqual(result.interactionTarget, result.hitOwnerTarget)
    || (result.scope === "window" && !structurallyEqual(result.interactionTarget, result.focusedTarget))) {
    context.addIssue({ code: "custom", message: "Hit owner и focused target должны совпадать с exact interaction target" })
  }
  const reference = result.interactionTarget.ref
  if (reference.runtimeEpoch !== result.space.display.runtimeEpoch || reference.loginSessionId !== result.space.display.loginSessionId
    || reference.nativeGeneration !== result.space.display.nativeGeneration || result.displayLayoutRevision !== result.space.display.displayLayoutRevision
    || Date.parse(result.observedAt) < Date.parse(result.frameTimestamp)) {
    context.addIssue({ code: "custom", message: "Hit-test содержит foreign topology/generation или неверные timestamps" })
  }
})

export const nativeHitTestResponseSchema = createNativeResponseEnvelopeSchema(nativeHitTestResultSchema)
export type NativeHitTestRequest = z.infer<typeof nativeHitTestRequestSchema>
export type NativeHitTestResult = z.infer<typeof nativeHitTestResultSchema>
export type NativeHitTestResponse = z.infer<typeof nativeHitTestResponseSchema>

export function nativeHitTestResultMatches(request: NativeHitTestRequest, result: NativeHitTestResult): boolean {
  if (result.status !== "confirmed") return true
  return result.operationId === request.operation.operationId && result.inventoryId === request.operation.inventoryId
    && result.inventoryRevision === request.operation.inventoryRevision && result.displayLayoutRevision === request.payload.observationRef.displayLayoutRevision
    && result.observationId === request.payload.observationRef.observationId && result.frameRef === request.payload.frameRef
    && result.regionIndex === request.payload.expectedRegionIndex && structurallyEqual(result.imagePoint, request.payload.imagePoint)
    && structurallyEqual(result.destinationPoint, request.payload.expectedDestinationPoint)
    && structurallyEqual(result.interactionTarget, request.payload.interactionTarget)
}
