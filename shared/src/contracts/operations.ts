import { z } from "zod"
import { contractErrorSchema } from "./errors.ts"
import {
  browserInstanceRefSchema,
  browserTargetRefSchema,
  clipboardRefSchema,
  deviceBrowserInstanceRefSchema,
  deviceBrowserTargetRefSchema,
  deviceRefSchema,
  fenceTokenSchema,
  generationIdSchema,
  nativeOperationTargetSchema,
  opaqueIdSchema,
  operationTargetSchema,
  sameRuntimeGeneration,
} from "./identities.ts"
import {
  cleanupCoversExactHandles,
  cleanupOutcomeSchema,
  runtimeResourceHandleSchema,
  type CleanupAuthority,
  type CleanupAuthorityReceipt,
} from "./resources.ts"
import { isoTimestampSchema } from "./schema.ts"
import { nativeRecoveryStateSchema } from "./recovery-domain.ts"

export const runtimeClientSessionSchema = z.strictObject({
  clientSessionId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  authenticationGeneration: generationIdSchema,
  authenticatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
}).superRefine((session, context) => {
  if (Date.parse(session.expiresAt) <= Date.parse(session.authenticatedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "session expiry должен быть позже authentication" })
  }
})
export type RuntimeClientSession = z.infer<typeof runtimeClientSessionSchema>

export const observationRefSchema = z.strictObject({
  observationId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  displayLayoutRevision: z.number().int().safe().min(0),
  proofRef: opaqueIdSchema,
})
export type ObservationRef = z.infer<typeof observationRefSchema>

export const targetPreconditionSchema = z.strictObject({
  target: operationTargetSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  observationRef: observationRefSchema.optional(),
}).superRefine((precondition, context) => {
  if (
    precondition.observationRef !== undefined
    && precondition.observationRef.inventoryRevision !== precondition.inventoryRevision
  ) {
    context.addIssue({
      code: "custom",
      path: ["observationRef", "inventoryRevision"],
      message: "observation и target должны ссылаться на одну inventory revision",
    })
  }
})
export type TargetPrecondition = z.infer<typeof targetPreconditionSchema>

const commonOperationContextShape = {
  operationId: opaqueIdSchema,
  clientRequestId: opaqueIdSchema,
  clientSessionId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  observationRef: observationRefSchema.optional(),
  deadlineAt: isoTimestampSchema,
}

const nativeExecutionContextBaseSchema = z.strictObject({
  kind: z.literal("native"),
  ...commonOperationContextShape,
  target: nativeOperationTargetSchema,
  nativeGeneration: generationIdSchema,
  fence: fenceTokenSchema,
})

export const nativeExecutionContextSchema = nativeExecutionContextBaseSchema.superRefine((operation, context) => {
  if (
    operation.fence.runtimeEpoch !== operation.runtimeEpoch
    || operation.fence.loginSessionId !== operation.loginSessionId
    || operation.fence.nativeGeneration !== operation.nativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["fence"], message: "fence не совпадает с operation generations" })
  }
  if (
    operation.target.ref.runtimeEpoch !== operation.runtimeEpoch
    || operation.target.ref.loginSessionId !== operation.loginSessionId
    || operation.target.ref.nativeGeneration !== operation.nativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["target"], message: "native target принадлежит другому generation" })
  }
  if (operation.observationRef !== undefined && operation.observationRef.inventoryRevision !== operation.inventoryRevision) {
    context.addIssue({ code: "custom", path: ["observationRef"], message: "observation revision не совпадает с operation" })
  }
})
export type NativeExecutionContext = z.infer<typeof nativeExecutionContextSchema>

export const browserExecutionContextSchema = z.strictObject({
  kind: z.literal("browser"),
  ...commonOperationContextShape,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("browser-instance"), ref: browserInstanceRefSchema }),
    z.strictObject({ kind: z.literal("browser-target"), ref: browserTargetRefSchema }),
  ]),
}).superRefine(assertContextTargetGeneration)
export type BrowserExecutionContext = z.infer<typeof browserExecutionContextSchema>

export const deviceExecutionContextSchema = z.strictObject({
  kind: z.literal("device"),
  ...commonOperationContextShape,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("device"), ref: deviceRefSchema }),
    z.strictObject({ kind: z.literal("device-browser-instance"), ref: deviceBrowserInstanceRefSchema }),
    z.strictObject({ kind: z.literal("device-browser-target"), ref: deviceBrowserTargetRefSchema }),
  ]),
}).superRefine(assertContextTargetGeneration)
export type DeviceExecutionContext = z.infer<typeof deviceExecutionContextSchema>

