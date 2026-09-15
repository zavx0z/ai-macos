import { z } from "zod"
import { contractErrorSchema } from "./errors.ts"
import { fenceTokenSchema, generationIdSchema, nativeGenerationSchema, opaqueIdSchema } from "./identities.ts"
import { dispatchStateSchema, interferenceStateSchema, targetVerificationStateSchema, type AdapterControl } from "./operations.ts"
import { observerCoverageSchema } from "./observer.ts"
import { cleanupStateSchema } from "./resources.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const NATIVE_EXECUTION_STATES = [
  "idle",
  "dispatching",
  "cancelling",
  "cancelled",
  "finished",
  "failed",
  "interrupted-unknown",
  "quarantined",
] as const
export const nativeExecutionStateSchema = z.enum(NATIVE_EXECUTION_STATES)
export type NativeExecutionState = z.infer<typeof nativeExecutionStateSchema>

export const HELD_INPUT_KINDS = ["key", "button"] as const
export const heldInputKindSchema = z.enum(HELD_INPUT_KINDS)
export type HeldInputKind = z.infer<typeof heldInputKindSchema>

export const HELD_INPUT_STATES = [
  "pending-down",
  "confirmed-down",
  "pending-up",
  "released",
  "uncertain",
] as const
export const heldInputStateSchema = z.enum(HELD_INPUT_STATES)
export type HeldInputState = z.infer<typeof heldInputStateSchema>
export const HELD_INPUT_LEDGER_CANONICAL_VERSION = "1" as const

export const heldInputLedgerEntrySchema = z.strictObject({
  sequence: z.number().int().safe().min(1),
  kind: heldInputKindSchema,
  code: z.number().int().min(0).max(0xffffffff),
  state: heldInputStateSchema,
})
export type HeldInputLedgerEntry = z.infer<typeof heldInputLedgerEntrySchema>

export const heldInputLedgerSnapshotSchema = z.strictObject({
  canonicalVersion: z.literal(HELD_INPUT_LEDGER_CANONICAL_VERSION),
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  revision: z.number().int().safe().min(1),
  previousSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  entries: z.array(heldInputLedgerEntrySchema).max(512),
}).superRefine((snapshot, context) => {
  const sequences = snapshot.entries.map(entry => entry.sequence)
  if (new Set(sequences).size !== sequences.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "ledger sequence не должен повторяться" })
  }
  if (sequences.some((sequence, index) => index > 0 && sequence <= (sequences[index - 1] ?? 0))) {
    context.addIssue({ code: "custom", path: ["entries"], message: "ledger должен быть упорядочен по sequence" })
  }
  const active = snapshot.entries.filter(entry => entry.state !== "released")
  const heldKeys = active.map(entry => `${entry.kind}:${entry.code}`)
  if (new Set(heldKeys).size !== heldKeys.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "один held input не может иметь две active entries" })
  }
})
export type HeldInputLedgerSnapshot = z.infer<typeof heldInputLedgerSnapshotSchema>

export const heldInputLedgerAckSchema = z.strictObject({
  requestId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  revision: z.number().int().safe().min(1),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  persistedAt: isoTimestampSchema,
  durable: z.literal(true),
})
export type HeldInputLedgerAck = z.infer<typeof heldInputLedgerAckSchema>

export interface HeldInputLedgerSink {
  persist(requestId: string, snapshot: HeldInputLedgerSnapshot): Promise<HeldInputLedgerAck>
}

