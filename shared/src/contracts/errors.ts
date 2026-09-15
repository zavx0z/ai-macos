import { z } from "zod"
import { capabilityIdSchema } from "./capabilities.ts"
import { opaqueIdSchema, operationTargetSchema } from "./identities.ts"

export const CONTRACT_ERROR_CODES = [
  "invalid-request",
  "protocol-version-mismatch",
  "backend-version-mismatch",
  "unauthorized",
  "payload-too-large",
  "deadline-exceeded",
  "target-stale",
  "target-ambiguous",
  "inventory-incomplete",
  "permission-denied",
  "user-interference",
  "observation-stale",
  "proof-invalid",
  "point-not-owned",
  "coordinate-space-mismatch",
  "space-transition-unavailable",
  "operation-in-progress",
  "operation-outcome-unknown",
  "cleanup-incomplete",
  "lease-revoked",
  "resource-quarantined",
  "unsupported-capability",
  "capability-unavailable",
  "request-payload-mismatch",
  "receipt-expired",
  "binary-frame-mismatch",
  "cancelled",
  "internal-error",
] as const

export const contractErrorCodeSchema = z.enum(CONTRACT_ERROR_CODES)
export type ContractErrorCode = z.infer<typeof contractErrorCodeSchema>

export const RECOVERY_ACTIONS = [
  "none",
  "retry-read-only",
  "inspect-health",
  "refresh-inventory",
  "capture-new-observation",
  "get-operation",
  "recover-input",
  "request-user-action",
  "apply-compatible-update",
] as const

export const recoveryActionSchema = z.enum(RECOVERY_ACTIONS)
export type RecoveryAction = z.infer<typeof recoveryActionSchema>

export const inputReadinessDiagnosticFields = {
  probe: z.literal("active-event"),
  quarantined: z.boolean(),
  movePosted: z.boolean(),
  moveObserved: z.boolean(),
  moveReadbackConfirmed: z.boolean(),
  restorePosted: z.boolean(),
  restoreObserved: z.boolean(),
  restoreReadbackConfirmed: z.boolean(),
  dispatch: z.enum(["none", "attempted", "partial", "finished", "unknown"]),
  cleanup: z.enum(["complete", "incomplete", "unknown"]),
  interference: z.enum(["none-observed", "observed", "unknown"]),
  restoration: z.enum([
    "not-attempted",
    "restored",
    "skipped-user-takeover",
    "failed",
    "unknown",
  ]),
} as const

export const inputReadinessDiagnosticsSchema = z.strictObject({
  ...inputReadinessDiagnosticFields,
  inputReady: z.literal(false),
  reason: z.string().min(1).max(1_024),
}).superRefine((diagnostics, context) => {
  if (
    diagnostics.moveObserved && !diagnostics.movePosted
    || diagnostics.moveReadbackConfirmed && !diagnostics.moveObserved
    || diagnostics.restorePosted && !diagnostics.movePosted
    || diagnostics.restoreObserved && !diagnostics.restorePosted
    || diagnostics.restoreReadbackConfirmed && !diagnostics.restoreObserved
  ) {
    context.addIssue({ code: "custom", message: "Readiness diagnostics содержит невозможный порядок этапов" })
  }
  if (
    diagnostics.restoration === "skipped-user-takeover"
    && diagnostics.interference !== "observed"
  ) {
    context.addIssue({ code: "custom", path: ["interference"], message: "Skipped restore требует observed interference" })
  }
})
export type InputReadinessDiagnostics = z.infer<typeof inputReadinessDiagnosticsSchema>

export const contractErrorContextSchema = z.strictObject({
  capabilityId: capabilityIdSchema.optional(),
  operationId: opaqueIdSchema.optional(),
  target: operationTargetSchema.optional(),
  resourceRef: opaqueIdSchema.optional(),
  checkpoint: z.string().min(1).max(128).optional(),
  inputReadiness: inputReadinessDiagnosticsSchema.optional(),
})
export type ContractErrorContext = z.infer<typeof contractErrorContextSchema>

export const contractErrorSchema = z.strictObject({
  code: contractErrorCodeSchema,
  message: z.string().min(1).max(2_048),
  stage: z.string().min(1).max(128),
  retryable: z.boolean(),
  replayAllowed: z.boolean(),
  recoveryAction: recoveryActionSchema,
  context: contractErrorContextSchema.optional(),
}).superRefine((error, context) => {
  if (
    [
      "operation-outcome-unknown",
      "cleanup-incomplete",
      "binary-frame-mismatch",
      "user-interference",
    ].includes(error.code)
    && error.replayAllowed
  ) {
    context.addIssue({ code: "custom", path: ["replayAllowed"], message: `${error.code} не разрешает автоматический replay` })
  }
})
export type ContractError = z.infer<typeof contractErrorSchema>
