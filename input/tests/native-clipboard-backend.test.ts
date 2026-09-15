import { describe, expect, test } from "bun:test"
import type {
  ClipboardExecutionContext,
  RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  NativeVersionedClipboardBackend,
  type NativeClipboardClient,
} from "../src/native-clipboard-backend.ts"

const runtimeEpoch = "runtime:clipboard"
const loginSessionId = "login:clipboard"
const nativeGeneration = "native:clipboard"
const deadlineAt = "2026-09-15T10:01:00.000Z"
const wire: ClipboardExecutionContext = {
  kind: "clipboard",
  operationId: "operation:clipboard",
  clientRequestId: "client-request:clipboard",
  clientSessionId: "client:clipboard",
  principalId: "principal:clipboard",
  runtimeEpoch,
  loginSessionId,
  inventoryId: "inventory:clipboard",
  inventoryRevision: 1,
  deadlineAt,
  target: { kind: "clipboard", ref: { runtimeEpoch, loginSessionId, clipboardRef: "system" } },
}
const context: RuntimeOperationContext<ClipboardExecutionContext> = {
  wire,
  session: {
    clientSessionId: wire.clientSessionId,
    principalId: wire.principalId,
    runtimeEpoch,
    loginSessionId,
    authenticationGeneration: "auth:clipboard",
    authenticatedAt: "2026-09-15T09:59:00.000Z",
    expiresAt: "2026-09-15T10:10:00.000Z",
  },
  resources: [],
  control: {
    signal: new AbortController().signal,
    checkpoint: () => undefined,
  },
}

type ClipboardCall = NativeClipboardClient["clipboard"]

function client(handler: ClipboardCall): NativeClipboardClient {
  return {
    adapterInstanceRef: "native-adapter:clipboard",
    loadedBuildId: "native-build:clipboard",
    generation: { runtimeEpoch, loginSessionId, nativeGeneration },
    clipboard: handler,
  }
}

function response(request: any, value: unknown) {
  return {
    kind: "response" as const,
    protocolVersion: "1" as const,
    requestId: request.requestId,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    operationId: wire.operationId,
    ok: true as const,
    result: { method: request.command.method, value },
  }
}

describe("C3 native versioned clipboard backend", () => {
  test("создаёт verified metadata receipt без explicit read payload", async () => {
    const backend = new NativeVersionedClipboardBackend(client(async request => {
      return response(request, {
        status: "ok",
        text: "секрет native read",
        utf8Bytes: 24,
        beforeChangeCount: 5,
        afterChangeCount: 5,
      }) as any
    }), purpose => `${purpose}:1`)
    const call = await backend.readText(context, 1_000_000)

    expect(call.value).toMatchObject({ status: "ok", text: "секрет native read" })
    expect(call.report).toMatchObject({
      authority: "verified-response",
      command: "clipboard.read",
      status: "ok",
      beforeChangeCount: 5,
      afterChangeCount: 5,
      receipt: {
        backendBuildId: "native-build:clipboard",
        nativeGeneration,
        operationId: wire.operationId,
      },
    })
    expect(JSON.stringify(call.report)).not.toContain("секрет native read")
    await expect(backend.verifyReport(call.report)).resolves.toBeUndefined()
    await expect(backend.verifyReport({ ...call.report, afterChangeCount: 6 })).rejects.toThrow("не зарегистрирован")
  })

  test("conditional write передаёт optimistic expected count без CAS claim", async () => {
    let captured: any
    const backend = new NativeVersionedClipboardBackend(client(async request => {
      captured = request
      return response(request, {
        status: "written",
        beforeChangeCount: 7,
        declaredChangeCount: 8,
        afterChangeCount: 8,
        mutationAttempted: true,
        setStringSucceeded: true,
        ownershipStableAfterWrite: true,
        atomicPrecondition: false,
        utf8Bytes: 5,
      }) as any
    }), purpose => `${purpose}:write`)
    const call = await backend.conditionalWrite(context, "value", 7)

    expect(captured.command).toEqual({
      method: "clipboard.write",
      payload: { text: "value", expectedChangeCount: 7 },
    })
    expect(call.report).toMatchObject({
      status: "written",
      mutationAttempted: "true",
      atomicPrecondition: false,
      beforeChangeCount: 7,
      declaredChangeCount: 8,
      afterChangeCount: 8,
    })
    expect(JSON.stringify(call.report)).not.toContain("value")
  })

  test("correlated native error получает verified receipt и redacted contract", async () => {
    const backend = new NativeVersionedClipboardBackend(client(async request => ({
      kind: "response",
      protocolVersion: "1",
      requestId: request.requestId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      operationId: wire.operationId,
      ok: false,
      error: {
        code: "invalid-request",
        message: `rejected ${request.command.method === "clipboard.write" ? request.command.payload.text : ""}`,
        stage: "native-clipboard",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "none",
      },
    }) as any), purpose => `${purpose}:error`)

    await expect(backend.conditionalWrite(context, "секрет error", undefined)).rejects.toMatchObject({
      message: "Native clipboard вернул structured error; payload исключён",
      contract: { message: "Native clipboard write завершился ошибкой; payload исключён" },
      report: { authority: "verified-response", status: "native-error", receipt: { receiptId: "receipt:error" } },
    })
  })

  test("lost reply остаётся unverified и не сохраняет write payload", async () => {
    const backend = new NativeVersionedClipboardBackend(client(async request => {
      throw new Error(`lost ${request.command.method === "clipboard.write" ? request.command.payload.text : ""}`)
    }), purpose => `${purpose}:lost`)

    try {
      await backend.conditionalWrite(context, "секрет lost", 3)
      throw new Error("Ожидалась ошибка lost reply")
    } catch (error) {
      expect(error).toMatchObject({
        message: "Native clipboard response недоступен; payload исключён",
        report: {
          authority: "unverified-request",
          status: "response-unavailable",
          mutationAttempted: "unknown",
        },
      })
      expect(JSON.stringify(error)).not.toContain("секрет lost")
    }
  })
})
