import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntimeHost } from "@meta/runtime"
import { z } from "@meta/shared/contracts"
import { createCatalogSnapshot } from "../src/catalog-snapshot.ts"
import { startChatProxy } from "../src/chat-proxy.ts"

test("справка раскрывается без Runtime, выполнение требует исполнителя", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-proxy-"))
  const catalogPath = join(directory, "catalog.json")
  const operation = { name: "click", description: "Нажатие мыши", inputSchema: { type: "object" as const, required: ["targetId"], properties: { targetId: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: true } }
  await writeFile(catalogPath, JSON.stringify(createCatalogSnapshot("runtime:test", [operation], ["click"])))
  const server = await startChatProxy({ catalogPath })
  const client = new Client({ name: "chat-proxy-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(["zavx0z"])
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: {} })
    expect(tools[0]?.description).toBe("")
    expect(client.getInstructions()).toBeUndefined()
    expect((await client.callTool({ name: "zavx0z", arguments: {} })).structuredContent).toMatchObject({ node: "root", children: [{ node: "computer" }], contract: { inputSchema: { properties: { node: { type: "string" }, action: { type: "string" }, input: { type: "object" } } } }, next: { node: "computer" } })
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer" } })).structuredContent).toMatchObject({ node: "computer", children: [{ action: "click" }] })
    for (const args of [
      { node: "computer/click" },
      { node: "computer/click", input: {} },
    ]) {
      expect((await client.callTool({ name: "zavx0z", arguments: args })).structuredContent).toMatchObject({ contract: operation, executed: false })
    }
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
  const catalogPath = join(directory, "catalog.json")
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
  await writeFile(catalogPath, JSON.stringify(createCatalogSnapshot("runtime:chat", host.catalog.descriptors().tools,
    ["system_health", "test_write", "get_operation"])))
  const server = await startChatProxy({ catalogPath, runtime: { socketPath, credentialPath, expectedHostname: hostname() } })
  const client = new Client({ name: "chat-executor-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const call = (args: Record<string, unknown>) => client.callTool({ name: "zavx0z", arguments: args })
  try {
    await Promise.all([client.connect(ct), server.connect(st)])
    expect((await call({ node: "computer/test_write", input: { value: 7 } })).structuredContent).toMatchObject({ executed: false })
    expect(calls).toBe(0)
    expect((await call({ node: "computer", action: "system_health" })).isError).toBe(true)
    await host.start()
    expect((await call({ node: "computer", action: "system_health" })).structuredContent).toMatchObject({ machine: { matchesExpected: true } })
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
