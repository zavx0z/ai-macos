import { describe, expect, test } from "bun:test"
import { CdpHttp, CdpSession, CdpTransportError } from "./cdp.ts"

class FakeSocket extends EventTarget {
  readonly sent: string[] = []
  closeCalls = 0

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls += 1
    this.dispatchEvent(new Event("close"))
  }

  open(): void {
    this.dispatchEvent(new Event("open"))
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
  }
}

function session(
  socket: FakeSocket,
  options: { connectTimeoutMs?: number; commandTimeoutMs?: number; signal?: AbortSignal } = {},
): CdpSession {
  return new CdpSession("ws://fixture", {
    ...options,
    socketFactory: () => socket,
  })
}

async function waitForSend(socket: FakeSocket, count: number): Promise<void> {
  const deadline = Date.now() + 100
  while (socket.sent.length < count && Date.now() < deadline) await Bun.sleep(1)
  if (socket.sent.length < count) throw new Error(`Expected ${count} sent CDP commands`)
}

describe("CDP transport deadlines", () => {
  test("HTTP deadline охватывает зависший body после полученных headers", async () => {
    const http = new CdpHttp("fixture", 9222, {
      requestTimeoutMs: 10,
      fetch: async () => new Response(new ReadableStream({ start() {} })),
    })

    await expect(http.version()).rejects.toMatchObject({ code: "command-timeout" })
  })

  test("HTTP response ограничивается до JSON.parse", async () => {
    const http = new CdpHttp("fixture", 9222, {
      maxResponseBytes: 1_024,
      fetch: async () => new Response(JSON.stringify([{ text: "x".repeat(2_000) }])),
    })
    await expect(http.list()).rejects.toMatchObject({ code: "message-too-large" })
  })

  test("ограничивает ожидание соединения", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket, { connectTimeoutMs: 10 })

    await expect(cdp.send("Runtime.enable")).rejects.toMatchObject({
      code: "connect-timeout",
    })
    expect(socket.closeCalls).toBe(1)
  })

  test("удаляет зависшую команду по deadline", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket, { commandTimeoutMs: 10 })
    socket.open()

    await expect(cdp.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "command-timeout",
      method: "Runtime.evaluate",
    })

    socket.message({ id: 1, result: { late: true } })
    cdp.close()
  })

  test("отклоняет pending-команды при disconnect", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()
    const pending = cdp.send("Page.reload")
    socket.dispatchEvent(new Event("close"))

    await expect(pending).rejects.toMatchObject({ code: "disconnected" })
  })

  test("close до socket open немедленно завершает ожидающую команду", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket, { connectTimeoutMs: 1_000 })
    const pending = cdp.send("Runtime.enable")
    cdp.close()

    await expect(pending).rejects.toMatchObject({ code: "disconnected" })
  })

  test("command abort во время connect не закрывает transport", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket, { connectTimeoutMs: 1_000 })
    const controller = new AbortController()
    const pending = cdp.send("Runtime.evaluate", {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "aborted" })

    socket.open()
    const next = cdp.send("Runtime.getHeapUsage")
    await waitForSend(socket, 1)
    socket.message({ id: 1, result: { usedSize: 1 } })
    await expect(next).resolves.toEqual({ usedSize: 1 })
    cdp.close()
  })

  test("already-aborted session закрывается без connect timer leak", async () => {
    const socket = new FakeSocket()
    const controller = new AbortController()
    controller.abort()
    const cdp = session(socket, { connectTimeoutMs: 1_000, signal: controller.signal })

    await expect(cdp.send("Runtime.enable")).rejects.toMatchObject({ code: "aborted" })
    expect(socket.closeCalls).toBe(1)
  })

  test("socket error без close завершает pending и закрывает socket", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()
    const pending = cdp.send("Runtime.evaluate")
    socket.dispatchEvent(new Event("error"))

    await expect(pending).rejects.toMatchObject({ code: "disconnected" })
    expect(socket.closeCalls).toBe(1)
  })

  test("отмена команды не закрывает соседнюю сессию", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()
    const controller = new AbortController()
    const pending = cdp.send("Runtime.evaluate", {}, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: "aborted" })
    const next = cdp.send("Runtime.getHeapUsage")
    await waitForSend(socket, 1)
    const requestId = (JSON.parse(socket.sent.at(-1)!) as { id: number }).id
    socket.message({ id: requestId, result: { usedSize: 1 } })
    await expect(next).resolves.toEqual({ usedSize: 1 })
    cdp.close()
  })
})

describe("CDP typed subscriptions", () => {
  test("доставляет только выбранное событие и освобождает подписку", () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()
    const values: number[] = []
    const unsubscribe = cdp.subscribe<{ value: number }>("Fixture.event", ({ value }) => values.push(value))

    socket.message({ method: "Other.event", params: { value: 1 } })
    socket.message({ method: "Fixture.event", params: { value: 2 } })
    unsubscribe()
    socket.message({ method: "Fixture.event", params: { value: 3 } })

    expect(values).toEqual([2])
    cdp.close()
  })

  test("ожидание события имеет deadline", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()

    const error = await cdp.waitForEvent("Fixture.never", { timeoutMs: 10 }).catch((caught) => caught)
    expect(error).toBeInstanceOf(CdpTransportError)
    expect(error).toMatchObject({ code: "command-timeout", method: "Fixture.never" })
    cdp.close()
  })

  test("close немедленно завершает event waiter и очищает timer", async () => {
    const socket = new FakeSocket()
    const cdp = session(socket)
    socket.open()
    const pending = cdp.waitForEvent("Fixture.never", { timeoutMs: 1_000 })
    cdp.close()

    await expect(pending).rejects.toMatchObject({ code: "disconnected" })
  })

  test("слишком большой WS payload отклоняется до JSON.parse", async () => {
    const socket = new FakeSocket()
    const cdp = new CdpSession("ws://fixture", {
      socketFactory: () => socket,
      maxIncomingMessageBytes: 1_024,
    })
    socket.open()
    const waiting = cdp.waitForEvent("Fixture.large", { timeoutMs: 1_000 })
    socket.dispatchEvent(new MessageEvent("message", { data: `{"method":"Fixture.large","params":{"text":"${"x".repeat(2_000)}"}}` }))
    await expect(waiting).rejects.toMatchObject({ code: "message-too-large" })
    expect(socket.closeCalls).toBe(1)
  })
})
