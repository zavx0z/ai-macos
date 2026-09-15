import { expect, test } from "bun:test"
import { hostname, tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { composeHostCapabilities } from "../src/host-capabilities.ts"
import { createRuntimeHost } from "../src/host.ts"
import { RuntimeUdsClient } from "../src/transport.ts"

test("MethodRegistry validates schemas and active session before execution", async () => {
  const runtime = new RuntimeCore({ generation: { runtimeEpoch: "runtime:registry", loginSessionId: "login:registry" }, runtimeBuildId: "build:registry" })
  const registry = new MethodRegistry(runtime)
  let calls = 0
  let changes = 0
  const unsubscribe = registry.subscribeCatalogChanged(() => { changes++ })
  registry.register("echo", {
    title: "Echo", description: "Test echo", readOnly: true,
    input: z.strictObject({ value: z.string().min(1) }), output: z.strictObject({ value: z.string() }),
    async execute(_context, input) { calls++; return input },
  })
  expect(changes).toBe(1)
  expect(registry.descriptors().tools[0]?.inputSchema.required).toEqual(["value"])
  const client = runtime.openClient("principal:registry")
  await expect(registry.dispatch(client.session, "echo", { value: "ok", extra: true }, new AbortController().signal)).rejects.toThrow()
  expect(calls).toBe(0)
  expect(await registry.dispatch(client.session, "echo", { value: "ok" }, new AbortController().signal)).toEqual({ data: { value: "ok" }, frameRefs: [] })
  runtime.clients.disconnect(client.session.clientSessionId)
  await expect(registry.dispatch(client.session, "echo", { value: "later" }, new AbortController().signal)).rejects.toThrow("отключена")
  expect(calls).toBe(1)
  unsubscribe()
})

test("method definition replacement не меняет advertised execution/schema/frames", async () => {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:immutable-method", loginSessionId: "login:immutable-method" }, runtimeBuildId: "build:immutable-method" })
  const registry = new MethodRegistry(core)
  const definition = {
    title: "Original", description: "Original", readOnly: true,
    input: z.strictObject({ value: z.string() }), output: z.strictObject({ value: z.string() }),
    async execute(_context: unknown, input: { value: string }) { return { value: `original:${input.value}` } },
    frames: (_output: { value: string }) => [] as string[],
  }
  registry.register("immutable", definition)
  definition.input = z.strictObject({ value: z.string().max(0) })
  definition.output = z.strictObject({ value: z.string().max(0) })
  definition.execute = async () => ({ value: "replaced" })
  definition.frames = () => ["forged:frame"]
  const session = core.openClient("principal:immutable").session
  expect(await registry.dispatch(session, "immutable", { value: "input" }, new AbortController().signal)).toEqual({ data: { value: "original:input" }, frameRefs: [] })
  expect(() => registry.register("invalid", { ...definition, readOnly: true, destructive: true })).toThrow("Read-only")
})

test("catalog advertisement и dispatch используют тот же actual capability snapshot", async () => {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:caps", loginSessionId: "login:caps" }, runtimeBuildId: "build:caps" })
  const registry = new MethodRegistry(core)
  let calls = 0
  registry.register("windows", {
    title: "Windows", description: "Test windows", input: z.strictObject({}), output: z.strictObject({ count: z.number() }), readOnly: true,
    requiredCapabilities: ["desktop.windows.all", "desktop.displays"], async execute() { calls++; return { count: 0 } },
  })
  const session = core.openClient("principal:caps").session
  expect(registry.descriptors().tools).toHaveLength(0)
  core.updateCapabilities(composeHostCapabilities("host:caps", { schemaVersion: "1", scope: "adapter", producerRef: "native:caps", capabilities: [
    { id: "desktop.applications", state: "ready" }, { id: "desktop.windows.all", state: "ready" }, { id: "desktop.displays", state: "ready" },
  ] }))
  expect(registry.descriptors().tools).toHaveLength(1)
  await registry.dispatch(session, "windows", {}, new AbortController().signal)
  core.updateCapabilities(composeHostCapabilities("host:caps", undefined, "Native disconnected"))
  expect(registry.descriptors().tools).toHaveLength(0)
  await expect(registry.dispatch(session, "windows", {}, new AbortController().signal)).rejects.toThrow("capabilities unavailable")
  expect(calls).toBe(1)
})

test("host singleton защищает запуск helper и drain закрывает catalogue admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-singleton-"))
  const options = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    runtimeBuildId: "build:singleton", expectedNativeBuildId: "build:native", loginSessionId: "login:singleton", expectedHostname: hostname() }
  const host = await createRuntimeHost(options)
  let factories = 0
  try {
    await expect(createRuntimeHost({ ...options, transportFactory() { factories++; throw new Error("must not spawn") } })).rejects.toThrow()
    expect(factories).toBe(0)
    host.catalog.register("mutation", { title: "Mutation", description: "Test mutation", readOnly: false,
      input: z.strictObject({}), output: z.strictObject({ count: z.number() }), async execute() { return { count: 1 } } })
    let changes = 0
    const unsubscribe = host.catalog.subscribeCatalogChanged(() => { changes++ })
    const beforeRevision = host.catalog.descriptors().revision
    await host.drain()
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "mutation")).toBe(false)
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "system_health")).toBe(true)
    expect(host.catalog.descriptors().revision).toBeGreaterThan(beforeRevision)
    expect(changes).toBe(1)
    const session = host.core.openClient("principal:drain").session
    await expect(host.catalog.dispatch(session, "mutation", {}, new AbortController().signal)).rejects.toThrow("sealed")
    expect(host.core.admissionSealed).toBe(true)
    host.core.unsealAdmission()
    expect(changes).toBe(2)
    expect(host.catalog.descriptors().tools.some(tool => tool.name === "mutation")).toBe(true)
    unsubscribe()
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("Runtime host serves schema catalogue, method health and per-lineage frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const host = await createRuntimeHost({
    socketPath, credentialPath, runtimeBuildId: "build:host", expectedNativeBuildId: "build:native",
    loginSessionId: "login:host", expectedHostname: hostname(),
  })
  try {
    await host.start()
    const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    expect(await client.adminInspect()).toMatchObject({ running: true, runtimeBuildId: "build:host", activeOperations: 0 })
    await expect(client.adminDrain({ runtimeEpoch: host.core.generation.runtimeEpoch, buildId: "build:host" })).rejects.toThrow("Native build")
    await client.open("host-test")
    expect((await client.listTools()).map(tool => tool.name)).toEqual(["system_health", "get_operation", "cancel_operation"])
    const health = await client.callTool("system_health", {}, new AbortController().signal)
    expect(health.structuredContent).toMatchObject({ runtime: { buildId: "build:host" }, native: { state: "unavailable" } })
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
    host.catalog.register("fixture_frame", {
      title: "Frame", description: "Scoped frame", readOnly: true,
      input: z.strictObject({}), output: z.strictObject({ frameRef: z.string() }),
      async execute(context) {
        const target = { kind: "browser-target" as const, ref: {
          ...host.core.generation, browserInstanceRef: "browser:fixture", transportGeneration: "cdp:fixture",
          targetId: "target:fixture", resourceRef: "target-resource:fixture",
        } }
        const frameRef = `frame:${crypto.randomUUID()}`
        const observationId = `observation:${crypto.randomUUID()}`
        host.core.frames.registerPublication({
          observationId, frameRef, ...host.core.generation, source: "browser-viewport", captureTarget: target,
          capturePolicySha256: "a".repeat(64), expiresAt: new Date(Date.now() + 5000).toISOString(),
          inventoryId: "inventory:fixture", inventoryRevision: 1, displayLayoutRevision: 0,
          cacheScopeRef: host.core.clients.lineage(context.session),
        })
        await host.core.frames.publish({
          observationId, frameRef, ...host.core.generation, source: "browser-viewport", target,
          capturedAt: new Date().toISOString(), widthPx: 1, heightPx: 1, mime: "image/png",
          expectedByteLength: png.byteLength, expectedSha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"), bytes: png,
        })
        return { frameRef }
      },
      frames: output => [output.frameRef],
    })
    const frame = await client.callTool("fixture_frame", {}, new AbortController().signal)
    expect(frame.content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
    const other = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
    await other.open("other-host-client")
    await expect(other.readFrame(String(frame.structuredContent?.frameRef))).rejects.toThrow("404")
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
