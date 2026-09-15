import { expect, test } from "bun:test"
import { nativeRecoveryGrantSchema } from "@meta/shared/contracts"
import { nativeDomainRecoveryRequestSchema, recoveryValueSha256, verifyDomainRecoveryAllUp,
  type NativeDomainRecoveryResponse } from "../src/domain-recovery-protocol.ts"

const now = new Date()
const descriptor = { policyVersion: "1", nativeBuildId: "build:old", method: "input.execute", domain: "possible-held-input", possibleHolds: [{ kind: "key", code: 0 }] }
const grant = nativeRecoveryGrantSchema.parse({ policyVersion: "1", runtimeEpoch: "runtime:old", loginSessionId: "login:same", nativeGeneration: "native:old",
  operationId: "operation:old", descriptor, descriptorSha256: recoveryValueSha256(descriptor), contextSha256: "a".repeat(64), journalRevision: 3, durable: true })
const request = nativeDomainRecoveryRequestSchema.parse({ kind: "domain-recovery", protocolVersion: "1", requestId: "probe:domain",
  runtimeEpoch: "runtime:new", loginSessionId: "login:same", nativeGeneration: "native:new", deadlineAt: new Date(now.getTime() + 2000).toISOString(), grant })
const response: NativeDomainRecoveryResponse = { kind: "domain-recovery-response", protocolVersion: "1", requestId: request.requestId,
  runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration, nativeBuildId: "build:new",
  oldOperationId: grant.operationId, oldRuntimeEpoch: grant.runtimeEpoch, oldNativeGeneration: grant.nativeGeneration,
  grantSha256: recoveryValueSha256(grant), descriptorSha256: grant.descriptorSha256, sampledAt: now.toISOString(),
  inputMonitoring: true, observerReady: true, sessionState: "active-console", lockState: "unknown", secureInput: "off", source: "cg-combined-session-state",
  entries: [{ kind: "key", code: 0, observed: "up" }] }

test("Unicode risk key0 проверяется без fabricated ledger", () => {
  expect(request.ledger).toBeUndefined()
  expect(() => verifyDomainRecoveryAllUp(request, response, "build:new", now)).not.toThrow()
})
test("partial prefix и held/unknown не дают all-up", () => {
  expect(() => verifyDomainRecoveryAllUp(request, { ...response, entries: [] }, "build:new", now)).toThrow("полный")
  for (const observed of ["held", "unknown"] as const) expect(() => verifyDomainRecoveryAllUp(request, {
    ...response, entries: [{ kind: "key", code: 0, observed }],
  }, "build:new", now)).toThrow()
})
test("grant tamper и недоступные positive predicates отвергаются", () => {
  expect(nativeDomainRecoveryRequestSchema.safeParse({ ...request, grant: { ...grant, descriptorSha256: "0".repeat(64) } }).success).toBe(false)
  expect(() => verifyDomainRecoveryAllUp(request, { ...response, observerReady: false }, "build:new", now)).toThrow()
  expect(() => verifyDomainRecoveryAllUp(request, { ...response, secureInput: "on" }, "build:new", now)).toThrow()
  expect(() => verifyDomainRecoveryAllUp(request, { ...response, grantSha256: "0".repeat(64) }, "build:new", now)).toThrow("digest")
})
