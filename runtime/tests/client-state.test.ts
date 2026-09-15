import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { operationOutcomeSchema, runtimeOperationIntentSchema, z } from "@meta/shared/contracts"
import { FileClientState } from "../src/client-state.ts"
import { RuntimeCore } from "../src/core.ts"
import { FileOperationJournal } from "../src/storage/index.ts"
import { createRuntimeHost } from "../src/host.ts"
import { RuntimeUdsClient } from "../src/transport.ts"

test("restart сохраняет exact lineage, HMAC и receipt без replay или plaintext credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "client-state-"))
  const statePath = join(directory, "clients.json")
  const create = async (runtimeEpoch: string) => {
    const store = new FileClientState(statePath)
    const state = await store.initialize("login:client-state")
    const core = new RuntimeCore({ generation: { runtimeEpoch, loginSessionId: state.loginSessionId }, runtimeBuildId: "build:client-state",
      secret: Buffer.from(state.secretHex, "hex"), hmacKeyGeneration: state.keyGeneration,
      operationJournal: new FileOperationJournal(join(directory, "operations")),
      clientPersistence: { sessions: state.sessions, persist: sessions => store.persist(sessions) },
      completionVerifier: { async verify() {} } })
    await core.initializeRecovery()
    return core
  }
  try {
    const first = await create("runtime:first")
    const credential = await first.openClientDurable("principal:client-state")
    const target = { kind: "clipboard" as const, ref: { ...first.generation, clipboardRef: "system" as const } }
    first.targets.register(target, "inventory:client-state", 0, "resolution:client-state", "proof:client-state", 0)
    const intent = runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:client-state",
      precondition: { target, inventoryId: "inventory:client-state", inventoryRevision: 0 },
      deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "clipboard", resourceRef: "system" }] })
    let dispatches = 0
    const execute = async (context: Parameters<Parameters<RuntimeCore["runOperation"]>[3]>[0]) => {
      dispatches++
      return { ok: true as const, value: {}, outcome: operationOutcomeSchema.parse({
        dispatch: "finished", dispatchAttempts: 1, targetVerified: "verified", userInterference: "unknown", observation: "unavailable",
        effect: { state: "unverified", proofRefs: [] }, restoration: "not-applicable",
        cleanup: { scope: "owned", state: "complete", resources: context.resources.map(handle => ({ handle, outcome: "released" })) },
      }) }
    }
    const completed = await first.runOperation(credential.session, intent, { text: "sensitive payload" }, execute)
    const second = await create("runtime:second")
    expect(second.admissionSealed).toBe(false)
    expect(() => second.clients.authenticate(credential.bearerToken)).toThrow()
    const resumed = await second.resumeClientDurable(credential.resumptionToken)
    expect(second.clients.lineage(resumed.session)).toBe(first.clients.lineage(credential.session))
    expect(await second.getOperation(resumed.session, completed.operation.context.operationId)).toEqual(completed.operation)
    await expect(second.runOperation(resumed.session, intent, { text: "sensitive payload" }, execute)).rejects.toThrow("только operation receipt")
    await expect(second.runOperation(resumed.session, intent, { text: "changed" }, execute)).rejects.toThrow("другой payload")
    expect(dispatches).toBe(1)
    const fresh = await second.openClientDurable("principal:client-state")
    await expect(second.getOperation(fresh.session, completed.operation.context.operationId)).rejects.toThrow("другой client lineage")
    const replayResume = await second.resumeClientDurable(credential.resumptionToken)
    expect(second.clients.lineage(replayResume.session)).toBe(second.clients.lineage(resumed.session))
    const text = await readFile(statePath, "utf8")
    expect(text).not.toContain(credential.bearerToken)
    expect(text).not.toContain(credential.resumptionToken)
    expect(text).not.toContain("sensitive payload")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("UDS resume обновляет bootstrap после host restart и сохраняет lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "client-uds-restart-"))
  const options = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    expectedHostname: hostname(), loginSessionId: "login:uds-restart", runtimeBuildId: "build:uds-restart", expectedNativeBuildId: "native:unused" }
  const create = async () => {
    const host = await createRuntimeHost(options)
    host.catalog.register("lineage", { title: "Lineage", description: "Проверка session", readOnly: true,
      input: z.strictObject({}), output: z.strictObject({ lineage: z.string(), epoch: z.string() }),
      async execute(context) { return { lineage: host.core.clients.lineage(context.session), epoch: host.core.generation.runtimeEpoch } } })
    await host.start()
    return host
  }
  let host = await create()
  try {
    const client = await RuntimeUdsClient.fromCredentialFile(options.socketPath, options.credentialPath)
    await client.open("restart")
    const first = (await client.callTool("lineage", {}, new AbortController().signal)).structuredContent!
    await host.close()
    host = await create()
    await client.resume()
    const second = (await client.callTool("lineage", {}, new AbortController().signal)).structuredContent!
    expect(second.lineage).toBe(first.lineage)
    expect(second.epoch).not.toBe(first.epoch)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("hung credential persistence не выдаёт client credential и закрывает admission", async () => {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:credential-hang", loginSessionId: "login:credential-hang" },
    runtimeBuildId: "build:credential-hang", durableTimeoutMs: 10,
    clientPersistence: { sessions: [], persist: () => new Promise(() => {}) } })
  await expect(core.openClientDurable("principal:credential-hang")).rejects.toThrow("deadline")
  expect(core.admissionSealed).toBe(true)
  expect(() => core.unsealAdmission()).toThrow("active/unknown")
}, 1000)
