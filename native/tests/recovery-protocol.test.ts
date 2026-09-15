import { expect, test } from "bun:test"
import { heldInputLedgerDigest, heldInputLedgerSnapshotSchema } from "@meta/shared/contracts"
import { nativeHeldRecoveryRequestSchema, nativeHeldRecoveryResponseSchema, verifyHeldRecoveryAllUp } from "../src/recovery-protocol.ts"

const now = new Date()
const ledger = heldInputLedgerSnapshotSchema.parse({ canonicalVersion: "1", runtimeEpoch: "runtime:old", loginSessionId: "login:same",
  nativeGeneration: "native:old", operationId: "operation:old", revision: 1,
  entries: [{ sequence: 1, kind: "key", code: 56, state: "pending-down" }] })
const request = nativeHeldRecoveryRequestSchema.parse({ kind: "held-recovery", protocolVersion: "1", requestId: "recovery:test",
  runtimeEpoch: "runtime:new", loginSessionId: "login:same", nativeGeneration: "native:new", deadlineAt: new Date(now.getTime() + 5000).toISOString(),
  ledger, ack: { requestId: "persist:old", runtimeEpoch: ledger.runtimeEpoch, loginSessionId: ledger.loginSessionId,
    nativeGeneration: ledger.nativeGeneration, operationId: ledger.operationId, revision: ledger.revision,
    snapshotSha256: heldInputLedgerDigest(ledger), persistedAt: now.toISOString(), durable: true } })
const response = nativeHeldRecoveryResponseSchema.parse({ kind: "held-recovery-response", protocolVersion: "1", requestId: request.requestId,
  runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration, nativeBuildId: "build:recovery",
  oldOperationId: ledger.operationId, oldRuntimeEpoch: ledger.runtimeEpoch, oldNativeGeneration: ledger.nativeGeneration,
  ledgerRevision: ledger.revision, ledgerSha256: heldInputLedgerDigest(ledger), sampledAt: now.toISOString(),
  inputMonitoring: true, sessionState: "active-console", lockState: "unknown", secureInput: "off", observerReady: true, source: "cg-combined-session-state",
  entries: [{ sequence: 1, kind: "key", code: 56, observed: "up" }] })

test("passive recovery принимает exact all-up, но не разрешает отправку input events", () => {
  expect(() => verifyHeldRecoveryAllUp(request, response, "build:recovery", now)).not.toThrow()
  expect("action" in request).toBe(false)
})

for (const patch of [
  { inputMonitoring: false }, { observerReady: false }, { lockState: "locked" as const },
  { secureInput: "on" as const }, { secureInput: "unknown" as const }, { sessionState: "inactive" as const },
  { nativeGeneration: "native:foreign" }, { ledgerSha256: "0".repeat(64) }, { entries: [] },
  { entries: [{ sequence: 1, kind: "key" as const, code: 56, observed: "held" as const }] },
  { entries: [{ sequence: 1, kind: "key" as const, code: 56, observed: "unknown" as const }] },
  { sampledAt: new Date(now.getTime() - 2000).toISOString() },
]) {
  test(`recovery отвергает ${JSON.stringify(patch)}`, () => {
    expect(() => verifyHeldRecoveryAllUp(request, { ...response, ...patch }, "build:recovery", now)).toThrow()
  })
}