export const clipboardExecutionContextSchema = z.strictObject({
  kind: z.literal("clipboard"),
  ...commonOperationContextShape,
  target: z.strictObject({ kind: z.literal("clipboard"), ref: clipboardRefSchema }),
}).superRefine(assertContextTargetGeneration)
export type ClipboardExecutionContext = z.infer<typeof clipboardExecutionContextSchema>

function assertContextTargetGeneration(
  operation: {
    runtimeEpoch: string
    loginSessionId: string
    target: { ref: { runtimeEpoch: string, loginSessionId: string } }
    observationRef?: ObservationRef
    inventoryRevision: number
  },
  context: z.RefinementCtx,
): void {
  if (!sameRuntimeGeneration(operation, operation.target.ref)) {
    context.addIssue({ code: "custom", path: ["target"], message: "target принадлежит другой runtime/login generation" })
  }
  if (operation.observationRef !== undefined && operation.observationRef.inventoryRevision !== operation.inventoryRevision) {
    context.addIssue({ code: "custom", path: ["observationRef"], message: "observation revision не совпадает с operation" })
  }
}

export const serializableOperationContextSchema = z.discriminatedUnion("kind", [
  nativeExecutionContextSchema,
  browserExecutionContextSchema,
  deviceExecutionContextSchema,
  clipboardExecutionContextSchema,
])
export type SerializableOperationContext = z.infer<typeof serializableOperationContextSchema>

export const OPERATION_STATES = [
  "registered",
  "rejected",
  "dispatching",
  "observing",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
  "interrupted-unknown",
] as const
export const operationStateSchema = z.enum(OPERATION_STATES)
export type OperationState = z.infer<typeof operationStateSchema>

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  "rejected",
  "completed",
  "cancelled",
  "failed",
  "interrupted-unknown",
]

const operationTransitions: Readonly<Record<OperationState, readonly OperationState[]>> = {
  registered: ["rejected", "dispatching", "cancelling", "interrupted-unknown"],
  rejected: [],
  dispatching: ["observing", "cancelling", "failed", "interrupted-unknown"],
  observing: ["completed", "failed", "interrupted-unknown"],
  cancelling: ["cancelled", "failed", "interrupted-unknown"],
  completed: [],
  cancelled: [],
  failed: [],
  "interrupted-unknown": [],
}

export const dispatchStateSchema = z.enum(["none", "attempted", "partial", "finished", "unknown"])
export type DispatchState = z.infer<typeof dispatchStateSchema>
export const targetVerificationStateSchema = z.enum(["verified", "failed", "unknown"])
export type TargetVerificationState = z.infer<typeof targetVerificationStateSchema>
export const interferenceStateSchema = z.enum(["none-observed", "observed", "unknown"])
export type InterferenceState = z.infer<typeof interferenceStateSchema>
export const observationOutcomeStateSchema = z.enum(["available", "failed", "stale", "unavailable"])
export type ObservationOutcomeState = z.infer<typeof observationOutcomeStateSchema>
export const restorationStateSchema = z.enum([
  "restored",
  "kept-target",
  "skipped-external-change",
  "failed",
  "not-applicable",
  "unknown",
])
export type RestorationState = z.infer<typeof restorationStateSchema>

export const effectOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unverified"), proofRefs: z.tuple([]) }),
  z.strictObject({ state: z.literal("verified"), proofRefs: z.array(opaqueIdSchema).min(1).max(64) }),
])
export type EffectOutcome = z.infer<typeof effectOutcomeSchema>

export const operationOutcomeSchema = z.strictObject({
  dispatch: dispatchStateSchema,
  targetVerified: targetVerificationStateSchema,
  userInterference: interferenceStateSchema,
  observation: observationOutcomeStateSchema,
  effect: effectOutcomeSchema,
  cleanup: cleanupOutcomeSchema,
  restoration: restorationStateSchema,
  lastCheckpoint: z.string().min(1).max(128).optional(),
  dispatchAttempts: z.number().int().safe().min(0),
  ledgerRevision: z.number().int().safe().min(0).optional(),
})
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>

