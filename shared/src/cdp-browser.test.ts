import { describe, expect, test } from "bun:test"
import { CdpBrowserTransport } from "./cdp-browser.ts"
import { withSession, type CdpSessionOptions } from "./cdp.ts"

type Socket = ReturnType<NonNullable<CdpSessionOptions["socketFactory"]>>
type Command = { id: number; method: string; sessionId?: string; params: Record<string, unknown> }
class FakeSocket extends EventTarget {
  commands: Command[] = []
  closeCalls = 0
  autoClose = true
  readonly socket: Socket = {
    addEventListener: this.addEventListener.bind(this) as Socket["addEventListener"],
    removeEventListener: this.removeEventListener.bind(this) as Socket["removeEventListener"],
    send: data => { this.commands.push(JSON.parse(String(data)) as Command) },
    close: () => { ++this.closeCalls; if (this.autoClose) this.dispatchEvent(new Event("close")) },
  }
  open() { this.dispatchEvent(new Event("open")) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
  reply(command: Command, result: unknown) { this.message({ id: command.id, sessionId: command.sessionId, result }) }
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function fixture(open = true) {
  const socket = new FakeSocket()
  const transport = new CdpBrowserTransport("ws://127.0.0.1:1/devtools/browser/test", {
    socketFactory: () => socket.socket, connectTimeoutMs: 100, commandTimeoutMs: 1_000,
  })
  if (open) socket.open()
  return { socket, transport }
}

describe("browser CDP transport", () => {
  test("routes simultaneous root and target responses by wire ID and exact sessionId", async () => {
    const { socket, transport } = fixture()
    try {
      const a = transport.session("session-a")
      const b = transport.session("session-b")
      const root = transport.root.send("Browser.getVersion")
      const first = a.send("Runtime.evaluate", { expression: "'a'" })
      const second = b.send("Runtime.evaluate", { expression: "'b'" })
      await flush()
      expect(new Set(socket.commands.map(command => command.id)).size).toBe(3)
      for (const command of [...socket.commands].reverse()) socket.reply(command, { from: command.sessionId ?? "root" })
      expect(await first).toEqual({ from: "session-a" })
      expect(await second).toEqual({ from: "session-b" })
      expect(await root).toEqual({ from: "root" })
      a.close(); b.close()
      expect(socket.closeCalls).toBe(0)
    } finally { await transport.disconnect() }
  })

  test("isolates events even when the event method is identical", async () => {
    const { socket, transport } = fixture()
    try {
      const a = transport.session("a"), b = transport.session("b")
      const seen: string[] = []
      a.subscribe("Page.loadEventFired", () => seen.push("a"))
      b.subscribe("Page.loadEventFired", () => seen.push("b"))
      transport.root.subscribe("Page.loadEventFired", () => seen.push("root"))
      socket.message({ method: "Page.loadEventFired", sessionId: "a", params: {} })
      expect(seen).toEqual(["a"])
      a.close()
      socket.message({ method: "Page.loadEventFired", sessionId: "a", params: {} })
      socket.message({ method: "Page.loadEventFired", sessionId: "b", params: {} })
      expect(seen).toEqual(["a", "b"])
      b.close()
    } finally { await transport.disconnect() }
  })

  test("withSession uses the bound factory and closing a read keeps the physical socket alive", async () => {
    const { socket, transport } = fixture()
    try {
      const target = {
        id: "target-a", title: "same title", url: "https://example.test", type: "page", webSocketDebuggerUrl: "not-a-websocket",
        sessionFactory: async (options: CdpSessionOptions) => transport.session("a", options),
      }
      for (let i = 0; i < 2; i++) {
        const pending = withSession(target, session => session.send("Runtime.evaluate"))
        await flush()
        socket.reply(socket.commands.at(-1)!, { number: i })
        expect(await pending).toEqual({ number: i })
        expect(socket.closeCalls).toBe(0)
      }
    } finally { await transport.disconnect() }
    expect(socket.closeCalls).toBe(1)
  })

  test("a mismatched response cannot satisfy another session", async () => {
    const { socket, transport } = fixture()
    const pending = transport.session("a").send("Runtime.evaluate")
    await flush()
    socket.message({ id: socket.commands[0]!.id, sessionId: "b", result: "wrong" })
    await expect(pending).rejects.toThrow()
    expect(transport.closed).toBe(true)
    await transport.disconnect()
  })

  test("target detach rejects only that logical target's pending work", async () => {
    const { socket, transport } = fixture()
    try {
      const a = transport.session("a"), b = transport.session("b")
      const first = a.send("Runtime.evaluate"), second = b.send("Runtime.evaluate")
      await flush()
      socket.message({ method: "Target.detachedFromTarget", params: { sessionId: "a" } })
      await expect(first).rejects.toThrow()
      socket.reply(socket.commands.find(command => command.sessionId === "b")!, { ok: true })
      expect(await second).toEqual({ ok: true })
      expect(transport.closed).toBe(false)
      b.close()
    } finally { await transport.disconnect() }
  })

  test("operation abort does not close another target or deliver a late response", async () => {
    const { socket, transport } = fixture()
    try {
      const controller = new AbortController()
      const a = transport.session("a", { signal: controller.signal })
      const b = transport.session("b")
      const first = a.send("Runtime.evaluate"), second = b.send("Runtime.evaluate")
      await flush()
      controller.abort()
      await expect(first).rejects.toThrow()
      for (const command of socket.commands) socket.reply(command, { from: command.sessionId })
      expect(await second).toEqual({ from: "b" })
      expect(socket.closeCalls).toBe(0)
      b.close()
    } finally { await transport.disconnect() }
  })

  test("disconnect requires the physical close event, not merely a close request", async () => {
    const { socket, transport } = fixture()
    socket.autoClose = false
    await expect(transport.disconnect(5)).rejects.toThrow("not confirmed")
    socket.dispatchEvent(new Event("close"))
    await transport.disconnect()
    expect(socket.closeCalls).toBe(1)
  })

  test("does not send a command while browser approval/handshake is pending", async () => {
    const { socket, transport } = fixture(false)
    const controller = new AbortController()
    const pending = transport.root.send("Browser.getVersion", {}, { signal: controller.signal })
    await flush()
    expect(socket.commands).toHaveLength(0)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await transport.disconnect()
  })

  test("physical close rejects pending commands and event waiters", async () => {
    const { socket, transport } = fixture()
    const session = transport.session("a")
    const pending = session.send("Runtime.evaluate")
    const event = session.waitForEvent("Page.loadEventFired")
    const pendingResult = pending.then(() => "resolved", error => error)
    const eventResult = event.then(() => "resolved", error => error)
    await flush()
    socket.dispatchEvent(new Event("close"))
    expect(await pendingResult).toBeInstanceOf(Error)
    expect(await eventResult).toBeInstanceOf(Error)
    await transport.disconnect()
  })
})
