import { expect, test } from "bun:test"
import { nativeHitTestRequestSchema, nativeHitTestResultSchema, nativeHitTestResultMatches } from "../src/hit-test-protocol.ts"
import { extractNativeEvidenceReports } from "../src/evidence-extractor.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const timestamp = new Date().toISOString()
const point = { x: 10, y: 20 }
const display = { ...generation, displayRef: "display", displayLayoutRevision: 1 }
const window = { kind: "window" as const, ref: { ...generation, applicationRef: "app", windowRef: "window" } }
const observationRef = { observationId: "observation", inventoryRevision: 1, displayLayoutRevision: 1, proofRef: "proof" }
const operation = { kind: "native" as const, ...generation, operationId: "operation", clientRequestId: "client-request", clientSessionId: "client",
  principalId: "principal", inventoryId: "inventory", inventoryRevision: 1, observationRef, target: window,
  fence: { ...generation, counter: 1 }, deadlineAt: timestamp }
const request = { kind: "request", protocolVersion: "1", ...generation, requestId: "hit", intent: "read", method: "input.hit-test", deadlineAt: timestamp,
  operation, payload: { observationRef, frameRef: "frame", imagePoint: point, interactionTarget: window, expectedRegionIndex: 0, expectedDestinationPoint: point } }
const common = { status: "confirmed", sourceResponseRef: "source", operationId: "operation", inventoryId: "inventory", inventoryRevision: 1,
  displayLayoutRevision: 1, observedAt: timestamp, observationId: "observation", frameRef: "frame", regionIndex: 0, imagePoint: point,
  destinationPoint: point, space: { kind: "macos-screen", display }, frameTimestamp: timestamp, topologyUnchanged: true }

test("readonly hit сохраняет existing operation/fence и exact AX owner", () => {
  const parsed = nativeHitTestRequestSchema.parse(request)
  const result = nativeHitTestResultSchema.parse({ ...common, scope: "window", interactionTarget: window, hitOwnerTarget: window,
    focusedTarget: window, hitRelation: "owned-descendant", focusRelation: "target", frameUnchanged: true })
  expect(parsed.intent).toBe("read")
  expect(nativeHitTestResultMatches(parsed, result)).toBe(true)
  expect(nativeHitTestRequestSchema.safeParse({ ...request, payload: { ...request.payload, observationRef: { ...observationRef, observationId: "foreign" } } }).success).toBe(false)
})

test("display scope не выдумывает AX focus и не принимает window fallback", () => {
  const target = { kind: "display", ref: display }
  const broad = { ...common, scope: "display", interactionTarget: target, hitOwnerTarget: target,
    hitRelation: "display-contained", focusRelation: "not-required-display-focus" }
  expect(nativeHitTestResultSchema.safeParse(broad).success).toBe(true)
  expect(nativeHitTestResultSchema.safeParse({ ...broad, interactionTarget: window, hitOwnerTarget: window }).success).toBe(false)
  expect(nativeHitTestResultSchema.safeParse({ ...broad, focusedTarget: window }).success).toBe(false)
})

test("stale result не содержит positive source fact", () => {
  expect(nativeHitTestResultSchema.safeParse({ status: "observation-stale", reason: "Геометрия изменилась" }).success).toBe(true)
  expect(nativeHitTestResultSchema.safeParse({ status: "observation-stale", reason: "Геометрия изменилась", sourceResponseRef: "source" }).success).toBe(false)
})

test("source extractor выдаёт point-hit только из confirmed raw response", () => {
  const result = { ...common, scope: "window", interactionTarget: window, hitOwnerTarget: window,
    focusedTarget: window, hitRelation: "exact", focusRelation: "target", frameUnchanged: true }
  const frame = { channel: "response", payload: { kind: "response", protocolVersion: "1", requestId: "hit", ...generation,
    operationId: "operation", ok: true, result } }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  expect(extractNativeEvidenceReports(encode(frame))[0]?.factKind).toBe("point-hit")
  expect(extractNativeEvidenceReports(encode({ ...frame, payload: { ...frame.payload, result: { status: "observation-stale", reason: "Геометрия изменилась" } } }))).toEqual([])
  expect(() => extractNativeEvidenceReports(encode({ ...frame, payload: { ...frame.payload, operationId: "foreign" } }))).toThrow("другой operation")
})
