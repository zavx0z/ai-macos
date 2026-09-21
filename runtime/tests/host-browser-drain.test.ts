import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type { CdpSessionOptions } from "@meta/shared"
import { browserInstanceSnapshotSchema, browserOperationResources, operationRecordSchema } from "@meta/shared/contracts"
import { ExistingChromeDriver } from "@meta/chrome/existing-session"
import { createRuntimeHost } from "../src/host.ts"
import { FileLifetimeStore } from "../src/lifetime-state.ts"
import { sha256 } from "../src/primitives.ts"
import { FileOperationJournal } from "../src/storage/index.ts"

type Socket = ReturnType<NonNullable<CdpSessionOptions["socketFactory"]>>

/** Только локальные события: сеть, настоящий Chrome и Native helper не запускаются. */
class ApprovalSocket extends EventTarget {
  autoClose = true
  closeCalls = 0
  commands: string[] = []
  readonly socket: Socket = {
    addEventListener: this.addEventListener.bind(this) as Socket["addEventListener"],
    removeEventListener: this.removeEventListener.bind(this) as Socket["removeEventListener"],
    send: data => { this.commands.push(String(data)) },
    close: () => {
      this.closeCalls += 1
      if (this.autoClose) this.confirmClose()
    },
  }

  confirmClose() { this.dispatchEvent(new Event("close")) }
}

