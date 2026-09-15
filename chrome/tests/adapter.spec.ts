import { describe, expect, test } from "bun:test"
import {
  freezeAdapterHostContext,
  capturePolicySha256,
  type AdapterServices,
  type BrowserExecutionContext,
  type BrowserInstanceRef,
  type BrowserCaptureRequest,
  type BrowserOperationRequest,
  type BrowserTargetRef,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import { buildCaptureResult, RuntimeBrowserAdapter, type BrowserDriver } from "../src/adapter.ts"
import type { CdpTarget } from "@meta/shared"
import { CdpTransportError } from "@meta/shared"

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch: "runtime:1", loginSessionId: "login:1" },
  runtimeBuildId: "runtime-build:1",
  capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "browser-adapter:fixture", capabilities: [] },
})

function target(id: string, url = "https://same.test"): CdpTarget {
  return { id, type: "page", title: id, url, webSocketDebuggerUrl: `ws://fixture/${id}` }
}

function fakeDriver(targets: CdpTarget[] = []): BrowserDriver & { activations: string[] } {
  const activations: string[] = []
  return {
    activations,
    async connect() { return { browserVersion: "Fixture/1" } },
    async disconnect() {},
    async listTargets() { return targets },
    async openTarget(url) {
      const opened = target(`new-${targets.length + 1}`, url)
      targets.push(opened)
      return opened
    },
    async closeTarget(targetId) {
      const index = targets.findIndex(item => item.id === targetId)
      if (index >= 0) targets.splice(index, 1)
    },
    async activateTarget(targetId) { activations.push(targetId) },
    async navigateTarget() { return ready() },
    async reloadTarget() { return ready() },
    async waitTarget() { return ready() },
    async captureTarget() { throw new Error("not used") },
    async readConsole() { return { entries: [], droppedEvents: 0 } },
    async readDom() { return { content: "<html></html>", truncated: false } },
    async readAccessibility() { return { content: "[]", nodeCount: 0, truncated: false } },
  }
}

function ready() {
  return { state: "ready" as const, policy: policy(), steps: [], timedOut: false }
}

function policy() {
  return { policyId: "policy:empty", requiredSteps: [], disabledSteps: [] }
}

const services: AdapterServices = {
  clientSessions: { async assertActive() {} },
  resources: { async assertActive() {}, async assertOwnedSet() {} },
  cleanup: { async verify() {} },
  targets: {
    async resolve(request) {
      return { target: request.target, resolutionId: "resolution:1", proofRef: "proof:1", inventoryId: request.inventoryId, inventoryRevision: request.inventoryRevision, displayLayoutRevision: 0 }
    },
  },
  proofs: { async assertValid() {} },
  evidence: { async issueTargetResolution() { throw new Error("not used") }, async issueWindowCorrelation() { throw new Error("not used") }, async issueInteractionPoint() { throw new Error("not used") }, async issueFrameFreshness() { throw new Error("not used") } },
  frames: { async publish() {} },
  observations: { async resolvePoint() { throw new Error("not used") } },
  continuations: { async issue() { throw new Error("not used") }, async registerAcceptedTask() { throw new Error("not used") }, async advanceVerifiedStatus() { throw new Error("not used") }, async markVerifiedTerminal() { throw new Error("not used") } },
  reservations: { async assertChild() { throw new Error("not used") } },
}

function resource(kind: RuntimeResourceHandle["kind"], resourceRef: string): RuntimeResourceHandle {
  return {
    kind,
    resourceRef,
    leaseId: `lease:${kind}:${resourceRef}`,
    leaseGeneration: "lease-generation:1",
    operationId: "operation:1",
    clientSessionId: "client:1",
    principalId: "principal:1",
    runtimeEpoch: "runtime:1",
    loginSessionId: "login:1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    state: "active",
  }
}

