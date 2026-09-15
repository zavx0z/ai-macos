import { expect, test } from "bun:test"
import {
  nativeCursorDisplayRequestSchema,
  nativeCursorDisplayResultSchema,
  nativeCursorDisplayResponseSchema,
  nativeCursorDisplayResultMatches,
} from "../src/cursor-display-protocol.ts"

const generation = { runtimeEpoch: "runtime:cursor", loginSessionId: "login:cursor", nativeGeneration: "native:cursor" }
const now = Date.now()
const request = nativeCursorDisplayRequestSchema.parse({
  kind: "request", protocolVersion: "1", requestId: "request:cursor", ...generation,
  deadlineAt: new Date(now + 1000).toISOString(), intent: "read", method: "input.cursor-display",
  payload: { inventoryId: "inventory:cursor", inventoryRevision: 2, displayLayoutRevision: 3 },
})
const result = nativeCursorDisplayResultSchema.parse({
  status: "resolved", ...generation, ...request.payload, sourceResponseRef: "source:cursor", observedAt: new Date(now).toISOString(),
  cursor: { x: -100, y: 50 }, displayRef: { ...generation, displayRef: "display:left", displayLayoutRevision: 3 },
})

test("cursor resolver — readonly exact snapshot без operation/fence/post flags", () => {
  expect(request.intent).toBe("read")
  expect(nativeCursorDisplayResultMatches(request, result)).toBe(true)
  expect(nativeCursorDisplayRequestSchema.safeParse({ ...request, operation: {} }).success).toBe(false)
  expect(nativeCursorDisplayRequestSchema.safeParse({ ...request, payload: { ...request.payload, post: true } }).success).toBe(false)
})

test("resolved display не переносится между revisions или native generations", () => {
  if (result.status !== "resolved") throw new Error("Resolved fixture expected")
  expect(nativeCursorDisplayResultMatches(request, { ...result, inventoryRevision: 4 })).toBe(false)
  expect(nativeCursorDisplayResultSchema.safeParse({ ...result, displayRef: { ...result.displayRef, displayLayoutRevision: 4 } }).success).toBe(false)
  const response = { kind: "response", protocolVersion: "1", requestId: request.requestId, ...generation, ok: true, result }
  expect(nativeCursorDisplayResponseSchema.safeParse(response).success).toBe(true)
  expect(nativeCursorDisplayResponseSchema.safeParse({ ...response, result: { ...result, displayRef: { ...result.displayRef, nativeGeneration: "native:other" } } }).success).toBe(false)
  expect(nativeCursorDisplayResponseSchema.safeParse({ ...response, operationId: "operation:invented" }).success).toBe(false)
})

test("ambiguous/unavailable/stale сохраняют trace ref, но не содержат выбранный display", () => {
  for (const status of ["ambiguous", "unavailable", "stale-inventory"] as const) {
    expect(nativeCursorDisplayResultSchema.safeParse({ status, sourceResponseRef: "trace:cursor", reason: "Точный display не подтверждён" }).success).toBe(true)
    expect(nativeCursorDisplayResultSchema.safeParse({ status, sourceResponseRef: "trace:cursor", reason: "Точный display не подтверждён", displayRef: "first-display" }).success).toBe(false)
  }
})
