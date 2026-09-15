import { z } from "zod"
import { CAPABILITY_SCHEMA_VERSION, capabilitySetSchema } from "./capabilities.ts"
import { contractErrorSchema, type ContractError } from "./errors.ts"
import {
  NATIVE_PROTOCOL_VERSION,
  generationIdSchema,
  nativeGenerationSchema,
  opaqueIdSchema,
} from "./identities.ts"
import { nativeExecutionContextSchema } from "./operations.ts"
import { isoTimestampSchema, utf8ByteLength } from "./schema.ts"

export const MAX_NATIVE_ENVELOPE_BYTES = 1024 * 1024
export const MAX_NATIVE_JSON_DEPTH = 32

export const processInstanceSchema = z.strictObject({
  pid: z.number().int().min(1).max(0x7fffffff),
  startedAt: isoTimestampSchema,
  nonce: generationIdSchema,
})
export type ProcessInstance = z.infer<typeof processInstanceSchema>

export const nativeAuditSessionSchema = z.discriminatedUnion("verified", [
  z.strictObject({ verified: z.literal(true), source: z.literal("darwin-audit"),
    uid: z.number().int().min(0).max(0xffffffff), effectiveUid: z.number().int().min(0).max(0xffffffff),
    auditUserId: z.number().int().min(0).max(0xffffffff), auditSessionId: z.number().int().min(0).max(0xffffffff) }),
  z.strictObject({ verified: z.literal(false), source: z.literal("darwin-audit"),
    uid: z.number().int().min(0).max(0xffffffff), effectiveUid: z.number().int().min(0).max(0xffffffff), reason: z.string().min(1).max(1024) }),
])
export type NativeAuditSession = z.infer<typeof nativeAuditSessionSchema>

export const nativeHandshakeRequestSchema = z.strictObject({
  kind: z.literal("handshake"),
  protocolVersion: z.literal(NATIVE_PROTOCOL_VERSION),
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  runtimeBuildId: opaqueIdSchema,
  expectedNativeBuildId: opaqueIdSchema,
  capabilitySchemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
})
export type NativeHandshakeRequest = z.infer<typeof nativeHandshakeRequestSchema>

export const nativeHandshakeResponseSchema = z.strictObject({
  kind: z.literal("handshake-response"),
  protocolVersion: z.literal(NATIVE_PROTOCOL_VERSION),
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  nativeBuildId: opaqueIdSchema,
  capabilitySchemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  installRoot: z.string().min(1).max(4_096).refine(path => path.startsWith("/"), "installRoot должен быть абсолютным"),
  process: processInstanceSchema,
  capabilities: capabilitySetSchema,
  session: nativeAuditSessionSchema.optional(),
})
export type NativeHandshakeResponse = z.infer<typeof nativeHandshakeResponseSchema>

const nativeRequestCommonShape = {
  kind: z.literal("request"),
  protocolVersion: z.literal(NATIVE_PROTOCOL_VERSION),
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  deadlineAt: isoTimestampSchema,
}

export function createNativeReadRequestEnvelopeSchema<Method extends string, Payload extends z.ZodType>(
  method: Method,
  payload: Payload,
) {
  return z.strictObject({
    ...nativeRequestCommonShape,
    intent: z.literal("read"),
    method: z.literal(method),
    payload,
  }).superRefine((request, context) => {
    if (utf8ByteLength(request) > MAX_NATIVE_ENVELOPE_BYTES) {
      context.addIssue({ code: "custom", message: `native envelope превышает ${MAX_NATIVE_ENVELOPE_BYTES} байт` })
    }
    if (jsonDepth(request) > MAX_NATIVE_JSON_DEPTH) {
      context.addIssue({ code: "custom", message: `native envelope глубже ${MAX_NATIVE_JSON_DEPTH}` })
    }
  })
}

