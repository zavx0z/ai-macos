import { expect, test } from "bun:test"
import { canonicalRecoveryJson, type NativeViewAdmission, type NativeRecoveryGrant, type NativeRecoveryDescriptor, type NativeExecutionContext, type ClipboardExecutionContext } from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import { nativeInputExecutionRequestSchema, nativeInputExecutionResponseSchema, nativeInputReadinessRequestSchema, nativeInputReadinessResponseSchema,
  type NativeTransportPacket, type NativeTransportRequestFrame } from "../src/protocol.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const sha = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalRecoveryJson(value)).digest("hex")
const grant = (wire: NativeExecutionContext | ClipboardExecutionContext, descriptor: NativeRecoveryDescriptor): NativeRecoveryGrant => ({
  policyVersion: "1", ...generation, operationId: wire.operationId, descriptor, contextSha256: sha(wire), descriptorSha256: sha(descriptor), journalRevision: 1, durable: true,
})
const proof = (wire: NativeExecutionContext): NativeViewAdmission => ({ version: "1", contextSha256: sha(wire), viewNonce: "view", observerInstanceRef: "observer",
  coverageStartCursor: "start", baselineCursor: "cursor", baselineNextSequence: 1, observedCursor: "cursor", observedNextSequence: 1,
  admissionCursor: "cursor", admissionNextSequence: 1, expiresAt: wire.deadlineAt })

class Transport implements NativeTransport {
  frames: NativeTransportRequestFrame[] = []
  queue: NativeTransportPacket[] = []
  wake: ((packet: NativeTransportPacket) => void) | undefined
  async send(frame: NativeTransportRequestFrame) {
    this.frames.push(frame)
    let packet: NativeTransportPacket
    if (frame.channel === "handshake") packet = { kind: "message", frame: { channel: "handshake", payload: {
      kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
      nativeBuildId: "build", capabilitySchemaVersion: "1", recoveryDomainVersion: "1", viewAdmissionVersion: "1",
      installRoot: "/tmp/view-fixture", process: { pid: 1, startedAt: new Date().toISOString(), nonce: "nonce" },
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "fixture", capabilities: [] },
    } } }
    else if (frame.channel === "request") packet = { kind: "message", frame: { channel: "response", payload: {
      kind: "response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation,
      ...("operation" in frame.payload ? { operationId: frame.payload.operation.operationId } : {}),
      ok: false, error: { code: "unsupported-capability", message: "No live dispatch", stage: "fixture", retryable: false, replayAllowed: false, recoveryAction: "none" },
    } } }
    else throw new Error("Unexpected channel")
    if (this.wake === undefined) this.queue.push(packet)
    else { const wake = this.wake; this.wake = undefined; wake(packet) }
  }
  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted) {
      const packet = this.queue.shift()
      if (packet !== undefined) { yield packet; continue }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        this.wake = value => { signal.removeEventListener("abort", abort); resolve(value) }
      })
    }
  }
  async close() {}
}

async function fixture() {
  const transport = new Transport()
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime",
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "fixture", capabilities: [] } },
    adapterInstanceRef: "adapter", transport, ledgerSink: { async persist() { throw new Error("No ledger") } },
    bindEvidence: () => ({ publisher: { async publish() { throw new Error("No evidence") } }, sourceResponses: { register() {} } }),
  })
  await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
    runtimeBuildId: "runtime", expectedNativeBuildId: "build", capabilitySchemaVersion: "1", requiredRecoveryDomainVersion: "1", requiredViewAdmissionVersion: "1" })
  const deadlineAt = new Date(Date.now() + 5000).toISOString()
  const request = nativeInputExecutionRequestSchema.parse({ ...generation, kind: "request", protocolVersion: "1", requestId: "input", method: "input.execute", intent: "mutation", deadlineAt,
    operation: { kind: "native", ...generation, operationId: "operation", clientRequestId: "request", clientSessionId: "client", principalId: "principal", deadlineAt,
      inventoryId: "inventory", inventoryRevision: 1, fence: { ...generation, counter: 1 },
      target: { kind: "window", ref: { ...generation, applicationRef: "app", windowRef: "window" } } },
    payload: { actionDeadlineAt: deadlineAt, action: { kind: "key", stroke: { keyCode: 0, flags: 0 } } },
  })
  const control = { signal: new AbortController().signal, checkpoint() {} }
  const send = (signal = control.signal) => adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema, { ...control, signal })
  return { adapter, transport, request, control, send }
}

