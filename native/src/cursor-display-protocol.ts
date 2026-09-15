import {
  createNativeReadRequestEnvelopeSchema,
  createNativeResponseEnvelopeSchema,
  displayRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  pointSchema,
  z,
} from "@meta/shared/contracts"

const snapshotIdentity = {
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
}

/** Выбирает существующий display из exact inventory, не выдавая новый target proof. */
export const nativeCursorDisplayRequestSchema = createNativeReadRequestEnvelopeSchema(
  "input.cursor-display",
  z.strictObject(snapshotIdentity),
)

export const nativeCursorDisplayResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    runtimeEpoch: generationIdSchema,
    loginSessionId: generationIdSchema,
    nativeGeneration: generationIdSchema,
    ...snapshotIdentity,
    sourceResponseRef: opaqueIdSchema,
    observedAt: z.iso.datetime({ offset: true }),
    cursor: pointSchema,
    displayRef: displayRefSchema,
  }),
  z.strictObject({
    status: z.enum(["unavailable", "ambiguous", "stale-inventory"]),
    sourceResponseRef: opaqueIdSchema,
    reason: z.string().min(1).max(1024),
  }),
]).superRefine((result, context) => {
  if (result.status === "resolved" && (result.displayRef.displayLayoutRevision !== result.displayLayoutRevision
    || result.displayRef.runtimeEpoch !== result.runtimeEpoch || result.displayRef.loginSessionId !== result.loginSessionId
    || result.displayRef.nativeGeneration !== result.nativeGeneration)) {
    context.addIssue({ code: "custom", path: ["displayRef"], message: "Cursor display относится к другой topology revision" })
  }
})

export const nativeCursorDisplayResponseSchema = createNativeResponseEnvelopeSchema(nativeCursorDisplayResultSchema)
  .superRefine((response, context) => {
    if (response.operationId !== undefined) {
      context.addIssue({ code: "custom", path: ["operationId"], message: "Passive cursor resolver не создаёт operation" })
    }
    if (!response.ok || response.result.status !== "resolved") return
    const display = response.result.displayRef
    if (display.runtimeEpoch !== response.runtimeEpoch || display.loginSessionId !== response.loginSessionId
      || display.nativeGeneration !== response.nativeGeneration || response.result.runtimeEpoch !== response.runtimeEpoch
      || response.result.loginSessionId !== response.loginSessionId || response.result.nativeGeneration !== response.nativeGeneration) {
      context.addIssue({ code: "custom", path: ["result", "displayRef"], message: "Cursor display принадлежит другой native generation" })
    }
  })

export type NativeCursorDisplayRequest = z.infer<typeof nativeCursorDisplayRequestSchema>
export type NativeCursorDisplayResult = z.infer<typeof nativeCursorDisplayResultSchema>
export type NativeCursorDisplayResponse = z.infer<typeof nativeCursorDisplayResponseSchema>

export function nativeCursorDisplayResultMatches(request: NativeCursorDisplayRequest, result: NativeCursorDisplayResult): boolean {
  if (result.status !== "resolved") return true
  return result.inventoryId === request.payload.inventoryId
    && result.inventoryRevision === request.payload.inventoryRevision
    && result.displayLayoutRevision === request.payload.displayLayoutRevision
    && result.runtimeEpoch === request.runtimeEpoch && result.loginSessionId === request.loginSessionId
    && result.nativeGeneration === request.nativeGeneration
    && result.displayRef.runtimeEpoch === request.runtimeEpoch
    && result.displayRef.loginSessionId === request.loginSessionId
    && result.displayRef.nativeGeneration === request.nativeGeneration
    && Date.parse(result.observedAt) <= Date.parse(request.deadlineAt)
}
