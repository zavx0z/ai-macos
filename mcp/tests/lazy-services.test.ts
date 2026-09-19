import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { startChatProxy } from "../src/chat-proxy.ts"

const contract = { name: "lookup", description: "test lookup", inputSchema: {
  type: "object" as const, properties: { query: { type: "string" } }, required: ["query"],
} }
const payload = { content: [{ type: "text" as const, text: "source:42" }],
  structuredContent: { run_id: "run-test", source: "archive:file#42" }, isError: false }

test("сервисы загружаются отдельно; корень, каталог и контракт не исполняют действие", async () => {
  const events: string[] = []
  const service = (id: string) => ({
    id, description: id,
    create: async () => {
      events.push(`${id}:load`)
      return {
        listTools: async () => { events.push(`${id}:catalog`); return [{ name: "lookup" }] },
        getTool: async () => { events.push(`${id}:contract`); return contract },
        call: async () => { events.push(`${id}:call`); return payload },
        close: async () => { events.push(`${id}:close`) },
      }
    },
  })
  const server = await startChatProxy({ services: [service("third"), service("knowledge"), service("computer")] })
  const client = new Client({ name: "lazy-test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(a), server.connect(b)])
    await client.listTools()
    const root = await client.callTool({ name: "zavx0z", arguments: {} })
    expect((root.structuredContent as Record<string, unknown> | undefined)?.children).toEqual([
      { node: "third", description: "third" }, { node: "knowledge", description: "knowledge" },
      { node: "computer", description: "computer" }, { node: "viewer", description: "Общее приложение Codex App" },
    ])
    expect((root.structuredContent as Record<string, unknown> | undefined)?.codexApp).toBeUndefined()
    expect((root.structuredContent as Record<string, unknown> | undefined)?.next).toEqual({ node: "third" })
    expect((root.structuredContent as Record<string, unknown> | undefined)?.examples).toMatchObject({ catalog: { node: "third" }, contract: { node: "computer/system_health" } })
    expect(events).toEqual([])
    const listing = await client.callTool({ name: "zavx0z", arguments: { node: "knowledge" } })
    expect((listing.structuredContent as Record<string, unknown> | undefined)?.children).toEqual([{ node: "knowledge/lookup", action: "lookup", title: "lookup" }])
    expect(JSON.stringify(listing)).not.toContain("inputSchema")
    expect(events).toEqual(["knowledge:load", "knowledge:catalog"])
    const described = await client.callTool({ name: "zavx0z", arguments: { node: "knowledge/lookup" } })
    expect(described.structuredContent).toMatchObject({ executed: false, contract })
    expect((described.structuredContent as Record<string, unknown> | undefined)?.codexApp).toBeUndefined()
    expect(events).toEqual(["knowledge:load", "knowledge:catalog", "knowledge:contract"])
    const mismatch = await client.callTool({ name: "zavx0z", arguments: { node: "third/lookup", action: "other" } })
    expect(mismatch.isError).toBe(true)
    expect(events.some(event => event.startsWith("third:"))).toBe(false)
    const response = await client.callTool({ name: "zavx0z", arguments: { node: "knowledge", action: "lookup", input: { query: "test" } } })
    expect(response).toMatchObject(payload)
    expect((response.structuredContent as Record<string, unknown> | undefined)?.codexApp).toBeUndefined()
    expect(events.filter(event => event.endsWith(":call"))).toEqual(["knowledge:call"])
  } finally {
    await client.close()
    await server.close()
  }
  expect(events.filter(event => event.endsWith(":close"))).toEqual(["knowledge:close"])
})

test("корень и закрытие работают без конфигурации и доступных backend", async () => {
  const server = await startChatProxy()
  const client = new Client({ name: "cold", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(a), server.connect(b)])
    const root = await client.callTool({ name: "zavx0z", arguments: {} })
    expect(root.isError).not.toBe(true)
    expect(JSON.stringify((root.structuredContent as Record<string, unknown> | undefined)?.children)).toContain("knowledge")
  } finally {
    await client.close()
    await server.close()
  }
})

test("ошибка сервиса не повторяет действие и не блокирует соседний сервис", async () => {
  let calls = 0
  const server = await startChatProxy({ services: [
    { id: "broken", description: "broken", create: async () => ({
      listTools: async () => [{ name: "lookup" }],
      call: async () => { calls += 1; throw new Error("lost response") },
      close: async () => {},
    }) },
    { id: "healthy", description: "healthy", create: async () => ({
      listTools: async () => [{ name: "lookup" }],
      call: async () => payload,
      close: async () => {},
    }) },
  ] })
  const client = new Client({ name: "isolation", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(a), server.connect(b)])
    const failed = await client.callTool({ name: "zavx0z", arguments: { node: "broken", action: "lookup" } })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain("broken")
    expect(calls).toBe(1)
    expect(await client.callTool({ name: "zavx0z", arguments: { node: "healthy", action: "lookup" } })).toMatchObject(payload)
    expect(calls).toBe(1)
  } finally {
    await client.close()
    await server.close()
  }
})
