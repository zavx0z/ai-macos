import { expect, test } from "bun:test"
import { freezeAdapterHostContext, runtimeOperationIntentSchema } from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "@meta/native/adapter"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "@meta/native/protocol"
import { DesktopInputAdapter } from "@meta/input/adapter"
import { RuntimeCore } from "../src/core.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileOperationJournal } from "../src/storage/index.ts"

const generation = { runtimeEpoch: "runtime:predispatch", loginSessionId: "login:predispatch" }
const nativeGeneration = "native:predispatch"

for (const tracked of [true, false]) {
  test(`Input predispatch release требует native delivery authority: ${tracked}`, async () => {
    const transport = new HandshakeTransport()
    const host = freezeAdapterHostContext({ generation, runtimeBuildId: "build:predispatch", capabilities: {
      schemaVersion: "1", scope: "adapter", producerRef: "native:predispatch", capabilities: [{ id: "input.pointer", state: "ready" }],
    } })
    const native = new NativeBrokerAdapter({ host, transport, adapterInstanceRef: "adapter:predispatch",
      ledgerSink: { async persist() { throw new Error("No ledger write expected") } },
      bindEvidence: () => ({ publisher: { async publish() { throw new Error("No evidence expected") } }, sourceResponses: { register() {} } }),
    })
    await native.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake:predispatch", ...generation,
      runtimeBuildId: "build:predispatch", expectedNativeBuildId: "native-build:predispatch", capabilitySchemaVersion: "1" })
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:predispatch", native, nativeGeneration,
      ...(tracked ? { nativeDelivery: native.mutationDelivery } : {}) })
    const input = new DesktopInputAdapter(host, core.services, native)
    const session = core.openClient("principal:predispatch").session
    const target = { kind: "display" as const, ref: { ...generation, nativeGeneration, displayRef: "display:predispatch", displayLayoutRevision: 0 } }
    core.targets.register(target, "inventory:predispatch", 0, "resolution:predispatch", "proof:predispatch", 0)
    try {
      const execution = await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:predispatch",
        precondition: { target, inventoryId: "inventory:predispatch", inventoryRevision: 0,
          observationRef: { observationId: "observation:missing", inventoryRevision: 0, displayLayoutRevision: 0, proofRef: "proof:missing" } },
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }], deadlineAt: new Date(Date.now() + 5000).toISOString(),
      }), { kind: "hover" as const, point: { x: 999999, y: 999999 } }, async (context, action) => {
        if (context.wire.kind !== "native") throw new Error("Native context expected")
        return input.execute({ ...context, wire: context.wire }, action)
      })
      expect(transport.mutations).toBe(0)
      expect(transport.statusQueries).toBe(tracked ? 0 : 1)
      expect(execution.operation.state).toBe(tracked ? "failed" : "interrupted-unknown")
      expect(core.resources.quarantinedCount()).toBe(tracked ? 0 : 1)
      if (tracked) expect(execution.operation.outcome.cleanup.state).toBe("complete")
    } finally {
      await native.close()
      await core.closeClientLifecycle()
    }
  })
}

class HandshakeTransport implements NativeTransport {
  constructor(readonly guarded = false) {}
  mutations = 0
  statusQueries = 0
  #resolve!: (value: NativeTransportPacket) => void
  readonly #handshake = new Promise<NativeTransportPacket>(resolve => { this.#resolve = resolve })
  async send(frame: NativeTransportRequestFrame): Promise<void> {
    if (frame.channel === "request" && frame.payload.intent === "mutation") this.mutations++
    if (frame.channel === "status") this.statusQueries++
    if (frame.channel !== "handshake") throw new Error("No native job was registered")
    this.#resolve({ kind: "message", frame: { channel: "handshake", payload: {
      kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId, ...generation, nativeGeneration,
      nativeBuildId: "native-build:predispatch", capabilitySchemaVersion: "1", installRoot: "/tmp/predispatch-fixture",
      process: { pid: 100, startedAt: new Date().toISOString(), nonce: "nonce:predispatch" },
      ...(this.guarded ? { recoveryDomainVersion: "1", viewAdmissionVersion: "1" } : {}),
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "native:predispatch", capabilities: [] },
    } } })
  }
  async *packets(signal: AbortSignal) {
    yield await this.#handshake
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
  }
  async close() {}
}

test("Runtime view rejection после durable grant не превращается в ложный Native cleanup unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "view-no-send-"))
  const transport = new HandshakeTransport(true)
  const host = freezeAdapterHostContext({ generation, runtimeBuildId: "build:predispatch", capabilities: {
    schemaVersion: "1", scope: "adapter", producerRef: "native:predispatch", capabilities: [{ id: "input.keyboard", state: "ready" }],
  } })
  const native = new NativeBrokerAdapter({ host, transport, adapterInstanceRef: "adapter:predispatch",
    ledgerSink: { async persist() { throw new Error("No ledger expected") } },
    bindEvidence: () => ({ publisher: { async publish() { throw new Error("No evidence expected") } }, sourceResponses: { register() {} } }),
  })
  await native.handshake({ kind: "handshake", protocolVersion: "1", requestId: "hs:guarded", ...generation,
    runtimeBuildId: "build:predispatch", expectedNativeBuildId: "native-build:predispatch", capabilitySchemaVersion: "1",
    requiredRecoveryDomainVersion: "1", requiredViewAdmissionVersion: "1" })
  const core = new RuntimeCore({ generation, native, nativeGeneration, runtimeBuildId: "build:predispatch", nativeDelivery: native.mutationDelivery,
    operationJournal: new FileOperationJournal(directory), nativeRecovery: { policyVersion: "1", nativeBuildId: "native-build:predispatch" } })
  await core.initializeRecovery()
  native.configureRecoveryAuthority((wire, descriptor) => core.authorizeNativeMutation(wire, descriptor))
  const authorize = core.bindNativeViewAdmission(async () => { throw new Error("View invalidated by external event") })
  native.configureViewAdmissionAuthorizer((wire, action) => authorize(wire, action))
  const input = new DesktopInputAdapter(host, core.services, native)
  const session = core.openClient("principal:predispatch").session
  const target = { kind: "window" as const, ref: { ...generation, nativeGeneration, applicationRef: "app:view", windowRef: "window:view" } }
  core.targets.register(target, "inventory:view", 1, "resolution:view", "proof:view", 0)
  try {
    const result = await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:guarded",
      precondition: { target, inventoryId: "inventory:view", inventoryRevision: 1 }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
      requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    }), { kind: "text" as const, text: "fixture", delayMs: 0 }, async (context, action) => {
      if (context.wire.kind !== "native") throw new Error("Native context expected")
      return input.execute({ ...context, wire: context.wire }, action)
    })
    expect(transport.mutations).toBe(0)
    expect(result.operation.state).toBe("failed")
    expect(result.operation.error?.code).toBe("observation-stale")
    expect(result.operation.outcome.dispatch).toBe("none")
    expect(result.operation.outcome.cleanup.state).toBe("complete")
    expect(result.operation.nativeRecovery?.phase).toBe("send-authorized")
    expect(core.resources.quarantinedCount()).toBe(0)
  } finally {
    await native.close()
    await core.closeClientLifecycle()
    await rm(directory, { recursive: true, force: true })
  }
})
