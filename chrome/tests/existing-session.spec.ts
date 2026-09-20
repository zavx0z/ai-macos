import { describe, expect, test } from "bun:test"
import { CdpHttp, withSession } from "@meta/shared"
import { ExistingChromeConnection, ExistingChromeDriver } from "../src/existing-session.ts"

function fixture(allow = true) {
  const counts = { jsonRequests: 0, upgradeRequests: 0, connections: 0, attachments: 0, methods: [] as string[] }
  let emit = (_value: unknown) => {}
  const targets = ["a", "b"].map(targetId => ({ targetId, type: "page", title: "same title", url: "https://example.test/same" }))
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname
      if (path.startsWith("/json/")) { ++counts.jsonRequests; return new Response("not available in approval mode", { status: 404 }) }
      if (path === "/devtools/browser/fixture") {
        ++counts.upgradeRequests
        if (!allow) return new Response("Connection rejected", { status: 403 })
        if (server.upgrade(request)) return
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(socket) { ++counts.connections; emit = value => { socket.send(JSON.stringify(value)) } },
      message(socket, raw) {
        const command = JSON.parse(String(raw)) as { id: number; method: string; sessionId?: string; params?: Record<string, unknown> }
        counts.methods.push(command.method)
        let result: unknown
        switch (command.method) {
          case "Browser.getVersion": result = { product: "Chrome/144.0.0.0", protocolVersion: "1.3", userAgent: "Fixture AppleWebKit/537.36" }; break
          case "Target.setDiscoverTargets": result = {}; break
          case "Target.getTargets": result = { targetInfos: targets }; break
          case "Target.attachToTarget": {
            ++counts.attachments
            if (command.params?.flatten !== true) throw new Error("Expected flattened attach")
            result = { sessionId: `session-${command.params.targetId}` }; break
          }
          case "Runtime.evaluate": result = { result: { value: JSON.stringify({ content: `<html>${command.sessionId}</html>`, truncated: false }) } }; break
          default:
            socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, error: { code: -32601, message: "Unexpected test method" } }))
            return
        }
        socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }))
      },
    },
  })
  const endpoint = { userDataDir: "/fixture", port: server.port!, browserPath: "/devtools/browser/fixture", webSocketUrl: `ws://127.0.0.1:${server.port}/devtools/browser/fixture` }
  return { counts, endpoint, discover: async () => endpoint, emit: (value: unknown) => emit(value), stop: () => server.stop(true) }
}

describe("existing Chrome connection (isolated loopback, no Chrome process)", () => {
  test("legacy /json fails while attach and repeated DOM reads use one approved browser socket", async () => {
    const f = fixture()
    const driver = new ExistingChromeDriver({ userDataDir: "/fixture", discover: f.discover })
    try {
      await expect(new CdpHttp("127.0.0.1", f.endpoint.port).version()).rejects.toThrow("404")
      const signal = new AbortController().signal
      expect(await driver.connect(signal)).toEqual({ browserVersion: "Chrome/144.0.0.0" })
      const targets = await driver.listTargets(signal)
      expect(targets.map(target => target.id)).toEqual(["a", "b"])
      expect(await driver.readDom("a", 4096, signal)).toEqual({ content: "<html>session-a</html>", truncated: false })
      expect(await driver.readDom("a", 4096, signal)).toEqual({ content: "<html>session-a</html>", truncated: false })
      expect(await driver.readDom("b", 4096, signal)).toEqual({ content: "<html>session-b</html>", truncated: false })
      expect(f.counts.jsonRequests).toBe(1) // Only the explicitly tested legacy client.
      expect(f.counts.connections).toBe(1)
      expect(f.counts.attachments).toBe(2)
      expect(f.counts.methods).not.toContain("Browser.close")
      expect(f.counts.methods).not.toContain("Target.createTarget")
      expect(f.counts.methods).not.toContain("Page.navigate")
    } finally { await driver.disconnect(); await f.stop() }
  })

  test("old target objects fail after explicit reconnect even if targetId/URL/title are identical", async () => {
    const f = fixture()
    const connection = new ExistingChromeConnection({ userDataDir: "/fixture", discover: f.discover })
    try {
      await connection.version()
      const old = (await connection.list())[0]!
      await withSession(old, session => session.send("Runtime.evaluate"))
      await connection.disconnect()
      await connection.version()
      await expect(withSession(old, session => session.send("Runtime.evaluate"))).rejects.toThrow("Stale")
      const fresh = (await connection.list())[0]!
      await withSession(fresh, session => session.send("Runtime.evaluate"))
      expect(f.counts.connections).toBe(2)
      expect(f.counts.attachments).toBe(2)
    } finally { await connection.disconnect(); await f.stop() }
  })

  test("refused approval makes one attempt, does not probe /json, and does not launch a fallback", async () => {
    const f = fixture(false)
    const connection = new ExistingChromeConnection({ userDataDir: "/fixture", discover: f.discover, approvalTimeoutMs: 100 })
    try {
      await expect(connection.version()).rejects.toThrow()
      expect(f.counts.upgradeRequests).toBe(1)
      expect(f.counts.connections).toBe(0)
      expect(f.counts.jsonRequests).toBe(0)
      await expect(connection.list()).rejects.toThrow("explicit connect-instance")
      expect(f.counts.upgradeRequests).toBe(1)
    } finally { await connection.disconnect(); await f.stop() }
  })

  test("missing discovery does not construct a WebSocket", async () => {
    let sockets = 0
    const connection = new ExistingChromeConnection({
      userDataDir: "/missing",
      discover: async () => { throw new Error("CHROME_DISCOVERY_UNAVAILABLE") },
      socketFactory: () => { ++sockets; throw new Error("Unexpected socket") },
    })
    await expect(connection.version()).rejects.toThrow("CHROME_DISCOVERY_UNAVAILABLE")
    expect(sockets).toBe(0)
    await connection.disconnect()
  })

  test("discovery changing during approval fails closed instead of selecting another browser", async () => {
    const f = fixture()
    let reads = 0
    const connection = new ExistingChromeConnection({
      userDataDir: "/fixture",
      discover: async () => ++reads === 1 ? f.endpoint : { ...f.endpoint, webSocketUrl: "ws://127.0.0.1:1/devtools/browser/other" },
    })
    try {
      await expect(connection.version()).rejects.toThrow("CHROME_DISCOVERY_CHANGED")
      expect(f.counts.connections).toBe(1)
      expect(f.counts.upgradeRequests).toBe(1)
    } finally { await connection.disconnect(); await f.stop() }
  })

  test("an already-aborted connect never discovers or opens a socket", async () => {
    let discoveries = 0
    const connection = new ExistingChromeConnection({ userDataDir: "/fixture", discover: async () => { ++discoveries; throw new Error("Unexpected discovery") } })
    const controller = new AbortController(); controller.abort()
    await expect(connection.version(controller.signal)).rejects.toThrow("cancelled")
    expect(discoveries).toBe(0)
    await connection.disconnect()
  })

  test("a detached attachment is not silently recreated", async () => {
    const f = fixture()
    const connection = new ExistingChromeConnection({ userDataDir: "/fixture", discover: f.discover })
    try {
      await connection.version()
      const target = (await connection.list())[0]!
      await withSession(target, session => session.send("Runtime.evaluate"))
      f.emit({ method: "Target.detachedFromTarget", params: { sessionId: "session-a", targetId: "a" } })
      await Bun.sleep(10)
      await expect(withSession(target, session => session.send("Runtime.evaluate"))).rejects.toThrow("detached")
      expect(f.counts.attachments).toBe(1)
    } finally { await connection.disconnect(); await f.stop() }
  })
})
