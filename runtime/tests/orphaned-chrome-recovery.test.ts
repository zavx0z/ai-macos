import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { CdpTransportError } from "@meta/shared"
import { browserOperationResources, runtimeOperationIntentSchema, type RuntimeClientSession } from "@meta/shared/contracts"
import { createBrowserHostComposition } from "../src/browser-host.ts"
import { FileClientState } from "../src/client-state.ts"
import { RuntimeCore } from "../src/core.ts"
import { createRuntimeHost } from "../src/host.ts"
import { FileLifetimeStore } from "../src/lifetime-state.ts"
import { FileOperationJournal } from "../src/storage/operation-journal.ts"
import { FixtureBrowserDriver } from "./browser-fixture.ts"

const loginSessionId = "login:orphaned-chrome-test"
const bindingId = "browser:orphaned-test"
const browserInstanceRef = "chrome:orphaned-test"

class TimeoutDriver extends FixtureBrowserDriver {
  failConnect = true
  failDisconnect = false
  override async connect() {
    this.connectCalls++
    this.connected = true
    if (this.failConnect) throw new CdpTransportError("connect-timeout", "injected CDP connect timeout")
    return { browserVersion: "Chrome/Test" }
  }
  override async disconnect() {
    this.disconnectCalls++
    if (this.failDisconnect) throw new Error("injected physical disconnect failure")
    this.connected = false
  }
}

function browserConfig(driver: TimeoutDriver) {
  return { chrome: { bindingId, instances: [{
    browserInstanceRef, initialTransportGeneration: "transport:initial",
    connectionMode: "existing-session" as const, userDataDir: "/fixture/orphaned-chrome-profile", driver,
  }] } }
}

async function connect(core: RuntimeCore, session: RuntimeClientSession, clientRequestId: string) {
  const instance = { ...core.generation, browserInstanceRef, transportGeneration: "transport:initial" }
  const request = { kind: "connect-instance" as const, instance }
  return core.browserLifetime.execute(session, bindingId, runtimeOperationIntentSchema.parse({
    intent: "mutation", clientRequestId,
    precondition: {
      target: { kind: "browser-instance", ref: instance },
      inventoryId: `browser-host:${bindingId}:${browserInstanceRef}:initial`, inventoryRevision: 0,
    },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(), requestedResources: browserOperationResources(request),
  }), request)
}

type FailWrites = { journal?: boolean, lifetime?: boolean }
async function openCore(directory: string, runtimeEpoch: string, driver: TimeoutDriver, fail: FailWrites = {}) {
  const clients = new FileClientState(join(directory, "clients.json"))
  const state = await clients.initialize(loginSessionId)
  const journal = new FileOperationJournal(join(directory, "operations"), {
    failpoint(stage) { if (stage === "before-write" && fail.journal) throw new Error("injected journal write failure") },
  })
  const lifetimes = new FileLifetimeStore(join(directory, "lifetimes"), {
    failpoint(stage) { if (stage === "before-write" && fail.lifetime) throw new Error("injected lifetime write failure") },
  })
  const core = new RuntimeCore({
    generation: { runtimeEpoch, loginSessionId }, runtimeBuildId: "build:orphaned-test",
    secret: Buffer.from(state.secretHex, "hex"), hmacKeyGeneration: state.keyGeneration,
    operationJournal: journal, lifetimeStore: lifetimes,
    clientPersistence: { sessions: state.sessions, persist: values => clients.persist(values) },
  })
  await core.initializeRecovery()
  createBrowserHostComposition(core, browserConfig(driver))
  await core.browserLifetime.restorePersisted()
  return { core, journal, lifetimes }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cu-orphaned-chrome-"))
  const driver = new TimeoutDriver()
  const old = await openCore(directory, "runtime:orphan-old", driver)
  const credential = await old.core.openClientDurable("mcp")
  const failed = await connect(old.core, credential.session, "connect:old-timeout")
  expect(failed.operation.state).toBe("failed")
  expect(failed.operation.outcome.cleanup.state).toBe("unknown")
  expect((await old.lifetimes.loadAll())[0]?.handle).toBeUndefined()
  await old.core.closeClientLifecycle()
  const fail: FailWrites = {}
  const current = await openCore(directory, "runtime:orphan-current", driver, fail)
  return {
    directory, driver, old, credential, failed, fail, current,
    operationId: failed.operation.context.operationId,
    journalKey: {
      runtimeEpoch: failed.operation.context.runtimeEpoch,
      loginSessionId: failed.operation.context.loginSessionId,
      operationId: failed.operation.context.operationId,
    },
    oldLineage: old.core.clients.lineage(credential.session),
    async close() { await current.core.closeClientLifecycle(); await rm(directory, { recursive: true, force: true }) },
  }
}

