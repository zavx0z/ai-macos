import { expect, test } from "bun:test"
import { nativeClipboardResponseSchema } from "@meta/native/protocol"
import type { NativeClipboardClient } from "@meta/input/native-clipboard-backend"
import { RuntimeCore } from "../src/core.ts"
import { RuntimeClipboardHandler } from "../src/clipboard-handler.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adapterResultSchema, operationRecordSchema, opaqueIdSchema, z } from "@meta/shared/contracts"
import { clipboardRequestSchema, clipboardResultSchema } from "@meta/input/clipboard-adapter"
import { MethodRegistry } from "../src/method-registry.ts"
import { RuntimeUdsClient, RuntimeUdsServer } from "../src/transport.ts"

for (const mode of ["written", "mismatch", "partial", "lost"] as const) {
  test(`registered clipboard handler: ${mode}`, async () => {
    const generation = { runtimeEpoch: "runtime:clipboard-handler", loginSessionId: "login:clipboard-handler" }
    let handler!: RuntimeClipboardHandler
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:clipboard-handler", completionVerifier: {
      verify: (context, result) => handler.verify(context, result),
    } })
    const secret = "private clipboard payload"
    let calls = 0
    const native: NativeClipboardClient = {
      adapterInstanceRef: "native:clipboard-handler", loadedBuildId: "build:native-clipboard",
      generation: { ...generation, nativeGeneration: "native-generation:clipboard" },
      async clipboard(request) {
        calls++
        if (mode === "lost") throw new Error(`reply lost ${secret}`)
        const value = mode === "written" ? {
          status: "written", beforeChangeCount: 4, declaredChangeCount: 5, afterChangeCount: 5,
          mutationAttempted: true, setStringSucceeded: true, ownershipStableAfterWrite: true,
          atomicPrecondition: false, utf8Bytes: new TextEncoder().encode(secret).byteLength,
        } : mode === "mismatch" ? {
          status: "precondition-mismatch-no-dispatch", beforeChangeCount: 8, mutationAttempted: false, atomicPrecondition: false,
        } : {
          status: "partial-or-unknown", beforeChangeCount: 4, declaredChangeCount: 5, afterChangeCount: 6,
          mutationAttempted: true, setStringSucceeded: true, ownershipStableAfterWrite: false,
          atomicPrecondition: false, utf8Bytes: new TextEncoder().encode(secret).byteLength,
        }
        return nativeClipboardResponseSchema.parse({
          kind: "response", protocolVersion: "1", requestId: request.requestId,
          runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration,
          operationId: request.operation.operationId, ok: true,
          result: { method: request.command.method, value },
        })
      },
    }
    handler = new RuntimeClipboardHandler(core, native)
    const client = core.openClient("principal:clipboard-handler")
    const request = { kind: "write" as const, text: secret, expectedVersion: { backendBuildId: native.loadedBuildId, changeCount: 4 } }
    const result = await handler.execute(client.session, "request:clipboard", request)
    expect(calls).toBe(1)
    expect(result.result).not.toHaveProperty("clipboard")
    expect(JSON.stringify(result.operation)).not.toContain(secret)
    expect(JSON.stringify(handler.report(result.operation.context.operationId))).not.toContain(secret)
    expect(result.operation.outcome.cleanup.state).toBe(mode === "written" || mode === "mismatch" ? "complete" : "unknown")
    expect(result.result.ok).toBe(mode === "written")
    const repeated = await handler.execute(client.session, "request:clipboard", request)
    expect(repeated.operation.context.operationId).toBe(result.operation.context.operationId)
    expect(calls).toBe(1)
    if (mode === "mismatch") expect(result.operation.outcome.dispatch).toBe("none")
    if (mode === "partial" || mode === "lost") expect(core.resources.quarantinedCount()).toBe(1)
  })
}

test("clipboard serialized 8MiB profile returns 1M control characters and propagates partial isError through UDS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipboard-method-"))
  const generation = { runtimeEpoch: "runtime:clipboard-wire", loginSessionId: "login:clipboard-wire" }
  let handler!: RuntimeClipboardHandler
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:clipboard-wire", completionVerifier: { verify: (context, result) => handler.verify(context, result) } })
  const text = "\u0000".repeat(1_000_000)
  const native: NativeClipboardClient = {
    adapterInstanceRef: "native:clipboard-wire", loadedBuildId: "build:native-wire", generation: { ...generation, nativeGeneration: "native:wire" },
    async clipboard(request) {
      const value = request.command.method === "clipboard.read"
        ? { status: "ok", text, utf8Bytes: 1_000_000, beforeChangeCount: 1, afterChangeCount: 1 }
        : { status: "partial-or-unknown", beforeChangeCount: 1, declaredChangeCount: 2, afterChangeCount: 3,
            mutationAttempted: true, setStringSucceeded: true, ownershipStableAfterWrite: false, atomicPrecondition: false, utf8Bytes: 3 }
      return nativeClipboardResponseSchema.parse({ kind: "response", protocolVersion: "1", requestId: request.requestId,
        runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration,
        operationId: request.operation.operationId, ok: true, result: { method: request.command.method, value } })
    },
  }
  handler = new RuntimeClipboardHandler(core, native)
  const registry = new MethodRegistry(core)
  registry.register("clipboard_fixture", {
    title: "Clipboard", description: "Native clipboard handler", readOnly: false, destructive: true,
    input: z.strictObject({ clientRequestId: opaqueIdSchema, request: clipboardRequestSchema }),
    output: z.strictObject({ operation: operationRecordSchema, result: adapterResultSchema(clipboardResultSchema) }),
    maxRequestBytes: 8 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024,
    isError: result => !result.result.ok,
    execute: (context, args) => handler.execute(context.session, args.clientRequestId, args.request, context.signal),
  })
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const server = new RuntimeUdsServer({ socketPath, credentialPath, core, catalog: registry })
  try {
    await server.start()
    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    await client.open("clipboard-wire")
    const read = await client.callTool("clipboard_fixture", { clientRequestId: "read:large", request: { kind: "read" } }, new AbortController().signal)
    expect(read.isError).toBe(false)
    expect(read.structuredContent).toMatchObject({ result: { ok: true, value: { text } } })
    expect(JSON.stringify(read.structuredContent?.operation)).not.toContain("\\u0000")
    const partial = await client.callTool("clipboard_fixture", { clientRequestId: "write:partial", request: { kind: "write", text: "sec" } }, new AbortController().signal)
    expect(partial.isError).toBe(true)
    expect(partial.structuredContent).toMatchObject({ result: { ok: false }, operation: { state: "failed" } })
    expect(JSON.stringify(partial)).not.toContain('"text":"sec"')
    expect(core.resources.quarantinedCount()).toBe(1)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})
