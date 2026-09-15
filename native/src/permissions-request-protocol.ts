import { capabilitySetSchema, generationIdSchema, opaqueIdSchema, z } from "@meta/shared/contracts"

const identity = {
  protocolVersion: z.literal("1"), requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
}

export const nativePermissionsRequestCommandSchema = z.enum(["request-missing", "status"])
export const nativePermissionRequestStateSchema = z.enum([
  "not-requested", "not-needed", "queued", "requesting", "finished", "unsupported", "failed", "cancelled",
])

export const nativePermissionRequestStatusSchema = z.strictObject({
  beforeGranted: z.boolean(),
  currentGranted: z.boolean(),
  requestState: nativePermissionRequestStateSchema,
  promptRequested: z.boolean(),
  requestFinished: z.boolean(),
  requestReturnedGranted: z.boolean().optional(),
  restartNeeded: z.boolean(),
  restartState: z.enum(["not-required", "required", "unknown"]),
  restartReason: z.string().min(1).max(1024).optional(),
  error: z.string().min(1).max(1024).optional(),
}).superRefine((status, context) => {
  const requested = ["requesting", "finished", "failed"].includes(status.requestState)
  if (status.promptRequested !== requested) {
    context.addIssue({ code: "custom", path: ["promptRequested"], message: "Prompt flag не совпадает с состоянием official request" })
  }
  if (status.requestFinished !== ["finished", "failed"].includes(status.requestState)) {
    context.addIssue({ code: "custom", path: ["requestFinished"], message: "Request completion не совпадает с terminal request state" })
  }
  if ((status.requestState === "finished") !== (status.requestReturnedGranted !== undefined)) {
    context.addIssue({ code: "custom", path: ["requestReturnedGranted"], message: "SDK return допустим только для завершённого official request" })
  }
  if (["failed", "unsupported", "cancelled"].includes(status.requestState) !== (status.error !== undefined)) {
    context.addIssue({ code: "custom", path: ["error"], message: "Failed/unsupported/cancelled permission требует error" })
  }
  if (status.beforeGranted && status.requestState !== "not-needed") {
    context.addIssue({ code: "custom", message: "Изначально granted permission не должна запускать request" })
  }
  if (status.restartNeeded !== (status.restartState === "required")) {
    context.addIssue({ code: "custom", path: ["restartNeeded"], message: "Restart-needed true допустим только при доказанном required state" })
  }
  if ((status.restartState !== "not-required") !== (status.restartReason !== undefined)) {
    context.addIssue({ code: "custom", path: ["restartReason"], message: "Unknown/required restart state требует reason" })
  }
  if (status.currentGranted && status.restartState !== "not-required") {
    context.addIssue({ code: "custom", path: ["restartState"], message: "Текущий grant не требует restart" })
  }
})

const permissions = z.strictObject({
  accessibility: nativePermissionRequestStatusSchema,
  screenRecording: nativePermissionRequestStatusSchema,
  postEvents: nativePermissionRequestStatusSchema,
  inputMonitoring: nativePermissionRequestStatusSchema,
})

export const nativeStartupPermissionsRequestSchema = z.strictObject({
  ...identity,
  kind: z.literal("permissions-request"),
  command: nativePermissionsRequestCommandSchema,
  deadlineAt: z.iso.datetime({ offset: true }),
})

export const nativeStartupPermissionsResponseSchema = z.strictObject({
  ...identity,
  kind: z.literal("permissions-request-response"),
  command: nativePermissionsRequestCommandSchema,
  nativeBuildId: opaqueIdSchema,
  observedAt: z.iso.datetime({ offset: true }),
  requestsFinished: z.boolean(),
  allGranted: z.boolean(),
  restartNeeded: z.boolean(),
  restartState: z.enum(["not-required", "required", "unknown"]),
  permissions,
  capabilities: capabilitySetSchema,
}).superRefine((response, context) => {
  const values = Object.values(response.permissions)
  const terminal = values.every(value => ["not-needed", "finished", "unsupported", "failed", "cancelled"].includes(value.requestState))
  if (response.requestsFinished !== terminal) {
    context.addIssue({ code: "custom", path: ["requestsFinished"], message: "Top-level completion не совпадает с permission states" })
  }
  if (response.allGranted !== values.every(value => value.currentGranted)) {
    context.addIssue({ code: "custom", path: ["allGranted"], message: "All-granted требует все четыре текущих grant" })
  }
  const restartState = values.some(value => value.restartState === "required") ? "required"
    : values.some(value => value.restartState === "unknown") ? "unknown" : "not-required"
  if (response.restartNeeded !== (restartState === "required") || response.restartState !== restartState) {
    context.addIssue({ code: "custom", path: ["restartNeeded"], message: "Top-level restart-needed должен отражать permission states" })
  }
  if (response.capabilities.scope !== "adapter" || response.capabilities.producerRef !== response.nativeGeneration) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Permission capabilities принадлежат другому Native producer" })
  }
})

export type NativeStartupPermissionsRequest = z.infer<typeof nativeStartupPermissionsRequestSchema>
export type NativeStartupPermissionsResponse = z.infer<typeof nativeStartupPermissionsResponseSchema>

export function nativeStartupPermissionsResponseMatches(
  request: NativeStartupPermissionsRequest,
  response: NativeStartupPermissionsResponse,
  loadedBuildId: string,
): boolean {
  return request.protocolVersion === response.protocolVersion && request.requestId === response.requestId
    && request.runtimeEpoch === response.runtimeEpoch && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration && request.command === response.command
    && response.nativeBuildId === loadedBuildId
}