export const nativeOperationStatusSchema = z.strictObject({
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  highWaterFence: fenceTokenSchema.optional(),
  acceptedFence: fenceTokenSchema.optional(),
  operationId: opaqueIdSchema.optional(),
  execution: nativeExecutionStateSchema,
  dispatch: dispatchStateSchema,
  cleanup: cleanupStateSchema,
  targetVerified: targetVerificationStateSchema,
  cancellationRequested: z.boolean(),
  userInterference: interferenceStateSchema,
  restorationAllowed: z.boolean(),
  quarantined: z.boolean(),
  heldCount: z.number().int().min(0).max(512),
  lastCheckpoint: z.string().min(1).max(128).optional(),
  dispatchAttempts: z.number().int().safe().min(0),
  ledgerRevision: z.number().int().safe().min(0),
  observer: observerCoverageSchema,
  error: contractErrorSchema.optional(),
}).superRefine((status, context) => {
  const active = status.execution !== "idle"
  if (active && status.operationId === undefined) {
    context.addIssue({ code: "custom", path: ["operationId"], message: "active status требует operationId" })
  }
  if (!active && status.operationId !== undefined) {
    context.addIssue({ code: "custom", path: ["operationId"], message: "idle status не должен сохранять operationId" })
  }
  if (active && status.acceptedFence === undefined) {
    context.addIssue({ code: "custom", path: ["acceptedFence"], message: "active status требует accepted fence" })
  }
  if (active && status.highWaterFence === undefined) {
    context.addIssue({ code: "custom", path: ["highWaterFence"], message: "active status требует high-water fence" })
  }
  for (const [field, fence] of [["highWaterFence", status.highWaterFence], ["acceptedFence", status.acceptedFence]] as const) {
    if (fence !== undefined && (
      fence.runtimeEpoch !== status.runtimeEpoch
      || fence.loginSessionId !== status.loginSessionId
      || fence.nativeGeneration !== status.nativeGeneration
    )) {
      context.addIssue({ code: "custom", path: [field], message: "status fence принадлежит другому generation" })
    }
  }
  if (
    status.acceptedFence !== undefined
    && status.highWaterFence !== undefined
    && status.acceptedFence.counter > status.highWaterFence.counter
  ) {
    context.addIssue({ code: "custom", path: ["acceptedFence"], message: "accepted fence выше high-water fence" })
  }
  const staleAcceptedFence = status.acceptedFence !== undefined
    && status.highWaterFence !== undefined
    && status.acceptedFence.counter < status.highWaterFence.counter
  if (status.execution === "dispatching" && staleAcceptedFence) {
    context.addIssue({ code: "custom", path: ["acceptedFence"], message: "dispatching требует current high-water fence" })
  }
  if (staleAcceptedFence && status.restorationAllowed) {
    context.addIssue({ code: "custom", path: ["restorationAllowed"], message: "stale accepted fence запрещает restore" })
  }
  if (
    staleAcceptedFence
    && !["cancelling", "cancelled", "finished", "failed", "interrupted-unknown", "quarantined"].includes(status.execution)
  ) {
    context.addIssue({ code: "custom", path: ["execution"], message: "stale accepted fence допустим только при stop/reconciliation/terminal state" })
  }
  if (
    status.observer.runtimeEpoch !== status.runtimeEpoch
    || status.observer.loginSessionId !== status.loginSessionId
    || status.observer.nativeGeneration !== status.nativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["observer"], message: "observer coverage принадлежит другому generation" })
  }
  if (status.observer.state !== "ready" && status.userInterference !== "unknown") {
    context.addIssue({ code: "custom", path: ["userInterference"], message: "недоступный observer означает unknown interference" })
  }
  if (status.observer.state !== "ready" && status.restorationAllowed) {
    context.addIssue({ code: "custom", path: ["restorationAllowed"], message: "restore запрещён без ready observer" })
  }
  if (["interrupted-unknown", "quarantined"].includes(status.execution) && !status.quarantined) {
    context.addIssue({ code: "custom", path: ["quarantined"], message: "неизвестное native outcome требует quarantine" })
  }
  if (status.cleanup === "complete" && status.heldCount !== 0) {
    context.addIssue({ code: "custom", path: ["heldCount"], message: "complete cleanup требует heldCount=0" })
  }
  if (status.dispatch === "none" && status.dispatchAttempts !== 0) {
    context.addIssue({ code: "custom", path: ["dispatchAttempts"], message: "dispatch none требует ноль attempts" })
  }
  if (status.dispatch !== "none" && status.targetVerified !== "verified") {
    context.addIssue({ code: "custom", path: ["targetVerified"], message: "native dispatch требует verified target checkpoint" })
  }
  if (status.execution === "finished" && !["partial", "finished"].includes(status.dispatch)) {
    context.addIssue({ code: "custom", path: ["dispatch"], message: "finished native execution требует фактический dispatch" })
  }
})
export type NativeOperationStatus = z.infer<typeof nativeOperationStatusSchema>

