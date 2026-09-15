import {
  applicationBundleResolutionSchema, applicationLaunchRequestSchema, applicationLaunchResultSchema,
  applicationQuitRequestSchema, applicationQuitResultSchema, applicationResolveRequestSchema,
  createNativeReadRequestEnvelopeSchema, createNativeMutationRequestEnvelopeSchema,
  createNativeResponseEnvelopeSchema, nativeOperationStatusSchema, z,
} from "@meta/shared/contracts"

export const nativeApplicationResolveRequestSchema = createNativeReadRequestEnvelopeSchema("application.resolve", applicationResolveRequestSchema)
export const nativeApplicationResolveResponseSchema = createNativeResponseEnvelopeSchema(applicationBundleResolutionSchema)
export const nativeApplicationLaunchRequestSchema = createNativeMutationRequestEnvelopeSchema("application.launch", applicationLaunchRequestSchema)
export const nativeApplicationLaunchResponseSchema = createNativeResponseEnvelopeSchema(z.strictObject({
  value: applicationLaunchResultSchema, status: nativeOperationStatusSchema,
}))
export const nativeApplicationQuitRequestSchema = createNativeMutationRequestEnvelopeSchema("application.quit", applicationQuitRequestSchema)
export const nativeApplicationQuitResponseSchema = createNativeResponseEnvelopeSchema(z.strictObject({
  value: applicationQuitResultSchema, status: nativeOperationStatusSchema,
}))
