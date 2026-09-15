import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import { nativeInventoryRequestSchema, nativeInventoryResponseSchema } from "../src/protocol.ts"
import { nativeAxInspectionRequestSchema, nativeAxInspectionResponseSchema } from "../src/protocol.ts"
import { nativeInputExecutionRequestSchema, nativeInputExecutionResponseSchema, type NativeInputExecutionPayload } from "../src/protocol.ts"
import { heldInputLedgerDigest, type HeldInputLedgerSink, type HeldInputLedgerSnapshot } from "@meta/shared/contracts"
import { nativeClipboardRequestSchema } from "../src/clipboard-protocol.ts"
import { nativeWindowTransitionRequestSchema, nativeWindowTransitionResponseSchema } from "../src/protocol.ts"
import { NativeTransportStreamDecoder, encodeNativeFrame, type NativeTransportRequestFrame, type NativeTransportResponseFrame } from "../src/protocol.ts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-command-loop."))
  binary = join(directory, "fixture")
  const root = join(import.meta.dir, "..")
  const compile = Bun.spawn([
    "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    `-I${join(root, "include")}`, join(root, "src/command_loop.m"), join(root, "src/broker_transport.m"), join(root, "tests/command_backend_fixture.m"),
    ...["input_job.m", "input_executor.m", "executor.c", "ledger.c", "input_bridge.c", "operation-receipts/meta_operation_receipts.m"].map(file => join(root, "src", file)),
    "-framework", "Foundation", "-o", binary,
  ], { stderr: "pipe" })
  const [code, error] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (code !== 0) throw new Error(error)
}, 20_000)
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
    const permissions = await adapter.permissions({
      kind: "permissions", protocolVersion: "1", requestId: "passive-permissions", ...generation, deadlineAt,
    }, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(permissions.accessibility).toBe(true)
    expect(permissions.postEvents).toBe(false)
    expect(permissions.screenRecording).toBe(false)
    expect(permissions.inputMonitoring).toBe(false)
    expect(permissions.capabilities.producerRef).toBe(adapter.generation!.nativeGeneration)
    expect(permissions.codeIdentity).toEqual({ helperPath: "/tmp/command-fixture", cdhash: "1111111111111111111111111111111111111111" })
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

test.each([false, true])("parent EOF: physicalDown=%s, cleanup не ждёт исчезнувший durable ACK", async physicalDown => {
  const child = Bun.spawn([binary, "--event-log"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new NativeTransportStreamDecoder()
  const frames: NativeTransportResponseFrame[] = []
  const write = async (frame: NativeTransportRequestFrame) => {
    child.stdin.write(encodeNativeFrame(frame))
    await child.stdin.flush()
  }
  const next = async () => {
    while (frames.length === 0) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Fixture EOF до ожидаемого frame")
      for (const packet of decoder.push(chunk.value)) if (packet.kind === "message") frames.push(packet.frame)
    }
    return frames.shift()!
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await write({ channel: "handshake", payload: { kind: "handshake", protocolVersion: "1", requestId: "eof-handshake",
      runtimeEpoch: "runtime", loginSessionId: "login", runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" } })
    expect((await next()).channel).toBe("handshake")
    await write({ channel: "request", payload: inputRequest({ kind: "key", stroke: { keyCode: 37, flags: 0 } }) })
    const pending = await next()
    if (pending.channel !== "ledger-persist") throw new Error("Ожидался pending-down ledger")
    if (physicalDown) {
      const snapshot = pending.payload.snapshot
      await write({ channel: "ledger-ack", payload: { requestId: pending.payload.requestId, operationId: snapshot.operationId,
        runtimeEpoch: snapshot.runtimeEpoch, loginSessionId: snapshot.loginSessionId, nativeGeneration: snapshot.nativeGeneration,
        revision: snapshot.revision, snapshotSha256: heldInputLedgerDigest(snapshot), persistedAt: new Date().toISOString(), durable: true } })
      const confirmed = await next()
      if (confirmed.channel !== "ledger-persist") throw new Error("Ожидался confirmed-down ledger")
      expect(confirmed.payload.snapshot.entries[0]?.state).toBe("confirmed-down")
    }
    child.stdin.end()
    await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture не завершился после EOF")), 2500) })])
    const events = await stderr
    expect(events.split("\n").filter(line => line === "held:37:down")).toHaveLength(physicalDown ? 1 : 0)
    expect(events.split("\n").filter(line => line === "held:37:up")).toHaveLength(physicalDown ? 1 : 0)
    expect(events).toContain("terminal:quarantined:unknown")
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    await reader.cancel().catch(() => undefined)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 5000)

test("window transition и input используют один native fence high-water", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const input = inputRequest({ kind: "text", utf16Units: 1, clusters: [{ text: "A", utf16Units: 1, atMs: 0 }] })
    const request = nativeWindowTransitionRequestSchema.parse({
      ...input, requestId: "window-show", method: "window.transition",
      operation: { ...input.operation, operationId: "window-operation" },
      payload: { kind: "show", target: input.operation.target.ref },
    })
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const result = await adapter.request(nativeWindowTransitionRequestSchema, request, nativeWindowTransitionResponseSchema, control)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Window fixture не завершилась")
    expect(result.result.status.dispatchAttempts).toBe(1)
    expect(result.result.status.execution).toBe("finished")
    const replay = await adapter.request(nativeInputExecutionRequestSchema, input, nativeInputExecutionResponseSchema, control)
    expect(replay.ok).toBe(false)
    const next = nativeInputExecutionRequestSchema.parse({ ...input, requestId: "input-next",
      operation: { ...input.operation, operationId: "input-next-operation", fence: { ...input.operation.fence, counter: 2 } } })
    const accepted = await adapter.request(nativeInputExecutionRequestSchema, next, nativeInputExecutionResponseSchema, control)
    expect(accepted.ok).toBe(true)
    const old = await adapter.status({ requestId: "old-window-status", ...adapter.generation!,
      operationId: request.operation.operationId, deadlineAt: request.deadlineAt })
    expect(old.operationId).toBe("window-operation")
    expect(old.dispatchAttempts).toBe(1)
    expect(old.execution).toBe("finished")
    expect(old.highWaterFence?.counter).toBe(2)
    expect(old.restorationAllowed).toBe(false)
    const oldCancel = await adapter.cancel({ requestId: "old-window-cancel", ...adapter.generation!,
      operationId: request.operation.operationId, fence: request.operation.fence, deadlineAt: request.deadlineAt, reason: "проверка старого статуса" }, control)
    expect(oldCancel.stopped).toBe(true)
  } finally { await adapter.close() }
})

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

test("shortcut проводит последовательность через C executor и durable ledger", async () => {
  const adapter = createAdapter({ async persist(requestId, snapshot) {
    return { requestId, operationId: snapshot.operationId, runtimeEpoch: snapshot.runtimeEpoch,
      loginSessionId: snapshot.loginSessionId, nativeGeneration: snapshot.nativeGeneration, revision: snapshot.revision,
      snapshotSha256: heldInputLedgerDigest(snapshot), persistedAt: new Date().toISOString(), durable: true }
  } })
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "shortcut", strokes: [{ keyCode: 0, flags: 0 }, { keyCode: 1, flags: 0 }], delayMs: 10 })
    const result = await adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema,
      { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Shortcut fixture не завершилась")
    expect(result.result.completedSteps).toBe(2)
    expect(result.result.dispatchAttempts).toBe(4)
    expect(result.result.status.cleanup).toBe("complete")
  } finally { await adapter.close() }
})

test.each([false, true])("job heartbeat watchdog: keepalive=%s", async keepalive => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const request = inputRequest({ kind: "text", utf16Units: 2,
      clusters: [{ text: "A", utf16Units: 1, atMs: 0 }, { text: "B", utf16Units: 1, atMs: 1400 }] })
    const control = { signal: new AbortController().signal, checkpoint: () => undefined }
    const running = adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema, control)
    if (keepalive) {
      for (let index = 0; index < 6; index += 1) {
        await Bun.sleep(200)
        const heartbeat = await adapter.heartbeat({ requestId: `keepalive-${index}`, ...adapter.generation!, deadlineAt: request.deadlineAt }, control)
        expect(heartbeat.accepted).toBe(true)
      }
    }
    const result = await running
    expect(result.ok).toBe(keepalive)
    if (!result.ok) {
      expect(result.nativeStatus?.execution).toBe("cancelled")
      expect(result.nativeStatus?.dispatchAttempts).toBe(1)
      const late = await adapter.heartbeat({ requestId: "late-heartbeat", ...adapter.generation!, deadlineAt: request.deadlineAt }, control)
      expect(late.accepted).toBe(false)
    }
  } finally { await adapter.close() }
})