export const nativeRecoveryLedgerStatusSchema = z.strictObject({
  recoveryId: opaqueIdSchema,
  sourceGeneration: nativeGenerationSchema,
  operationId: opaqueIdSchema,
  ledgerRevision: z.number().int().safe().min(0),
  heldCount: z.number().int().min(0).max(512),
  cleanup: cleanupStateSchema,
  quarantined: z.literal(true),
})
export type NativeRecoveryLedgerStatus = z.infer<typeof nativeRecoveryLedgerStatusSchema>

const nativeLifecycleRequestShape = {
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  deadlineAt: isoTimestampSchema,
}

export const nativeStatusRequestSchema = z.strictObject({
  ...nativeLifecycleRequestShape,
  operationId: opaqueIdSchema.optional(),
})
export type NativeStatusRequest = z.infer<typeof nativeStatusRequestSchema>

export const nativeHeartbeatRequestSchema = z.strictObject(nativeLifecycleRequestShape)
export type NativeHeartbeatRequest = z.infer<typeof nativeHeartbeatRequestSchema>

export const nativeHeartbeatAckSchema = z.strictObject({
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  accepted: z.boolean(),
  acknowledgedAt: isoTimestampSchema,
  quarantined: z.boolean(),
})
export type NativeHeartbeatAck = z.infer<typeof nativeHeartbeatAckSchema>

export const nativeCancelRequestSchema = z.strictObject({
  ...nativeLifecycleRequestShape,
  operationId: opaqueIdSchema,
  fence: fenceTokenSchema,
  reason: z.string().min(1).max(1_024),
}).superRefine((request, context) => {
  if (
    request.fence.runtimeEpoch !== request.runtimeEpoch
    || request.fence.loginSessionId !== request.loginSessionId
    || request.fence.nativeGeneration !== request.nativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["fence"], message: "cancel fence принадлежит другому generation" })
  }
})
export type NativeCancelRequest = z.infer<typeof nativeCancelRequestSchema>

export const nativeCancelAckSchema = z.strictObject({
  requestId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  fence: fenceTokenSchema,
  acknowledged: z.boolean(),
  stopped: z.boolean(),
  cleanup: cleanupStateSchema,
  ledgerRevision: z.number().int().safe().min(0),
  lastCheckpoint: z.string().min(1).max(128).optional(),
  quarantined: z.boolean(),
}).superRefine((ack, context) => {
  if (
    ack.fence.runtimeEpoch !== ack.runtimeEpoch
    || ack.fence.loginSessionId !== ack.loginSessionId
    || ack.fence.nativeGeneration !== ack.nativeGeneration
  ) {
    context.addIssue({ code: "custom", path: ["fence"], message: "cancel ACK fence принадлежит другому generation" })
  }
  if (ack.stopped && !ack.acknowledged) {
    context.addIssue({ code: "custom", path: ["stopped"], message: "stopped требует acknowledged" })
  }
  if (ack.cleanup !== "complete" && !ack.quarantined) {
    context.addIssue({ code: "custom", path: ["quarantined"], message: "неполный cleanup требует quarantine" })
  }
})
export type NativeCancelAck = z.infer<typeof nativeCancelAckSchema>

export const nativeDrainRequestSchema = z.strictObject(nativeLifecycleRequestShape)
export type NativeDrainRequest = z.infer<typeof nativeDrainRequestSchema>

export const nativeDrainAckSchema = z.strictObject({
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  accepted: z.boolean(),
  activeOperationIds: z.array(opaqueIdSchema).max(128),
  cleanup: cleanupStateSchema,
  quarantined: z.boolean(),
}).superRefine((ack, context) => {
  if (new Set(ack.activeOperationIds).size !== ack.activeOperationIds.length) {
    context.addIssue({ code: "custom", path: ["activeOperationIds"], message: "operation ID не должен повторяться" })
  }
  if (ack.cleanup !== "complete" && !ack.quarantined) {
    context.addIssue({ code: "custom", path: ["quarantined"], message: "неполный drain требует quarantine" })
  }
})
export type NativeDrainAck = z.infer<typeof nativeDrainAckSchema>

