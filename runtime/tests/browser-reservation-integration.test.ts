import { expect, test } from "bun:test"
import {
  browserOperationRequestSchema,
  freezeAdapterHostContext,
  runtimeOperationIntentSchema,
  type BrowserExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { RuntimeBrowserAdapter, type BrowserDriver } from "@meta/chrome/adapter"
import { RuntimeCore } from "../src/core.ts"

const generation = { runtimeEpoch: "runtime:browser-composition", loginSessionId: "login:browser-composition" }
const instance0 = {
  ...generation,
  browserInstanceRef: "browser:composition",
  transportGeneration: "cdp:0",
}

test("RuntimeBrowserAdapter connect creates lifetime reservation used by child and verified disconnect", async () => {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:browser-composition",
    completionVerifier: { async verify() {} },
  })
  const driver = new FakeBrowserDriver()
  const browser = new RuntimeBrowserAdapter(
    freezeAdapterHostContext({
      generation,
      runtimeBuildId: "runtime-build:browser-composition",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "browser:composition",
        capabilities: [
          { id: "browser.instances", state: "ready" },
          { id: "browser.targets", state: "ready" },
          { id: "browser.resources", state: "ready" },
        ],
      },
    }),
    runtime.services,
    [{
      browserInstanceRef: instance0.browserInstanceRef,
      initialTransportGeneration: instance0.transportGeneration,
      provenance: {
        kind: "local-cdp",
        endpointHost: "127.0.0.1",
        endpointPort: 9222,
        profilePath: "/tmp/browser-composition",
      },
      driver,
    }],
    () => "cdp:1",
  )
  runtime.targets.register(
    { kind: "browser-instance", ref: instance0 },
    "browser-inventory:0",
    1,
    "resolution:browser:0",
    "proof:browser:0",
    0,
  )
  const client = runtime.openClient("principal:browser-composition")
  const connectRequest = browserOperationRequestSchema.parse({ kind: "connect-instance", instance: instance0 })
  const connect = await runtime.runOperation(
    client.session,
    operationIntent("connect", { kind: "browser-instance", ref: instance0 }, "browser-inventory:0", 1, instance0.browserInstanceRef),
    connectRequest,
    (context, request) => browser.execute(context as RuntimeOperationContext<BrowserExecutionContext>, request),
  )
  if (!connect.result.ok || connect.result.value.value.kind !== "instance-connected") throw new Error("Browser connect failed")
  const instance1 = connect.result.value.value.instance.ref
  const reservation = runtime.reservations.reserve({
    session: client.session,
    operation: connect.operation,
    target: { kind: "browser-instance", ref: instance1 },
    statusRevision: 1,
    ttlMs: 60_000,
  })
  runtime.targets.register(
    { kind: "browser-instance", ref: instance1 },
    "browser-inventory:1",
    2,
    "resolution:browser:1",
    "proof:browser:1",
    0,
  )
  const openRequest = browserOperationRequestSchema.parse({
    kind: "open-target",
    instance: instance1,
    url: "https://example.com",
    policy: { policyId: "policy:browser", requiredSteps: [], disabledSteps: [] },
    timeoutMs: 1_000,
  })
  const opened = await runtime.runOperation(
    client.session,
    operationIntent("open", { kind: "browser-instance", ref: instance1 }, "browser-inventory:1", 2, instance1.browserInstanceRef),
    openRequest,
    (context, request) => browser.execute(context as RuntimeOperationContext<BrowserExecutionContext>, request),
  )
  expect(opened.operation.state).toBe("completed")
  expect(driver.openCalls).toBe(1)

  const disconnectRequest = browserOperationRequestSchema.parse({ kind: "disconnect-instance", instance: instance1 })
  const disconnected = await runtime.runOperation(
    client.session,
    operationIntent("disconnect", { kind: "browser-instance", ref: instance1 }, "browser-inventory:1", 2, instance1.browserInstanceRef),
    disconnectRequest,
    (context, request) => browser.execute(context as RuntimeOperationContext<BrowserExecutionContext>, request),
  )
  expect(disconnected.operation.state).toBe("completed")
  const cleanupReport = {
    reservationId: reservation.reservationId,
    reservationGeneration: reservation.reservationGeneration,
    externalGeneration: reservation.externalGeneration,
    statusRevision: 2,
    cleanupEvidenceRef: "browser-disconnect-confirmed:1",
  }
  expect((await runtime.reservations.release(client.session, cleanupReport, {
    async verifyRemoval(_handle, report) {
      expect(driver.connected).toBe(false)
      expect(report.cleanupEvidenceRef).toBe("browser-disconnect-confirmed:1")
    },
  })).state).toBe("released")
})

function operationIntent(
  suffix: string,
  target: { kind: "browser-instance", ref: typeof instance0 },
  inventoryId: string,
  inventoryRevision: number,
  resourceRef: string,
) {
  return runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: `request:browser:${suffix}`,
    precondition: { target, inventoryId, inventoryRevision },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: [{ kind: "cdp-target", resourceRef }],
  })
}

class FakeBrowserDriver implements BrowserDriver {
  connected = false
  openCalls = 0

  async connect() { this.connected = true; return { browserVersion: "Chrome/Fake" } }
  async disconnect() { this.connected = false }
  async listTargets() { return [] }
  async openTarget(url: string) {
    this.openCalls++
    return { id: "target:composition", type: "page", title: "Example", url, webSocketDebuggerUrl: "ws://fake" }
  }
  async closeTarget() {}
  async activateTarget() {}
  async navigateTarget(): Promise<never> { throw new Error("not used") }
  async reloadTarget(): Promise<never> { throw new Error("not used") }
  async waitTarget(_targetId: string, policy: Parameters<BrowserDriver["waitTarget"]>[1]) {
    return { state: "ready" as const, policy, steps: [], timedOut: false }
  }
  async captureTarget(): Promise<never> { throw new Error("not used") }
  async readConsole(): Promise<never> { throw new Error("not used") }
  async readDom(): Promise<never> { throw new Error("not used") }
  async readAccessibility(): Promise<never> { throw new Error("not used") }
}
