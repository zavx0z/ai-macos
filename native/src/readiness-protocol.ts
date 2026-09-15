import { createNativeMutationRequestEnvelopeSchema, createNativeResponseEnvelopeSchema, displayRefSchema,
  inputReadinessDiagnosticFields, inputReadinessDiagnosticsSchema, nativeOperationStatusSchema,
  opaqueIdSchema, pointSchema, structurallyEqual, z } from "@meta/shared/contracts"

export const nativeInputReadinessRequestSchema = createNativeMutationRequestEnvelopeSchema("input.readiness", z.strictObject({
  expectedDisplayRef: displayRefSchema,
})).superRefine((request, context) => {
  if (request.operation.target.kind !== "display" || !structurallyEqual(request.operation.target.ref, request.payload.expectedDisplayRef)) {
    context.addIssue({ code: "custom", message: "Active readiness требует exact display target той же operation" })
  }
})

export const nativeInputReadinessResultSchema = z.strictObject({
  ...inputReadinessDiagnosticFields,
  operationId: opaqueIdSchema, expectedDisplayRef: displayRefSchema,
  inputReady: z.boolean(),
  originalCursor: pointSchema.optional(), probeCursor: pointSchema.optional(), resolvedDisplayRef: displayRefSchema.optional(),
  reason: z.string().min(1).max(1024).optional(),
}).superRefine((result, context) => {
  if (result.inputReady && (result.quarantined || result.dispatch !== "finished" || result.cleanup !== "complete"
    || result.interference !== "none-observed" || result.restoration !== "restored" || result.reason !== undefined
    || !result.movePosted || !result.moveObserved || !result.moveReadbackConfirmed || !result.restorePosted || !result.restoreObserved || !result.restoreReadbackConfirmed
    || result.originalCursor === undefined || result.probeCursor === undefined || !structurallyEqual(result.resolvedDisplayRef, result.expectedDisplayRef))) {
    context.addIssue({ code: "custom", message: "Ready требует подтверждённый own move/readback/restore без interference и unknown cleanup" })
  }
  if (!result.inputReady) {
    const diagnostics = inputReadinessDiagnosticsSchema.safeParse({
      probe: result.probe,
      inputReady: false,
      quarantined: result.quarantined,
      movePosted: result.movePosted,
      moveObserved: result.moveObserved,
      moveReadbackConfirmed: result.moveReadbackConfirmed,
      restorePosted: result.restorePosted,
      restoreObserved: result.restoreObserved,
      restoreReadbackConfirmed: result.restoreReadbackConfirmed,
      dispatch: result.dispatch,
      cleanup: result.cleanup,
      interference: result.interference,
      restoration: result.restoration,
      reason: result.reason,
    })
    if (!diagnostics.success) {
      context.addIssue({ code: "custom", message: "Not-ready diagnostics не соответствует bounded error context" })
    }
  }
})

export const nativeInputReadinessResponseSchema = createNativeResponseEnvelopeSchema(z.strictObject({
  value: nativeInputReadinessResultSchema, status: nativeOperationStatusSchema,
})).superRefine((response, context) => {
  if (!response.ok) return
  const { value, status } = response.result
  if (value.operationId !== response.operationId || status.operationId !== value.operationId || status.requestId !== response.requestId) {
    context.addIssue({ code: "custom", message: "Readiness result/status относятся к другой operation/request" })
  }
  if (value.inputReady && (status.execution !== "finished" || status.cleanup !== "complete" || status.quarantined || status.observer.state !== "ready")) {
    context.addIssue({ code: "custom", message: "Readiness не завершена current executor/observer" })
  }
})
export type NativeInputReadinessRequest = z.infer<typeof nativeInputReadinessRequestSchema>
export type NativeInputReadinessResult = z.infer<typeof nativeInputReadinessResultSchema>
export type NativeInputReadinessResponse = z.infer<typeof nativeInputReadinessResponseSchema>

export function nativeInputReadinessResultMatches(request: NativeInputReadinessRequest,
  result: { value: NativeInputReadinessResult, status: z.infer<typeof nativeOperationStatusSchema> }): boolean {
  return result.value.operationId === request.operation.operationId && result.status.operationId === request.operation.operationId
    && result.status.requestId === request.requestId && structurallyEqual(result.value.expectedDisplayRef, request.payload.expectedDisplayRef)
    && structurallyEqual(result.status.acceptedFence, request.operation.fence)
}
