import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createAiClient } from "../src/ai-client.ts"
import { ToolError } from "../../vendor/ai/shared/errors.ts"
import { renderAiMetadata } from "../../scripts/ai-metadata.ts"

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cu-ai-test-"))
  path = join(directory, "file.txt")
  writeFileSync(path, "before")
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const signal = () => new AbortController().signal
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const code = (r: CallToolResult) => (r.structuredContent?.error as { code?: string })?.code
const request = () => ({ node: "ai/filesystem/write", action: "run", input: { path, content: "after", expectedHash: hash("before") } })
const client = () => createAiClient({ expectedHostname: hostname() })

test("метаданные воспроизводимы", () => {
  expect(readFileSync(new URL("../src/ai-metadata.ts", import.meta.url), "utf8")).toBe(renderAiMetadata())
})

test("файловая запись работает без отдельного допуска", async () => {
  const c = createAiClient({ expectedHostname: hostname() })
  const r = await c.request!(request(), signal())
  expect(r.isError).not.toBe(true)
  expect(readFileSync(path, "utf8")).toBe("after")
})

test("описания и все заявленные views не исполняют операции", async () => {
  let calls = 0
  const c = createAiClient({ authorize: () => { calls++; return false } })
  const node = "ai/filesystem/write"
  const first = await c.request!({ node }, signal())
  expect(first.isError).not.toBe(true)
  const texts: string[] = []
  for (const view of first.structuredContent?.views as string[]) {
    const r = await c.request!({ node, input: { view } }, signal())
    expect(r.isError).not.toBe(true)
    texts.push(JSON.stringify(r.structuredContent))
  }
  expect(texts.join(" ")).toContain("expectedHash")
  expect(calls).toBe(0)
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("read, write expectedHash, read и конфликт старого hash", async () => {
  const c = client()
  const read = () => c.request!({ node: "ai/filesystem/read", action: "run", input: { path } }, signal())
  expect((await read()).structuredContent?.content).toBe("before")
  expect((await c.request!(request(), signal())).isError).not.toBe(true)
  expect((await read()).structuredContent?.content).toBe("after")
  expect((await c.request!(request(), signal())).isError).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("after")
})

test("другая машина не получает даже callback разрешения", async () => {
  let calls = 0
  const c = createAiClient({ expectedHostname: "not-this-machine", authorize: () => { calls++; return true } })
  expect(code(await c.request!(request(), signal()))).toBe("MACHINE_MISMATCH")
  expect(calls).toBe(0)
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("UI полномочия и input.authorize не разрешают файловую запись", async () => {
  const c = createAiClient({ expectedHostname: hostname(), authorize: i => i.node.startsWith("computer/") })
  const q = request()
  const r = await c.request!({ ...q, input: { ...q.input, authorize: true } }, signal())
  expect(code(r)).toBe("AUTHORIZATION_REQUIRED")
  expect(readFileSync(path, "utf8")).toBe("before")

})

test("отмена до допуска не выполняет запись", async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await client().request!(request(), ac.signal)
  expect(r.isError).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("отмена во время ожидания допуска не выполняет запись", async () => {
  const ac = new AbortController()
  const c = createAiClient({ expectedHostname: hostname(), authorize: async () => {
    await Promise.resolve()
    ac.abort()
    return true
  } })
  expect((await c.request!(request(), ac.signal)).isError).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("закрытый сервис и неизвестный action не исполняются", async () => {
  const c = client()
  expect(code(await c.request!({ ...request(), action: "write" }, signal()))).toBe("ACTION_NOT_ALLOWED")
  await c.close()
  expect(code(await c.request!(request(), signal()))).toBe("SERVICE_CLOSED")
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("частичная ошибка сохраняет code и details", async () => {
  const details = { applied: ["fixture"], failed: "fixture-2" }
  const c = createAiClient({ expectedHostname: hostname(), authorize: () => {
    throw new ToolError("PARTIAL_FAILURE", "Проверка передачи ошибки", 409, details)
  } })
  const r = await c.request!(request(), signal())
  expect(r.isError).toBe(true)
  expect(code(r)).toBe("PARTIAL_FAILURE")
  expect((r.structuredContent?.error as { details: unknown }).details).toEqual(details)
  expect(r.structuredContent?.automaticRetry).toBe(false)
})

test("неизвестная ошибка не вызывает повтор", async () => {
  let calls = 0
  const c = createAiClient({ expectedHostname: hostname(), authorize: () => {
    calls++
    throw new Error("unexpected")
  } })
  const r = await c.request!(request(), signal())
  expect(code(r)).toBe("SERVICE_UNAVAILABLE_OR_UNKNOWN")
  expect(calls).toBe(1)
  expect(r.structuredContent?.automaticRetry).toBe(false)
  expect(readFileSync(path, "utf8")).toBe("before")
})

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { startChatProxy } from "../src/chat-proxy.ts"

test("единый zavx0z раскрывает ai и выполняет read-write-read без нового сервера", async () => {
  const server = await startChatProxy({ runtime: {
    expectedHostname: hostname(), socketPath: join(directory, "missing.sock"),
    credentialPath: join(directory, "missing.json"),
  } })
  const c = new Client({ name: "ai-route-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([c.connect(ct), server.connect(st)])
    const call = (args: Record<string, unknown>) => c.callTool({ name: "zavx0z", arguments: args })
    const root = await call({})
    expect(JSON.stringify(root.structuredContent)).toContain('"node":"ai"')
    const contract = await call({ node: "ai/filesystem/write", input: { view: "contract" } })
    expect(contract.isError).not.toBe(true)
    expect(JSON.stringify(contract.structuredContent)).toContain("expectedHash")
    expect(readFileSync(path, "utf8")).toBe("before")
    const read = () => call({ node: "ai/filesystem/read", action: "run", input: { path } })
    expect(JSON.stringify((await read()).structuredContent)).toContain("before")
    expect((await call(request())).isError).not.toBe(true)
    expect(JSON.stringify((await read()).structuredContent)).toContain("after")
    expect((await call(request())).isError).toBe(true)
    expect((await call({ node: "computer/system_health/extra" })).isError).toBe(true)
    expect((await read()).isError).not.toBe(true)
    expect((await c.listResources()).resources.length).toBe(1)
    expect((await c.listTools()).tools.map(t => t.name)).toEqual(["zavx0z", "codex_app", "codex_app_next"])
  } finally {
    await c.close()
    await server.close()
  }
})