test("View admission происходит после fsync; actual action берётся из parsed request", async () => {
  const value = await fixture()
  const order: string[] = []
  value.adapter.configureRecoveryAuthority(async (wire, descriptor) => { order.push("durable"); return grant(wire, descriptor) })
  value.adapter.configureViewAdmissionAuthorizer(async (wire, action) => { order.push(`${action.method}:${action.actionKind}`); return proof(wire) })
  try {
    await value.send()
    const frame = value.transport.frames.at(-1)
    expect(order).toEqual(["durable", "input.execute:key"])
    expect(frame?.channel === "request" && frame.payload.intent === "mutation" && frame.payload.viewAdmission?.contextSha256).toBe(sha(value.request.operation))
    expect(() => value.adapter.configureViewAdmissionAuthorizer(async wire => proof(wire))).toThrow()
  } finally { await value.adapter.close() }
})

test("Отсутствие view hook и caller proof не дают guarded send", async () => {
  const value = await fixture()
  let grants = 0
  value.adapter.configureRecoveryAuthority(async (wire, descriptor) => { grants += 1; return grant(wire, descriptor) })
  try {
    await expect(value.adapter.request(nativeInputExecutionRequestSchema, { ...value.request, viewAdmission: proof(value.request.operation) }, nativeInputExecutionResponseSchema, value.control)).rejects.toThrow("Caller viewAdmission")
    expect(grants).toBe(0)
    await expect(value.send()).rejects.toThrow("configured Runtime authorizer")
    expect(value.transport.frames.length).toBe(1)
  } finally { await value.adapter.close() }
})

test("Late view authorization после отмены не отправляет действие и блокирует rotation до settle", async () => {
  const value = await fixture()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  value.adapter.configureRecoveryAuthority(async (wire, descriptor) => grant(wire, descriptor))
  value.adapter.configureViewAdmissionAuthorizer(async wire => { await wait; return proof(wire) })
  const abort = new AbortController()
  try {
    const response = value.send(abort.signal)
    await Bun.sleep(0)
    expect(() => value.adapter.sealForRotation()).toThrow()
    abort.abort(new Error("cancelled view"))
    await expect(response).rejects.toThrow("cancelled view")
    await value.adapter.close()
    release()
    await Bun.sleep(0)
    expect(value.transport.frames.length).toBe(1)
  } finally { release(); await value.adapter.close() }
})

test("Чужой context и expiry не проходят view admission", async () => {
  for (const wrong of ["context", "expiry"] as const) {
    const value = await fixture()
    value.adapter.configureRecoveryAuthority(async (wire, descriptor) => grant(wire, descriptor))
    value.adapter.configureViewAdmissionAuthorizer(async wire => ({ ...proof(wire), ...(wrong === "context" ? { contextSha256: "0".repeat(64) } : { expiresAt: new Date(Date.now() + 60_000).toISOString() }) }))
    try {
      await expect(value.send()).rejects.toThrow("current context")
      expect(value.transport.frames.length).toBe(1)
    } finally { await value.adapter.close() }
  }
})

test("Readiness остаётся отдельной explicit операцией без view bypass flags", async () => {
  const value = await fixture()
  value.adapter.configureRecoveryAuthority(async (wire, descriptor) => grant(wire, descriptor))
  try {
    const display = { ...generation, displayRef: "display", displayLayoutRevision: 1 }
    const request = nativeInputReadinessRequestSchema.parse({ ...value.request, method: "input.readiness",
      operation: { ...value.request.operation, target: { kind: "display", ref: display } }, payload: { expectedDisplayRef: display } })
    await value.adapter.request(nativeInputReadinessRequestSchema, request, nativeInputReadinessResponseSchema, value.control)
    expect(value.transport.frames.length).toBe(2)
  } finally { await value.adapter.close() }
})
