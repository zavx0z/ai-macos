import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import type { NativeTransport } from "@meta/native/adapter"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "@meta/native/protocol"
import type { NativePermissionsResponse } from "@meta/native/protocol"
import { createRuntimeHost } from "../src/host.ts"
import { CAPABILITY_IDS } from "@meta/shared/contracts"

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
    expect(good.catalog.internal.descriptors().tools.some(tool => tool.name === "list_windows")).toBe(true)
    expect(good.catalog.descriptors().tools.some(tool => tool.name === "list_windows")).toBe(false)
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
  permissions: Partial<NativePermissionsResponse> = {}
  permissionCalls = 0
  readinessCalls = 0
  readinessState?: "ready" | "degraded" | "unavailable"
  fullView = false
  viewVersion: "1" | undefined
  mutationCalls = 0
  inventoryStarted?: () => void
  #packet: Promise<NativeTransportPacket>
  #resolve!: (packet: NativeTransportPacket) => void
  constructor(readonly session: { verified: true, source: "darwin-audit", uid: number, effectiveUid: number, auditUserId: number, auditSessionId: number }) {
    this.#packet = new Promise(resolve => { this.#resolve = resolve })
  }
  async send(frame: NativeTransportRequestFrame) {
    if (frame.channel === "request" && frame.payload.intent === "mutation") this.mutationCalls++
    if (this.fullView && frame.channel === "request" && frame.payload.method === "window.inventory") {
      const request = frame.payload
      this.#resolve({ kind: "message", frame: { channel: "response", payload: {
        kind: "response", protocolVersion: "1", requestId: request.requestId,
        runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration,
        ok: true, result: { sourceResponseRef: `source:${request.requestId}`, inventoryId: "inventory:host-view", layoutRef: "layout:host-view",
          revision: 1, displayLayoutRevision: 1, capturedAt: new Date().toISOString(), complete: true,
          errors: [], applications: [], windows: [], displays: [] },
      } } })
      return
    }
    if (this.fullView && frame.channel === "observer") {
      const request = frame.payload
      const generation = { runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration }
      const now = new Date().toISOString()
      this.#resolve({ kind: "message", frame: { channel: "observer", payload: {
        kind: "observer-response", protocolVersion: "1", requestId: request.requestId, command: request.command,
        ...generation, nativeBuildId: "build:native-audit", ok: true,
        snapshot: { observerInstanceRef: "observer:host-view", inventoryId: "inventory:host-view", inventoryRevision: 1, indexRevision: 1,
          coverage: { state: "ready", ...generation, coverageStartCursor: "cursor:start", cursor: "cursor:start", nextSequence: 1,
            startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
            coveredKinds: ["input", "focus", "window-structure", "lifecycle"], droppedEvents: 0, gapDetected: false },
          sessionReadiness: { state: "active-console", lockState: "unknown", userId: this.session.uid, auditSessionId: this.session.auditSessionId,
            onConsole: true, loginDone: true, evidence: "fixture passive facts", observedAt: now }, secureInput: "off" },
        ...(request.command === "events" ? { fromCursor: request.afterCursor!, events: [] } : {}),
      } } })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "input.readiness") {
      this.readinessCalls++
      throw new Error("Active readiness не ожидался")
    }
    if (frame.channel === "heartbeat") {
      this.#resolve({ kind: "message", frame: { channel: "heartbeat", payload: {
        requestId: frame.payload.requestId, runtimeEpoch: frame.payload.runtimeEpoch,
        loginSessionId: frame.payload.loginSessionId, nativeGeneration: frame.payload.nativeGeneration,
        accepted: true, quarantined: false, acknowledgedAt: new Date().toISOString(),
      } } })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "window.inventory" && this.inventoryStarted !== undefined) {
      this.inventoryStarted()
      await new Promise<void>(() => {})
      return
    }
    if (frame.channel === "permissions") {
      this.permissionCalls++
      const { deadlineAt: _, ...identity } = frame.payload
      this.#resolve({ kind: "message", frame: { channel: "permissions", payload: {
        ...identity, kind: "permissions-response", nativeBuildId: "build:native-audit",
        accessibility: true, postEvents: true, screenRecording: false,
        codeIdentity: { helperPath: "/tmp/signed-self-helper", cdhash: "a".repeat(40) }, ...this.permissions,
      } } })
      return
    }
    if (frame.channel !== "handshake") throw new Error("handshake fixture only")
    this.#resolve({ kind: "message", frame: { channel: "handshake", payload: {
      kind: "handshake-response", protocolVersion: "1", requestId: frame.payload.requestId,
      runtimeEpoch: frame.payload.runtimeEpoch, loginSessionId: frame.payload.loginSessionId,
      nativeGeneration: "native:audit", nativeBuildId: "build:native-audit", capabilitySchemaVersion: "1", installRoot: "/tmp/native-audit",
      process: { pid: 100, startedAt: new Date().toISOString(), nonce: "process:audit" }, session: this.session,
      ...(this.viewVersion === undefined ? {} : { recoveryDomainVersion: "1", viewAdmissionVersion: this.viewVersion }),
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "native:audit", capabilities: [
        { id: "desktop.applications", state: "ready" }, { id: "desktop.windows.all", state: "ready" }, { id: "desktop.displays", state: "ready" },
        { id: "input.clipboard", state: "ready" },
        ...(this.readinessState === undefined ? [] : [{ id: "input.readiness" as const, state: this.readinessState,
          ...(this.readinessState === "ready" ? {} : { reason: "Fixture readiness implementation pending" }) }]),
        ...(this.fullView ? CAPABILITY_IDS.filter(id => !["desktop.applications", "desktop.windows.all", "desktop.displays", "input.clipboard", "input.readiness"].includes(id))
          .map(id => ({ id, state: "ready" as const })) : []),
      ] },
    } } })
  }
  async *packets(signal: AbortSignal) {
    let onAbort!: () => void
    const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true }) })
    try {
      while (!signal.aborted) {
        const packet = await Promise.race([this.#packet, aborted])
        if (packet === undefined) return
        this.#packet = new Promise(resolve => { this.#resolve = resolve })
        yield packet
      }
    } finally { signal.removeEventListener("abort", onAbort) }
  }
  async close() { this.closed = true }
}

