import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { operationOutcomeSchema, runtimeOperationIntentSchema, type OperationRecord } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { FileOperationJournal, type PersistentOperationJournal } from "../src/storage/index.ts"

test("durable core writes dispatching before callback and terminal receipt before release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-core-"))
  const store = new FileOperationJournal(directory)
  const generation = { runtimeEpoch: "runtime:durable", loginSessionId: "login:durable" }
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:durable", operationJournal: store, completionVerifier: { async verify() {} } })
  await core.initializeRecovery()
  const session = core.openClient("principal:durable").session
  const target = { kind: "clipboard" as const, ref: { ...generation, clipboardRef: "system" as const } }
  core.targets.register(target, "inventory:durable", 0, "resolution:durable", "proof:durable", 0)
  const intent = runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:durable",
    precondition: { target, inventoryId: "inventory:durable", inventoryRevision: 0 }, deadlineAt: new Date(Date.now() + 33_000).toISOString(),
    requestedResources: [{ kind: "clipboard", resourceRef: "system" }] })
  try {
    const execution = await core.runOperation(session, intent, { text: "redacted" }, async context => {
      expect(context.resources[0]?.expiresAt).toBe(intent.deadlineAt)
      const persisted = await new FileOperationJournal(directory).read({ ...generation, operationId: context.wire.operationId })
      expect(persisted?.record.state).toBe("dispatching")
      expect(persisted?.record.outcome.cleanup.state).toBe("pending")
      expect(JSON.stringify(persisted)).not.toContain("redacted")
      return { ok: true, value: { complete: true }, outcome: operationOutcomeSchema.parse({
        dispatch: "finished", dispatchAttempts: 1, targetVerified: "verified", userInterference: "unknown", observation: "unavailable",
        effect: { state: "unverified", proofRefs: [] }, restoration: "not-applicable",
        cleanup: { scope: "owned", state: "complete", resources: context.resources.map(handle => ({ handle, outcome: "released" })) },
      }) }
    })
    expect(execution.operation.state).toBe("completed")
    expect((await new FileOperationJournal(directory).read({ ...generation, operationId: execution.operation.context.operationId }))?.record.outcome.cleanup.state).toBe("complete")
    expect(core.resources.quarantinedCount()).toBe(0)
    expect(core.resources.handlesForOperation(execution.operation.context.operationId)).toHaveLength(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("process crash after durable dispatch restarts sealed with evidence and no replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-restart-"))
  try {
    const process = Bun.spawn([Bun.which("bun")!, new URL("./fixtures/crash-after-dispatch.ts", import.meta.url).pathname, directory], { stdout: "pipe", stderr: "pipe" })
    expect(await process.exited).toBe(0)
    const operationId = (await new Response(process.stdout).text()).trim()
    expect(operationId.startsWith("operation:")).toBe(true)
    const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:restarted", loginSessionId: "login:crash" }, runtimeBuildId: "build:restarted", operationJournal: new FileOperationJournal(directory) })
    const evidence = await core.initializeRecovery()
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.record.context.operationId).toBe(operationId)
    expect(evidence[0]?.record.state).toBe("dispatching")
    expect(core.admissionSealed).toBe(true)
    expect(() => core.unsealAdmission()).toThrow("active/unknown")
    const fresh = core.openClient("principal:crash")
    expect(await core.getOperation(fresh.session, operationId)).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const failingState of ["registered", "dispatching", "completed"] as const) {
  test(`durable ${failingState} failure не выдаёт ложный completed receipt`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-fault-"))
    const disk = new FileOperationJournal(directory)
    const store: PersistentOperationJournal = {
      read: disk.read.bind(disk), loadRecoveryEvidence: disk.loadRecoveryEvidence.bind(disk),
      persist(record, revision, options) {
        if (record.state === failingState) return Promise.reject(new Error("injected storage failure"))
        return disk.persist(record, revision, options)
      },
    }
    const generation = { runtimeEpoch: "runtime:fault", loginSessionId: "login:fault" }
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:fault", operationJournal: store, completionVerifier: { async verify() {} } })
    await core.initializeRecovery()
    const session = core.openClient("principal:fault").session
    const target = { kind: "clipboard" as const, ref: { ...generation, clipboardRef: "system" as const } }
    core.targets.register(target, "inventory:fault", 0, "resolution:fault", "proof:fault", 0)
    let dispatches = 0
    try {
      const execution = await core.runOperation(session, runtimeOperationIntentSchema.parse({
        intent: "mutation", clientRequestId: "request:fault", precondition: { target, inventoryId: "inventory:fault", inventoryRevision: 0 },
        deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "clipboard", resourceRef: "system" }],
      }), {}, async context => {
        dispatches++
        return { ok: true, value: {}, outcome: operationOutcomeSchema.parse({
          dispatch: "finished", dispatchAttempts: 1, targetVerified: "verified", userInterference: "unknown", observation: "unavailable",
          effect: { state: "unverified", proofRefs: [] }, restoration: "not-applicable",
          cleanup: { scope: "owned", state: "complete", resources: context.resources.map(handle => ({ handle, outcome: "released" })) },
        }) }
      })
      expect(execution.operation.state).not.toBe("completed")
      expect(dispatches).toBe(failingState === "completed" ? 1 : 0)
      expect(core.resources.quarantinedCount()).toBe(failingState === "completed" ? 1 : 0)
      const evidence = await disk.loadRecoveryEvidence()
      expect(evidence.length).toBe(failingState === "completed" ? 1 : 0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

for (const stalledState of ["registered", "dispatching", "completed"] as const) {
  test(`зависший durable ${stalledState} ограничивает cancel/drain и игнорирует late ACK`, async () => {
    let release!: () => void
    let reached!: () => void
    const entered = new Promise<void>(resolve => { reached = resolve })
    let calls = 0
    const store: PersistentOperationJournal = {
      async read() { return undefined }, async loadRecoveryEvidence() { return [] },
      async persist(record, revision) {
        calls++
        if (record.state === stalledState) {
          reached()
          await new Promise<void>(resolve => { release = resolve })
        }
        return { record, revision }
      },
    }
    const generation = { runtimeEpoch: "runtime:stalled", loginSessionId: "login:stalled" }
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:stalled", operationJournal: store,
      durableTimeoutMs: 20, cancelGraceMs: 5, completionVerifier: { async verify() {} } })
    await core.initializeRecovery()
    const session = core.openClient("principal:stalled").session
    const target = { kind: "clipboard" as const, ref: { ...generation, clipboardRef: "system" as const } }
    core.targets.register(target, "inventory:stalled", 0, "resolution:stalled", "proof:stalled", 0)
    let dispatches = 0
    const pending = core.runOperation(session, runtimeOperationIntentSchema.parse({
      intent: "mutation", clientRequestId: "request:stalled", precondition: { target, inventoryId: "inventory:stalled", inventoryRevision: 0 },
      deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "clipboard", resourceRef: "system" }],
    }), {}, async context => {
      dispatches++
      return { ok: true, value: {}, outcome: operationOutcomeSchema.parse({
        dispatch: "finished", dispatchAttempts: 1, targetVerified: "verified", userInterference: "unknown", observation: "unavailable",
        effect: { state: "unverified", proofRefs: [] }, restoration: "not-applicable",
        cleanup: { scope: "owned", state: "complete", resources: context.resources.map(handle => ({ handle, outcome: "released" })) },
      }) }
    })
    await entered
    const operation = await core.getOperationByRequest(session, "request:stalled")
    const cancel = core.cancelOperation(session, operation!.context.operationId, "cancel stalled write")
    const draining = core.drainOperations().catch(error => error)
    const execution = await pending
    await Promise.all([cancel, draining])
    expect(execution.operation.state).not.toBe("completed")
    expect(dispatches).toBe(stalledState === "completed" ? 1 : 0)
    expect(core.resources.quarantinedCount()).toBe(stalledState === "completed" ? 1 : 0)
    expect(core.admissionSealed).toBe(true)
    expect(core.activeOperationCount()).toBe(0)
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(await core.getOperation(session, operation!.context.operationId)).toEqual(execution.operation)
    expect(() => core.unsealAdmission()).toThrow("active/unknown")
    expect(calls).toBe(["registered", "dispatching", "completed"].indexOf(stalledState) + 1)
  }, 1000)
}
