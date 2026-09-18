import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntimeHost } from "@meta/runtime"
import { z } from "@meta/shared/contracts"
import { startChatProxy } from "../src/chat-proxy.ts"
import { VIEWER_UI_URI, viewerUiHtml } from "../src/viewer-ui.ts"

test("справка раскрывается без Runtime, выполнение требует исполнителя", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-proxy-"))
  const server = await startChatProxy({ runtime: { socketPath: join(directory, "missing.sock"), credentialPath: join(directory, "missing.json"), expectedHostname: hostname() } })
  const client = new Client({ name: "chat-proxy-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(["zavx0z", "codex_app", "codex_app_next"])
    expect(tools[0]?._meta?.["openai/outputTemplate"]).toBeUndefined()
    expect(tools[1]?._meta?.["openai/outputTemplate"]).toBe(VIEWER_UI_URI)
    const resources = (await client.listResources()).resources
    expect(resources.map(resource => resource.uri)).toEqual([VIEWER_UI_URI])
    const resource = await client.readResource({ uri: VIEWER_UI_URI })
    const firstContent = resource.contents[0]
    const html = firstContent && "text" in firstContent ? firstContent.text : ""
    expect(html).toBe(viewerUiHtml)
    const emptyCapture = await client.callTool({ name: "zavx0z", arguments: {
      node: "ui/latest_capture", input: { clientId: "test-widget" },
    } })
    expect(emptyCapture.isError).toBe(true)
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object", additionalProperties: false,
      properties: { node: { type: "string" }, action: { type: "string" }, input: { type: "object" } } })
    expect(Object.keys(tools[0]!.inputSchema.properties!)).toEqual(["node", "action", "input"])
    expect(tools[0]?.inputSchema.required ?? []).toEqual([])
    expect(tools[0]?.description).toContain("контракт без выполнения")
    expect(client.getInstructions()).toBe(tools[0]?.description)
    const root = (await client.callTool({ name: "zavx0z", arguments: {} })).structuredContent as Record<string, unknown>
    expect((root.contract as { inputSchema: unknown }).inputSchema).toEqual(tools[0]?.inputSchema)
    expect(root.examples).toMatchObject({ execute: { node: "computer", action: "system_health", input: {} } })
    expect((await client.callTool({ name: "zavx0z", arguments: {} })).structuredContent).toMatchObject({ node: "root", children: [{ node: "computer" }, { node: "viewer" }], contract: { inputSchema: { properties: { node: { type: "string" }, action: { type: "string" }, input: { type: "object" } } } }, next: { node: "computer" } })
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer" } })).isError).toBe(true)
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer", action: "not_published" } })).isError).toBe(true)
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer/click", action: "different" } })).isError).toBe(true)
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer", action: "click" } })).isError).toBe(true)
    expect((await client.callTool({ name: "unknown_action", arguments: {} })).isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("action выполняется через UDS ровно один раз, input необязателен, отказ Runtime сохраняется", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-executor-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const host = await createRuntimeHost({ socketPath, credentialPath, expectedHostname: hostname(),
    loginSessionId: "login:chat", runtimeBuildId: "runtime:chat", expectedNativeBuildId: "native:chat" })
  let calls = 0
  host.catalog.register("test_write", {
    title: "Тестовая запись", description: "Меняет только счётчик теста", readOnly: false,
    input: z.strictObject({ value: z.number().default(1) }),
    output: z.strictObject({ calls: z.number(), value: z.number(), failed: z.boolean() }),
    isError: value => value.failed,
    async execute(_context, input) {
      calls++
      return { calls, value: input.value, failed: input.value < 0 }
    },
  })
  const server = await startChatProxy({ runtime: { socketPath, credentialPath, expectedHostname: hostname(),
    allowedActions: ["system_health", "test_write", "get_operation", "late_method", "fixture_frame"] } })
  const client = new Client({ name: "chat-executor-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const call = (args: Record<string, unknown>, _meta?: Record<string, unknown>) => client.callTool({ name: "zavx0z", arguments: args, ...(_meta ? { _meta } : {}) })
  try {
    await Promise.all([client.connect(ct), server.connect(st)])
    expect((await call({})).isError).not.toBe(true)
    expect((await call({ node: "computer", action: "system_health" })).isError).toBe(true)
    await host.start()
    expect((await call({ node: "computer", action: "system_health" })).structuredContent).toMatchObject({ machine: { matchesExpected: true } })
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
    host.catalog.register("fixture_frame", {
      title: "Снимок", description: "Изолированный кадр без доступа к экрану", readOnly: true,
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
    const meta = { "openai/session": "first-screenshot" }
    const firstFrame = await call({ node: "computer", action: "fixture_frame" }, meta)
    expect(firstFrame.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("CODEX_APP_OPEN_REQUIRED") }))
    expect(firstFrame.structuredContent).toMatchObject({
      frameRef: expect.any(String),
      codexApp: { status: "CODEX_APP_OPEN_REQUIRED", tool: "codex_app", repeatPreviousCommand: false },
    })
    const opened = await client.callTool({ name: "codex_app", arguments: {}, _meta: meta })
    expect(opened._meta?.viewer).toMatchObject({ version: 1, content: { kind: "image", data: png.toString("base64") } })
    const nextResponse = await call({}, meta)
    expect(nextResponse.content).not.toContainEqual(expect.objectContaining({ type: "text", text: expect.stringMatching(/^CODEX_APP_OPEN_REQUIRED:/) }))
    const secondFrame = await call({ node: "computer", action: "fixture_frame" })
    expect(nextResponse.structuredContent).not.toHaveProperty("codexApp")
    const firstScreenshot = firstFrame._meta?.screenshot as { version: number, streamId: string }
    const secondScreenshot = secondFrame._meta?.screenshot as { version: number, streamId: string }
    expect(firstFrame.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" })
    expect(firstFrame._meta?.screenshot).toMatchObject({ data: png.toString("base64"), mimeType: "image/png" })
    expect(secondScreenshot.version).toBeGreaterThan(firstScreenshot.version)
    expect(secondScreenshot.streamId).toBe(firstScreenshot.streamId)
    expect((await call({}))._meta?.screenshot).toBeUndefined()
    expect((await call({ node: "ui/latest_capture", input: { clientId: "foreign-widget" } })).isError).toBe(true)
    expect((await call({ node: "computer/test_write", input: { value: 7 } })).structuredContent).toMatchObject({ executed: false })
    expect(calls).toBe(0)
    expect((await call({ node: "computer/late_method" })).isError).toBe(true)
    host.catalog.register("late_method", {
      title: "Новая операция", description: "Появляется без snapshot и перезапуска proxy", readOnly: true,
      input: z.strictObject({}), output: z.strictObject({ live: z.literal(true) }),
      async execute() { return { live: true } },
    })
    expect((await call({ node: "computer/late_method" })).structuredContent).toMatchObject({ contract: { name: "late_method" } })
    expect((await call({ node: "computer", action: "late_method" })).structuredContent).toEqual({ live: true })
    expect((await call({ node: "computer", action: "test_write" })).structuredContent).toEqual({ calls: 1, value: 1, failed: false })
    const failed = await call({ node: "computer/test_write", action: "test_write", input: { value: -7 } })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toEqual({ calls: 2, value: -7, failed: true })
    expect((await call({ node: "computer", action: "test_write", input: { invalid: true } })).isError).toBe(true)
    expect((await call({ node: "computer", action: "not_allowed" })).isError).toBe(true)
    expect(calls).toBe(2)
    host.core.sealAdmission()
    expect((await call({ node: "computer", action: "test_write" })).isError).toBe(true)
    expect((await call({ node: "computer", action: "get_operation", input: { operationId: "operation:missing" } })).structuredContent).toEqual({ operation: null })
    expect(calls).toBe(2)
  } finally {
    await client.close()
    await server.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("default proxy раскрывает recovery при sealed admission, но сохраняет запрет чужой lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-recovery-catalog-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const host = await createRuntimeHost({ socketPath, credentialPath, expectedHostname: hostname(),
    loginSessionId: "login:recovery-catalog", runtimeBuildId: "runtime:recovery-catalog", expectedNativeBuildId: "native:recovery-catalog" })
  const server = await startChatProxy({ runtime: { socketPath, credentialPath, expectedHostname: hostname() } })
  const client = new Client({ name: "chat-recovery-catalog", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  try {
    await host.start()
    host.core.sealAdmission()
    await Promise.all([client.connect(ct), server.connect(st)])
    const contract = await client.callTool({ name: "zavx0z", arguments: { node: "computer/recover_startup_input" } })
    expect(contract.isError).not.toBe(true)
    expect(contract.structuredContent).toMatchObject({ executed: false, contract: { name: "recover_startup_input" } })
    const foreign = await client.callTool({ name: "zavx0z", arguments: {
      node: "computer", action: "recover_startup_input", input: { operationId: "operation:foreign" },
    } })
    expect(foreign.isError).toBe(true)
    expect(JSON.stringify(foreign.content)).toContain("Operation недоступна этой lineage")
    expect(host.core.admissionSealed).toBe(true)
  } finally {
    await client.close()
    await server.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