for (const guarded of [false, true]) {
  test(`Host high-level protected catalogue требует negotiated view gate: ${guarded}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-view-gate-"))
    const session = { verified: true as const, source: "darwin-audit" as const,
      uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 128 }
    const transport = new AuditTransport(session)
    transport.fullView = true
    transport.readinessState = "ready"
    if (guarded) transport.viewVersion = "1"
    const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
      runtimeBuildId: "build:host-view", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
    try {
      await host.start()
      await host.ready()
      expect(host.doctor().observer.viewReady).toBe(guarded)
      const names = host.catalog.descriptors().tools.map(tool => tool.name)
      for (const name of ["get_state", "observe", "show_window", "check_input", "list_displays", "get_target_status", "cancel_target", "window_transition", "launch_application"]) expect(names).toContain(name)
      for (const name of ["type_text", "press_key", "click", "scroll", "drag"]) expect(names.includes(name)).toBe(guarded)
      for (const name of ["list_windows", "inspect_accessibility", "press_accessibility", "input_readiness", "keyboard_type", "mouse_click"]) expect(names).not.toContain(name)
      const client = await host.core.openClientDurable("principal:host-view")
      const displays = await host.catalog.dispatch(client.session, "list_displays", {}, new AbortController().signal)
      expect(displays.data).toMatchObject({ inventoryId: "inventory:host-view", displays: [] })
      expect(displays.data).not.toHaveProperty("windows")
      await expect(host.catalog.dispatch(client.session, "keyboard_type", {}, new AbortController().signal)).rejects.toThrow()
      expect(transport.mutationCalls).toBe(0)
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
}

test("host health использует fresh passive grants и signed loaded identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-permissions-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 125 }
  const transport = new AuditTransport(session)
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:host-permissions", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    const client = await host.core.openClientDurable("principal:permissions")
    const read = async () => (await host.catalog.dispatch(client.session, "system_health", {}, new AbortController().signal)).data
    expect((await read()).permissions).toEqual({
      accessibility: { granted: true, helperPath: "/tmp/signed-self-helper", cdhash: "a".repeat(40) },
      screenRecording: { granted: false, ownerPath: "/tmp/signed-self-helper", cdhash: "a".repeat(40) },
      postEvents: { granted: true, helperPath: "/tmp/signed-self-helper", cdhash: "a".repeat(40) },
    })
    transport.permissions = { accessibility: false }
    expect((await read()).permissions).toMatchObject({ accessibility: { granted: false } })
    transport.permissions = { nativeBuildId: "build:wrong" }
    expect((await read()).permissionsUnavailable).toContain("identity mismatch")
    transport.permissions = { nativeGeneration: "native:wrong" }
    expect((await read()).permissions).toBeUndefined()
    expect(transport.permissionCalls).toBe(4)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("host close отменяет зависшую background inventory до observer prepare", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-preparation-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 126 }
  const transport = new AuditTransport(session)
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  transport.inventoryStarted = entered
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:host-preparation", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    await host.start()
    await preparing
    expect(host.doctor().observer.state).toBe("preparing")
    await host.close()
    expect(transport.closed).toBe(true)
    expect(host.doctor().observer.state).toBe("unavailable")
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 1000)

for (const readinessState of ["ready", "degraded", "unavailable"] as const) {
  test(`host readiness gate ${readinessState} не запускает active probe в startup/health`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-readiness-gate-"))
    const session = { verified: true as const, source: "darwin-audit" as const,
      uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 127 }
    const transport = new AuditTransport(session)
    transport.readinessState = readinessState
    const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
      runtimeBuildId: "build:readiness-gate", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
    try {
      await host.start()
      const client = await host.core.openClientDurable("principal:readiness-gate")
      await host.catalog.dispatch(client.session, "system_health", {}, new AbortController().signal)
      expect(host.core.capabilities.capabilities.find(capability => capability.id === "input.readiness")?.state).toBe(readinessState)
      expect(host.catalog.descriptors().tools.some(tool => tool.name === "input_readiness")).toBe(false)
      const method = host.catalog.descriptors().tools.find(tool => tool.name === "check_input")
      expect(method !== undefined).toBe(readinessState === "ready")
      if (method !== undefined) expect(method.annotations.readOnlyHint).toBe(false)
      expect(transport.readinessCalls).toBe(0)
    } finally {
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
