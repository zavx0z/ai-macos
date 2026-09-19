import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { startChatProxy } from "../src/chat-proxy.ts"
import { createKnowledgeClient } from "../src/knowledge-client.ts"

const contract = { name: "lookup", description: "Search", inputSchema: { type: "object", properties: {} } }
const result = { content: [{ type: "text", text: "Первичный источник" }],
  structuredContent: { run_id: "r1", source: "archive:file#42" }, isError: false }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n")

test("KB: уровни HTTP загружаются отдельно; прогресс доходит через внешний MCP", async () => {
  const requests: string[] = []
  let body: unknown
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path === "/v1/catalog") return Response.json({ tools: [{ name: "lookup" }] })
    if (path === "/v1/catalog/lookup") return Response.json(contract)
    body = await request.json()
    let cancelled = false
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          for (let progress = 1; progress <= 4; progress += 1) {
            if (cancelled) return
            controller.enqueue(encode({ type: "progress", progress, message: "работа" }))
            await Bun.sleep(100)
          }
          if (cancelled) return
          const bytes = encode({ type: "result", result })
          // Каждый байт отдельно: проверяем разделённые UTF-8 символы и строки.
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        })().catch(error => { if (!cancelled) controller.error(error) })
      },
      cancel() { cancelled = true },
    }), { headers: { "Content-Type": "application/x-ndjson" } })
  } })
  const proxy = await startChatProxy({
    knowledge: { baseUrl: `http://127.0.0.1:${http.port}`, idleTimeoutMs: 200 },
    runtime: { expectedHostname: "not-this-machine", socketPath: "/missing", credentialPath: "/missing" },
  })
  const client = new Client({ name: "kb-http-test", version: "1" })
  const progress: number[] = []
  client.setNotificationHandler(ProgressNotificationSchema, notification => { progress.push(notification.params.progress) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(a), proxy.connect(b)])
    await client.callTool({ name: "zavx0z", arguments: {} })
    expect(requests).toEqual([])
    await client.callTool({ name: "zavx0z", arguments: { node: "knowledge" } })
    expect(requests).toEqual(["GET /v1/catalog"])
    await client.callTool({ name: "zavx0z", arguments: { node: "knowledge/lookup" } })
    expect(requests).toEqual(["GET /v1/catalog", "GET /v1/catalog/lookup"])
    const response = await client.callTool({
      name: "zavx0z", arguments: { node: "knowledge", action: "lookup", input: { query: "факт" } },
      _meta: { progressToken: "kb-progress" },
    })
    expect(response).toMatchObject(result)
    expect((response.structuredContent as Record<string, unknown> | undefined)?.codexApp).toBeUndefined()
    expect(progress).toEqual([1, 2, 3, 4])
    expect(body).toEqual({ query: "факт" })
    expect(requests).toEqual(["GET /v1/catalog", "GET /v1/catalog/lookup", "POST /v1/tools/lookup"])
  } finally {
    await client.close()
    await proxy.close()
    http.stop(true)
  }
})
test.each(["error", "lost", "stall"])("KB: %s не повторяет POST", async mode => {
  let calls = 0
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls += 1
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "error") controller.enqueue(encode({ type: "error", message: "original failure" }))
        if (mode !== "stall") controller.close()
      },
    }), { headers: { "Content-Type": "application/x-ndjson" } })
  } })
  const client = createKnowledgeClient({ baseUrl: `http://127.0.0.1:${http.port}`, idleTimeoutMs: 50 })
  try {
    await expect(client.call("lookup", {}, new AbortController().signal)).rejects.toThrow(
      mode === "error" ? "original failure" : mode === "lost" ? "without a final result" : "KB progress timeout",
    )
    expect(calls).toBe(1)
    await client.close()
    await expect(client.listTools()).rejects.toThrow("knowledge")
    expect(calls).toBe(1)
  } finally {
    await client.close()
    http.stop(true)
  }
})
