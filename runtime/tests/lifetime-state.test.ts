import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserLifetimeCoordinator } from "../src/reservations.ts"
import {
  browserOperationResources,
  runtimeOperationIntentSchema,
  type BrowserExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  FileLifetimeStore,
  lifetimeConfigFingerprint,
  type LifetimeStateRecord,
} from "../src/lifetime-state.ts"
import { browserFixture } from "./browser-fixture.ts"

test("FileLifetimeStore восстанавливает connecting как durable evidence и блокирует ABA generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifetime-state-"))
  const store = new FileLifetimeStore(directory)
  const first = record({ state: "connecting", revision: 1 })
  try {
    await store.persist(first)
    expect(await new FileLifetimeStore(directory).loadAll()).toEqual([first])
    const quarantined = { ...first, state: "quarantined" as const, revision: 2, updatedAt: "2026-09-15T00:00:01.000Z" }
    await store.persist(quarantined)
    await expect(store.persist(record({
      runtimeEpoch: "runtime:new",
      target: { kind: "browser-instance", ref: { runtimeEpoch: "runtime:new", loginSessionId: "login:1", browserInstanceRef: "browser:1", transportGeneration: "transport:new" } },
      state: "connecting",
      revision: 3,
    }))).rejects.toThrow()
    expect((await store.loadAll())[0]?.state).toBe("quarantined")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("startup restore публикует только quarantined slot без connect или cleanup replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifetime-restore-"))
  const store = new FileLifetimeStore(directory)
  const fixture = browserFixture()
  const lineageId = fixture.runtime.clients.lineage(fixture.credential.session)
  const stored = record({ lineageId, state: "active", revision: 1 })
  await store.persist(stored)
  let recoverCalls = 0
  const coordinator = new BrowserLifetimeCoordinator({
    generation: fixture.runtime.generation,
    clients: fixture.runtime.clients,
    store,
    lookup: () => undefined,
    run: async () => { throw new Error("startup restore must not run operation") },
    stageRecovered: async () => () => {},
  })
  coordinator.configure("browser:durable", {
    domain: "browser",
    adapter: fixture.adapter,
    persistence: [{
      owner: stored.owner,
      configFingerprint: stored.configFingerprint,
      physicalOwnershipKey: stored.physicalOwnershipKey,
    }],
    verifier: {
      async verifyConnected() { throw new Error("not used") },
      async verifyRemoved() { throw new Error("not used") },
      async verifyCompletion() { throw new Error("not used") },
      async recoverRemoval() { recoverCalls += 1 },
    },
  })
  try {
    const restored = await coordinator.restorePersisted()
    expect(restored).toHaveLength(1)
    expect(restored[0]?.state).toBe("quarantined")
    expect(recoverCalls).toBe(0)
    expect((await coordinator.authority.inspect(fixture.credential.session, stored.target))?.state).toBe("quarantined")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Android matching tuple after restart остаётся quarantine, не ownership proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifetime-android-"))
  const store = new FileLifetimeStore(directory)
  const android = record({
    bindingId: "android:durable",
    physicalOwnershipKey: {
      kind: "android-forward",
      serial: "phone-a",
      localPort: 9223,
      remoteSocket: "localabstract:chrome_devtools_remote",
    },
    owner: {
      kind: "device-browser",
      deviceRef: "device:phone-a",
      serial: "phone-a",
      browserInstanceRef: "android-browser:phone-a",
    },
    initialTarget: {
      kind: "device-browser-instance",
      ref: {
        runtimeEpoch: "runtime:1",
        loginSessionId: "login:1",
        deviceRef: "device:phone-a",
        serial: "phone-a",
        transportGeneration: "usb:1",
        browserInstanceRef: "android-browser:phone-a",
        browserTransportGeneration: "android-cdp:1",
      },
    },
    target: {
      kind: "device-browser-instance",
      ref: {
        runtimeEpoch: "runtime:1",
        loginSessionId: "login:1",
        deviceRef: "device:phone-a",
        serial: "phone-a",
        transportGeneration: "usb:1",
        browserInstanceRef: "android-browser:phone-a",
        browserTransportGeneration: "android-cdp:1",
      },
    },
    handle: undefined,
    state: "quarantined",
    revision: 1,
  })
  try {
    await store.persist(android)
    const restored = (await new FileLifetimeStore(directory).loadAll())[0]!
    expect(restored.state).toBe("quarantined")
    expect(restored.physicalOwnershipKey).toEqual(android.physicalOwnershipKey)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("coordinator persists connecting before side effect, active before acceptance, released before cleanup commit", async () => {
  const fixture = browserFixture()
  const connectRequest = { kind: "connect-instance" as const, instance: fixture.initial }
  const connect = await fixture.invoke(fixture.credential.session, "durable:template-connect", connectRequest, 1)
  if (!connect.result.ok || connect.result.value.value.kind !== "instance-connected") throw new Error("connect template failed")
  const actual = connect.result.value.value.instance.ref
  const persisted: LifetimeStateRecord[] = []
  const store = {
    async persist(value: LifetimeStateRecord) {
      persisted.push(structuredClone(value))
      return structuredClone(value)
    },
    async loadAll() { return [] },
  }
  let current = connect
  const coordinator = new BrowserLifetimeCoordinator({
    generation: fixture.runtime.generation,
    clients: fixture.runtime.clients,
    store,
    lookup: operationId => current.operation.context.operationId === operationId ? current.operation : undefined,
    stageRecovered: async () => () => {},
    run: async (_session, _intent, request, _execute, lifecycle) => {
      const context: RuntimeOperationContext<BrowserExecutionContext> = {
        wire: current.operation.context as BrowserExecutionContext,
        session: fixture.credential.session,
        control: { signal: new AbortController().signal, checkpoint() {} },
        resources: current.operation.resources,
      }
      await lifecycle.before(context)
      expect(persisted.at(-1)?.state).toBe(request.kind === "connect-instance" ? "connecting" : "active")
      const commit = await lifecycle.stage(current.operation, current.result)
      expect(persisted.at(-1)?.state).toBe(request.kind === "connect-instance" ? "active" : "released")
      commit()
      return current
    },
  })
  const persistence = {
    owner: { kind: "browser" as const, browserInstanceRef: fixture.initial.browserInstanceRef },
    configFingerprint: lifetimeConfigFingerprint({ endpoint: 9222 }),
    physicalOwnershipKey: { kind: "chrome-cdp" as const, endpointHost: "127.0.0.1" as const, endpointPort: 9222, profilePath: "/durable/profile" },
  }
  coordinator.configure("durable", {
    domain: "browser",
    adapter: fixture.adapter,
    verifier: fixture.verifier,
    persistence: [persistence],
  })
  const connectIntent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "durable:connect",
    precondition: { target: { kind: "browser-instance", ref: fixture.initial }, inventoryId: "inventory:1", inventoryRevision: 1 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(connectRequest),
  })
  await coordinator.execute(fixture.credential.session, "durable", connectIntent, connectRequest)

  fixture.register(actual, 2)
  const disconnectRequest = { kind: "disconnect-instance" as const, instance: actual }
  current = await fixture.invoke(fixture.credential.session, "durable:template-disconnect", disconnectRequest, 2)
  const disconnectIntent = runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId: "durable:disconnect",
    precondition: { target: { kind: "browser-instance", ref: actual }, inventoryId: "inventory:2", inventoryRevision: 2 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: browserOperationResources(disconnectRequest),
  })
  await coordinator.execute(fixture.credential.session, "durable", disconnectIntent, disconnectRequest)
  expect(persisted.map(item => item.state)).toEqual(["connecting", "active", "active", "released"])
})

