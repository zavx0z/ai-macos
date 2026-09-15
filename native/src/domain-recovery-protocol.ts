import {
  canonicalRecoveryJson, generationIdSchema, heldInputLedgerAckMatches, heldInputLedgerAckSchema,
  heldInputLedgerSnapshotSchema, nativeRecoveryGrantSchema, opaqueIdSchema, z,
} from "@meta/shared/contracts"

const identity = {
  protocolVersion: z.literal("1"), requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
}
export function recoveryValueSha256(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalRecoveryJson(value)).digest("hex")
}

export const nativeDomainRecoveryRequestSchema = z.strictObject({
  ...identity, kind: z.literal("domain-recovery"), deadlineAt: z.iso.datetime({ offset: true }),
  grant: nativeRecoveryGrantSchema,
  ledger: heldInputLedgerSnapshotSchema.optional(), ack: heldInputLedgerAckSchema.optional(),
}).superRefine((request, context) => {
  const grant = request.grant
  if (grant.loginSessionId !== request.loginSessionId || grant.descriptor.domain !== "possible-held-input"
    || grant.descriptor.possibleHolds.length === 0 || recoveryValueSha256(grant.descriptor) !== grant.descriptorSha256) {
    context.addIssue({ code: "custom", path: ["grant"], message: "Domain recovery требует exact persisted possible-hold grant той же audit session" })
  }
  if ((request.ledger === undefined) !== (request.ack === undefined)) {
    context.addIssue({ code: "custom", path: ["ledger"], message: "Ledger и ACK передаются только парой" })
  }
  if (request.ledger !== undefined && request.ack !== undefined) {
    const ledger = request.ledger
    if (!heldInputLedgerAckMatches(request.ack.requestId, ledger, request.ack)
      || ledger.operationId !== grant.operationId || ledger.runtimeEpoch !== grant.runtimeEpoch
      || ledger.loginSessionId !== grant.loginSessionId || ledger.nativeGeneration !== grant.nativeGeneration
      || ledger.entries.some(entry => entry.state !== "released" && !grant.descriptor.possibleHolds.some(hold => hold.kind === entry.kind && hold.code === entry.code))) {
      context.addIssue({ code: "custom", path: ["ledger"], message: "Ledger не соответствует grant/risk set" })
    }
  }
})

export const nativeDomainRecoveryResponseSchema = z.strictObject({
  ...identity, kind: z.literal("domain-recovery-response"), nativeBuildId: opaqueIdSchema,
  oldOperationId: opaqueIdSchema, oldRuntimeEpoch: generationIdSchema, oldNativeGeneration: generationIdSchema,
  grantSha256: z.string().regex(/^[a-f0-9]{64}$/), descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampledAt: z.iso.datetime({ offset: true }), inputMonitoring: z.boolean(), observerReady: z.boolean(),
  sessionState: z.enum(["active-console", "inactive", "unknown"]), lockState: z.enum(["unknown", "locked"]), secureInput: z.enum(["off", "on", "unknown"]),
  source: z.literal("cg-combined-session-state"),
  entries: z.array(z.strictObject({ kind: z.enum(["key", "button"]), code: z.number().int().min(0).max(65535),
    observed: z.enum(["up", "held", "unknown"]) })).max(512),
  reason: z.string().min(1).max(1024).optional(),
})
export type NativeDomainRecoveryRequest = z.infer<typeof nativeDomainRecoveryRequestSchema>
export type NativeDomainRecoveryResponse = z.infer<typeof nativeDomainRecoveryResponseSchema>

export function nativeDomainRecoveryResponseMatches(request: NativeDomainRecoveryRequest, response: NativeDomainRecoveryResponse, loadedBuildId: string): boolean {
  return request.requestId === response.requestId && request.protocolVersion === response.protocolVersion
    && request.runtimeEpoch === response.runtimeEpoch && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration && response.nativeBuildId === loadedBuildId
    && response.oldOperationId === request.grant.operationId && response.oldRuntimeEpoch === request.grant.runtimeEpoch
    && response.oldNativeGeneration === request.grant.nativeGeneration && response.grantSha256 === recoveryValueSha256(request.grant)
    && response.descriptorSha256 === request.grant.descriptorSha256
}

/** Actor exit проверяет Runtime отдельно; этот verifier не разрешает UP/restore. */
export function verifyDomainRecoveryAllUp(requestValue: NativeDomainRecoveryRequest, responseValue: NativeDomainRecoveryResponse, loadedBuildId: string, now: Date): void {
  const request = nativeDomainRecoveryRequestSchema.parse(requestValue)
  const response = nativeDomainRecoveryResponseSchema.parse(responseValue)
  if (!nativeDomainRecoveryResponseMatches(request, response, loadedBuildId)) throw new Error("Domain recovery identity/digest mismatch")
  const age = now.getTime() - Date.parse(response.sampledAt)
  if (!response.inputMonitoring || !response.observerReady || response.sessionState !== "active-console" || response.lockState === "locked"
    || response.secureInput !== "off" || age < -1000 || age > 1000 || now.getTime() >= Date.parse(request.deadlineAt)) throw new Error("Domain recovery readiness/session/freshness unavailable")
  const holds = request.grant.descriptor.possibleHolds
  if (response.entries.length !== holds.length || response.entries.some((entry, index) => entry.kind !== holds[index]!.kind
    || entry.code !== holds[index]!.code || entry.observed !== "up")) throw new Error("Domain recovery не подтвердил полный declared risk set")
}
