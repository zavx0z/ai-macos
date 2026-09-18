import { contractErrorSchema, generationIdSchema, observerCoverageSchema, observedEventSchema, opaqueIdSchema, z, type ObservedEvent } from "@meta/shared/contracts"

const identity = {
  protocolVersion: z.literal("1"), requestId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
}
const commands = ["prepare", "coverage", "events", "stop"] as const

export const nativeObserverRequestSchema = z.strictObject({
  ...identity, kind: z.literal("observer"), command: z.enum(commands), deadlineAt: z.iso.datetime({ offset: true }),
  observerInstanceRef: opaqueIdSchema.optional(),
  previousObserverInstanceRef: opaqueIdSchema.optional(),
  afterCursor: opaqueIdSchema.optional(),
}).superRefine((request, context) => {
  if ((request.command === "prepare") === (request.observerInstanceRef !== undefined)) {
    context.addIssue({ code: "custom", path: ["observerInstanceRef"], message: "Новый prepare не принимает current instance; остальные команды требуют exact instance" })
  }
  if (request.command !== "prepare" && request.previousObserverInstanceRef !== undefined) {
    context.addIssue({ code: "custom", path: ["previousObserverInstanceRef"], message: "Previous instance допустим только при явном prepare/restart" })
  }
  if ((request.command === "events") !== (request.afterCursor !== undefined)) {
    context.addIssue({ code: "custom", path: ["afterCursor"], message: "Cursor требуется только для чтения events" })
  }
})

export const nativeObserverSnapshotSchema = z.strictObject({
  observerInstanceRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  indexRevision: z.number().int().safe().min(1),
  coverage: observerCoverageSchema,
  sessionReadiness: z.strictObject({
    state: z.enum(["active-console", "inactive", "unknown"]),
    lockState: z.enum(["locked", "unknown"]),
    userId: z.number().int().safe().min(0).optional(),
    onConsole: z.boolean().optional(),
    loginDone: z.boolean().optional(),
    auditSessionId: z.number().int().safe().min(0).optional(),
    evidence: z.string().min(1).max(1024),
    observedAt: z.iso.datetime({ offset: true }),
  }),
  secureInput: z.enum(["off", "on", "unknown"]),
}).superRefine((snapshot, context) => {
  if (snapshot.coverage.state === "ready" && snapshot.coverage.coveredKinds.length !== 4) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Ready observer требует все четыре coverage kind" })
  }
  const session = snapshot.sessionReadiness
  if (session.state === "active-console" && (session.userId === undefined || session.auditSessionId === undefined || session.onConsole !== true || session.loginDone !== true)) {
    context.addIssue({ code: "custom", path: ["sessionReadiness"], message: "Active console требует подтверждённые caller session/audit facts, а не unlocked assertion" })
  }
})

export const nativeObserverEventEnvelopeSchema = z.strictObject({
  observerInstanceRef: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
  event: observedEventSchema,
}).superRefine((packet, context) => {
  if (packet.event.runtimeEpoch !== packet.runtimeEpoch || packet.event.loginSessionId !== packet.loginSessionId || packet.event.nativeGeneration !== packet.nativeGeneration) {
    context.addIssue({ code: "custom", message: "Observer event и envelope принадлежат разным generation" })
  }
})
/** Отказ observer завершает только его поток, а не Native transport. */
export const nativeObserverGapEnvelopeSchema = z.strictObject({
  observerInstanceRef: opaqueIdSchema,
  runtimeEpoch: generationIdSchema, loginSessionId: generationIdSchema, nativeGeneration: generationIdSchema,
  gapReason: z.string().min(1).max(1024),
})
export type NativeObservedEvent = ObservedEvent & { readonly observerInstanceRef?: string }

const response = {
  ...identity, kind: z.literal("observer-response"), command: z.enum(commands), nativeBuildId: opaqueIdSchema,
}
export const nativeObserverPrepareFailureSchema = z.strictObject({
  stage: z.enum(["inventory", "index", "readiness", "main-start", "cleanup"]),
  retryDisposition: z.enum(["clean-no-instance", "clean-stopped", "unknown"]),
  transient: z.boolean(),
}).superRefine((failure, context) => {
  if (failure.transient && (!["inventory", "index", "readiness", "main-start"].includes(failure.stage)
    || failure.retryDisposition === "unknown")) {
    context.addIssue({ code: "custom", message: "Transient observer failure требует clean inventory/index/readiness/main-start disposition" })
  }
})
export const nativeObserverResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...response, ok: z.literal(true), snapshot: nativeObserverSnapshotSchema,
    fromCursor: opaqueIdSchema.optional(), events: z.array(observedEventSchema).max(1000).optional() }),
  z.strictObject({ ...response, ok: z.literal(false), error: contractErrorSchema,
    prepareFailure: nativeObserverPrepareFailureSchema.optional() }),
]).superRefine((value, context) => {
  if (!value.ok) {
    if ((value.command === "prepare") !== (value.prepareFailure !== undefined)) {
      context.addIssue({ code: "custom", path: ["prepareFailure"], message: "Typed prepare failure допустим и обязателен только для prepare" })
    }
    return
  }
  if (value.command === "events" ? value.events === undefined || value.fromCursor === undefined : value.events !== undefined || value.fromCursor !== undefined) {
    context.addIssue({ code: "custom", path: ["events"], message: "Events response требует batch и исходный cursor" })
  }
  for (const item of [value.snapshot.coverage, ...(value.events ?? [])]) {
    if (item.runtimeEpoch !== value.runtimeEpoch || item.loginSessionId !== value.loginSessionId || item.nativeGeneration !== value.nativeGeneration) {
      context.addIssue({ code: "custom", message: "Observer snapshot/event относится к другой generation" })
    }
  }
})

export type NativeObserverRequest = z.infer<typeof nativeObserverRequestSchema>
export type NativeObserverResponse = z.infer<typeof nativeObserverResponseSchema>
export type NativeObserverSnapshot = z.infer<typeof nativeObserverSnapshotSchema>

export function nativeObserverResponseMatches(request: NativeObserverRequest, response: NativeObserverResponse, buildId: string): boolean {
  if (response.requestId !== request.requestId || response.command !== request.command || response.nativeBuildId !== buildId
    || response.runtimeEpoch !== request.runtimeEpoch || response.loginSessionId !== request.loginSessionId || response.nativeGeneration !== request.nativeGeneration) return false
  if (!response.ok) return true
  if (request.command === "prepare") return response.snapshot.observerInstanceRef !== request.previousObserverInstanceRef
  return response.snapshot.observerInstanceRef === request.observerInstanceRef
    && (request.command !== "events" || response.fromCursor === request.afterCursor)
}