function record(overrides: Partial<LifetimeStateRecord> = {}): LifetimeStateRecord {
  const target = {
    kind: "browser-instance" as const,
    ref: {
      runtimeEpoch: "runtime:1",
      loginSessionId: "login:1",
      browserInstanceRef: "browser:1",
      transportGeneration: "transport:1",
    },
  }
  const handle = {
    reservationId: "reservation:1",
    reservationGeneration: "reservation-generation:1",
    runtimeEpoch: "runtime:1",
    loginSessionId: "login:1",
    principalId: "principal:1",
    lineageRef: "lineage:1",
    target,
    externalGeneration: { kind: "browser" as const, browserTransportGeneration: "transport:1" },
    createdAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    state: "active" as const,
    statusRevision: 1,
  }
  const value: LifetimeStateRecord = {
    runtimeEpoch: "runtime:1",
    loginSessionId: "login:1",
    bindingId: "browser:durable",
    owner: { kind: "browser", browserInstanceRef: "browser:1" },
    configFingerprint: lifetimeConfigFingerprint({ profile: "/configured/profile" }),
    physicalOwnershipKey: {
      kind: "chrome-cdp",
      endpointHost: "127.0.0.1",
      endpointPort: 9222,
      profilePath: "/configured/profile",
    },
    lineageId: "lineage:1",
    operationId: "operation:connect",
    initialTarget: target,
    target,
    handle,
    state: "active",
    revision: 1,
    operationIds: ["operation:connect"],
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  }
  if (value.state === "connecting") delete value.handle
  return value
}
