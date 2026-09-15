import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import { nativeInventoryRequestSchema, nativeInventoryResponseSchema } from "../src/protocol.ts"
import { nativeInputExecutionRequestSchema, nativeInputExecutionResponseSchema, type NativeInputExecutionPayload } from "../src/protocol.ts"
import { heldInputLedgerDigest, type HeldInputLedgerSink } from "@meta/shared/contracts"
import { nativeClipboardRequestSchema } from "../src/clipboard-protocol.ts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-command-loop."))
  binary = join(directory, "fixture")
  const root = join(import.meta.dir, "..")
  const compile = Bun.spawn([
    "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    `-I${join(root, "include")}`, join(root, "src/command_loop.m"), join(root, "src/broker_transport.m"), join(root, "tests/command_backend_fixture.m"),
    ...["input_job.m", "input_executor.m", "executor.c", "ledger.c", "input_bridge.c"].map(file => join(root, "src", file)),
    "-framework", "Foundation", "-o", binary,
  ], { stderr: "pipe" })
  const [code, error] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (code !== 0) throw new Error(error)
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true }) })

function createAdapter(ledgerSink: HeldInputLedgerSink = { persist: async () => { throw new Error("ledger не используется") } }, args: string[] = []) {
  return new NativeBrokerAdapter({
    host: {
      generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "command-test", capabilities: [] },
    },
    adapterInstanceRef: "command-adapter", transport: new NativeProcessTransport(binary, args),
    ledgerSink,
    bindEvidence: () => ({ publisher: { publish: async () => { throw new Error("evidence не используется") } }, sourceResponses: { register: () => undefined } }),
  })
}

test("production command loop: verified handshake → coherent clipboard method → sealed drain", async () => {
  const adapter = createAdapter()
  try {
    const handshake = await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    expect(handshake.session).toEqual({ verified: false, source: "darwin-audit", uid: 501, effectiveUid: 501,
      reason: "Injected fixture не вызывает системный audit syscall" })
    const deadlineAt = new Date(Date.now() + 1_000).toISOString()
    const generation = adapter.generation!
    const response = await adapter.clipboard({
      kind: "request", protocolVersion: "1", requestId: "clipboard", ...generation, deadlineAt,
      operation: {
        kind: "clipboard", operationId: "operation", clientRequestId: "client-request", clientSessionId: "client", principalId: "principal",
        runtimeEpoch: "runtime", loginSessionId: "login", inventoryId: "inventory", inventoryRevision: 0, deadlineAt,
        target: { kind: "clipboard", ref: { runtimeEpoch: "runtime", loginSessionId: "login", clipboardRef: "system" } },
      },
      command: { method: "clipboard.version", payload: {} },
    }, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(response.ok && response.result).toEqual({ method: "clipboard.version", value: { status: "ok", changeCount: 7 } })
    const drain = await adapter.drain({ requestId: "drain", ...generation, deadlineAt }, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(drain.cleanup).toBe("complete")
    expect(drain.activeOperationIds).toEqual([])
  } finally { await adapter.close() }
})

function inputRequest(action: NativeInputExecutionPayload["action"]) {
  const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native-command-fixture" }
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  return nativeInputExecutionRequestSchema.parse({
    kind: "request", protocolVersion: "1", requestId: "input", ...generation, deadlineAt,
    method: "input.execute", intent: "mutation",
    operation: {
      kind: "native", operationId: "operation-input", clientRequestId: "client-request", clientSessionId: "client", principalId: "principal",
      ...generation, deadlineAt, inventoryId: "inventory", inventoryRevision: 1,
      fence: { ...generation, counter: 1 },
      target: { kind: "window", ref: { ...generation, applicationRef: "application-fixture", windowRef: "window-fixture" } },
    },
    payload: { actionDeadlineAt: deadlineAt, action },
  })
}

test("actual concurrent command loop: cancel останавливает C text executor между clusters", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "text", utf16Units: 4, clusters: [
      { text: "A", utf16Units: 1, atMs: 0 }, { text: "я", utf16Units: 1, atMs: 200 },
      { text: "B", utf16Units: 1, atMs: 600 }, { text: "C", utf16Units: 1, atMs: 1000 },
    ] })
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const running = adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema, control)
    await Bun.sleep(250)
    const cancel = await adapter.cancel({
      requestId: "cancel", ...adapter.generation!, operationId: request.operation.operationId,
      fence: request.operation.fence, deadlineAt: request.deadlineAt, reason: "test cancel",
    }, control)
    expect(cancel.acknowledged).toBe(true)
    const outcome = await running
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("Expected cancellation")
    expect(outcome.nativeStatus?.execution).toBe("cancelled")
    expect(outcome.nativeStatus?.cleanup).toBe("complete")
    expect(outcome.nativeStatus?.dispatchAttempts).toBeLessThan(4)
    const stopped = await adapter.cancel({
      requestId: "cancel-confirmed-stop", ...adapter.generation!, operationId: request.operation.operationId,
      fence: request.operation.fence, deadlineAt: request.deadlineAt, reason: "confirm stop",
    }, control)
    expect(stopped.stopped).toBe(true)
    expect(stopped.cleanup).toBe("complete")
    const before = outcome.nativeStatus?.dispatchAttempts
    if (before === undefined) throw new Error("Cancelled operation не сохранила dispatch counter")
    await Bun.sleep(40)
    const status = await adapter.status({ requestId: "status-after-stop", ...adapter.generation!, operationId: request.operation.operationId, deadlineAt: request.deadlineAt })
    expect(status.dispatchAttempts).toBe(before)
  } finally { await adapter.close() }
})

