import { expect, test } from "bun:test"
import { CAPABILITY_IDS, type CapabilitySet } from "@meta/shared/contracts"
import type { NativeStartupPermissionsRequest, NativeStartupPermissionsResponse } from "@meta/native/protocol"
import { RuntimeStartupPermissions, STARTUP_PERMISSION_NAMES } from "../src/startup-permissions.ts"

const generation = { runtimeEpoch: "runtime:permissions", loginSessionId: "login:permissions", nativeGeneration: "native:permissions" }
const capabilities: CapabilitySet = { schemaVersion: "1", scope: "adapter", producerRef: generation.nativeGeneration,
  capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) }

test("already granted startup не вызывает official request API", async () => {
  const native = new PermissionsFixture([response("status", "granted")])
  let ready = 0
  const flow = new RuntimeStartupPermissions({ native, onReady() { ready++ } })
  expect(await flow.start(new AbortController().signal)).toMatchObject({ state: "ready", missing: [], requestIssued: false })
  expect(native.commands).toEqual(["status"])
  expect(ready).toBe(1)
})

test("missing grants вызывают request-missing один раз и затем только passive status", async () => {
  let now = Date.now()
  const native = new PermissionsFixture([
    response("status", "missing"), response("request-missing", "queued"),
    response("status", "requesting"), response("status", "granted", true),
  ])
  let capabilitiesUpdates = 0
  const flow = new RuntimeStartupPermissions({ native, now: () => new Date(now), waitMs: 10_000, pollMs: 100,
    async sleep(ms, signal) { signal.throwIfAborted(); now += ms }, onCapabilities() { capabilitiesUpdates++ } })
  const result = await flow.start(new AbortController().signal)
  expect(result).toMatchObject({ state: "ready", requestIssued: true, requestsFinished: true, missing: [] })
  expect(native.commands).toEqual(["status", "request-missing", "status", "status"])
  expect(native.commands.filter(command => command === "request-missing")).toHaveLength(1)
  expect(capabilitiesUpdates).toBe(4)
})

test("health cancellation не отменяет background permission wait и не повторяет prompt", async () => {
  let now = Date.now()
  let releaseBackground!: () => void
  let enteredBackground!: () => void
  const backgroundEntered = new Promise<void>(resolve => { enteredBackground = resolve })
  const backgroundGate = new Promise<void>(resolve => { releaseBackground = resolve })
  const native = new PermissionsFixture([
    response("status", "missing"), response("request-missing", "queued"),
    async (request, signal) => { enteredBackground(); await abortable(backgroundGate, signal); return match(request, response("status", "granted", true)) },
  ])
  const flow = new RuntimeStartupPermissions({ native, now: () => new Date(now), waitMs: 10_000, pollMs: 100,
    async sleep(ms, signal) { signal.throwIfAborted(); now += ms } })
  const lifecycle = new AbortController()
  const running = flow.start(lifecycle.signal)
  await backgroundEntered
  const health = new AbortController()
  health.abort(new Error("health request cancelled"))
  await expect(flow.refreshStatus(health.signal)).rejects.toThrow("health request cancelled")
  releaseBackground()
  expect((await running).state).toBe("ready")
  expect(native.commands.filter(command => command === "request-missing")).toHaveLength(1)
})

test("manual denial остаётся waiting до bounded timeout без restart claim", async () => {
  let now = Date.now()
  const native = new PermissionsFixture([
    response("status", "missing"), response("request-missing", "denied"), response("status", "denied"), response("status", "denied"),
  ], request => match(request, response(request.command, "denied")))
  const flow = new RuntimeStartupPermissions({ native, now: () => new Date(now), waitMs: 1000, pollMs: 500,
    async sleep(ms, signal) { signal.throwIfAborted(); now += ms } })
  const result = await flow.start(new AbortController().signal)
  expect(result).toMatchObject({ state: "timed-out", requestIssued: true, restartNeeded: false, restartState: "unknown" })
  expect(result.missing).toEqual([...STARTUP_PERMISSION_NAMES])
  expect(native.commands.filter(command => command === "request-missing")).toHaveLength(1)
})

test("unsupported official request завершается failed сразу, без десятиминутного ожидания", async () => {
  const initial = response("status", "missing")
  const unsupported = response("request-missing", "missing")
  const value = { beforeGranted: false, currentGranted: false, requestState: "unsupported" as const,
    promptRequested: false, requestFinished: false, restartNeeded: false, restartState: "unknown" as const,
    restartReason: "Restart requirement неизвестен", error: "API unavailable" }
  unsupported.permissions = { accessibility: value, screenRecording: value, postEvents: value, inputMonitoring: value }
  unsupported.requestsFinished = true
  unsupported.restartState = "unknown"
  const native = new PermissionsFixture([initial, unsupported])
  const flow = new RuntimeStartupPermissions({ native })
  expect(await flow.start(new AbortController().signal)).toMatchObject({ state: "failed", requestIssued: true, missing: STARTUP_PERMISSION_NAMES })
  expect(native.commands).toEqual(["status", "request-missing"])
})