export const payloadReceiptSchema = z.strictObject({
  keyGeneration: generationIdSchema,
  hmacSha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type PayloadReceipt = z.infer<typeof payloadReceiptSchema>

export const operationRecordSchema = z.strictObject({
  clientSessionId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  intent: z.enum(["read", "mutation", "admin"]),
  context: serializableOperationContextSchema,
  state: operationStateSchema,
  outcome: operationOutcomeSchema,
  resources: z.array(runtimeResourceHandleSchema).max(16),
  payloadReceipt: payloadReceiptSchema,
  nativeRecovery: nativeRecoveryStateSchema.optional(),
  registeredAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  error: contractErrorSchema.optional(),
}).superRefine((record, context) => {
  if (record.nativeRecovery !== undefined) {
    if (record.context.kind !== "native" && record.context.kind !== "clipboard") {
      context.addIssue({ code: "custom", path: ["nativeRecovery"], message: "Native recovery gate требует native-backed context" })
    } else {
      const recovery = record.nativeRecovery
      const generation = recovery.phase === "not-authorized" ? recovery.nativeGeneration : recovery.grant.nativeGeneration
      if (record.context.kind === "native" && generation !== record.context.nativeGeneration || recovery.phase === "send-authorized" && (
        recovery.grant.operationId !== record.context.operationId || recovery.grant.runtimeEpoch !== record.context.runtimeEpoch
        || recovery.grant.loginSessionId !== record.context.loginSessionId)) {
        context.addIssue({ code: "custom", path: ["nativeRecovery"], message: "Native recovery gate принадлежит другой operation/generation" })
      }
    }
  }
  if (
    record.clientSessionId !== record.context.clientSessionId
    || record.principalId !== record.context.principalId
  ) {
    context.addIssue({ code: "custom", path: ["context"], message: "operation authority не совпадает с record" })
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.registeredAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt не может быть раньше registeredAt" })
  }
  if (record.state === "rejected" && record.outcome.dispatch !== "none") {
    context.addIssue({ code: "custom", path: ["outcome", "dispatch"], message: "rejected operation не отправляет side effect" })
  }
  if (record.state === "cancelled" && record.outcome.cleanup.state !== "complete") {
    context.addIssue({ code: "custom", path: ["outcome", "cleanup"], message: "cancelled требует подтверждённый cleanup" })
  }
  const terminal = TERMINAL_OPERATION_STATES.includes(record.state)
  if (terminal && record.outcome.cleanup.state === "pending") {
    context.addIssue({ code: "custom", path: ["outcome", "cleanup"], message: "terminal operation не может удерживать pending leases" })
  }
  if (!terminal && record.resources.length > 0 && record.outcome.cleanup.state !== "pending") {
    context.addIssue({ code: "custom", path: ["outcome", "cleanup"], message: "active operation должна явно удерживать pending leases" })
  }
  if (
    record.intent === "mutation"
    && record.state === "completed"
    && record.outcome.effect.state === "verified"
    && (
      record.outcome.targetVerified !== "verified"
      || !["partial", "finished"].includes(record.outcome.dispatch)
    )
  ) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "verified mutation требует verified target и фактический dispatch" })
  }
  const handleIds = record.resources.map(resource => resource.leaseId)
  if (new Set(handleIds).size !== handleIds.length) {
    context.addIssue({ code: "custom", path: ["resources"], message: "resource lease не должен повторяться" })
  }
  for (const resource of record.resources) {
    if (
      resource.operationId !== record.context.operationId
      || resource.clientSessionId !== record.clientSessionId
      || resource.principalId !== record.principalId
      || resource.runtimeEpoch !== record.context.runtimeEpoch
      || resource.loginSessionId !== record.context.loginSessionId
    ) {
      context.addIssue({ code: "custom", path: ["resources"], message: "resource handle принадлежит другой authority/operation" })
    }
  }
  if (!cleanupCoversExactHandles(record.resources, record.outcome.cleanup)) {
    context.addIssue({ code: "custom", path: ["outcome", "cleanup"], message: "cleanup не покрывает exact operation resources" })
  }
})
export type OperationRecord = z.infer<typeof operationRecordSchema>

export interface AdapterControl {
  readonly signal: AbortSignal
  checkpoint(stage: string): void | Promise<void>
}

export type OperationCheckpoint = AdapterControl

export type RuntimeOperationContext<TWire extends SerializableOperationContext = SerializableOperationContext> = {
  wire: TWire
  session: RuntimeClientSession
  control: AdapterControl
  resources: readonly z.infer<typeof runtimeResourceHandleSchema>[]
}

export function isTerminalOperationState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(state)
}

export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  return operationTransitions[from].includes(to)
}

export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!canTransitionOperation(from, to)) throw new Error(`Недопустимый переход операции: ${from} -> ${to}`)
}

export async function operationCanReleaseMutationLease(
  authority: CleanupAuthority,
  record: OperationRecord,
  receipt: CleanupAuthorityReceipt,
): Promise<boolean> {
  if (!isTerminalOperationState(record.state)) return false
  if (record.outcome.cleanup.state !== "complete") return false
  if (
    receipt.operationId !== record.context.operationId
    || receipt.runtimeEpoch !== record.context.runtimeEpoch
    || receipt.loginSessionId !== record.context.loginSessionId
    || receipt.leases.length !== record.resources.length
    || record.resources.some(handle => !receipt.leases.some(lease => {
      return lease.leaseId === handle.leaseId && lease.leaseGeneration === handle.leaseGeneration
    }))
  ) {
    return false
  }
  await authority.verify(receipt, record.resources)
  return true
}