test("ledger ACK wait не блокирует control heartbeat и cancel до event post", async () => {
  let releaseAck!: () => void
  let notifyPending!: () => void
  const pending = new Promise<void>(resolve => { notifyPending = resolve })
  const release = new Promise<void>(resolve => { releaseAck = resolve })
  const adapter = createAdapter({ async persist(requestId, snapshot) {
    notifyPending()
    await release
    return { requestId, operationId: snapshot.operationId, runtimeEpoch: snapshot.runtimeEpoch,
      loginSessionId: snapshot.loginSessionId, nativeGeneration: snapshot.nativeGeneration, revision: snapshot.revision,
      snapshotSha256: heldInputLedgerDigest(snapshot), persistedAt: new Date().toISOString(), durable: true }
  } })
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "key", stroke: { keyCode: 37, flags: 0 } })
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const running = adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema, control)
    await pending
    const heartbeat = await adapter.heartbeat({ requestId: "heartbeat-during-ack", ...adapter.generation!, deadlineAt: request.deadlineAt }, control)
    expect(heartbeat.accepted).toBe(true)
    await adapter.cancel({ requestId: "cancel-during-ack", ...adapter.generation!, operationId: request.operation.operationId,
      fence: request.operation.fence, deadlineAt: request.deadlineAt, reason: "test cancel" }, control)
    releaseAck()
    const result = await running
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected cancellation before post")
    expect(result.nativeStatus?.dispatchAttempts).toBe(0)
    expect(result.nativeStatus?.quarantined).toBe(true)
    expect(result.error.code).toBe("resource-quarantined")
  } finally { releaseAck(); await adapter.close() }
})

test.each([false, true])("focused sheet: exact surface=%s; parent target never substitutes sheet", async exactSurface => {
  const adapter = createAdapter(undefined, ["--focused-sheet"])
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "text", utf16Units: 1, clusters: [{ text: "A", utf16Units: 1, atMs: 0 }] })
    if (exactSurface) request.operation.target = {
      kind: "surface", ref: { ...adapter.generation!, applicationRef: "application-fixture", surfaceRef: "sheet-fixture", ownerWindowRef: "window-fixture" },
    }
    const result = await adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema,
      { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(result.ok).toBe(exactSurface)
    if (!result.ok) {
      expect(result.error.code).toBe("target-stale")
      expect(result.nativeStatus?.execution).toBe("failed")
      expect(result.nativeStatus?.dispatchAttempts).toBe(0)
    }
  } finally { await adapter.close() }
})