export const nativeCleanupControlSchema = z.strictObject({
  kind: z.literal("cleanup-only"),
  purpose: z.enum(["result", "status", "cancel", "release"]),
  requestId: opaqueIdSchema,
  cleanupRequestId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  acceptedFence: fenceTokenSchema,
  currentHighWaterFence: fenceTokenSchema,
  deadlineAt: isoTimestampSchema,
  expectedStatusRevision: z.number().int().safe().min(0),
  expectedDrainedEvidenceRef: opaqueIdSchema,
}).superRefine((control, context) => {
  for (const [field, fence] of [["acceptedFence", control.acceptedFence], ["currentHighWaterFence", control.currentHighWaterFence]] as const) {
    if (
      fence.runtimeEpoch !== control.runtimeEpoch
      || fence.loginSessionId !== control.loginSessionId
      || fence.nativeGeneration !== control.nativeGeneration
    ) {
      context.addIssue({ code: "custom", path: [field], message: "cleanup fence принадлежит другой generation" })
    }
  }
  if (control.acceptedFence.counter > control.currentHighWaterFence.counter) {
    context.addIssue({ code: "custom", path: ["acceptedFence"], message: "accepted fence выше current high-water" })
  }
})
export type NativeCleanupControl = z.infer<typeof nativeCleanupControlSchema>

export type NativeContinuationIssueRequest = {
  operationId: string
  taskRef: string
  purpose: NativeCleanupControl["purpose"]
  expectedRevision: number
  requestedDeadlineAt?: string
}

export type NativeContinuation = {
  control: AdapterControl
  cleanupControl: NativeCleanupControl
}

export interface NativeContinuationIssuer {
  issue(request: NativeContinuationIssueRequest): Promise<NativeContinuation>
}

export function createNativeCleanupRequestSchema<Payload extends z.ZodType>(payload: Payload) {
  return z.strictObject({
    control: nativeCleanupControlSchema,
    payload,
  })
}

export const nativeCleanupAckSchema = z.strictObject({
  kind: z.literal("cleanup-ack"),
  requestId: opaqueIdSchema,
  cleanupRequestId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  acceptedFence: fenceTokenSchema,
  currentHighWaterFence: fenceTokenSchema,
  statusRevision: z.number().int().safe().min(0),
  drainedEvidenceRef: opaqueIdSchema,
  terminalReceiptRef: opaqueIdSchema.optional(),
  cleanup: cleanupStateSchema,
  drained: z.boolean(),
  quarantined: z.boolean(),
}).superRefine((ack, context) => {
  if (ack.cleanup === "complete" && (!ack.drained || ack.terminalReceiptRef === undefined || ack.quarantined)) {
    context.addIssue({ code: "custom", message: "complete cleanup ACK требует drained terminal receipt без quarantine" })
  }
  if (ack.cleanup !== "complete" && !ack.quarantined) {
    context.addIssue({ code: "custom", path: ["quarantined"], message: "неполный cleanup ACK требует quarantine" })
  }
})
export type NativeCleanupAck = z.infer<typeof nativeCleanupAckSchema>

export function heldInputLedgerAckMatches(
  requestId: string,
  snapshot: HeldInputLedgerSnapshot,
  ack: HeldInputLedgerAck,
): boolean {
  return ack.durable
    && ack.requestId === requestId
    && ack.operationId === snapshot.operationId
    && ack.runtimeEpoch === snapshot.runtimeEpoch
    && ack.loginSessionId === snapshot.loginSessionId
    && ack.nativeGeneration === snapshot.nativeGeneration
    && ack.revision === snapshot.revision
    && ack.snapshotSha256 === heldInputLedgerDigest(snapshot)
}

export function nativeLifecycleAckMatches(
  request: NativeStatusRequest | NativeHeartbeatRequest | NativeCancelRequest | NativeDrainRequest,
  ack: NativeHeartbeatAck | NativeCancelAck | NativeDrainAck,
): boolean {
  return request.requestId === ack.requestId
    && request.runtimeEpoch === ack.runtimeEpoch
    && request.loginSessionId === ack.loginSessionId
    && request.nativeGeneration === ack.nativeGeneration
}

export function nativeStatusMatchesRequest(request: NativeStatusRequest, status: NativeOperationStatus): boolean {
  return request.requestId === status.requestId
    && request.runtimeEpoch === status.runtimeEpoch
    && request.loginSessionId === status.loginSessionId
    && request.nativeGeneration === status.nativeGeneration
    && request.operationId === status.operationId
}