test("old Chrome cleanup использует historical receipt, не ResourceRegistry нового Runtime", async () => {
  const f = await fixture()
  try {
    expect(f.current.core.resources.quarantinedCount()).toBe(0)
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
    const fresh = await f.current.core.openClientDurable("mcp")
    expect(f.current.core.clients.lineage(fresh.session)).not.toBe(f.oldLineage)
    try {
      await f.current.core.browserLifetime.shutdownLineage(f.oldLineage)
    } catch (error) {
      if (error instanceof Error && error.message === "Recovery resource generation не совпадает") {
        console.error("EXPECTED_BASELINE_BUG=historical-resource-not-current")
      }
      throw error
    }
    await f.current.core.refreshStartupRecovery(true)
    expect(f.driver.disconnectCalls).toBe(1)
    expect(f.current.core.admissionSealed).toBe(false)
    expect(f.current.core.recoveryEvidence()).toHaveLength(0)
    const saved = await f.current.journal.read(f.journalKey)
    expect(saved?.record.outcome.cleanup.state).toBe("complete")
    expect(saved?.record.context).toEqual(f.failed.operation.context)
    expect(saved?.record.resources).toEqual(f.failed.operation.resources)
    expect(saved?.record.error).toEqual(f.failed.operation.error)
    expect(saved?.record.outcome.dispatch).toBe("unknown")
    expect(saved?.record.outcome.effect).toEqual(f.failed.operation.outcome.effect)
    expect(saved?.record.state).toBe("failed")
    await expect(f.current.core.getOperation(fresh.session, f.operationId)).rejects.toThrow("другой client lineage")
    expect((await f.current.lifetimes.loadAll())[0]).toMatchObject({ state: "released", lineageId: f.oldLineage })
    await f.current.core.browserLifetime.shutdownLineage(f.oldLineage)
    expect(f.driver.disconnectCalls).toBe(1)
    f.driver.failConnect = false
    expect((await connect(f.current.core, fresh.session, "connect:after-recovery")).operation.state).toBe("completed")
    await f.current.core.browserLifetime.shutdownLineage()
    const third = await openCore(f.directory, "runtime:orphan-third", f.driver)
    try {
      expect(third.core.admissionSealed).toBe(false)
      expect(third.core.recoveryEvidence()).toHaveLength(0)
    } finally { await third.core.closeClientLifecycle() }
  } finally { await f.close() }
})

test("host startup устраняет failed connect до появления новой MCP lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cu-orphaned-host-"))
  const driver = new TimeoutDriver()
  const options = {
    socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    stateDirectory: join(directory, "state"), runtimeBuildId: "build:orphaned-host",
    expectedNativeBuildId: "native:unused", expectedHostname: hostname(), loginSessionId, browser: browserConfig(driver),
  }
  let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
  try {
    host = await createRuntimeHost(options)
    const oldClient = await host.core.openClientDurable("mcp")
    const oldLineage = host.core.clients.lineage(oldClient.session)
    expect((await connect(host.core, oldClient.session, "connect:host-timeout")).operation.outcome.cleanup.state).toBe("unknown")
    await host.close()
    host = undefined
    host = await createRuntimeHost(options)
    if (host.core.admissionSealed) console.error("EXPECTED_BASELINE_BUG=orphaned-connect-still-blocked")
    expect(host.core.admissionSealed).toBe(false)
    expect(host.core.recoveryEvidence()).toHaveLength(0)
    expect(driver.disconnectCalls).toBe(1)
    const fresh = await host.core.openClientDurable("mcp")
    expect(host.core.clients.lineage(fresh.session)).not.toBe(oldLineage)
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }) }
})

