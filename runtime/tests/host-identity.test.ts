import { expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import type { NativeTransport } from "@meta/native/adapter"
import type { NativeTransportPacket, NativeTransportRequestFrame } from "@meta/native/protocol"
import type { NativePermissionsResponse } from "@meta/native/protocol"
import type { NativeStartupPermissionsRequest } from "@meta/native/protocol"
import { createRuntimeHost } from "../src/host.ts"
import { CAPABILITY_IDS } from "@meta/shared/contracts"
import { acquireHostLock } from "../src/host-lock.ts"

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
  inventoryCalls = 0
  startupPermissionCommands: string[] = []
  startupPermissionGranted?: boolean
  startupPermissionRequested = false
  grantStartupPermissions(): void {
    this.startupPermissionGranted = true
    this.permissions = { accessibility: true, screenRecording: true, postEvents: true, inputMonitoring: true }
  }
  inventoryStarted?: () => void
  observerStarted?: () => void
  hangObserverPrepare = false
  observerPrepareFailures = 0
  observerPrepareAttempts = 0
  observerCoverageCalls = 0
  hangObserverCoverageCall?: number
  observerCoverageStarted?: () => void
  observerStopAttempts = 0
  observerFailureUnknown = false
  #packet: Promise<NativeTransportPacket>
  #resolve!: (packet: NativeTransportPacket) => void
  #end!: () => void
  readonly #ended = new Promise<undefined>(resolve => { this.#end = () => resolve(undefined) })
  disconnect(): void { this.#end() }
  constructor(readonly session: { verified: true, source: "darwin-audit", uid: number, effectiveUid: number, auditUserId: number, auditSessionId: number }) {
    this.#packet = new Promise(resolve => { this.#resolve = resolve })
  }
  async send(frame: NativeTransportRequestFrame) {
    if (frame.channel === "permissions-request") {
      this.startupPermissionCommands.push(frame.payload.command)
      if (frame.payload.command === "request-missing") this.startupPermissionRequested = true
      this.#resolve({ kind: "message", frame: { channel: "permissions-request",
        payload: startupPermissionResponse(frame.payload, this.startupPermissionGranted === true, this.startupPermissionRequested) } })
      return
    }
    if (frame.channel === "request" && frame.payload.intent === "mutation") this.mutationCalls++
    if (this.fullView && frame.channel === "request" && frame.payload.method === "window.inventory") {
      this.inventoryCalls++
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
      if (frame.payload.command === "prepare") this.observerPrepareAttempts++
      if (frame.payload.command === "coverage") {
        this.observerCoverageCalls++
        if (this.observerCoverageCalls === this.hangObserverCoverageCall) {
          this.observerCoverageStarted?.()
          return
        }
      }
      if (frame.payload.command === "stop") this.observerStopAttempts++
      if (frame.payload.command === "prepare" && this.hangObserverPrepare) {
        this.observerStarted?.()
        return
      }
      if (frame.payload.command === "prepare" && this.observerPrepareFailures-- > 0) {
        const generation = { runtimeEpoch: frame.payload.runtimeEpoch, loginSessionId: frame.payload.loginSessionId,
          nativeGeneration: frame.payload.nativeGeneration }
        this.#resolve({ kind: "message", frame: { channel: "observer", payload: {
          kind: "observer-response", protocolVersion: "1", requestId: frame.payload.requestId, command: "prepare",
          ...generation, nativeBuildId: "build:native-audit", ok: false,
          error: { code: "capability-unavailable", message: "Fixture observer index unavailable", stage: "native-observer",
            retryable: false, replayAllowed: false, recoveryAction: "inspect-health" },
          prepareFailure: this.observerFailureUnknown
            ? { stage: "cleanup", retryDisposition: "unknown", transient: false }
            : { stage: "index", retryDisposition: "clean-no-instance", transient: true },
        } } })
        return
      }
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
        accessibility: true, postEvents: true, screenRecording: false, inputMonitoring: true,
        capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "native:audit", capabilities: [
          { id: "desktop.applications", state: "ready" }, { id: "desktop.windows.all", state: "ready" }, { id: "desktop.displays", state: "ready" },
          { id: "input.clipboard", state: "ready" },
          ...(this.readinessState === undefined ? [] : [{ id: "input.readiness" as const, state: this.readinessState,
            ...(this.readinessState === "ready" ? {} : { reason: "Fixture readiness implementation pending" }) }]),
          ...(this.fullView ? CAPABILITY_IDS.filter(id => !["desktop.applications", "desktop.windows.all", "desktop.displays", "input.clipboard", "input.readiness"].includes(id))
            .map(id => ({ id, state: "ready" as const })) : []),
        ] },
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
        const packet = await Promise.race([this.#packet, aborted, this.#ended])
        if (packet === undefined) return
        this.#packet = new Promise(resolve => { this.#resolve = resolve })
        yield packet
      }
    } finally { signal.removeEventListener("abort", onAbort) }
  }
  async close() {
    this.closed = true
    this.disconnect()
  }
}

