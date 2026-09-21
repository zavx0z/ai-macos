import { test, expect } from "bun:test"
import { runInNewContext } from "node:vm"
import { webcrypto } from "node:crypto"
import { CdpHttp } from "@meta/shared"
import { CdpBrowserDriver } from "../src/adapter.ts"

/** Executes only our fixed driver-generated expression in an isolated fake page; no real browser/network. */
function fixture(options: { page?: string; content?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let dom = options.content ?? "<main>Привет 😀</main>"
  const server = Bun.serve({ port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade", { status: 426 }) },
    websocket: { async message(socket, raw) {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params: { expression: string } }
      try {
        if (message.method !== "Runtime.evaluate") throw new Error("unexpected method")
        const value = await runInNewContext(message.params.expression, {
          document: { documentElement: { outerHTML: dom } }, location: { href: options.page ?? "https://example.test/c/fixture", origin: new URL(options.page ?? "https://example.test/c/fixture").origin },
          URL, TextEncoder, TextDecoder, crypto: webcrypto, AbortSignal,
          fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(dom, { status: 200, headers: { "content-type": "text/plain;charset=utf-8" } }) },
        }, { timeout: 1000 })
        socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }))
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, result: { exceptionDetails: { text: String(error) } } }))
      }
    } },
  })
  const target = { id: "fixture", type: "page", title: "Fixture", url: "https://example.test/c/fixture", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}` }
  const driver = new CdpBrowserDriver(new CdpHttp("fixture", 9222, { fetch: async () => Response.json([target]) }))
  return { driver, calls, set: (text: string) => { dom = text }, stop: () => server.stop(true) }
}
const signal = () => new AbortController().signal

test("same-origin is rechecked in page execution context before fetch after navigation", async () => {
  const f = fixture({ page: "https://other.test/" })
  try {
    await expect(f.driver.readResource("fixture", { url: "/resource", offsetBytes: 0, maxBytes: 64 }, signal())).rejects.toThrow("ORIGIN_CHANGED")
    expect(f.calls).toHaveLength(0)
  } finally { f.stop() }
})

test("byte chunks preserve Unicode and BOM, reassemble exactly and reject a changed snapshot", async () => {
  const text = "\ufeffЯ😀ABC\ufeffКонец"
  const f = fixture({ content: text })
  try {
    for (const mode of ["dom", "resource"] as const) {
      let offsetBytes = 0, expectedSnapshotSha256: string | undefined
      let joined = ""
      for (let step = 0; step < 20; step++) {
        const request = { offsetBytes, maxBytes: 6, ...(expectedSnapshotSha256 === undefined ? {} : { expectedSnapshotSha256 }) }
        const chunk = mode === "dom" ? await f.driver.readDom("fixture", request, signal()) : await f.driver.readResource("fixture", { ...request, url: "/resource" }, signal())
        const value = "body" in chunk ? chunk.body : chunk.content
        const bytes = "bodyBytes" in chunk ? chunk.bodyBytes : chunk.contentBytes
        expect(Buffer.byteLength(value)).toBe(bytes)
        joined += value; offsetBytes = chunk.nextOffsetBytes; expectedSnapshotSha256 = chunk.snapshotSha256
        if (!chunk.truncated) break
      }
      expect(joined).toBe(text)
      expect(offsetBytes).toBe(Buffer.byteLength(text))
      f.set(text + "changed")
      const read = mode === "dom" ? f.driver.readDom("fixture", { offsetBytes: 0, maxBytes: 6, expectedSnapshotSha256 }, signal()) : f.driver.readResource("fixture", { url: "/resource", offsetBytes: 0, maxBytes: 6, expectedSnapshotSha256 }, signal())
      await expect(read).rejects.toThrow("SNAPSHOT_CHANGED")
      f.set(text)
    }
    expect(f.calls.every(c => c.init.method === "GET" && c.init.credentials === "include" && c.init.redirect === "error" && c.init.mode === "same-origin")).toBe(true)
  } finally { f.stop() }
})
