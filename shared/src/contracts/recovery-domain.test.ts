import { expect, test } from "bun:test"
import { nativeRecoveryDescriptorSchema, canonicalRecoveryJson } from "./recovery-domain.ts"
import { nativeHandshakeCompatibility, nativeHandshakeRequestSchema, nativeHandshakeResponseSchema } from "./native.ts"

test("domain имеет bounded canonical hold set и не принимает plaintext", () => {
  const descriptor = { policyVersion: "1", nativeBuildId: "build:domain", method: "input.execute",
    domain: "possible-held-input", possibleHolds: [{ kind: "key", code: 0 }] }
  expect(nativeRecoveryDescriptorSchema.safeParse(descriptor).success).toBe(true)
  expect(nativeRecoveryDescriptorSchema.safeParse({ ...descriptor, domain: "no-held-input" }).success).toBe(false)
  expect(nativeRecoveryDescriptorSchema.safeParse({ ...descriptor, possibleHolds: [{ kind: "key", code: 0 }, { kind: "key", code: 0 }] }).success).toBe(false)
  expect(nativeRecoveryDescriptorSchema.safeParse({ ...descriptor, text: "secret" }).success).toBe(false)
  expect(canonicalRecoveryJson({ z: 1, a: { c: 2, b: 3 } })).toBe('{"a":{"b":3,"c":2},"z":1}')
})

test("required recovery version не подменяется legacy handshake", () => {
  const request = nativeHandshakeRequestSchema.parse({ kind: "handshake", protocolVersion: "1", requestId: "hs:domain",
    runtimeEpoch: "runtime:domain", loginSessionId: "login:domain", runtimeBuildId: "build:runtime", expectedNativeBuildId: "build:native",
    requiredRecoveryDomainVersion: "1", capabilitySchemaVersion: "1" })
  const response = nativeHandshakeResponseSchema.parse({ kind: "handshake-response", protocolVersion: "1", requestId: request.requestId,
    runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: "native:domain", nativeBuildId: "build:native",
    capabilitySchemaVersion: "1", installRoot: "/fixture/native", process: { pid: 100, startedAt: new Date().toISOString(), nonce: "nonce:domain" },
    capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "native:domain", capabilities: [] } })
  expect(nativeHandshakeCompatibility(request, response)).toBeDefined()
  expect(nativeHandshakeCompatibility(request, { ...response, recoveryDomainVersion: "1" })).toBeUndefined()
})