test("публичный recover по-прежнему не отдаёт чужую lineage новому клиенту", async () => {
  const f = await fixture()
  try {
    const fresh = await f.current.core.openClientDurable("mcp")
    const execution = await f.current.core.browserLifetime.recover(fresh.session, bindingId, runtimeOperationIntentSchema.parse({
      intent: "admin", clientRequestId: "recover:foreign-lineage",
      precondition: {
        target: { kind: "browser-instance", ref: { ...f.current.core.generation, browserInstanceRef, transportGeneration: "transport:initial" } },
        inventoryId: `browser-host:${bindingId}:${browserInstanceRef}:initial`, inventoryRevision: 0,
      },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(), requestedResources: [],
    }))
    expect(execution.operation.state).toBe("rejected")
    expect(execution.operation.outcome.dispatchAttempts).toBe(0)
    expect(f.driver.disconnectCalls).toBe(0)
    expect(f.current.core.admissionSealed).toBe(true)
  } finally { await f.close() }
})

test("startup-only cleanup не очищает текущую generation и resumed владельца", async () => {
  const f = await fixture()
  try {
    await expect(f.old.core.browserLifetime.recoverRestoredConnect(f.operationId)).rejects.toThrow("exact orphaned")
    await f.current.core.resumeClientDurable(f.credential.resumptionToken)
    await expect(f.current.core.browserLifetime.recoverRestoredConnect(f.operationId)).rejects.toThrow("действующего клиента")
    expect(f.driver.disconnectCalls).toBe(0)
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
  } finally { await f.close() }
})

test("неподтверждённый disconnect не изменяет operation journal и не снимает quarantine", async () => {
  const f = await fixture()
  try {
    const before = await f.current.journal.read(f.journalKey)
    f.driver.failDisconnect = true
    await expect(f.current.core.browserLifetime.recoverRestoredConnect(f.operationId)).rejects.toThrow("physical disconnect failure")
    expect(await f.current.journal.read(f.journalKey)).toEqual(before)
    expect((await f.current.lifetimes.loadAll())[0]?.state).toBe("quarantined")
    expect(f.current.core.admissionSealed).toBe(true)
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
  } finally { await f.close() }
})

test("ошибка записи historical receipt не превращается в успешную очистку", async () => {
  const f = await fixture()
  try {
    f.fail.journal = true
    await expect(f.current.core.browserLifetime.recoverRestoredConnect(f.operationId)).rejects.toThrow()
    expect((await f.current.journal.read(f.journalKey))?.record.outcome.cleanup.state).toBe("unknown")
    expect((await f.current.lifetimes.loadAll())[0]?.state).toBe("quarantined")
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
    expect(f.current.core.admissionSealed).toBe(true)
  } finally { await f.close() }
})

test("operation write без lifetime commit не снимает recovery blocker; повтор использует штатный cleanup", async () => {
  const f = await fixture()
  try {
    f.fail.lifetime = true
    await expect(f.current.core.browserLifetime.recoverRestoredConnect(f.operationId)).rejects.toThrow("lifetime write failure")
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
    expect(f.current.core.admissionSealed).toBe(true)
    expect((await f.current.lifetimes.loadAll())[0]?.state).toBe("quarantined")
    f.fail.lifetime = false
    await f.current.core.browserLifetime.recoverRestoredConnect(f.operationId)
    await f.current.core.refreshStartupRecovery(true)
    expect(f.current.core.recoveryEvidence()).toHaveLength(0)
    expect(f.current.core.admissionSealed).toBe(false)
    expect((await f.current.lifetimes.loadAll())[0]?.state).toBe("released")
  } finally { await f.close() }
})

test("отменённый startup cleanup не отправляет disconnect и не пишет journal", async () => {
  const f = await fixture()
  try {
    const before = await f.current.journal.read(f.journalKey)
    await expect(f.current.core.browserLifetime.recoverRestoredConnect(f.operationId, AbortSignal.abort())).rejects.toThrow()
    expect(f.driver.disconnectCalls).toBe(0)
    expect(await f.current.journal.read(f.journalKey)).toEqual(before)
    expect(f.current.core.recoveryEvidence()).toHaveLength(1)
  } finally { await f.close() }
})