function startupPermissionResponse(request: NativeStartupPermissionsRequest, granted: boolean, requested: boolean) {
  const status = granted
    ? { beforeGranted: !requested, currentGranted: true, requestState: requested ? "finished" as const : "not-needed" as const,
        promptRequested: requested, requestFinished: requested,
        ...(requested ? { requestReturnedGranted: true } : {}), restartNeeded: false, restartState: "not-required" as const }
    : requested
      ? { beforeGranted: false, currentGranted: false, requestState: "queued" as const, promptRequested: false,
          requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
      : { beforeGranted: false, currentGranted: false, requestState: "not-requested" as const, promptRequested: false,
          requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
  const permissions = { accessibility: status, screenRecording: status, postEvents: status, inputMonitoring: status }
  return { kind: "permissions-request-response" as const, protocolVersion: "1" as const, requestId: request.requestId,
    runtimeEpoch: request.runtimeEpoch, loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration,
    command: request.command, nativeBuildId: "build:native-audit", observedAt: new Date().toISOString(),
    requestsFinished: granted, allGranted: granted, restartNeeded: false, restartState: "not-required" as const,
    permissions, capabilities: { scope: "adapter" as const, schemaVersion: "1" as const, producerRef: request.nativeGeneration,
      capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })) } }
}