export function createNativeMutationRequestEnvelopeSchema<Method extends string, Payload extends z.ZodType>(
  method: Method,
  payload: Payload,
) {
  return z.strictObject({
    ...nativeRequestCommonShape,
    intent: z.literal("mutation"),
    method: z.literal(method),
    operation: nativeExecutionContextSchema,
    payload,
  }).superRefine((request, context) => {
    if (
      request.operation.operationId === ""
      || request.operation.runtimeEpoch !== request.runtimeEpoch
      || request.operation.loginSessionId !== request.loginSessionId
      || request.operation.nativeGeneration !== request.nativeGeneration
      || request.operation.deadlineAt !== request.deadlineAt
    ) {
      context.addIssue({ code: "custom", path: ["operation"], message: "operation не коррелирует с native envelope" })
    }
    if (utf8ByteLength(request) > MAX_NATIVE_ENVELOPE_BYTES) {
      context.addIssue({ code: "custom", message: `native envelope превышает ${MAX_NATIVE_ENVELOPE_BYTES} байт` })
    }
    if (jsonDepth(request) > MAX_NATIVE_JSON_DEPTH) {
      context.addIssue({ code: "custom", message: `native envelope глубже ${MAX_NATIVE_JSON_DEPTH}` })
    }
  })
}

export const nativeResponseBaseSchema = z.strictObject({
  kind: z.literal("response"),
  protocolVersion: z.literal(NATIVE_PROTOCOL_VERSION),
  requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  operationId: opaqueIdSchema.optional(),
})

export function createNativeResponseEnvelopeSchema<Result extends z.ZodType>(result: Result) {
  return z.discriminatedUnion("ok", [
    nativeResponseBaseSchema.extend({ ok: z.literal(true), result }).strict(),
    nativeResponseBaseSchema.extend({ ok: z.literal(false), error: contractErrorSchema }).strict(),
  ])
}

export type NativeResponseBase = z.infer<typeof nativeResponseBaseSchema>

export function nativeHandshakeCompatibility(
  request: NativeHandshakeRequest,
  response: NativeHandshakeResponse,
): ContractError | undefined {
  if (
    request.requestId !== response.requestId
    || request.runtimeEpoch !== response.runtimeEpoch
    || request.loginSessionId !== response.loginSessionId
  ) {
    return mismatch("Native handshake принадлежит другой request/runtime/login generation", "inspect-health")
  }
  if (
    response.protocolVersion !== request.protocolVersion
    || response.capabilitySchemaVersion !== request.capabilitySchemaVersion
  ) {
    return mismatch("Native protocol или capability schema несовместимы с runtime", "apply-compatible-update")
  }
  if (response.nativeBuildId !== request.expectedNativeBuildId) {
    return mismatch(
      `Native build ${response.nativeBuildId} не совпадает с configured ${request.expectedNativeBuildId}`,
      "apply-compatible-update",
    )
  }
  return undefined
}

export function nativeResponseMatchesRequest(
  request: {
    requestId: string
    runtimeEpoch: string
    loginSessionId: string
    nativeGeneration: string
    operation?: { operationId: string }
  },
  response: NativeResponseBase,
): boolean {
  return request.requestId === response.requestId
    && request.runtimeEpoch === response.runtimeEpoch
    && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration
    && response.operationId === request.operation?.operationId
}

export function nativeGenerationFromHandshake(response: NativeHandshakeResponse): z.infer<typeof nativeGenerationSchema> {
  return {
    runtimeEpoch: response.runtimeEpoch,
    loginSessionId: response.loginSessionId,
    nativeGeneration: response.nativeGeneration,
  }
}

function mismatch(message: string, recoveryAction: "inspect-health" | "apply-compatible-update"): ContractError {
  return {
    code: "backend-version-mismatch",
    message,
    stage: "native-handshake",
    retryable: false,
    replayAllowed: false,
    recoveryAction,
  }
}

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.reduce((maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)), depth)
}
