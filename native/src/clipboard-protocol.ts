import {
  clipboardExecutionContextSchema,
  createNativeResponseEnvelopeSchema,
  isoTimestampSchema,
  nativeResponseBaseSchema,
  nativeRecoveryGrantSchema,
  structurallyEqual,
  z,
} from "@meta/shared/contracts"

export const NATIVE_CLIPBOARD_MAX_UTF8_BYTES = 1_000_000
export const NATIVE_CLIPBOARD_WIRE_BYTES = 8 * 1024 * 1024
const count = z.number().int().safe().min(0)
const bytes = z.number().int().min(0).max(NATIVE_CLIPBOARD_MAX_UTF8_BYTES)
const text = z.string().refine(value => new TextEncoder().encode(value).byteLength <= NATIVE_CLIPBOARD_MAX_UTF8_BYTES,
  "clipboard text превышает 1000000 UTF-8 bytes")

const clipboardMethodSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("clipboard.version"), payload: z.strictObject({}) }),
  z.strictObject({ method: z.literal("clipboard.read"), payload: z.strictObject({ maxBytes: bytes.min(1) }) }),
  z.strictObject({ method: z.literal("clipboard.write"), payload: z.strictObject({ text, expectedChangeCount: count.optional() }) }),
])

export const nativeClipboardRequestSchema = nativeResponseBaseSchema.omit({ operationId: true }).extend({
  kind: z.literal("request"),
  deadlineAt: isoTimestampSchema,
  operation: clipboardExecutionContextSchema,
  command: clipboardMethodSchema,
  recoveryGrant: nativeRecoveryGrantSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.runtimeEpoch !== request.operation.runtimeEpoch
    || request.loginSessionId !== request.operation.loginSessionId
    || request.deadlineAt !== request.operation.deadlineAt) {
    context.addIssue({ code: "custom", message: "Clipboard operation не совпадает с transport runtime/login/deadline" })
  }
  const grant = request.recoveryGrant
  if (grant !== undefined && (request.command.method !== "clipboard.write" || grant.operationId !== request.operation.operationId
    || grant.runtimeEpoch !== request.runtimeEpoch || grant.loginSessionId !== request.loginSessionId
    || grant.nativeGeneration !== request.nativeGeneration)) {
    context.addIssue({ code: "custom", path: ["recoveryGrant"], message: "Clipboard recovery grant не совпадает с mutation envelope" })
  }
})

const failure = z.strictObject({
  status: z.enum(["backend-unavailable", "invalid-argument", "payload-too-large", "invalid-utf8"]),
  mutationAttempted: z.literal(false),
})
export const nativeClipboardVersionResultSchema = z.union([
  z.strictObject({ status: z.literal("ok"), changeCount: count }),
  failure,
])
export const nativeClipboardReadResultSchema = z.union([
  z.strictObject({
    status: z.literal("ok"), text, utf8Bytes: bytes,
    beforeChangeCount: count, afterChangeCount: count,
  }).superRefine((value, context) => {
    if (value.beforeChangeCount !== value.afterChangeCount || new TextEncoder().encode(value.text).byteLength !== value.utf8Bytes) {
      context.addIssue({ code: "custom", message: "Coherent clipboard read требует равные counts и точную длину" })
    }
  }),
  z.strictObject({ status: z.enum(["changed-during-read", "text-unavailable"]), beforeChangeCount: count, afterChangeCount: count }),
  failure,
])
export const nativeClipboardWriteResultSchema = z.union([
  z.strictObject({
    status: z.literal("written"), beforeChangeCount: count, declaredChangeCount: count, afterChangeCount: count,
    mutationAttempted: z.literal(true), setStringSucceeded: z.literal(true),
    ownershipStableAfterWrite: z.literal(true), atomicPrecondition: z.literal(false), utf8Bytes: bytes,
  }).refine(value => value.declaredChangeCount === value.afterChangeCount, "written требует observed stable changeCount"),
  z.strictObject({
    status: z.literal("precondition-mismatch-no-dispatch"), beforeChangeCount: count,
    mutationAttempted: z.literal(false), atomicPrecondition: z.literal(false),
  }),
  z.strictObject({
    status: z.literal("partial-or-unknown"), beforeChangeCount: count,
    declaredChangeCount: count.optional(), afterChangeCount: count.optional(),
    mutationAttempted: z.literal(true), setStringSucceeded: z.boolean(),
    ownershipStableAfterWrite: z.boolean(), atomicPrecondition: z.literal(false), utf8Bytes: bytes,
  }),
  failure,
])

export const nativeClipboardResultSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("clipboard.version"), value: nativeClipboardVersionResultSchema }),
  z.strictObject({ method: z.literal("clipboard.read"), value: nativeClipboardReadResultSchema }),
  z.strictObject({ method: z.literal("clipboard.write"), value: nativeClipboardWriteResultSchema }),
])
export const nativeClipboardResponseSchema = createNativeResponseEnvelopeSchema(nativeClipboardResultSchema)
export type NativeClipboardRequest = z.infer<typeof nativeClipboardRequestSchema>
export type NativeClipboardResponse = z.infer<typeof nativeClipboardResponseSchema>

export function clipboardResponseMatches(request: NativeClipboardRequest, response: NativeClipboardResponse): boolean {
  return request.requestId === response.requestId
    && request.operation.operationId === response.operationId
    && request.runtimeEpoch === response.runtimeEpoch
    && request.loginSessionId === response.loginSessionId
    && request.nativeGeneration === response.nativeGeneration
    && (!response.ok || structurallyEqual(request.command.method, response.result.method))
}
