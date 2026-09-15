import { expect, test } from "bun:test"
import { canonicalRecoveryJson, type NativeRecoveryDescriptor, type NativeRecoveryGrant, type NativeExecutionContext, type ClipboardExecutionContext } from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import { nativeInputReadinessRequestSchema, nativeInputReadinessResponseSchema, nativeHitTestRequestSchema, nativeHitTestResponseSchema,
  type NativeTransportPacket, type NativeTransportRequestFrame } from "../src/protocol.ts"
import { nativeClipboardRequestSchema } from "../src/clipboard-protocol.ts"
import { classifyNativeRecoveryDescriptor } from "../src/recovery-domain-classifier.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalRecoveryJson(value)).digest("hex")
function grant(wire: NativeExecutionContext | ClipboardExecutionContext, descriptor: NativeRecoveryDescriptor): NativeRecoveryGrant {
  return { policyVersion: "1", ...generation, operationId: wire.operationId,
    contextSha256: digest(wire), descriptor, descriptorSha256: digest(descriptor), journalRevision: 1, durable: true }
}

class Transport implements NativeTransport {
  sent: NativeTransportRequestFrame[] = []
  queue: NativeTransportPacket[] = []
  waiters: Array<(packet: NativeTransportPacket) => void> = []
  constructor(readonly version: boolean) {}
  async send(frame: NativeTransportRequestFrame) {
    this.sent.push(frame)
    let packet: NativeTransportPacket
    if (frame.channel === "handshake") {
      packet = { kind: "message", frame: { channel: "handshake", payload: {
        kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
        nativeBuildId: "build", capabilitySchemaVersion: "1", installRoot: "/tmp/recovery-fixture",
        process: { pid: 1, startedAt: new Date().toISOString(), nonce: "nonce" },
        capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "fixture", capabilities: [] },
        ...(this.version ? { recoveryDomainVersion: "1" as const } : {}),
      } } }
    } else if (frame.channel === "request" || frame.channel === "clipboard") {
      packet = { kind: "message", frame: { channel: frame.channel === "clipboard" ? "clipboard" : "response", payload: {
        kind: "response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
        ...(!("operation" in frame.payload) || frame.payload.operation === undefined ? {} : { operationId: frame.payload.operation.operationId }),
        ok: false, error: { code: "unsupported-capability", message: "Fixture не отправляет input", stage: "fixture", retryable: false, replayAllowed: false, recoveryAction: "none" },
      } } }
    } else throw new Error("Unexpected fixture channel")
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.queue.push(packet)
    else waiter(packet)
  }
  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted) {
      const queued = this.queue.shift()
      if (queued !== undefined) { yield queued; continue }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        this.waiters.push(value => { signal.removeEventListener("abort", abort); resolve(value) })
      })
    }
  }
  async close() {}
}

async function setup(version = true) {
  const transport = new Transport(version)
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "fixture", capabilities: [] } },
    transport, adapterInstanceRef: "adapter", ledgerSink: { async persist() { throw new Error("No ledger expected") } },
    bindEvidence: () => ({ publisher: { async publish() { throw new Error("No evidence expected") } }, sourceResponses: { register() {} } }),
  })
  await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
    runtimeBuildId: "runtime-build", expectedNativeBuildId: "build", capabilitySchemaVersion: "1", ...(version ? { requiredRecoveryDomainVersion: "1" as const } : {}) })
  const deadlineAt = new Date(Date.now() + 5000).toISOString()
  const display = { ...generation, displayRef: "display", displayLayoutRevision: 1 }
  const request = nativeInputReadinessRequestSchema.parse({
    kind: "request", protocolVersion: "1", requestId: "request", ...generation, deadlineAt, intent: "mutation", method: "input.readiness",
    operation: { kind: "native", ...generation, operationId: "operation", clientRequestId: "client-request", clientSessionId: "client", principalId: "principal",
      deadlineAt, inventoryId: "inventory", inventoryRevision: 1, fence: { ...generation, counter: 1 }, target: { kind: "display", ref: display } },
    payload: { expectedDisplayRef: display },
  })
  const control = { signal: new AbortController().signal, checkpoint() {} }
  const send = (signal = control.signal) => adapter.request(nativeInputReadinessRequestSchema, request, nativeInputReadinessResponseSchema, { ...control, signal })
  return { adapter, transport, request, control, send }
}

test("Recovery v1 без authority не отправляет mutation; legacy profile остаётся отличимым", async () => {
  for (const version of [true, false]) {
    const fixture = await setup(version)
    try {
      if (version) await expect(fixture.send()).rejects.toThrow("durable authority")
      else await fixture.send()
      expect(fixture.transport.sent.filter(frame => frame.channel === "request").length).toBe(version ? 0 : 1)
    } finally { await fixture.adapter.close() }
  }
})

