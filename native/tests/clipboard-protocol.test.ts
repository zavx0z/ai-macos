import { expect, test } from "bun:test"
import {
  nativeClipboardRequestSchema, nativeClipboardReadResultSchema,
  nativeClipboardWriteResultSchema, nativeClipboardResponseSchema, clipboardResponseMatches,
} from "../src/clipboard-protocol.ts"

function request() {
  const generation = { runtimeEpoch: "runtime", loginSessionId: "login" }
  const deadlineAt = new Date(Date.now() + 1_000).toISOString()
  return nativeClipboardRequestSchema.parse({
    kind: "request", protocolVersion: "1", requestId: "request", ...generation,
    nativeGeneration: "native", deadlineAt,
    operation: {
      kind: "clipboard", operationId: "operation", clientRequestId: "client-request",
      clientSessionId: "client", principalId: "principal", ...generation,
      inventoryId: "inventory", inventoryRevision: 0, deadlineAt,
      target: { kind: "clipboard", ref: { ...generation, clipboardRef: "system" } },
    },
    command: { method: "clipboard.write", payload: { text: "Привет", expectedChangeCount: 7 } },
  })
}

test("clipboard transport сохраняет общий clipboard context без native fence", () => {
  const parsed = request()
  expect(parsed.operation.kind).toBe("clipboard")
  expect("fence" in parsed.operation).toBe(false)
  expect(() => nativeClipboardRequestSchema.parse({ ...parsed, loginSessionId: "foreign" })).toThrow()
})

test("coherent read сохраняет empty text и отвергает changed read с payload", () => {
  expect(nativeClipboardReadResultSchema.parse({ status: "ok", text: "", utf8Bytes: 0, beforeChangeCount: 1, afterChangeCount: 1 }).status).toBe("ok")
  expect(() => nativeClipboardReadResultSchema.parse({ status: "ok", text: "value", utf8Bytes: 5, beforeChangeCount: 1, afterChangeCount: 2 })).toThrow()
  expect(() => nativeClipboardReadResultSchema.parse({ status: "changed-during-read", text: "stale", beforeChangeCount: 1, afterChangeCount: 2 })).toThrow()
})

test("write never promises atomic CAS and retains partial outcome without text", () => {
  const value = nativeClipboardWriteResultSchema.parse({
    status: "partial-or-unknown", mutationAttempted: true, beforeChangeCount: 7,
    declaredChangeCount: 8, afterChangeCount: 9, setStringSucceeded: false,
    ownershipStableAfterWrite: false, atomicPrecondition: false, utf8Bytes: 12,
  })
  expect(() => nativeClipboardWriteResultSchema.parse({ ...value, atomicPrecondition: true })).toThrow()
  const parsed = request()
  const response = nativeClipboardResponseSchema.parse({
    kind: "response", protocolVersion: "1", requestId: parsed.requestId,
    runtimeEpoch: parsed.runtimeEpoch, loginSessionId: parsed.loginSessionId,
    nativeGeneration: parsed.nativeGeneration, operationId: parsed.operation.operationId,
    ok: true, result: { method: "clipboard.write", value },
  })
  expect(clipboardResponseMatches(parsed, response)).toBe(true)
  expect(JSON.stringify(response)).not.toContain("Привет")
  expect(clipboardResponseMatches(parsed, { ...response, nativeGeneration: "foreign" })).toBe(false)
})
