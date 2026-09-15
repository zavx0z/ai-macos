import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import type { NativeTransport } from "@meta/native/adapter"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "@meta/native/protocol"
import { createRuntimeHost } from "../src/host.ts"

test("host derives audit login identity and rejects different live helper session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-audit-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 123 }
  const options = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:host-audit", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session } }
  const bad = new AuditTransport({ ...session, auditSessionId: 124 })
  const invalid = await createRuntimeHost({ ...options, transport: bad })
  expect(invalid.doctor().runtime.loginSessionId).toBe(`audit:${session.uid}:123`)
  expect(invalid.doctor().native.state).toBe("unavailable")
  expect(bad.closed).toBe(true)
  await invalid.close()
  const good = await createRuntimeHost({ ...options, transport: new AuditTransport(session) })
  try {
    expect(good.doctor().native.state).toBe("compatible")
    expect(good.catalog.descriptors().tools.some(tool => tool.name === "list_windows")).toBe(true)
    const descriptors = good.catalog.descriptors().tools
    const read = descriptors.find(tool => tool.name === "clipboard_read")
    const write = descriptors.find(tool => tool.name === "clipboard_write")
    expect(read?.inputSchema).toMatchObject({ properties: { request: { properties: { kind: { const: "read" } } } } })
    expect(write?.inputSchema).toMatchObject({ properties: { request: { properties: { kind: { const: "write" } } } } })
    expect(JSON.stringify(read?.outputSchema)).not.toContain('"written"')
    expect(JSON.stringify(write?.outputSchema)).not.toContain('"text-unavailable"')
    expect(read?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    await good.core.native?.close()
    await Promise.resolve()
    expect(good.catalog.descriptors().tools.some(tool => tool.name === "list_windows")).toBe(false)
  } finally { await good.close(); await rm(directory, { recursive: true, force: true }) }
})

class AuditTransport implements NativeTransport {
  closed = false
  readonly #packet: Promise<NativeTransportPacket>
  #resolve!: (packet: NativeTransportPacket) => void
  constructor(readonly session: { verified: true, source: "darwin-audit", uid: number, effectiveUid: number, auditUserId: number, auditSessionId: number }) {
    this.#packet = new Promise(resolve => { this.#resolve = resolve })
  }
  async send(frame: NativeTransportRequestFrame) {
    if (frame.channel !== "handshake") throw new Error("handshake fixture only")
    this.#resolve({ kind: "message", frame: { channel: "handshake", payload: {
      kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId,
      runtimeEpoch: frame.payload.runtimeEpoch, loginSessionId: frame.payload.loginSessionId,
      nativeGeneration: "native:audit", nativeBuildId: "build:native-audit", capabilitySchemaVersion: "1", installRoot: "/tmp/native-audit",
      process: { pid: 100, startedAt: new Date().toISOString(), nonce: "process:audit" }, session: this.session,
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "native:audit", capabilities: [
        { id: "desktop.applications", state: "ready" }, { id: "desktop.windows.all", state: "ready" }, { id: "desktop.displays", state: "ready" },
        { id: "input.clipboard", state: "ready" },
      ] },
    } } })
  }
  async *packets(signal: AbortSignal) {
    yield await this.#packet
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  async close() { this.closed = true }
}