for (const guarded of [false, true]) {
  test(`Host high-level protected catalogue требует negotiated view gate: ${guarded}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-view-gate-"))
    const session = { verified: true as const, source: "darwin-audit" as const,
      uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 128 }
    const transport = new AuditTransport(session)
    transport.fullView = true
    transport.grantStartupPermissions()
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

test("startup уже с grants не вызывает request API и активирует observer после passive status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-permission-granted-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 130 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.startupPermissionGranted = true
  transport.grantStartupPermissions()
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:permissions-granted", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport,
    startupPermissions: { mode: "request-missing", waitMs: 5000, pollMs: 100 } })
  try {
    await host.start()
    await host.ready()
    expect(transport.startupPermissionCommands).toEqual(["status"])
    expect(transport.inventoryCalls).toBe(0)
    expect(host.doctor()).toMatchObject({ startup: { permissions: { state: "ready", requestIssued: false, missing: [] } },
      observer: { state: "ready", viewReady: true }, runtime: { admissionSealed: false } })
    expect(transport.mutationCalls).toBe(0)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("startup запрашивает missing grants один раз, health polling passive, activation только после grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-permission-request-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 131 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.startupPermissionGranted = false
  transport.permissions = { accessibility: false, screenRecording: false, postEvents: false, inputMonitoring: false }
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:permissions-request", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport,
    startupPermissions: { mode: "request-missing", waitMs: 5000, pollMs: 500 } })
  try {
    await host.start()
    while (!transport.startupPermissionCommands.includes("request-missing")) await Promise.resolve()
    expect(transport.startupPermissionCommands.filter(command => command === "request-missing")).toHaveLength(1)
    expect(host.core.admissionSealed).toBe(true)
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "get_state")).toBe(false)
    const healthClient = await host.core.openClientDurable("principal:permission-health")
    const health = async () => host.catalog.dispatch(healthClient.session, "system_health", {}, new AbortController().signal)
    expect((await health()).data).toMatchObject({ startup: { permissions: { state: "waiting", requestIssued: true,
      missing: ["accessibility", "screenRecording", "postEvents", "inputMonitoring"] } } })
    expect(transport.startupPermissionCommands.filter(command => command === "request-missing")).toHaveLength(1)
    transport.grantStartupPermissions()
    expect((await health()).data).toMatchObject({ startup: { permissions: { state: "ready", requestIssued: true, missing: [] } } })
    await host.ready()
    expect(host.doctor()).toMatchObject({ observer: { state: "ready", viewReady: true }, runtime: { admissionSealed: false } })
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "get_state")).toBe(true)
    expect(transport.startupPermissionCommands.filter(command => command === "request-missing")).toHaveLength(1)
    expect(transport.mutationCalls).toBe(0)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("host close отменяет ожидание permission response без повторного prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-permission-close-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 132 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.startupPermissionGranted = false
  const options = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:permissions-close", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session } }
  const host = await createRuntimeHost({ ...options, transport,
    startupPermissions: { mode: "request-missing", waitMs: 5000, pollMs: 500 } })
  try {
    await host.start()
    while (!transport.startupPermissionCommands.includes("request-missing")) await Promise.resolve()
    await Promise.race([host.close(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Host close waited for permission timeout")), 1000))])
    expect(transport.startupPermissionCommands.filter(command => command === "request-missing")).toHaveLength(1)
    expect(transport.mutationCalls).toBe(0)
    await expect(stat(options.socketPath)).rejects.toThrow()
  } finally {
    await host.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test("startup не запрашивает TCC при чужом helper cdhash и health не обходит owner check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-permission-owner-"))
  const helperPath = join(directory, "meta-native-helper")
  await writeFile(helperPath, "fixture")
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 133 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.startupPermissionGranted = true
  transport.permissions = { codeIdentity: { helperPath, cdhash: "a".repeat(40) } }
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:permission-owner", expectedNativeBuildId: "build:native-audit", expectedNativeCdhash: "b".repeat(40),
    expectedHostname: hostname(), helperPath, metadata: { session }, transport,
    startupPermissions: { mode: "request-missing", waitMs: 5000, pollMs: 100 } })
  try {
    await host.start()
    await host.ready()
    expect(host.doctor()).toMatchObject({ startup: { permissions: { state: "failed", requestIssued: false } },
      runtime: { admissionSealed: true }, observer: { state: "unavailable", viewReady: false } })
    expect(transport.startupPermissionCommands).toEqual([])
    const client = await host.core.openClientDurable("principal:owner-health")
    const health = await host.catalog.dispatch(client.session, "system_health", {}, new AbortController().signal)
    expect(health.data).toMatchObject({ startup: { permissions: { state: "failed" } } })
    expect(transport.startupPermissionCommands).toEqual([])
    expect(transport.mutationCalls).toBe(0)
  } finally { await host.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }) }
})

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
      inputMonitoring: { granted: true, helperPath: "/tmp/signed-self-helper", cdhash: "a".repeat(40) },
    })
    transport.permissions = { accessibility: false }
    expect((await read()).permissions).toMatchObject({ accessibility: { granted: false } })
    transport.permissions = { nativeBuildId: "build:wrong" }
    expect((await read()).permissionsUnavailable).toContain("identity mismatch")
    transport.permissions = { nativeGeneration: "native:wrong" }
    expect((await read()).permissions).toBeUndefined()
    expect(transport.permissionCalls).toBe(4)
    expect(transport.startupPermissionCommands).toEqual([])
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("host close отменяет зависший Native observer prepare", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-preparation-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 126 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.hangObserverPrepare = true
  transport.grantStartupPermissions()
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  transport.observerStarted = entered
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

test("host close отменяет view guard coverage в общем preparation budget и очищает observer binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-view-preparation-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 135 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.grantStartupPermissions()
  transport.hangObserverCoverageCall = 2
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  transport.observerCoverageStarted = entered
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:host-view-preparation", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    await host.start()
    await preparing
    expect(host.doctor().observer.state).toBe("preparing")
    await host.close()
    expect(transport.observerCoverageCalls).toBe(2)
    expect(transport.observerStopAttempts).toBe(1)
    expect(host.doctor().observer.state).toBe("unavailable")
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 1000)

test("Host health показывает bounded observer retry progress с единым absolute deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-observer-retry-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 134 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.grantStartupPermissions()
  transport.observerPrepareFailures = 2
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:observer-retry", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    await host.start()
    while (transport.observerPrepareAttempts < 1 || host.doctor().observer.preparation?.nextRetryAt === undefined) await Bun.sleep(1)
    const first = host.doctor().observer.preparation!
    expect(first).toMatchObject({ attempt: 1, maxAttempts: 3 })
    expect(Date.parse(first.deadlineAt) - Date.parse(first.startedAt)).toBe(26_000)
    while (transport.observerPrepareAttempts < 2 || host.doctor().observer.preparation?.attempt !== 2) await Bun.sleep(1)
    const second = host.doctor().observer.preparation!
    expect(second.startedAt).toBe(first.startedAt)
    expect(second.deadlineAt).toBe(first.deadlineAt)
    await host.ready()
    expect(transport.observerPrepareAttempts).toBe(3)
    expect(host.doctor().observer).toMatchObject({ state: "ready", viewReady: true })
    expect(host.doctor().observer).not.toHaveProperty("preparation")
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 5000)

test("unknown observer prepare failure не повторяется и остаётся sealed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-observer-unknown-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 135 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.grantStartupPermissions()
  transport.observerPrepareFailures = 3
  transport.observerFailureUnknown = true
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:observer-unknown", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    await host.start()
    await host.ready()
    expect(transport.observerPrepareAttempts).toBe(1)
    expect(host.doctor()).toMatchObject({ observer: { state: "unavailable", viewReady: false }, runtime: { admissionSealed: true } })
    expect(host.doctor().observer.reason).toContain("cleanup/unknown")
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("grant revocation между clean retries запрещает следующую Native prepare", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-observer-grant-revoke-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 136 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.grantStartupPermissions()
  transport.observerPrepareFailures = 1
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:observer-revoke", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session }, transport })
  try {
    await host.start()
    while (host.doctor().observer.preparation?.nextRetryAt === undefined) await Bun.sleep(1)
    transport.permissions = { screenRecording: false }
    await host.ready()
    expect(transport.observerPrepareAttempts).toBe(1)
    expect(host.doctor()).toMatchObject({ observer: { state: "unavailable", viewReady: false }, runtime: { admissionSealed: true } })
    expect(host.doctor().observer.reason).toContain("passive TCC grants")
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 5000)

test("Native disconnect после ready observer не прерывает UDS/lock cleanup при failed stop RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-disconnect-cleanup-"))
  const session = { verified: true as const, source: "darwin-audit" as const,
    uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 129 }
  const transport = new AuditTransport(session)
  transport.fullView = true
  transport.viewVersion = "1"
  transport.grantStartupPermissions()
  const options = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:disconnect-cleanup", expectedNativeBuildId: "build:native-audit", expectedHostname: hostname(), metadata: { session } }
  const host = await createRuntimeHost({ ...options, transport })
  try {
    await host.start()
    await host.ready()
    expect(host.doctor().observer).toMatchObject({ state: "ready", viewReady: true })
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "get_state")).toBe(true)
    const changed = new Promise<void>(resolve => {
      const unsubscribe = host.core.subscribeCapabilities(() => {
        if (host.doctor().native.state === "unavailable") { unsubscribe(); resolve() }
      })
    })
    transport.disconnect()
    await changed
    await expect(host.close()).rejects.toThrow("часть подтверждений отсутствует")
    expect(transport.closed).toBe(true)
    await expect(stat(options.socketPath)).rejects.toThrow()
    await expect(stat(options.credentialPath)).rejects.toThrow()
    const release = await acquireHostLock(options.socketPath)
    await release()
  } finally {
    await host.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 5000)

for (const readinessState of ["ready", "degraded", "unavailable"] as const) {
  test(`host readiness gate ${readinessState} не запускает active probe в startup/health`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-readiness-gate-"))
    const session = { verified: true as const, source: "darwin-audit" as const,
      uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 127 }
    const transport = new AuditTransport(session)
    transport.fullView = true
    transport.grantStartupPermissions()
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