test("owner verification failure не вызывает prompt и passive health не обходит проверку", async () => {
  const native = new PermissionsFixture([response("status", "granted")])
  let checks = 0
  const flow = new RuntimeStartupPermissions({ native, async verifyOwner() { checks++; throw new Error("cdhash mismatch") } })
  expect(await flow.start(new AbortController().signal)).toMatchObject({ state: "failed", requestIssued: false })
  expect(native.commands).toEqual([])
  await expect(flow.refreshStatus(new AbortController().signal)).rejects.toThrow("cdhash mismatch")
  expect(native.commands).toEqual([])
  expect(checks).toBe(2)
})

test("доказанный restart-required возвращается как состояние без автоматического restart loop", async () => {
  const initial = response("status", "missing")
  const required = response("request-missing", "denied")
  const value = { beforeGranted: false, currentGranted: false, requestState: "finished" as const,
    promptRequested: true, requestFinished: true, requestReturnedGranted: true,
    restartNeeded: true, restartState: "required" as const, restartReason: "OS требует новый process" }
  required.permissions = { accessibility: value, screenRecording: value, postEvents: value, inputMonitoring: value }
  required.restartNeeded = true
  required.restartState = "required"
  const native = new PermissionsFixture([initial, required])
  const flow = new RuntimeStartupPermissions({ native })
  expect(await flow.start(new AbortController().signal)).toMatchObject({ state: "restart-needed", restartNeeded: true, restartState: "required" })
  expect(native.commands).toEqual(["status", "request-missing"])
})

type Mode = "granted" | "missing" | "queued" | "requesting" | "denied"
type Step = NativeStartupPermissionsResponse | ((request: NativeStartupPermissionsRequest, signal: AbortSignal) => Promise<NativeStartupPermissionsResponse>)
class PermissionsFixture {
  readonly generation = generation
  readonly loadedBuildId = "native-build:permissions"
  readonly commands: string[] = []
  constructor(readonly steps: Step[], readonly fallback?: (request: NativeStartupPermissionsRequest) => NativeStartupPermissionsResponse) {}
  async startupPermissionsRequest(request: NativeStartupPermissionsRequest, control: { signal: AbortSignal }) {
    this.commands.push(request.command)
    control.signal.throwIfAborted()
    const step = this.steps.shift()
    if (typeof step === "function") return step(request, control.signal)
    return match(request, step ?? this.fallback?.(request) ?? response(request.command, "denied"))
  }
}
function response(command: "status" | "request-missing", mode: Mode, current = false): NativeStartupPermissionsResponse {
  const granted = mode === "granted" || current
  const status = granted
    ? { beforeGranted: mode === "granted", currentGranted: true, requestState: "not-needed" as const, promptRequested: false,
        requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
    : mode === "missing"
      ? { beforeGranted: false, currentGranted: false, requestState: "not-requested" as const, promptRequested: false,
          requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
      : mode === "queued"
        ? { beforeGranted: false, currentGranted: false, requestState: "queued" as const, promptRequested: false,
            requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
        : mode === "requesting"
          ? { beforeGranted: false, currentGranted: false, requestState: "requesting" as const, promptRequested: true,
              requestFinished: false, restartNeeded: false, restartState: "not-required" as const }
          : { beforeGranted: false, currentGranted: false, requestState: "finished" as const, promptRequested: true,
              requestFinished: true, requestReturnedGranted: false, restartNeeded: false, restartState: "unknown" as const,
              restartReason: "SDK завершился без текущего grant; restart requirement неизвестен" }
  const permissions = Object.fromEntries(STARTUP_PERMISSION_NAMES.map(name => [name, status])) as NativeStartupPermissionsResponse["permissions"]
  return { kind: "permissions-request-response", command, protocolVersion: "1", requestId: "placeholder", ...generation,
    nativeBuildId: "native-build:permissions", observedAt: new Date().toISOString(),
    requestsFinished: granted || mode === "denied", allGranted: granted, restartNeeded: false,
    restartState: mode === "denied" ? "unknown" : "not-required", permissions, capabilities }
}
function match(request: NativeStartupPermissionsRequest, value: NativeStartupPermissionsResponse): NativeStartupPermissionsResponse {
  return { ...value, requestId: request.requestId, command: request.command, runtimeEpoch: request.runtimeEpoch,
    loginSessionId: request.loginSessionId, nativeGeneration: request.nativeGeneration }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return await Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))])
}
