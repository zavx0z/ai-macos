import { capabilitySetSchema, generationIdSchema, opaqueIdSchema, z } from "@meta/shared/contracts"

const identity = {
  protocolVersion: z.literal("1"), requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
}
export const nativePermissionsRequestSchema = z.strictObject({
  ...identity, kind: z.literal("permissions"), deadlineAt: z.iso.datetime({ offset: true }),
})
export const nativePermissionsResponseSchema = z.strictObject({
  ...identity, kind: z.literal("permissions-response"), nativeBuildId: opaqueIdSchema,
  accessibility: z.boolean(), postEvents: z.boolean(), screenRecording: z.boolean(), inputMonitoring: z.boolean(),
  capabilities: capabilitySetSchema,
  codeIdentity: z.strictObject({
    helperPath: z.string().min(1).max(4096).startsWith("/"),
    cdhash: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  }).optional(),
}).superRefine((response, context) => {
  if (response.capabilities.scope !== "adapter" || response.capabilities.producerRef !== response.nativeGeneration) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Passive permission capabilities принадлежат другому Native producer" })
  }
})
export type NativePermissionsRequest = z.infer<typeof nativePermissionsRequestSchema>
export type NativePermissionsResponse = z.infer<typeof nativePermissionsResponseSchema>

export function nativePermissionsResponseMatches(request: NativePermissionsRequest, response: NativePermissionsResponse, loadedBuildId: string): boolean {
  return request.protocolVersion === response.protocolVersion && request.requestId === response.requestId
    && request.runtimeEpoch === response.runtimeEpoch && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration && response.nativeBuildId === loadedBuildId
}
