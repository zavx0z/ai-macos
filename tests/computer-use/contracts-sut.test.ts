import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const runtimePackageDirectory = resolve(import.meta.dir, "../../runtime")
const contractsPackageEntry = Bun.resolveSync(
  "@meta/shared/contracts",
  runtimePackageDirectory
)
const {
  CAPABILITY_SCHEMA_VERSION,
  NATIVE_PROTOCOL_VERSION,
  capabilitySetSchema,
  contractErrorSchema,
  nativeExecutionContextSchema,
  nativeHandshakeCompatibility,
  nativeHandshakeRequestSchema,
  nativeHandshakeResponseSchema,
  nativeOperationStatusSchema,
  payloadReceiptSchema
} = await import(contractsPackageEntry)

const runtimeEpoch = "runtime-acceptance"
const loginSessionId = "login-acceptance"
const nativeGeneration = "native-acceptance"
const timestamp = "2026-09-15T12:00:00.000Z"

function handshakeRequest() {
  return nativeHandshakeRequestSchema.parse({
    kind: "handshake",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId: "request-handshake",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: "runtime-build-1",
    expectedNativeBuildId: "native-build-expected",
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION
  })
}

function handshakeResponse(nativeBuildId: string) {
  return nativeHandshakeResponseSchema.parse({
    kind: "handshake-response",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId: "request-handshake",
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    nativeBuildId,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    installRoot: "/fixture/native",
    process: {
      pid: 123,
      startedAt: timestamp,
      nonce: "process-nonce"
    },
    capabilities: {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      scope: "adapter",
      producerRef: "native-adapter",
      capabilities: []
    }
  })
}

function observerCoverage() {
  return {
    state: "unavailable" as const,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    coverageStartCursor: "cursor-start",
    cursor: "cursor-current",
    nextSequence: 1,
    startedAt: timestamp,
    coveredFrom: timestamp,
    coveredThrough: timestamp,
    heartbeatAt: timestamp,
    coveredKinds: [],
    droppedEvents: 0,
    gapDetected: false,
    reason: "fixture observer отсутствует"
  }
}

describe("real @meta/shared/contracts acceptance", () => {
  test("C1 package export разрешается через workspace dependency", () => {
    expect(contractsPackageEntry).toEndWith("shared/src/contracts/index.ts")
  })

  test("A01: несовместимый native build даёт non-replayable backend mismatch", () => {
    const mismatch = nativeHandshakeCompatibility(
      handshakeRequest(),
      handshakeResponse("native-build-stale")
    )

    expect(mismatch).toMatchObject({
      code: "backend-version-mismatch",
      retryable: false,
      replayAllowed: false,
      recoveryAction: "apply-compatible-update"
    })
  })

  test("A01: совместимый handshake сохраняет exact request/runtime/login", () => {
    const request = handshakeRequest()
    const response = handshakeResponse("native-build-expected")

    expect(nativeHandshakeCompatibility(request, response)).toBeUndefined()
  })

  test("A08: unknown native outcome без quarantine не проходит public parser", () => {
    const result = nativeOperationStatusSchema.safeParse({
      requestId: "status-request",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      highWaterFence: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        counter: 1
      },
      acceptedFence: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        counter: 1
      },
      operationId: "operation-unknown",
      execution: "interrupted-unknown",
      dispatch: "unknown",
      cleanup: "unknown",
      targetVerified: "verified",
      cancellationRequested: true,
      userInterference: "unknown",
      restorationAllowed: false,
      quarantined: false,
      heldCount: 1,
      dispatchAttempts: 1,
      ledgerRevision: 2,
      observer: observerCoverage()
    })

    expect(result.success).toBe(false)
  })

  test("A10: native operation с fence другой login generation отвергается", () => {
    const result = nativeExecutionContextSchema.safeParse({
      kind: "native",
      operationId: "operation-a10",
      clientRequestId: "client-request-a10",
      clientSessionId: "client-session-a10",
      principalId: "principal-a10",
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory-a10",
      inventoryRevision: 5,
      deadlineAt: "2026-09-15T12:01:00.000Z",
      target: {
        kind: "window",
        ref: {
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          applicationRef: "application-a10",
          windowRef: "window-a10"
        }
      },
      nativeGeneration,
      fence: {
        runtimeEpoch,
        loginSessionId: "login-stale",
        nativeGeneration,
        counter: 1
      }
    })

    expect(result.success).toBe(false)
  })

  test("A11: public payload receipt не принимает исходный payload", () => {
    const result = payloadReceiptSchema.safeParse({
      keyGeneration: "payload-key-1",
      hmacSha256: "a".repeat(64),
      payload: "секретный текст"
    })

    expect(result.success).toBe(false)
  })

  test("A11: unknown outcome не может разрешать automatic replay", () => {
    const result = contractErrorSchema.safeParse({
      code: "operation-outcome-unknown",
      message: "Native ACK потерян",
      stage: "native-dispatch",
      retryable: false,
      replayAllowed: true,
      recoveryAction: "get-operation"
    })

    expect(result.success).toBe(false)
  })

  test("A38: adapter capability snapshot допускает отсутствие optional adapters", () => {
    const result = capabilitySetSchema.safeParse({
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      scope: "adapter",
      producerRef: "desktop-core",
      capabilities: [
        { id: "runtime.identity", state: "ready" },
        { id: "browser.instances", state: "unavailable", reason: "Chrome не запущен" },
        { id: "android.chrome", state: "unsupported", reason: "Adapter отключён" }
      ]
    })

    expect(result.success).toBe(true)
  })
})
