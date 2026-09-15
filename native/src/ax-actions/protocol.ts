import {
  axPressRequestSchema,
  axPressResultMatches,
  axPressResultSchema,
  contractErrorSchema,
  createNativeMutationRequestEnvelopeSchema,
  nativeOperationStatusSchema,
  nativeResponseBaseSchema,
  structurallyEqual,
  z,
} from "@meta/shared/contracts"

export const nativeAxPressRequestSchema = createNativeMutationRequestEnvelopeSchema(
  "ax.press",
  axPressRequestSchema,
).superRefine((request, context) => {
  const target = request.operation.target
  if (target.kind !== "window" && target.kind !== "surface") {
    context.addIssue({ code: "custom", path: ["operation", "target"], message: "AXPress требует exact window или surface parent" })
    return
  }
  const element = request.payload.element
  if (
    element.runtimeEpoch !== target.ref.runtimeEpoch
    || element.loginSessionId !== target.ref.loginSessionId
    || element.nativeGeneration !== target.ref.nativeGeneration
    || element.applicationRef !== target.ref.applicationRef
  ) {
    context.addIssue({ code: "custom", path: ["payload", "element"], message: "AX element принадлежит другому parent target или generation" })
  }
})

export const nativeAxPressResponseSchema = z.discriminatedUnion("ok", [
  nativeResponseBaseSchema.extend({
    ok: z.literal(true),
    result: z.strictObject({
      value: axPressResultSchema,
      status: nativeOperationStatusSchema,
    }),
  }).strict(),
  nativeResponseBaseSchema.extend({
    ok: z.literal(false),
    error: contractErrorSchema,
    nativeStatus: nativeOperationStatusSchema.optional(),
  }).strict(),
]).superRefine((response, context) => {
  if (!response.ok) {
    if (
      response.nativeStatus !== undefined
      && (
        response.nativeStatus.operationId !== response.operationId
        || response.nativeStatus.requestId !== response.requestId
        || response.nativeStatus.runtimeEpoch !== response.runtimeEpoch
        || response.nativeStatus.loginSessionId !== response.loginSessionId
        || response.nativeStatus.nativeGeneration !== response.nativeGeneration
      )
    ) {
      context.addIssue({ code: "custom", path: ["nativeStatus"], message: "AXPress failure status относится к другой operation" })
    }
    return
  }
  if (
    response.operationId !== response.result.status.operationId
    || response.requestId !== response.result.status.requestId
    || response.result.status.execution !== "finished"
    || response.result.status.dispatch !== "finished"
    || response.result.status.cleanup !== "complete"
    || response.result.status.targetVerified !== "verified"
    || response.result.status.dispatchAttempts < 1
    || response.result.status.quarantined
  ) {
    context.addIssue({ code: "custom", path: ["result", "status"], message: "AXPress success требует exact terminal native dispatch" })
  }
})

export type NativeAxPressRequest = z.infer<typeof nativeAxPressRequestSchema>
export type NativeAxPressResponse = z.infer<typeof nativeAxPressResponseSchema>

export function nativeAxPressResultMatches(
  request: NativeAxPressRequest,
  result: Extract<NativeAxPressResponse, { ok: true }>["result"],
): boolean {
  return result.status.operationId === request.operation.operationId
    && result.status.requestId === request.requestId
    && structurallyEqual(result.status.acceptedFence, request.operation.fence)
    && axPressResultMatches(request.payload, result.value)
}
