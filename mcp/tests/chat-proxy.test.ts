import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createCatalogSnapshot } from "../src/catalog-snapshot.ts"
import { startChatProxy } from "../src/chat-proxy.ts"

test("readonly-вход возвращает контракт изменяющей операции, не выполняя её", async () => {
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
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: {} })
    expect(tools[0]?.description).toBe("")
    expect(client.getInstructions()).toBeUndefined()
    expect((await client.callTool({ name: "zavx0z", arguments: {} })).structuredContent).toMatchObject({ node: "root", children: [{ node: "computer" }], contract: { inputSchema: { properties: { node: { type: "string" }, action: { type: "string" }, input: { type: "object" } } } }, next: { node: "computer" } })
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer" } })).structuredContent).toMatchObject({ node: "computer", children: [{ action: "click" }] })
    for (const args of [
      { node: "computer/click" },
      { node: "computer", action: "click" },
      { node: "computer", action: "click", input: { targetId: "must-not-be-clicked" } },
      { node: "computer/click", input: {} },
    ]) {
      expect((await client.callTool({ name: "zavx0z", arguments: args })).structuredContent).toMatchObject({ contract: operation, executed: false })
    }
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer", action: "not_published" } })).isError).toBe(true)
    expect((await client.callTool({ name: "zavx0z", arguments: { node: "computer/click", action: "different" } })).isError).toBe(true)
    expect((await client.callTool({ name: "unknown_action", arguments: {} })).isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