async function fixture(options: { autoClose?: boolean, approvalTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cu-bdrain-"))
  const socket = new ApprovalSocket()
  socket.autoClose = options.autoClose ?? true
  let connections = 0
  let socketCreated!: () => void
  const created = new Promise<void>(resolve => { socketCreated = resolve })
  const driver = new ExistingChromeDriver({
    userDataDir: "/fixture/chrome-drain",
    approvalTimeoutMs: options.approvalTimeoutMs ?? 20,
    discover: async userDataDir => ({ userDataDir, port: 1, browserPath: "/devtools/browser/fixture",
      webSocketUrl: "ws://127.0.0.1:1/devtools/browser/fixture" }),
    socketFactory: () => {
      connections += 1
      socketCreated()
      return socket.socket
    },
  })
  const loginSessionId = "login:browser-drain-test"
  let host: Awaited<ReturnType<typeof createRuntimeHost>>
  try {
    host = await createRuntimeHost({
      socketPath: join(directory, "r.sock"),
      credentialPath: join(directory, "credential.json"),
      stateDirectory: join(directory, "state"),
      runtimeBuildId: "build:browser-drain-test",
      expectedNativeBuildId: "build:unused",
      expectedHostname: hostname(),
      loginSessionId,
      browser: { chrome: { bindingId: "browser", instances: [{
        browserInstanceRef: "browser:drain-test", initialTransportGeneration: "transport:initial",
        connectionMode: "existing-session", userDataDir: "/fixture/chrome-drain", driver,
      }] } },
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const credential = await host.core.openClientDurable("principal:browser-drain-test")
  const state = join(directory, "state", `login-${sha256(loginSessionId)}`)
  const store = new FileLifetimeStore(join(state, "lifetimes"))
  const journal = new FileOperationJournal(join(state, "operations"))
  const connect = async (signal = new AbortController().signal) => {
    const inventory = await host.catalog.dispatch(credential.session, "browser_chrome_instances", {}, signal)
    const snapshot = browserInstanceSnapshotSchema.parse(inventory.data)
    const request = { kind: "connect-instance" as const, instance: snapshot.instances[0]!.ref }
    return host.catalog.dispatch(credential.session, "browser_chrome_operation", {
      intent: {
        intent: "mutation", clientRequestId: `connect:${crypto.randomUUID()}`,
        precondition: { target: { kind: "browser-instance", ref: request.instance },
          inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.inventoryRevision },
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
        requestedResources: browserOperationResources(request),
      },
      request,
    }, signal)
  }
  return {
    host, credential, socket, store, journal, connect, created,
    connections: () => connections,
    async dispose() {
      socket.confirmClose()
      await driver.disconnect()
      await host.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function failedConnect(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.connect()
  const operation = operationRecordSchema.parse(response.data.operation)
  expect(operation).toMatchObject({ state: "failed", error: { code: "deadline-exceeded", stage: "browser-adapter" },
    outcome: { dispatch: "unknown", cleanup: { state: "unknown" } } })
  expect(f.host.core.activeOperationCount()).toBe(0)
  expect(f.host.core.resources.quarantinedCount()).toBe(1)
  expect(f.connections()).toBe(1)
  expect(f.socket.closeCalls).toBe(1)
  expect(f.socket.commands).toEqual([])
  return operation
}

test("host drain после approval timeout достигает browser cleanup до строгой проверки quarantine", async () => {
  const f = await fixture()
  try {
    const before = await failedConnect(f)
    // Эти запреты должны сохраниться: очистку browser нельзя подменить Native restart.
    await expect(f.host.core.drainOperations()).rejects.toThrow("Runtime drain оставил unknown/active operations")
    await expect(f.host.core.retainForRecoveryRestart()).rejects.toThrow("Unknown non-native cleanup")
    await expect(f.host.drain()).resolves.toMatchObject({ cleanup: "complete" })
    const after = await f.host.core.getOperation(f.credential.session, before.context.operationId)
    expect(after).toMatchObject({ state: before.state, error: before.error,
      outcome: { dispatch: before.outcome.dispatch, effect: before.outcome.effect, cleanup: { state: "complete" } } })
    const stored = await f.journal.read({ runtimeEpoch: before.context.runtimeEpoch,
      loginSessionId: before.context.loginSessionId, operationId: before.context.operationId })
    expect(stored?.record.outcome.cleanup.state).toBe("complete")
    expect((await f.store.loadAll())[0]?.state).toBe("released")
    expect(f.host.core.resources.quarantinedCount()).toBe(0)
    expect(f.host.core.resources.cleanupReceiptByLeaseId(before.resources[0]!.leaseId)?.state).toBe("complete")
    expect(f.host.doctor().runtime).toMatchObject({ draining: true, admissionSealed: true })
    await expect(f.host.core.retainForRecoveryRestart()).resolves.toEqual({ journalDurable: true, operationIds: [] })
    expect(f.connections()).toBe(1)
    expect(f.socket.commands).toEqual([])
    const foreign = await f.host.core.openClientDurable("principal:foreign-test")
    await expect(f.host.core.getOperation(foreign.session, before.context.operationId)).rejects.toThrow("другой client lineage")
  } finally { await f.dispose() }
})

test("host drain ждёт физический close, а не только вызов close", async () => {
  const f = await fixture({ autoClose: false })
  let drainResult: Promise<unknown> | undefined
  try {
    const before = await failedConnect(f)
    let settled = false
    drainResult = f.host.drain().then(value => { settled = true; return value }, error => { settled = true; return error })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    expect(f.host.core.resources.quarantinedCount()).toBe(1)
    expect((await f.store.loadAll())[0]?.state).toBe("quarantined")
    expect(f.host.core.resources.cleanupReceiptByLeaseId(before.resources[0]!.leaseId)).toBeUndefined()
    f.socket.confirmClose()
    expect(await drainResult).toMatchObject({ cleanup: "complete" })
    expect(f.host.core.resources.quarantinedCount()).toBe(0)
    expect(f.socket.closeCalls).toBe(1)
    expect(f.connections()).toBe(1)
  } finally {
    f.socket.confirmClose()
    await drainResult
    await f.dispose()
  }
})

test("отмена host drain без physical close сохраняет quarantine и не принимает поздний результат", async () => {
  const f = await fixture({ autoClose: false })
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const before = await failedConnect(f)
    timer = setTimeout(() => controller.abort(new Error("test:cleanup-deadline")), 30)
    await expect(f.host.drain(controller.signal)).rejects.toThrow()
    expect(f.host.core.resources.quarantinedCount()).toBe(1)
    expect(f.host.core.admissionSealed).toBe(true)
    f.socket.confirmClose()
    await Bun.sleep(10)
    expect((await f.store.loadAll())[0]?.state).toBe("quarantined")
    expect((await f.host.core.getOperation(f.credential.session, before.context.operationId))?.outcome.cleanup.state).toBe("unknown")
    expect(f.host.core.resources.cleanupReceiptByLeaseId(before.resources[0]!.leaseId)).toBeUndefined()
    expect(f.connections()).toBe(1)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    await f.dispose()
  }
})

test("host drain останавливает незавершённый connect до browser cleanup", async () => {
  const f = await fixture({ approvalTimeoutMs: 1_000 })
  let pending: ReturnType<typeof f.connect> | undefined
  try {
    pending = f.connect()
    // Обработчик rejection установлен до ожидания следующего события.
    pending.catch(() => undefined)
    await Promise.race([f.created, pending.then(() => { throw new Error("Connect завершился до создания подставного socket") })])
    expect(f.host.core.activeOperationCount()).toBe(1)
    await expect(f.host.drain()).resolves.toMatchObject({ cleanup: "complete" })
    const operation = operationRecordSchema.parse((await pending).data.operation)
    const actual = await f.host.core.getOperation(f.credential.session, operation.context.operationId)
    expect(actual?.outcome.cleanup.state).toBe("complete")
    expect(f.host.core.activeOperationCount()).toBe(0)
    expect(f.host.core.resources.quarantinedCount()).toBe(0)
    expect((await f.store.loadAll())[0]?.state).toBe("released")
    expect(f.connections()).toBe(1)
    expect(f.socket.commands).toEqual([])
  } finally {
    f.socket.confirmClose()
    await pending?.catch(() => undefined)
    await f.dispose()
  }
})

test("очистка browser не освобождает неподтверждённый desktop resource", async () => {
  const f = await fixture()
  try {
    const before = await failedConnect(f)
    // Ресурс существует только в изолированном registry: настоящий ввод не отправляется.
    const [held] = f.host.core.resources.acquire(f.credential.session, "operation:unresolved-desktop",
      [{ kind: "desktop-input", resourceRef: "desktop:test" }], new Date(Date.now() + 5_000).toISOString())
    f.host.core.resources.quarantine("operation:unresolved-desktop")
    await expect(f.host.drain()).rejects.toThrow("Runtime drain оставил unknown/active operations")
    expect((await f.host.core.getOperation(f.credential.session, before.context.operationId))?.outcome.cleanup.state).toBe("complete")
    expect((await f.store.loadAll())[0]?.state).toBe("released")
    expect(f.host.core.resources.quarantinedCount()).toBe(1)
    expect(f.host.core.resources.handleByLeaseId(held!.leaseId)?.state).toBe("quarantined")
    expect(f.host.core.resources.cleanupReceiptByLeaseId(held!.leaseId)).toBeUndefined()
    expect(f.host.core.admissionSealed).toBe(true)
    expect(f.connections()).toBe(1)
  } finally { await f.dispose() }
})
