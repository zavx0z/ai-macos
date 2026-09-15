import {
  browserOperationRequestSchema,
  browserOperationResources,
  freezeAdapterHostContext,
  runtimeOperationIntentSchema,
  type BrowserOperationRequest,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import { RuntimeBrowserAdapter, type BrowserDriver } from "@meta/chrome/adapter"
import { RuntimeCore } from "../src/core.ts"

export function browserFixture(options: { ttlMs?: number } = {}) {
  let nowMs = Date.now()
  const clock = { now: () => new Date(nowMs) }
  const generation = { runtimeEpoch: "runtime:lifetime", loginSessionId: "login:lifetime" }
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "build:lifetime", clock, reservationTtlMs: options.ttlMs })
  const driver = new FixtureBrowserDriver()
  let sequence = 0
  const initial = { ...generation, browserInstanceRef: "browser:lifetime", transportGeneration: "transport:0" }
  const host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "build:lifetime",
    capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "browser:lifetime", capabilities: [] },
  })
  const adapter = new RuntimeBrowserAdapter(host, runtime.services, [{
    browserInstanceRef: initial.browserInstanceRef,
    initialTransportGeneration: initial.transportGeneration,
    provenance: { kind: "local-cdp", endpointHost: "127.0.0.1", endpointPort: 9222, profilePath: "/tmp/lifetime-test" },
    driver,
  }], () => `transport:${++sequence}`, clock.now)
  const verifier = {
    async verifyConnected() { if (!driver.connected) throw new Error("Driver connect не подтверждён") },
    async verifyRemoved() { if (driver.connected) throw new Error("Driver disconnect не подтверждён") },
    async verifyCompletion() {
      if (driver.verifierGate !== undefined) await driver.verifierGate
    },
    async recoverRemoval() { await driver.disconnect() },
  }
  runtime.browserLifetime.configure("browser", { domain: "browser", adapter, verifier })
  const register = (instance: typeof initial, revision: number) => runtime.targets.register(
    { kind: "browser-instance", ref: instance }, `inventory:${revision}`, revision, `resolution:${revision}`, `proof:${revision}`, 0,
  )
  register(initial, 1)
  const credential = runtime.openClient("principal:lifetime")
  const invoke = (session: RuntimeClientSession, requestId: string, raw: BrowserOperationRequest, revision: number) => {
    const request = browserOperationRequestSchema.parse(raw)
    const target = "instance" in request
      ? { kind: "browser-instance" as const, ref: request.instance }
      : { kind: "browser-target" as const, ref: request.target }
    return runtime.browserLifetime.execute(session, "browser", runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: requestId,
      precondition: { target, inventoryId: `inventory:${revision}`, inventoryRevision: revision },
      deadlineAt: new Date(nowMs + 5_000).toISOString(),
      requestedResources: browserOperationResources(request),
    }), request)
  }
  return { runtime, driver, initial, credential, invoke, register, adapter, verifier, advance: (ms: number) => { nowMs += ms } }
}

export class FixtureBrowserDriver implements BrowserDriver {
  connected = false
  connectCalls = 0
  openCalls = 0
  disconnectCalls = 0
  verifierGate?: Promise<void>
  failOpen = false
  async connect() { this.connectCalls++; this.connected = true; return { browserVersion: "Chrome/Test" } }
  async disconnect() { this.disconnectCalls++; this.connected = false }
  async listTargets() { return [] }
  async openTarget(url: string) {
    this.openCalls++
    if (this.failOpen) throw new Error("Target list unavailable")
    return { id: "target:test", type: "page", title: "Test", url, webSocketDebuggerUrl: "ws://test" }
  }
  async closeTarget() {}
  async activateTarget() {}
  async navigateTarget(): Promise<never> { throw new Error("not used") }
  async reloadTarget(): Promise<never> { throw new Error("not used") }
  async waitTarget(_target: string, policy: Parameters<BrowserDriver["waitTarget"]>[1]) {
    return { state: "ready" as const, policy, steps: [], timedOut: false }
  }
  async captureTarget(): Promise<never> { throw new Error("not used") }
  async readConsole(): Promise<never> { throw new Error("not used") }
  async readDom(): Promise<never> { throw new Error("not used") }
  async readAccessibility(): Promise<never> { throw new Error("not used") }
}
