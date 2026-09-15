import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  CAPABILITY_IDS,
  NATIVE_PROTOCOL_VERSION,
  browserExecutionContextSchema,
  capabilityIsLocallyReady,
  capabilityIsReady,
  capabilitySetSchema,
  clipboardExecutionContextSchema,
  contractJsonSchema,
  contractSchemaRegistry,
  createNativeMutationRequestEnvelopeSchema,
  generationIdSchema,
  isoTimestampSchema,
  nativeExecutionContextSchema,
  nativeHandshakeCompatibility,
  nativeHandshakeRequestSchema,
  nativeHandshakeResponseSchema,
  nativeTextChunkSchema,
  opaqueIdSchema,
  parseWireValue,
  parseWireJson,
  runtimeGenerationSchema,
  structurallyEqual,
} from "./index.ts"
import {
  adapterCapabilities,
  browserTargetRef,
  deadlineAt,
  loginSessionId,
  nativeContext,
  nativeGeneration,
  now,
  runtimeEpoch,
  windowRef,
} from "./test-fixtures.ts"

describe("C1 JSON boundary", () => {
  test("Zod declaration экспортирует строгую JSON Schema", () => {
    const schema = contractJsonSchema(nativeExecutionContextSchema) as Record<string, unknown>
    expect(schema.type).toBe("object")
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties).toBeDefined()
    expect(JSON.stringify(schema)).toContain("nativeGeneration")
    expect(JSON.stringify(schema)).toContain("fence")
  })

  test("каждая публичная wire schema из registry экспортируется в JSON Schema", () => {
    for (const [name, declaration] of Object.entries(contractSchemaRegistry)) {
      const exported = contractJsonSchema(declaration)
      expect(JSON.stringify(exported), name).toContain('"$schema"')
    }
  })

  test("semantic DTO equality не зависит от insertion order полей", () => {
    expect(structurallyEqual(
      { mapping: { ref: "display:1", nativeDisplayId: 1 } },
      { mapping: { nativeDisplayId: 1, ref: "display:1" } },
    )).toBe(true)
    expect(structurallyEqual({ ref: "display:1" }, { ref: "display:2" })).toBe(false)
  })

  test("prototype-like fields, Date, Map, undefined и sparse array отклоняются без преобразования", () => {
    const prototypePayload = JSON.parse('{"text":"x","utf16Units":1,"__proto__":{"injected":true}}')
    expect(() => parseWireValue(nativeTextChunkSchema, prototypePayload)).toThrow("запрещён")
    expect(() => parseWireValue(runtimeGenerationSchema, new Date())).toThrow("non-plain")
    expect(() => parseWireValue(runtimeGenerationSchema, new Map())).toThrow("non-plain")
    expect(() => parseWireValue(runtimeGenerationSchema, { runtimeEpoch, loginSessionId: undefined })).toThrow("undefined")
    expect(() => parseWireValue(capabilitySetSchema, {
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "adapter:test",
      capabilities: [, { id: "runtime.identity", state: "ready" }],
    })).toThrow("sparse")
    const cyclic: Record<string, unknown> = { runtimeEpoch, loginSessionId }
    cyclic.self = cyclic
    expect(() => parseWireValue(runtimeGenerationSchema, cyclic)).toThrow("циклическую")
    expect((prototypePayload as Record<string, unknown>).injected).toBeUndefined()
  })

  test("даты требуют ISO timezone, числа safe, native IDs учитывают C NUL capacity", () => {
    expect(isoTimestampSchema.safeParse("1").success).toBe(false)
    expect(isoTimestampSchema.safeParse("2026-09-15T10:00:00").success).toBe(false)
    expect(isoTimestampSchema.safeParse("2026-09-15T10:00:00Z").success).toBe(true)
    expect(generationIdSchema.safeParse("g".repeat(64)).success).toBe(true)
    expect(generationIdSchema.safeParse("g".repeat(65)).success).toBe(false)
    expect(opaqueIdSchema.safeParse("r".repeat(127)).success).toBe(true)
    expect(opaqueIdSchema.safeParse("r".repeat(128)).success).toBe(false)
    expect(nativeExecutionContextSchema.safeParse({ ...nativeContext(), inventoryRevision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
  })

  test("native envelope имеет одну Zod shape, method payload, byte и depth bounds", () => {
    const payloadSchema = z.strictObject({ text: z.string().max(2 * 1024 * 1024) })
    const envelopeSchema = createNativeMutationRequestEnvelopeSchema("input.type", payloadSchema)
    const envelope = {
      kind: "request",
      intent: "mutation",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: "native-request:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      deadlineAt,
      method: "input.type",
      operation: nativeContext(),
      payload: { text: "Привет" },
    }
    expect(envelopeSchema.parse(envelope).requestId).toBe("native-request:1")
    expect(envelopeSchema.safeParse({ ...envelope, fallbackTitle: "похожее окно" }).success).toBe(false)
    expect(envelopeSchema.safeParse({ ...envelope, payload: { text: "x".repeat(1024 * 1024) } }).success).toBe(false)

    let deepPayload: z.ZodType = z.string()
    let deepValue: unknown = "leaf"
    for (let index = 0; index < 34; index++) {
      deepPayload = z.strictObject({ nested: deepPayload })
      deepValue = { nested: deepValue }
    }
    const deepEnvelope = createNativeMutationRequestEnvelopeSchema("test.deep", deepPayload)
    expect(deepEnvelope.safeParse({ ...envelope, method: "test.deep", payload: deepValue }).success).toBe(false)
  })

  test("общий wire reader ограничивает bytes/depth до Zod и JSON.parse", () => {
    let value: unknown = "leaf"
    for (let index = 0; index < 200; index++) value = { nested: value }
    expect(() => parseWireValue(z.unknown(), value)).toThrow("wire depth 32")
    expect(() => parseWireJson(z.unknown(), "x".repeat(1024 * 1024 + 1))).toThrow("до JSON.parse")
    expect(() => parseWireValue(z.unknown(), { nested: "ok" }, { maxBytes: 1024, maxDepth: 4 })).not.toThrow()
    expect(() => parseWireValue(z.unknown(), { nested: "ok" }, { maxBytes: 1024, maxDepth: 1_000 })).toThrow("maxDepth")
  })
})

describe("C1 domain contexts and capabilities", () => {
  test("browser и clipboard context не требуют native generation/fence", () => {
    expect(browserExecutionContextSchema.parse({
      kind: "browser",
      operationId: "operation:browser",
      clientRequestId: "request:browser",
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory:browser",
      inventoryRevision: 1,
      deadlineAt,
      target: { kind: "browser-target", ref: browserTargetRef },
    })).not.toHaveProperty("nativeGeneration")
    expect(clipboardExecutionContextSchema.parse({
      kind: "clipboard",
      operationId: "operation:clipboard",
      clientRequestId: "request:clipboard",
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory:clipboard",
      inventoryRevision: 1,
      deadlineAt,
      target: { kind: "clipboard", ref: { runtimeEpoch, loginSessionId, clipboardRef: "system" } },
    })).not.toHaveProperty("fence")
  })

  test("native context требует fence и связывает target с runtime/login/native generation", () => {
    const { fence: _, ...withoutFence } = nativeContext()
    expect(nativeExecutionContextSchema.safeParse(withoutFence).success).toBe(false)
    expect(nativeExecutionContextSchema.safeParse({
      ...nativeContext(),
      target: { kind: "window", ref: { ...windowRef, loginSessionId: "login:foreign" } },
    }).success).toBe(false)
  })

  test("adapter subset не является full readiness, runtime применяет canonical dependencies", () => {
    expect(capabilityIsLocallyReady(adapterCapabilities, "runtime.identity")).toBe(true)
    expect(capabilityIsReady(adapterCapabilities, "runtime.identity")).toBe(false)
    const runtimeCapabilities = capabilitySetSchema.parse({
      schemaVersion: "1",
      scope: "runtime",
      producerRef: "runtime:1",
      capabilities: CAPABILITY_IDS.map(id => ({
        id,
        state: id === "runtime.identity" ? "unavailable" : "ready",
        ...(id === "runtime.identity" ? { reason: "identity unavailable" } : {}),
      })),
    })
    expect(capabilityIsReady(runtimeCapabilities, "runtime.health")).toBe(false)
    expect(capabilitySetSchema.safeParse({ ...runtimeCapabilities, schemaVersion: "2" }).success).toBe(false)
  })

  test("handshake отвергает loaded build и login generation mismatch", () => {
    const request = nativeHandshakeRequestSchema.parse({
      kind: "handshake",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: "handshake:1",
      runtimeEpoch,
      loginSessionId,
      runtimeBuildId: "runtime-build:1",
      expectedNativeBuildId: "native-build:1",
      capabilitySchemaVersion: "1",
    })
    const response = nativeHandshakeResponseSchema.parse({
      kind: "handshake-response",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: "handshake:1",
      runtimeEpoch,
      loginSessionId: "login:foreign",
      nativeGeneration,
      nativeBuildId: "native-build:old",
      capabilitySchemaVersion: "1",
      installRoot: "/Users/test/Library/Application Support/ai-macos",
      process: { pid: 44, startedAt: now, nonce: "process:1" },
      capabilities: adapterCapabilities,
    })
    expect(nativeHandshakeCompatibility(request, response)?.code).toBe("backend-version-mismatch")
  })
})