function context(
  target: BrowserExecutionContext["target"],
  resources: RuntimeResourceHandle[],
): RuntimeOperationContext<BrowserExecutionContext> {
  return {
    wire: {
      kind: "browser",
      operationId: "operation:1",
      clientRequestId: "request:1",
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch: "runtime:1",
      loginSessionId: "login:1",
      inventoryId: "browser-inventory:0",
      inventoryRevision: 0,
      target,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
    session: {
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch: "runtime:1",
      loginSessionId: "login:1",
      authenticationGeneration: "auth:1",
      authenticatedAt: "2026-09-15T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    control: { signal: new AbortController().signal, checkpoint() {} },
    resources,
  }
}

function adapter(driver: BrowserDriver, generations = ["cdp:1", "cdp:2"]) {
  return new RuntimeBrowserAdapter(host, services, [{
    browserInstanceRef: "browser:main",
    initialTransportGeneration: "cdp:0",
    provenance: { kind: "local-cdp", endpointHost: "localhost", endpointPort: 9222, profilePath: "/fixture/profile" },
    driver,
  }], () => generations.shift() ?? "cdp:last", () => new Date("2026-09-15T00:00:00.000Z"))
}

async function connect(subject: RuntimeBrowserAdapter, ref: BrowserInstanceRef) {
  const request: BrowserOperationRequest = { kind: "connect-instance", instance: ref }
  return await subject.execute(
    context({ kind: "browser-instance", ref }, [resource("cdp-target", ref.browserInstanceRef)]),
    request,
  )
}

describe("RuntimeBrowserAdapter identity", () => {
  test("connect создаёт новый transport epoch и инвалидирует старый ref", async () => {
    const subject = adapter(fakeDriver([target("a"), target("b")]))
    const initial = (await subject.listInstances({ signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const result = await connect(subject, initial)
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.value.kind !== "instance-connected") throw new Error("Expected connected result")
    const connected = result.value.value.instance.ref
    expect(connected.transportGeneration).toBe("cdp:1")

    await expect(subject.listTargets(initial, { signal: new AbortController().signal, checkpoint() {} })).rejects.toThrow("stale")
    const snapshot = await subject.listTargets(connected, { signal: new AbortController().signal, checkpoint() {} })
    expect(snapshot.targets.map(item => item.ref.targetId)).toEqual(["a", "b"])
  })

  test("одинаковые URL сохраняют exact targetId", async () => {
    const subject = adapter(fakeDriver([target("a"), target("b")]))
    const initial = (await subject.listInstances({ signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const connected = await connect(subject, initial)
    if (!connected.ok || connected.value.value.kind !== "instance-connected") throw new Error("Expected connected result")
    const snapshot = await subject.listTargets(connected.value.value.instance.ref, { signal: new AbortController().signal, checkpoint() {} })
    expect(snapshot.targets[0]!.ref.targetId).toBe("a")
    expect(snapshot.targets[1]!.ref.targetId).toBe("b")
  })

  test("каждый inventory snapshot получает новый ID", async () => {
    const subject = adapter(fakeDriver())
    const control = { signal: new AbortController().signal, checkpoint() {} }
    const first = await subject.listInstances(control)
    const second = await subject.listInstances(control)
    expect(first.inventoryId).not.toBe(second.inventoryId)
  })

  test("visible activation без desktop lease не достигает driver", async () => {
    const driver = fakeDriver([target("a")])
    const subject = adapter(driver)
    const initial = (await subject.listInstances({ signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const connected = await connect(subject, initial)
    if (!connected.ok || connected.value.value.kind !== "instance-connected") throw new Error("Expected connected result")
    const instance = connected.value.value.instance.ref
    const snapshot = await subject.listTargets(instance, { signal: new AbortController().signal, checkpoint() {} })
    const targetRef = snapshot.targets[0]!.ref as BrowserTargetRef
    const result = await subject.execute(
      context({ kind: "browser-target", ref: targetRef }, [resource("cdp-target", targetRef.resourceRef)]),
      { kind: "activate-visible-target", target: targetRef },
    )

    expect(result.ok).toBe(false)
    expect(driver.activations).toEqual([])
  })

  test("неподтверждённый CDP timeout quarantines exact resource", async () => {
    const driver = fakeDriver()
    driver.connect = async () => {
      throw new CdpTransportError("command-timeout", "fixture timeout")
    }
    const subject = adapter(driver)
    const initial = (await subject.listInstances({ signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const result = await connect(subject, initial)

    expect(result.ok).toBe(false)
    expect(result.outcome.dispatch).toBe("unknown")
    expect(result.outcome.cleanup).toMatchObject({
      scope: "owned",
      state: "unknown",
      resources: [{ outcome: "quarantined" }],
    })
  })

  test("ошибка readiness после open не маскирует уже подтверждённый side effect", async () => {
    const driver = fakeDriver()
    driver.waitTarget = async () => { throw new Error("readiness predicate failed") }
    const subject = adapter(driver)
    const initial = (await subject.listInstances({ signal: new AbortController().signal, checkpoint() {} })).instances[0]!.ref
    const connected = await connect(subject, initial)
    if (!connected.ok || connected.value.value.kind !== "instance-connected") throw new Error("Expected connected")
    const instance = connected.value.value.instance.ref
    const result = await subject.execute(
      context({ kind: "browser-instance", ref: instance }, [resource("cdp-target", instance.browserInstanceRef)]),
      { kind: "open-target", instance, url: "https://example.test", policy: policy(), timeoutMs: 1_000 },
    )

    expect(result.ok).toBe(false)
    expect(result.outcome.dispatch).toBe("finished")
    expect(result.outcome.dispatchAttempts).toBe(1)
    expect(result.outcome.cleanup.state).toBe("complete")
  })
})

test("capture публикует фактические PNG bytes через BinaryFramePublisher", async () => {
  const targetRef: BrowserTargetRef = {
    runtimeEpoch: "runtime:1",
    loginSessionId: "login:1",
    browserInstanceRef: "browser:main",
    transportGeneration: "cdp:1",
    targetId: "target:a",
    resourceRef: "cdp:browser:main:target:a",
  }
  const capturePolicy = {
    clip: { kind: "full-target" as const },
    fullPage: true,
    cursor: "exclude" as const,
    readinessPolicy: policy(),
    output: { format: "image/png" as const, scale: 1, maxWidthPx: 100, maxHeightPx: 100, maxPixels: 10_000, maxEncodedBytes: 1_024 },
  }
  const request: BrowserCaptureRequest = {
    source: "browser-viewport",
    caption: "Ожидаю fixture frame",
    publication: { observationId: "observation:1", frameRef: "frame:runtime:1", source: "browser-viewport", captureTarget: { kind: "browser-target", ref: targetRef }, capturePolicySha256: capturePolicySha256(capturePolicy), runtimeEpoch: "runtime:1", loginSessionId: "login:1", expiresAt: "2099-01-01T00:00:00.000Z", inventoryId: "browser-inventory:1", inventoryRevision: 1, displayLayoutRevision: 0, cacheScopeRef: "client:1" },
    target: { kind: "browser-target", ref: targetRef },
    ...capturePolicy,
  }
  const bytes = fixturePng()
  const published: Uint8Array[] = []
  const captureServices: AdapterServices = {
    ...services,
    frames: { async publish(frame) { published.push(frame.bytes) } },
  }

  const result = await buildCaptureResult(host, captureServices, request, targetRef, {
    bytes,
    width: 1,
    height: 1,
    capturedAt: "2026-09-15T00:00:01.000Z",
    readiness: ready(),
  })

  expect(published[0]).toEqual(bytes)
  expect(result.frame.frameRef).toBe("frame:runtime:1")
  expect(result.observation.regions[0]!.space).toEqual({ kind: "browser-viewport", target: targetRef })
})

function fixturePng(): Uint8Array {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
}