export function nativeCleanupAckMatches(control: NativeCleanupControl, ack: NativeCleanupAck): boolean {
  return ack.requestId === control.requestId
    && ack.cleanupRequestId === control.cleanupRequestId
    && ack.operationId === control.operationId
    && ack.runtimeEpoch === control.runtimeEpoch
    && ack.loginSessionId === control.loginSessionId
    && ack.nativeGeneration === control.nativeGeneration
    && structurallyEqual(ack.acceptedFence, control.acceptedFence)
    && structurallyEqual(ack.currentHighWaterFence, control.currentHighWaterFence)
    && ack.statusRevision >= control.expectedStatusRevision
    && ack.drainedEvidenceRef === control.expectedDrainedEvidenceRef
}

export function nativeCancelAckMatches(request: NativeCancelRequest, ack: NativeCancelAck): boolean {
  return nativeLifecycleAckMatches(request, ack)
    && request.operationId === ack.operationId
    && structurallyEqual(request.fence, ack.fence)
}

export function nativeStatusMatchesOperation(
  operation: import("./operations.ts").NativeExecutionContext,
  status: NativeOperationStatus,
): boolean {
  return status.operationId === operation.operationId
    && status.runtimeEpoch === operation.runtimeEpoch
    && status.loginSessionId === operation.loginSessionId
    && status.nativeGeneration === operation.nativeGeneration
    && status.acceptedFence !== undefined
    && structurallyEqual(status.acceptedFence, operation.fence)
}

export function validateLedgerTransition(
  previous: HeldInputLedgerSnapshot,
  next: HeldInputLedgerSnapshot,
  previousAck: HeldInputLedgerAck,
): void {
  if (
    previous.operationId !== next.operationId
    || previous.runtimeEpoch !== next.runtimeEpoch
    || previous.loginSessionId !== next.loginSessionId
    || previous.nativeGeneration !== next.nativeGeneration
  ) {
    throw new Error("Ledger transition принадлежит другой operation/generation")
  }
  if (!heldInputLedgerAckMatches(previousAck.requestId, previous, previousAck)) {
    throw new Error("Previous ledger ACK не подтверждает canonical snapshot")
  }
  if (next.revision !== previous.revision + 1 || next.previousSnapshotSha256 !== previousAck.snapshotSha256) {
    throw new Error("Ledger transition нарушает revision/hash chain")
  }
  const allowed: Readonly<Record<HeldInputState, readonly HeldInputState[]>> = {
    "pending-down": ["pending-down", "confirmed-down", "uncertain"],
    "confirmed-down": ["confirmed-down", "pending-up", "uncertain"],
    "pending-up": ["pending-up", "released", "uncertain"],
    released: ["released"],
    uncertain: ["uncertain"],
  }
  const previousBySequence = new Map(previous.entries.map(entry => [entry.sequence, entry]))
  const previousMaximum = Math.max(0, ...previous.entries.map(entry => entry.sequence))
  for (const entry of next.entries) {
    const before = previousBySequence.get(entry.sequence)
    if (before === undefined) {
      if (entry.state !== "pending-down") throw new Error("Новая ledger entry должна начинаться с pending-down")
      if (entry.sequence <= previousMaximum) throw new Error("Новая ledger sequence должна быть выше previous high-water")
      continue
    }
    if (before.kind !== entry.kind || before.code !== entry.code || !allowed[before.state].includes(entry.state)) {
      throw new Error(`Недопустимый ledger transition для sequence ${entry.sequence}`)
    }
    previousBySequence.delete(entry.sequence)
  }
  if (previousBySequence.size > 0) throw new Error("Ledger transition потерял существующую entry")
}

export function heldInputLedgerCanonicalBytes(snapshot: HeldInputLedgerSnapshot): Uint8Array {
  const canonical = {
    canonicalVersion: snapshot.canonicalVersion,
    operationId: snapshot.operationId,
    runtimeEpoch: snapshot.runtimeEpoch,
    loginSessionId: snapshot.loginSessionId,
    nativeGeneration: snapshot.nativeGeneration,
    revision: snapshot.revision,
    previousSnapshotSha256: snapshot.previousSnapshotSha256 ?? null,
    entries: snapshot.entries.map(entry => ({
      sequence: entry.sequence,
      kind: entry.kind,
      code: entry.code,
      state: entry.state,
    })),
  }
  return new TextEncoder().encode(JSON.stringify(canonical))
}

export function heldInputLedgerDigest(snapshot: HeldInputLedgerSnapshot): string {
  return new Bun.CryptoHasher("sha256").update(heldInputLedgerCanonicalBytes(snapshot)).digest("hex")
}
