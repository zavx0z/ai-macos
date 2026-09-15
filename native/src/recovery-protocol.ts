import {
  generationIdSchema, opaqueIdSchema, heldInputLedgerSnapshotSchema, heldInputLedgerAckSchema,
  heldInputLedgerAckMatches, heldInputLedgerDigest, z,
} from "@meta/shared/contracts"

const currentIdentity = {
  protocolVersion: z.literal("1"), requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
}
export const nativeHeldRecoveryRequestSchema = z.strictObject({
  ...currentIdentity, kind: z.literal("held-recovery"), deadlineAt: z.iso.datetime({ offset: true }),
  ledger: heldInputLedgerSnapshotSchema, ack: heldInputLedgerAckSchema,
}).superRefine((request, context) => {
  if (request.loginSessionId !== request.ledger.loginSessionId
    || !heldInputLedgerAckMatches(request.ack.requestId, request.ledger, request.ack)) context.addIssue({ code: "custom", message: "Recovery требует exact durable ledger ACK той же audit session" })
})
export const nativeHeldRecoveryResponseSchema = z.strictObject({
  ...currentIdentity, kind: z.literal("held-recovery-response"), nativeBuildId: opaqueIdSchema,
  oldOperationId: opaqueIdSchema, oldRuntimeEpoch: generationIdSchema, oldNativeGeneration: generationIdSchema,
  ledgerRevision: z.number().int().safe().min(1), ledgerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampledAt: z.iso.datetime({ offset: true }),
  inputMonitoring: z.boolean(), sessionState: z.enum(["active-console", "inactive", "unknown"]),
  lockState: z.enum(["unknown", "locked"]), secureInput: z.enum(["off", "on", "unknown"]),
  observerReady: z.boolean(), source: z.literal("cg-combined-session-state"),
  entries: z.array(z.strictObject({ sequence: z.number().int().safe().min(1), kind: z.enum(["key", "button"]),
    code: z.number().int().min(0).max(0xffffffff), observed: z.enum(["up", "held", "unknown"]) })).max(512),
  reason: z.string().min(1).max(1024).optional(),
})
export type NativeHeldRecoveryRequest = z.infer<typeof nativeHeldRecoveryRequestSchema>
export type NativeHeldRecoveryResponse = z.infer<typeof nativeHeldRecoveryResponseSchema>

export function nativeHeldRecoveryResponseMatches(request: NativeHeldRecoveryRequest, response: NativeHeldRecoveryResponse, loadedBuildId: string): boolean {
  return response.requestId === request.requestId && response.protocolVersion === request.protocolVersion
    && response.runtimeEpoch === request.runtimeEpoch && response.loginSessionId === request.loginSessionId
    && response.nativeGeneration === request.nativeGeneration && response.nativeBuildId === loadedBuildId
    && response.oldOperationId === request.ledger.operationId && response.oldRuntimeEpoch === request.ledger.runtimeEpoch
    && response.oldNativeGeneration === request.ledger.nativeGeneration && response.ledgerRevision === request.ledger.revision
    && response.ledgerSha256 === heldInputLedgerDigest(request.ledger)
}

/** Пассивное all-up подтверждение; не разрешает отправку key-up/button-up. */
export function verifyHeldRecoveryAllUp(request: NativeHeldRecoveryRequest, response: NativeHeldRecoveryResponse, loadedBuildId: string, now: Date): void {
  request = nativeHeldRecoveryRequestSchema.parse(request)
  response = nativeHeldRecoveryResponseSchema.parse(response)
  if (!nativeHeldRecoveryResponseMatches(request, response, loadedBuildId)) throw new Error("Held recovery identity/digest mismatch")
  const age = now.getTime() - Date.parse(response.sampledAt)
  if (!response.inputMonitoring || response.sessionState !== "active-console" || response.lockState === "locked"
    || response.secureInput !== "off" || !response.observerReady
    || age < -1000 || age > 1000 || now.getTime() >= Date.parse(request.deadlineAt)) throw new Error("Held recovery readiness/session/freshness unavailable")
  const expected = request.ledger.entries.filter(entry => entry.state !== "released")
  if (response.entries.length !== expected.length) throw new Error("Held recovery не покрывает exact ledger")
  for (let index = 0; index < expected.length; index++) {
    const entry = expected[index]!
    const observed = response.entries[index]!
    if (entry.sequence !== observed.sequence || entry.kind !== observed.kind || entry.code !== observed.code || observed.observed !== "up") throw new Error("Held recovery содержит held/unknown или другой input")
  }
}