test("Durable grant завершается до send и pending fsync запрещает rotation", async () => {
  const fixture = await setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  fixture.adapter.configureRecoveryAuthority(async (wire, descriptor) => { await barrier; return grant(wire, descriptor) })
  try {
    const response = fixture.send()
    await Bun.sleep(0)
    expect(fixture.adapter.sessionState.pendingRequests).toBe(1)
    expect(() => fixture.adapter.sealForRotation()).toThrow()
    expect(fixture.transport.sent.length).toBe(1)
    release()
    await response
    const frame = fixture.transport.sent.at(-1)
    expect(frame?.channel === "request" && frame.payload.intent === "mutation" && frame.payload.recoveryGrant?.descriptor.domain).toBe("no-held-input")
    expect(() => fixture.adapter.configureRecoveryAuthority(async (wire, descriptor) => grant(wire, descriptor))).toThrow()
  } finally { release(); await fixture.adapter.close() }
})

test("Отмена во время durable await не допускает late send", async () => {
  const fixture = await setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  fixture.adapter.configureRecoveryAuthority(async (wire, descriptor) => { await barrier; return grant(wire, descriptor) })
  const abort = new AbortController()
  try {
    const response = fixture.send(abort.signal)
    await Bun.sleep(0)
    abort.abort(new Error("cancelled during fsync"))
    await expect(response).rejects.toThrow("cancelled during fsync")
    expect(fixture.adapter.sessionState.pendingRequests).toBe(1)
    await fixture.adapter.close()
    release()
    await Bun.sleep(0)
    expect(fixture.transport.sent.length).toBe(1)
    expect(fixture.adapter.sessionState.pendingRequests).toBe(0)
  } finally { release(); await fixture.adapter.close() }
})

test("Caller grant и неподходящий durable digest отвергаются до send", async () => {
  const fixture = await setup()
  fixture.adapter.configureRecoveryAuthority(async (wire, descriptor) => ({ ...grant(wire, descriptor), contextSha256: "0".repeat(64) }))
  try {
    const supplied = grant(fixture.request.operation, classifyNativeRecoveryDescriptor(fixture.request, "build"))
    await expect(fixture.adapter.request(nativeInputReadinessRequestSchema, { ...fixture.request, recoveryGrant: supplied }, nativeInputReadinessResponseSchema, fixture.control)).rejects.toThrow("Caller recoveryGrant")
    await expect(fixture.send()).rejects.toThrow("actual context")
    expect(fixture.transport.sent.length).toBe(1)
  } finally { await fixture.adapter.close() }
})

test("Read-only hit-test с pending operation не получает recovery send grant", async () => {
  const fixture = await setup()
  try {
    const observation = { observationId: "observation", inventoryRevision: 1, displayLayoutRevision: 1, proofRef: "proof" }
    const request = nativeHitTestRequestSchema.parse({ ...fixture.request, method: "input.hit-test", intent: "read",
      operation: { ...fixture.request.operation, observationRef: observation }, payload: { observationRef: observation, frameRef: "frame", imagePoint: { x: 1, y: 1 },
        interactionTarget: fixture.request.operation.target, expectedRegionIndex: 0, expectedDestinationPoint: { x: 1, y: 1 } } })
    await fixture.adapter.request(nativeHitTestRequestSchema, request, nativeHitTestResponseSchema, fixture.control)
    expect(fixture.transport.sent.length).toBe(2)
  } finally { await fixture.adapter.close() }
})

test("Clipboard write получает no-hold grant по actual clipboard context без fence", async () => {
  const fixture = await setup()
  let calls = 0
  fixture.adapter.configureRecoveryAuthority(async (wire, descriptor) => { calls += 1; return grant(wire, descriptor) })
  const operation = { kind: "clipboard", operationId: "clipboard-operation", clientRequestId: "clipboard-client", clientSessionId: "client", principalId: "principal",
    runtimeEpoch: "runtime", loginSessionId: "login", deadlineAt: fixture.request.deadlineAt,
    inventoryId: "inventory", inventoryRevision: 1,
    target: { kind: "clipboard", ref: { runtimeEpoch: "runtime", loginSessionId: "login", clipboardRef: "system" } } }
  try {
    for (const method of ["clipboard.version", "clipboard.write"] as const) {
      const request = nativeClipboardRequestSchema.parse({ kind: "request", protocolVersion: "1", requestId: method, ...generation,
        deadlineAt: fixture.request.deadlineAt, operation, command: { method, payload: method === "clipboard.write" ? { text: "synthetic fixture" } : {} } })
      await fixture.adapter.clipboard(request, fixture.control)
    }
    expect(calls).toBe(1)
    const frame = fixture.transport.sent.at(-1)
    expect(frame?.channel === "clipboard" && frame.payload.recoveryGrant?.contextSha256).toBe(digest(operation))
    expect(frame?.channel === "clipboard" && "fence" in frame.payload.operation).toBe(false)
  } finally { await fixture.adapter.close() }
})
