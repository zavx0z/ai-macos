import { expect, test } from "bun:test"
import { CdpHttp } from "@meta/shared"
import { CdpBrowserDriver } from "../src/adapter.ts"

test("CdpBrowserDriver bounded DOM AX console использует только typed CDP methods", async () => {
  const methods: string[] = []
  const expressions: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { expression?: string } }
        methods.push(message.method)
        if (message.params?.expression) expressions.push(message.params.expression)
        const result = message.method === "Runtime.evaluate"
          ? { result: { value: JSON.stringify({ content: "<main>bounded</main>", truncated: false }) } }
          : message.method === "Accessibility.getRootAXNode"
            ? { node: { nodeId: "root", childIds: ["child"] } }
            : message.method === "Accessibility.getChildAXNodes"
              ? { nodes: [{ nodeId: "child", role: { value: "main" }, childIds: [] }] }
              : {}
        socket.send(JSON.stringify({ id: message.id, result }))
        if (message.method === "Runtime.enable") {
          setTimeout(() => socket.send(JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: {
              type: "log",
              args: [{ value: "x".repeat(2_000) }],
              timestamp: Date.now() / 1_000,
            },
          })), 5)
        }
      },
    },
  })
  const target = {
    id: "target:fixture",
    type: "page",
    title: "Fixture",
    url: "https://example.test",
    webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}`,
  }
  const http = new CdpHttp("fixture", 9222, {
    fetch: async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      return Response.json([target])
    },
  })
  const driver = new CdpBrowserDriver(http)
  const signal = new AbortController().signal
  try {
    expect(await driver.readDom(target.id, 64, signal)).toEqual({
      content: "<main>bounded</main>",
      truncated: false,
    })
    const accessibility = await driver.readAccessibility(target.id, 10, 1_024, signal)
    expect(accessibility.nodeCount).toBe(2)
    expect(accessibility.truncated).toBe(false)
    const consoleResult = await driver.readConsole(target.id, 10, 128, signal)
    expect(consoleResult.entries).toHaveLength(0)
    expect(consoleResult.droppedEvents).toBe(1)
    expect(expressions[0]).toContain("document.documentElement.outerHTML")
    expect(methods).toContain("Accessibility.getRootAXNode")
    expect(methods).toContain("Accessibility.getChildAXNodes")
    expect(methods).not.toContain("Browser.getVersion")
  } finally {
    server.stop(true)
  }
})