test("cancel до post после durable ACK закрывает ledger без событий и quarantine", async () => {
  let releaseAck!: () => void
  let notifyPending!: () => void
  const pending = new Promise<void>(resolve => { notifyPending = resolve })
  const release = new Promise<void>(resolve => { releaseAck = resolve })
  const persisted: HeldInputLedgerSnapshot[] = []
  const child = Bun.spawn([binary, "--event-log"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const events = new Response(child.stderr).text()
  const ledgerSink: HeldInputLedgerSink = { async persist(requestId, snapshot) {
    notifyPending()
    await release
    persisted.push(structuredClone(snapshot))
    return { requestId, operationId: snapshot.operationId, runtimeEpoch: snapshot.runtimeEpoch,
      loginSessionId: snapshot.loginSessionId, nativeGeneration: snapshot.nativeGeneration, revision: snapshot.revision,
      snapshotSha256: heldInputLedgerDigest(snapshot), persistedAt: new Date().toISOString(), durable: true }
  } }
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "command-test", capabilities: [] } },
    adapterInstanceRef: "command-adapter", ledgerSink,
    bindEvidence: () => ({ publisher: { publish: async () => { throw new Error("evidence не используется") } }, sourceResponses: { register: () => undefined } }),
    transport: {
      async send(frame) {
        child.stdin.write(encodeNativeFrame(frame))
        await child.stdin.flush()
      },
      async *packets(signal) {
        const reader = child.stdout.getReader()
        const decoder = new NativeTransportStreamDecoder()
        const abort = () => void reader.cancel(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        try {
          while (!signal.aborted) {
            const chunk = await reader.read()
            if (chunk.done) break
            yield* decoder.push(chunk.value)
          }
          decoder.finish()
        } finally {
          signal.removeEventListener("abort", abort)
          reader.releaseLock()
        }
      },
      async close() {
        child.stdin.end()
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 1500)
        try { await child.exited } finally { clearTimeout(timer) }
      },
    },
  })
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
    expect(result.nativeStatus).toMatchObject({
      execution: "cancelled", dispatch: "none", dispatchAttempts: 0,
      quarantined: false, cleanup: "complete", heldCount: 0, ledgerRevision: 2,
    })
    expect(result.error.code).toBe("cancelled")
    expect(persisted.map(snapshot => ({ revision: snapshot.revision, entries: snapshot.entries }))).toEqual([
      { revision: 1, entries: [{ sequence: 1, kind: "key", code: 37, state: "pending-down" }] },
      { revision: 2, entries: [{ sequence: 1, kind: "key", code: 37, state: "released" }] },
    ])
    expect(persisted[1]?.previousSnapshotSha256).toBe(heldInputLedgerDigest(persisted[0]!))
  } finally {
    releaseAck()
    await adapter.close()
  }
  const trace = await events
  expect(trace.split("\n").filter(line => line.startsWith("held:"))).toEqual([])
  expect(trace).toContain("terminal:cancelled:complete")
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

test("ax.inspect request проходит production action queue и сохраняет raw nodes", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const result = await adapter.request(nativeAxInspectionRequestSchema, {
      kind: "request", intent: "read", protocolVersion: "1", requestId: "inspect", ...adapter.generation!,
      deadlineAt: new Date(Date.now() + 1_000).toISOString(), method: "ax.inspect",
      payload: { target: { kind: "window", ref: { ...adapter.generation!, applicationRef: "application-fixture", windowRef: "window-fixture" } },
        depth: 2, maxNodes: 10, maxBytes: 4096 },
    }, nativeAxInspectionResponseSchema, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.nodes[0]?.title).toBe("Fixture button")
  } finally { await adapter.close() }
})
