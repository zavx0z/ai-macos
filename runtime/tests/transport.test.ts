import { expect, test } from "bun:test"
import { chmod as fsChmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  operationOutcomeSchema,
  runtimeOperationIntentSchema,
  z,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import {
  RuntimeUdsClient,
  RuntimeUdsServer,
  readBoundedResponseText,
  readBoundedText,
} from "../src/transport.ts"

const generation = { runtimeEpoch: "runtime:uds", loginSessionId: "login:uds" }
const fixtureTarget = {
  kind: "clipboard" as const,
  ref: {
    ...generation,
    clipboardRef: "system" as const,
  },
}

test("admin UDS требует отдельный credential и exact epoch/build до drain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-admin-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "build:admin" })
  let drains = 0
  let activeOperations = 1
  const server = new RuntimeUdsServer({ socketPath, credentialPath, core: runtime, admin: {
    inspect: () => ({ running: true, runtimeEpoch: generation.runtimeEpoch, runtimeBuildId: "build:admin", nativeBuildId: "build:native", activeOperations, quarantinedResources: 0 }),
    async drain() {
      drains++
      activeOperations = 0
      return { runtimeEpoch: generation.runtimeEpoch, runtimeBuildId: "build:admin", nativeBuildId: "build:native",
        cleanup: "complete", activeOperations: 0, quarantinedResources: 0 }
    },
  } })
  try {
    await server.start()
    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    expect((await client.adminInspect()).activeOperations).toBe(1)
    const credential = JSON.parse(await readFile(credentialPath, "utf8"))
    const session = runtime.openClient("principal:admin-test")
    for (const token of [credential.bootstrapToken, session.bearerToken]) {
      const response = await fetch("http://localhost/v1/admin/inspect", { unix: socketPath, headers: { authorization: `Bearer ${token}` } })
      expect(response.status).toBe(401)
      await response.text()
    }
    await expect(client.adminDrain({ runtimeEpoch: "runtime:other", buildId: "build:admin" })).rejects.toThrow("mismatch")
    await expect(client.adminDrain({ runtimeEpoch: generation.runtimeEpoch, buildId: "build:other" })).rejects.toThrow("mismatch")
    await expect(client.adminDrain({ runtimeEpoch: generation.runtimeEpoch, buildId: "build:admin", nativeBuildId: "native:other" })).rejects.toThrow("mismatch")
    expect(drains).toBe(0)
    expect(await client.adminDrain({ runtimeEpoch: generation.runtimeEpoch, buildId: "build:admin", nativeBuildId: "build:native" })).toMatchObject({ cleanup: "complete", activeOperations: 0 })
    expect(drains).toBe(1)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

test("UDS callTool использует advertised method budget вместо короткого transport default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-budget-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:budget" })
  const catalog = new MethodRegistry(core)
  let calls = 0
  catalog.register("slow_read", {
    title: "Медленное чтение", description: "Проверка бюджета", readOnly: true, timeoutMs: 500,
    input: z.strictObject({}), output: z.strictObject({ done: z.literal(true) }),
    async execute() { calls++; await Bun.sleep(100); return { done: true } },
  })
  const server = new RuntimeUdsServer({ socketPath, credentialPath, core, catalog })
  try {
    await server.start()
    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath, { timeoutMs: 50 })
    await client.open("method-budget")
    expect((await client.listTools())[0]?._meta?.timeoutMs).toBe(500)
    expect((await client.callTool("slow_read", {}, new AbortController().signal)).structuredContent).toEqual({ done: true })
    expect(calls).toBe(1)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

test("UDS автоматически renews после fake idle/outage дольше bearer TTL и close прекращает calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-renewal-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  let now = Date.now()
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:renewal", clock: { now: () => new Date(now) } })
  const catalog = new MethodRegistry(core)
  catalog.register("identity", { title: "Session", description: "Проверка renewal", readOnly: true,
    input: z.strictObject({}), output: z.strictObject({ session: z.string(), lineage: z.string() }),
    async execute(context) { return { session: context.session.clientSessionId, lineage: core.clients.lineage(context.session) } } })
  const server = new RuntimeUdsServer({ socketPath, credentialPath, core, catalog })
  try {
    await server.start()
    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath, { now: () => now })
    await client.open("renewal")
    const first = (await client.callTool("identity", {}, new AbortController().signal)).structuredContent!
    now += 240_000
    const renewed = (await client.callTool("identity", {}, new AbortController().signal)).structuredContent!
    expect(renewed.session).not.toBe(first.session)
    expect(renewed.lineage).toBe(first.lineage)
    now += 400_000
    const resumed = (await client.callTool("identity", {}, new AbortController().signal)).structuredContent!
    expect(resumed.session).not.toBe(renewed.session)
    expect(resumed.lineage).toBe(first.lineage)
    await client.close()
    await expect(client.listTools()).rejects.toThrow("закрыт")
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

test("private UDS authenticates clients before executor and preserves exact operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-runtime-uds-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "runtime-build:uds" })
  runtime.targets.register(
    fixtureTarget,
    "browser-inventory:uds",
    1,
    "resolution:browser:uds",
    "proof:browser:uds",
    0,
  )
  const server = new RuntimeUdsServer({ socketPath, credentialPath, core: runtime })
  let executions = 0
  server.register("test.echo", {
    input: z.strictObject({ text: z.string().max(128) }),
    async execute(context, input) {
      executions++
      return {
        ok: true,
        value: { echoed: input.text },
        outcome: operationOutcomeSchema.parse({
          dispatch: "none",
          targetVerified: "verified",
          userInterference: "none-observed",
          observation: "available",
          effect: { state: "unverified", proofRefs: [] },
          cleanup: { scope: "none", state: "complete", resources: [] },
          restoration: "not-applicable",
          dispatchAttempts: 0,
        }),
      }
    },
  })
  let slowExecutions = 0
  server.register("test.slow", {
    input: z.strictObject({ delayMs: z.number().int().min(1).max(500) }),
    async execute(_context, input) {
      slowExecutions++
      await Bun.sleep(input.delayMs)
      return {
        ok: true,
        value: { finished: true },
        outcome: operationOutcomeSchema.parse({
          dispatch: "none",
          targetVerified: "verified",
          userInterference: "none-observed",
          observation: "available",
          effect: { state: "unverified", proofRefs: [] },
          cleanup: { scope: "none", state: "complete", resources: [] },
          restoration: "not-applicable",
          dispatchAttempts: 0,
        }),
      }
    },
  })

  try {
    await server.start()
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)

    const forged = await fetch("http://localhost/v1/invoke/test.echo", {
      unix: socketPath,
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: JSON.stringify({ text: "не должен попасть в executor" }),
    })
    expect(forged.status).toBe(401)
    expect(executions).toBe(0)

    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    await client.open("runtime-test")
    const intent = runtimeOperationIntentSchema.parse({
      intent: "read",
      clientRequestId: "request:uds:1",
      precondition: {
        target: fixtureTarget,
        inventoryId: "browser-inventory:uds",
        inventoryRevision: 1,
      },
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      requestedResources: [],
    })
    const execution = await client.invoke<{ echoed: string }>("test.echo", intent, { text: "hello" })
    expect(execution.result).toMatchObject({ ok: true, value: { echoed: "hello" } })
    expect(execution.operation.state).toBe("completed")
    expect(executions).toBe(1)
    const unrelated = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    await unrelated.open("runtime-test-unrelated")
    await expect(unrelated.getOperation(execution.operation.context.operationId)).rejects.toThrow("401")
    await expect(unrelated.cancelOperation(
      execution.operation.context.operationId,
      "foreign lineage",
    )).rejects.toThrow("401")
    await client.resume()
    const repeated = await client.invoke<{ echoed: string }>("test.echo", intent, { text: "hello" })
    expect(repeated.operation.context.operationId).toBe(execution.operation.context.operationId)
    expect(executions).toBe(1)
    expect(await client.getOperation(execution.operation.context.operationId)).toEqual(execution.operation)
    expect(await client.health()).toMatchObject({
      ok: true,
      native: { state: "unavailable" },
    })

    const shortClient = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath, { timeoutMs: 20 })
    await shortClient.open("runtime-test-short")
    const slowIntent = runtimeOperationIntentSchema.parse({
      ...intent,
      clientRequestId: "request:uds:slow",
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      requestedResources: [],
    })
    await expect(shortClient.invoke("test.slow", slowIntent, { delayMs: 100 })).rejects.toMatchObject({
      name: "RuntimeUnknownDeliveryError",
      operation: { context: { clientRequestId: "request:uds:slow" } },
    })
    expect(slowExecutions).toBe(1)
    await Bun.sleep(120)
    expect((await shortClient.getOperationByRequest("request:uds:slow"))?.state).toBe("completed")
    expect(slowExecutions).toBe(1)
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("post-bind chmod failure stops owned server and removes only owned socket/credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-runtime-uds-chmod-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const runtime = new RuntimeCore({
    generation: { runtimeEpoch: "runtime:chmod", loginSessionId: "login:chmod" },
    runtimeBuildId: "runtime-build:chmod",
  })
  const server = new RuntimeUdsServer({
    socketPath,
    credentialPath,
    core: runtime,
    async chmod(path, mode) {
      if (String(path) === socketPath) throw new Error("fixture socket chmod failure")
      await fsChmod(path, mode)
    },
  })
  try {
    await expect(server.start()).rejects.toThrow("fixture socket chmod failure")
    await expect(stat(socketPath)).rejects.toThrow()
    await expect(stat(credentialPath)).rejects.toThrow()
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("credential chmod failure rolls back owned token but preserves foreign preexisting credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-runtime-uds-credential-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const runtime = new RuntimeCore({
    generation: { runtimeEpoch: "runtime:credential", loginSessionId: "login:credential" },
    runtimeBuildId: "runtime-build:credential",
  })
  const server = new RuntimeUdsServer({
    socketPath,
    credentialPath,
    core: runtime,
    async chmod(path, mode) {
      if (String(path) === credentialPath) throw new Error("fixture credential chmod failure")
      await fsChmod(path, mode)
    },
  })
  try {
    await expect(server.start()).rejects.toThrow("fixture credential chmod failure")
    await expect(stat(credentialPath)).rejects.toThrow()
    await writeFile(credentialPath, "foreign-credential", { encoding: "utf8", mode: 0o600 })
    await expect(server.start()).rejects.toThrow()
    expect(await readFile(credentialPath, "utf8")).toBe("foreign-credential")
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("bounded request/response readers cancel and release never-closing streams", async () => {
  let responseCancelled = 0
  const responseStream = new ReadableStream<Uint8Array>({
    cancel() { responseCancelled++ },
  })
  await expect(readBoundedResponseText(new Response(responseStream), 100, 10)).rejects.toThrow("deadline")
  expect(responseCancelled).toBe(1)
  expect(responseStream.locked).toBe(false)

  let requestCancelled = 0
  const requestStream = new ReadableStream<Uint8Array>({
    cancel() { requestCancelled++ },
  })
  const request = new Request("http://localhost/test", { method: "POST", body: requestStream })
  await expect(readBoundedText(request, 100, 10)).rejects.toThrow("deadline")
  expect(requestCancelled).toBe(1)
  expect(requestStream.locked).toBe(false)
})

test("reader timeout does not wait for never-resolving cancel and reports incomplete disposal", async () => {
  const responseStream = new ReadableStream<Uint8Array>({
    cancel() { return new Promise<void>(() => {}) },
  })
  const responseStarted = performance.now()
  await expect(readBoundedResponseText(new Response(responseStream), 100, 10)).rejects.toThrow("cleanup incomplete")
  expect(performance.now() - responseStarted).toBeLessThan(100)
  expect(responseStream.locked).toBe(false)

  const requestStream = new ReadableStream<Uint8Array>({
    cancel() { return new Promise<void>(() => {}) },
  })
  const requestStarted = performance.now()
  await expect(readBoundedText(new Request("http://localhost/test", {
    method: "POST",
    body: requestStream,
  }), 100, 10)).rejects.toThrow("cleanup incomplete")
  expect(performance.now() - requestStarted).toBeLessThan(100)
  expect(requestStream.locked).toBe(false)
})
