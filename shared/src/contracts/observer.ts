import { z } from "zod"
import { generationIdSchema, opaqueIdSchema, operationTargetSchema } from "./identities.ts"
import { isoTimestampSchema } from "./schema.ts"

export const OBSERVER_STATES = ["ready", "unavailable", "revoked"] as const
export const observerStateSchema = z.enum(OBSERVER_STATES)
export type ObserverState = z.infer<typeof observerStateSchema>

export const OBSERVED_EVENT_SOURCES = ["synthetic", "external-user", "unknown"] as const
export const observedEventSourceSchema = z.enum(OBSERVED_EVENT_SOURCES)
export type ObservedEventSource = z.infer<typeof observedEventSourceSchema>

export const OBSERVED_EVENT_KINDS = ["input", "focus", "window-structure", "lifecycle"] as const
export const observedEventKindSchema = z.enum(OBSERVED_EVENT_KINDS)
export type ObservedEventKind = z.infer<typeof observedEventKindSchema>

export const LIFECYCLE_EVENTS = [
  "sleep",
  "wake",
  "lock",
  "unlock",
  "logout",
  "login-session-change",
] as const
export const lifecycleEventSchema = z.enum(LIFECYCLE_EVENTS)
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>

export const observerCoverageSchema = z.strictObject({
  state: observerStateSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  coverageStartCursor: opaqueIdSchema,
  cursor: opaqueIdSchema,
  nextSequence: z.number().int().safe().min(1),
  startedAt: isoTimestampSchema,
  coveredFrom: isoTimestampSchema,
  coveredThrough: isoTimestampSchema,
  heartbeatAt: isoTimestampSchema,
  lastEventAt: isoTimestampSchema.optional(),
  coveredKinds: z.array(observedEventKindSchema).max(OBSERVED_EVENT_KINDS.length),
  droppedEvents: z.number().int().safe().min(0),
  gapDetected: z.boolean(),
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((coverage, context) => {
  if (new Set(coverage.coveredKinds).size !== coverage.coveredKinds.length) {
    context.addIssue({ code: "custom", path: ["coveredKinds"], message: "coverage kind не должен повторяться" })
  }
  if (coverage.state !== "ready" && coverage.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "неready observer требует reason" })
  }
  if (coverage.state === "ready" && (coverage.gapDetected || coverage.droppedEvents > 0)) {
    context.addIssue({ code: "custom", message: "ready observer требует непрерывное coverage без drops" })
  }
  if (
    Date.parse(coverage.startedAt) > Date.parse(coverage.coveredFrom)
    || Date.parse(coverage.coveredFrom) > Date.parse(coverage.coveredThrough)
    || Date.parse(coverage.coveredThrough) > Date.parse(coverage.heartbeatAt)
  ) {
    context.addIssue({ code: "custom", message: "observer coverage timestamps нарушают monotonic interval" })
  }
})
export type ObserverCoverage = z.infer<typeof observerCoverageSchema>
export const observerStatusSchema = observerCoverageSchema
export type ObserverStatus = ObserverCoverage

export const observedEventSchema = z.strictObject({
  eventId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  cursor: opaqueIdSchema,
  sequence: z.number().int().safe().min(1),
  observedAt: isoTimestampSchema,
  kind: observedEventKindSchema,
  source: observedEventSourceSchema,
  target: operationTargetSchema.optional(),
  syntheticTag: opaqueIdSchema.optional(),
  lifecycle: lifecycleEventSchema.optional(),
  nextLoginSessionId: generationIdSchema.optional(),
}).superRefine((event, context) => {
  if (event.source === "synthetic" && event.syntheticTag === undefined) {
    context.addIssue({ code: "custom", path: ["syntheticTag"], message: "synthetic event требует tag" })
  }
  if (event.source !== "synthetic" && event.syntheticTag !== undefined) {
    context.addIssue({ code: "custom", path: ["syntheticTag"], message: "tag запрещён для несинтетического event" })
  }
  if (event.kind === "lifecycle" && event.lifecycle === undefined) {
    context.addIssue({ code: "custom", path: ["lifecycle"], message: "lifecycle event требует lifecycle value" })
  }
  if (event.kind !== "lifecycle" && event.lifecycle !== undefined) {
    context.addIssue({ code: "custom", path: ["lifecycle"], message: "lifecycle value допустим только для lifecycle event" })
  }
  if (event.lifecycle === "login-session-change" && event.nextLoginSessionId === undefined) {
    context.addIssue({ code: "custom", path: ["nextLoginSessionId"], message: "смена login session требует новый ID" })
  }
  if (event.lifecycle !== "login-session-change" && event.nextLoginSessionId !== undefined) {
    context.addIssue({ code: "custom", path: ["nextLoginSessionId"], message: "новый login ID допустим только при смене session" })
  }
  if (event.target !== undefined && (
    event.target.ref.runtimeEpoch !== event.runtimeEpoch
    || event.target.ref.loginSessionId !== event.loginSessionId
    || ("nativeGeneration" in event.target.ref && event.target.ref.nativeGeneration !== event.nativeGeneration)
  )) {
    context.addIssue({ code: "custom", path: ["target"], message: "observed target принадлежит другой generation" })
  }
})
export type ObservedEvent = z.infer<typeof observedEventSchema>

export type ObserverDecisionContext = {
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration: string
  interactionStartedAt: string
  expectedCoverageStartCursor: string
  now: Date
  maxLagMs: number
}

export function observerAllowsRestoration(
  coverage: ObserverCoverage,
  decision?: ObserverDecisionContext,
): boolean {
  if (decision === undefined || !Number.isFinite(decision.maxLagMs) || decision.maxLagMs < 0) return false
  const nowMs = decision.now.getTime()
  return coverage.state === "ready"
    && !coverage.gapDetected
    && coverage.droppedEvents === 0
    && coverage.coveredKinds.includes("input")
    && coverage.coveredKinds.includes("focus")
    && coverage.runtimeEpoch === decision.runtimeEpoch
    && coverage.loginSessionId === decision.loginSessionId
    && coverage.nativeGeneration === decision.nativeGeneration
    && coverage.coverageStartCursor === decision.expectedCoverageStartCursor
    && Date.parse(coverage.coveredFrom) <= Date.parse(decision.interactionStartedAt)
    && Date.parse(coverage.coveredThrough) >= nowMs - decision.maxLagMs
    && Date.parse(coverage.coveredThrough) <= Date.parse(coverage.heartbeatAt)
    && Date.parse(coverage.heartbeatAt) <= nowMs + 1_000
}

export const observerAllowsLeaseExtension = observerAllowsRestoration
