import { expect, test } from "bun:test"
import { nativeObserverRequestSchema, nativeObserverResponseSchema, nativeObserverResponseMatches, nativeObserverGapEnvelopeSchema } from "../src/observer-protocol.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const timestamp = new Date().toISOString()
function snapshot() {
  return { observerInstanceRef: "observer-instance", inventoryId: "inventory", inventoryRevision: 1, indexRevision: 1,
    coverage: { ...generation, state: "ready" as const, coverageStartCursor: "start", cursor: "start", nextSequence: 1,
      startedAt: timestamp, coveredFrom: timestamp, coveredThrough: timestamp, heartbeatAt: timestamp,
      coveredKinds: ["input", "focus", "window-structure", "lifecycle"], droppedEvents: 0, gapDetected: false },
    sessionReadiness: { state: "active-console" as const, lockState: "unknown" as const, userId: 501, onConsole: true,
      loginDone: true, auditSessionId: 100, evidence: "Injected fixture", observedAt: timestamp }, secureInput: "off" as const }
}
const base = { ...generation, protocolVersion: "1", requestId: "request" }

test("observer lifecycle проверяет exact instance и cursor", () => {
  const request = nativeObserverRequestSchema.parse({ ...base, kind: "observer", command: "events", deadlineAt: timestamp,
    observerInstanceRef: "observer-instance", afterCursor: "start" })
  const response = nativeObserverResponseSchema.parse({ ...base, kind: "observer-response", command: "events", nativeBuildId: "build",
    ok: true, snapshot: snapshot(), fromCursor: "start", events: [] })
  expect(nativeObserverResponseMatches(request, response, "build")).toBe(true)
  expect(nativeObserverResponseMatches({ ...request, observerInstanceRef: "foreign" }, response, "build")).toBe(false)
  expect(nativeObserverResponseMatches({ ...request, afterCursor: "foreign" }, response, "build")).toBe(false)
})

test("subscription coverage не объявляет неизвестный lock state unlocked", () => {
  const value = snapshot()
  expect(nativeObserverResponseSchema.safeParse({ ...base, kind: "observer-response", command: "coverage", nativeBuildId: "build", ok: true,
    snapshot: { ...value, sessionReadiness: { ...value.sessionReadiness, state: "unknown" } } }).success).toBe(true)
  expect(nativeObserverResponseSchema.safeParse({ ...base, kind: "observer-response", command: "coverage", nativeBuildId: "build", ok: true,
    snapshot: { ...value, sessionReadiness: { ...value.sessionReadiness, lockState: "unlocked" } } }).success).toBe(false)
})

test("events из другой generation и лишний batch запрещены", () => {
  const response = { ...base, kind: "observer-response", command: "coverage", nativeBuildId: "build", ok: true, snapshot: snapshot() }
  expect(nativeObserverResponseSchema.safeParse({ ...response, fromCursor: "start" }).success).toBe(false)
  expect(nativeObserverResponseSchema.safeParse({ ...response, command: "events", fromCursor: "start", events: [{ ...generation,
    nativeGeneration: "foreign", eventId: "event", cursor: "next", sequence: 1, observedAt: timestamp, kind: "input", source: "unknown" }] }).success).toBe(false)
})

test("prepare/restart не переиспользует прошлый instance", () => {
  const request = nativeObserverRequestSchema.parse({ ...base, kind: "observer", command: "prepare", deadlineAt: timestamp,
    previousObserverInstanceRef: "observer-instance" })
  const response = nativeObserverResponseSchema.parse({ ...base, kind: "observer-response", command: "prepare", nativeBuildId: "build", ok: true, snapshot: snapshot() })
  expect(nativeObserverResponseMatches(request, response, "build")).toBe(false)
  expect(nativeObserverRequestSchema.safeParse({ ...request, observerInstanceRef: "observer-instance" }).success).toBe(false)
  expect(nativeObserverRequestSchema.safeParse({ ...base, kind: "observer", command: "events", deadlineAt: timestamp, observerInstanceRef: "instance" }).success).toBe(false)
})

test("prepare failure содержит typed cleanup proof без text inference", () => {
  const failure = { ...base, kind: "observer-response", command: "prepare", nativeBuildId: "build", ok: false,
    error: { code: "capability-unavailable", message: "Detailed diagnostics", stage: "native-observer-command",
      retryable: false, replayAllowed: false, recoveryAction: "inspect-health" },
    prepareFailure: { stage: "inventory", retryDisposition: "clean-no-instance", transient: true } }
  expect(nativeObserverResponseSchema.safeParse(failure).success).toBe(true)
  expect(nativeObserverResponseSchema.safeParse({ ...failure, prepareFailure: undefined }).success).toBe(false)
  expect(nativeObserverResponseSchema.safeParse({ ...failure, command: "coverage" }).success).toBe(false)
  expect(nativeObserverResponseSchema.safeParse({ ...failure,
    prepareFailure: { stage: "cleanup", retryDisposition: "unknown", transient: true } }).success).toBe(false)
})


test("observer fault — отдельный bounded envelope, не GUI event и не чужая generation", () => {
  const fault = { ...generation, observerInstanceRef: "observer-instance", gapReason: "fixture gap" }
  expect(nativeObserverGapEnvelopeSchema.safeParse(fault).success).toBe(true)
  expect(nativeObserverGapEnvelopeSchema.safeParse({ ...fault, observerInstanceRef: undefined }).success).toBe(false)
  expect(nativeObserverGapEnvelopeSchema.safeParse({ ...fault, gapReason: "x".repeat(1025) }).success).toBe(false)
  expect(nativeObserverGapEnvelopeSchema.safeParse({ ...fault, inputText: "not-allowed" }).success).toBe(false)
})