test("rejected durable ledger poisons transport; late result cannot leave ready readerless session", async () => {
  const adapter = createAdapter({ persist: async () => { throw new Error("ledger rejected") } })
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "key", stroke: { keyCode: 37, flags: 0 } })
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    await expect(adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema, control)).rejects.toThrow("ledger rejected")
    expect(adapter.sessionState.state).toBe("poisoned")
    await expect(adapter.status({ requestId: "status-after-poison", ...adapter.generation!, deadlineAt: request.deadlineAt, operationId: request.operation.operationId })).rejects.toThrow("закрыт")
    await expect(adapter.cancel({ requestId: "cancel-after-poison", ...adapter.generation!, deadlineAt: request.deadlineAt, operationId: request.operation.operationId,
      fence: request.operation.fence, reason: "after poison" }, control)).rejects.toThrow("закрыт")
  } finally { await adapter.close() }
})

test("production command loop reports loaded build and rejects incompatible handshake", async () => {
  const adapter = createAdapter()
  try {
    await expect(adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "foreign-build", capabilitySchemaVersion: "1" })).rejects.toThrow("build")
    expect(adapter.generation).toBeUndefined()
  } finally { await adapter.close() }
})

test("clipboard-only 8MiB profile round-trips 1M NUL plaintext через actual framed loop", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    const base = {
      kind: "request" as const, protocolVersion: "1" as const, ...adapter.generation!, deadlineAt,
      operation: {
        kind: "clipboard" as const, operationId: "clipboard-operation", clientRequestId: "client-request", clientSessionId: "client", principalId: "principal",
        runtimeEpoch: "runtime", loginSessionId: "login", deadlineAt, inventoryId: "inventory", inventoryRevision: 0,
        target: { kind: "clipboard" as const, ref: { runtimeEpoch: "runtime", loginSessionId: "login", clipboardRef: "system" as const } },
      },
    }
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const text = "\0".repeat(1_000_000)
    const written = await adapter.clipboard(nativeClipboardRequestSchema.parse({ ...base, requestId: "large-write",
      command: { method: "clipboard.write", payload: { text, expectedChangeCount: 7 } } }), control)
    expect(written.ok).toBe(true)
    const read = await adapter.clipboard(nativeClipboardRequestSchema.parse({ ...base, requestId: "large-read",
      command: { method: "clipboard.read", payload: { maxBytes: 1_000_000 } } }), control)
    if (!read.ok || read.result.method !== "clipboard.read" || read.result.value.status !== "ok") throw new Error("clipboard read failed")
    expect(read.result.value.text).toBe(text)
    expect(read.result.value.utf8Bytes).toBe(1_000_000)
    expect(() => nativeClipboardRequestSchema.parse({ ...base, requestId: "too-large",
      command: { method: "clipboard.write", payload: { text: `${text}x` } } })).toThrow()
  } finally { await adapter.close() }
}, 20_000)

test("slow inventory не блокирует control heartbeat; drain sealed-pending не разрешает replacement", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const deadlineAt = new Date(Date.now() + 3_000).toISOString()
    const generation = adapter.generation!
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const inventory = adapter.request(nativeInventoryRequestSchema, {
      kind: "request", protocolVersion: "1", requestId: "inventory", ...generation,
      deadlineAt, intent: "read", method: "window.inventory", payload: {},
    }, nativeInventoryResponseSchema, control)
    await Bun.sleep(30)
    const startedAt = performance.now()
    const heartbeat = await adapter.heartbeat({ requestId: "heartbeat", ...generation, deadlineAt }, control)
    expect(heartbeat.accepted).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(400)
    const pending = await adapter.drain({ requestId: "drain-pending", ...generation, deadlineAt }, control)
    expect(pending.cleanup).toBe("unknown")
    expect((await inventory).ok).toBe(false)
    const completed = await adapter.drain({ requestId: "drain-completed", ...generation, deadlineAt }, control)
    expect(completed.cleanup).toBe("complete")
  } finally { await adapter.close() }
})
