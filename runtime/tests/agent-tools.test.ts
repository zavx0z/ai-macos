import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { RuntimeToolResult as CallToolResult } from "../src/transport.ts"
import { createToolsClient } from "../src/agent-tools.ts"
import { ToolError } from "../../vendor/tools/shared/errors.ts"
import { renderToolsMetadata } from "../../scripts/tools-metadata.ts"

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cu-tools-test-"))
  path = join(directory, "file.txt")
  writeFileSync(path, "before")
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const signal = () => new AbortController().signal
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const code = (r: CallToolResult) => (r.structuredContent?.error as { code?: string })?.code
const request = () => ({ node: "tools/filesystem/write", action: "run", input: { path, content: "after", expectedHash: hash("before") } })
const client = () => createToolsClient({ expectedHostname: hostname() })

test("метаданные воспроизводимы", () => {
  expect(readFileSync(new URL("../src/tools-metadata.ts", import.meta.url), "utf8")).toBe(renderToolsMetadata())
})

test("файловая запись работает без отдельного допуска", async () => {
  const c = createToolsClient({ expectedHostname: hostname() })
  const r = await c.request!(request(), signal())
  expect(r.isError).not.toBe(true)
  expect(readFileSync(path, "utf8")).toBe("after")
})

test("описания и все заявленные views не исполняют операции", async () => {
  let calls = 0
  const c = createToolsClient({ authorize: () => { calls++; return false } })
  const node = "tools/filesystem/write"
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
  const read = () => c.request!({ node: "tools/filesystem/read", action: "run", input: { path } }, signal())
  expect((await read()).structuredContent?.content).toBe("before")
  expect((await c.request!(request(), signal())).isError).not.toBe(true)
  expect((await read()).structuredContent?.content).toBe("after")
  expect((await c.request!(request(), signal())).isError).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("after")
})

test("другая машина не получает даже callback разрешения", async () => {
  let calls = 0
  const c = createToolsClient({ expectedHostname: "not-this-machine", authorize: () => { calls++; return true } })
  expect(code(await c.request!(request(), signal()))).toBe("MACHINE_MISMATCH")
  expect(calls).toBe(0)
  expect(readFileSync(path, "utf8")).toBe("before")
})

test("UI полномочия и input.authorize не разрешают файловую запись", async () => {
  const c = createToolsClient({ expectedHostname: hostname(), authorize: i => i.node.startsWith("computer/") })
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
  const c = createToolsClient({ expectedHostname: hostname(), authorize: async () => {
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
  const c = createToolsClient({ expectedHostname: hostname(), authorize: () => {
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
  const c = createToolsClient({ expectedHostname: hostname(), authorize: () => {
    calls++
    throw new Error("unexpected")
  } })
  const r = await c.request!(request(), signal())
  expect(code(r)).toBe("SERVICE_UNAVAILABLE_OR_UNKNOWN")
  expect(calls).toBe(1)
  expect(r.structuredContent?.automaticRetry).toBe(false)
  expect(readFileSync(path, "utf8")).toBe("before")
})
