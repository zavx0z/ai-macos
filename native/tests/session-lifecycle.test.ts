import { expect, test } from "bun:test"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import { NativeSessionLifecycle, type NativeRotationAuthority } from "../src/session-lifecycle.ts"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "../src/protocol.ts"

const host = {
  generation: { runtimeEpoch: "runtime-rotation", loginSessionId: "login-rotation" },
  runtimeBuildId: "runtime-build",
  capabilities: { schemaVersion: "1" as const, scope: "adapter" as const, producerRef: "rotation-test", capabilities: [] },
}

class RotationTransport implements NativeTransport {
  readonly stream = new TransformStream<NativeTransportPacket, NativeTransportPacket>()
  readonly writer = this.stream.writable.getWriter()
  closed = false
  sent = 0
  constructor(readonly generationId: string, readonly complete = true) {}

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    this.sent += 1
    const generation = { ...host.generation, nativeGeneration: this.generationId }
    if (frame.channel === "handshake") {
      await this.writer.write({ kind: "message", frame: { channel: "handshake", payload: {
        kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId,
        ...generation, nativeBuildId: "native-build", capabilitySchemaVersion: "1",
        installRoot: "/tmp/rotation-fixture", process: { pid: 123, nonce: "fixture", startedAt: new Date().toISOString() },
        capabilities: host.capabilities,
      } } })
    } else if (frame.channel === "permissions") {
      await this.writer.write({ kind: "message", frame: { channel: "permissions", payload: {
        kind: "permissions-response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
        nativeBuildId: "native-build", accessibility: false, postEvents: false, screenRecording: false,
      } } })
    } else if (frame.channel === "heartbeat") {
      await this.writer.write({ kind: "message", frame: { channel: "heartbeat", payload: {
        requestId: frame.payload.requestId, ...generation, accepted: true,
        acknowledgedAt: new Date().toISOString(), quarantined: false,
      } } })
    } else if (frame.channel === "drain") {
      await this.writer.write({ kind: "message", frame: { channel: "drain", payload: {
        requestId: frame.payload.requestId, ...generation, accepted: true,
        activeOperationIds: this.complete ? [] : ["unresolved-operation"],
        cleanup: this.complete ? "complete" : "unknown", quarantined: !this.complete,
      } } })
    }
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    const reader = this.stream.readable.getReader()
    const abort = () => { void reader.cancel() }
    signal.addEventListener("abort", abort, { once: true })
    try {
      while (!signal.aborted) {
        const item = await reader.read()
        if (item.done) return
        yield item.value
      }
    } finally {
      signal.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  }

  async close(): Promise<void> { this.closed = true }
}

async function adapter(generationId: string, complete = true) {
  const transport = new RotationTransport(generationId, complete)
  const value = new NativeBrokerAdapter({
    host, transport, adapterInstanceRef: `adapter-${generationId}`,
    ledgerSink: { persist: async () => { throw new Error("ledger не используется") } },
    bindEvidence: () => ({
      publisher: { publish: async () => { throw new Error("evidence не используется") } },
      sourceResponses: { register: () => { throw new Error("source не используется") } },
    }),
  })
  await value.handshake({
    kind: "handshake", protocolVersion: "1", requestId: "handshake-initial", ...host.generation,
    runtimeBuildId: "runtime-build", expectedNativeBuildId: "native-build", capabilitySchemaVersion: "1",
  })
  return { value, transport }
}

function authority(events: string[], factory: () => Promise<NativeBrokerAdapter>): NativeRotationAuthority {
  return {
    async prepare(current) {
      events.push("prepare")
      return {
        request: { requestId: "drain-rotation", ...current.generation!, deadlineAt: new Date(Date.now() + 1_000).toISOString() },
        control: { signal: new AbortController().signal, checkpoint: () => undefined },
      }
    },
    async retainAndAuthorize() { events.push("retain-terminal-receipts") },
    async createReplacement() {
      events.push("new-handshake")
      return await factory()
    },
    async invalidateAndReinventory() { events.push("invalidate-and-reinventory") },
    async quarantine() { events.push("quarantine") },
  }
}

test("request admission сообщает rotation до cap; runtime сохраняет receipts до новой generation", async () => {
  const current = await adapter("native-old")
  const control = { signal: new AbortController().signal, checkpoint: () => undefined }
  for (let index = 0; index < 8_999; index += 1) {
    await current.value.permissions({
      kind: "permissions", protocolVersion: "1", requestId: `permissions-${index}`, ...current.value.generation!, deadlineAt: new Date(Date.now() + 2_000).toISOString(),
    }, control)
  }
  expect(current.value.sessionState.state).toBe("rotation-required")
  const events: string[] = []
  const next = await new NativeSessionLifecycle(authority(events, async () => {
    expect(current.transport.closed).toBe(true)
    return (await adapter("native-new")).value
  })).rotate(current.value)
  expect(events).toEqual(["prepare", "retain-terminal-receipts", "new-handshake", "invalidate-and-reinventory"])
  expect(next.sessionState.requestsUsed).toBe(1)
  expect(next.sessionState.state).toBe("ready")
  await expect(next.heartbeat({
    requestId: "old-generation-replay", ...current.value.generation!, deadlineAt: new Date(Date.now() + 1_000).toISOString(),
  }, control)).rejects.toThrow("другой generation")
  await next.close()
}, 15_000)

test("unknown drain запрещает replacement и сохраняет прежний helper", async () => {
  const current = await adapter("native-unknown", false)
  const events: string[] = []
  await expect(new NativeSessionLifecycle(authority(events, async () => {
    throw new Error("factory не должна выполняться")
  })).rotate(current.value)).rejects.toThrow("quiescence")
  expect(events).toEqual(["prepare", "quarantine"])
  expect(current.transport.closed).toBe(false)
  await current.value.close()
})

test("pending binary запрещает rotation до drain и не освобождает данные", async () => {
  const current = await adapter("native-binary")
  await current.transport.writer.write({ kind: "binary", binaryToken: "frame-in-flight", bytes: new Uint8Array([1]) })
  const events: string[] = []
  await expect(new NativeSessionLifecycle(authority(events, async () => {
    throw new Error("factory не должна выполняться")
  })).rotate(current.value)).rejects.toThrow("binaries")
  expect(current.transport.closed).toBe(false)
  expect(await current.value.takeBinary("frame-in-flight", 1)).toEqual(new Uint8Array([1]))
  await current.value.close()
})
