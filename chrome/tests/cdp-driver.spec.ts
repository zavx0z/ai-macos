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
          ? { result: { value: JSON.stringify({ content: "<main>bounded</main>", contentBytes: 20, offsetBytes: 0, nextOffsetBytes: 20, totalBytes: 20, snapshotSha256: "ef".repeat(32), truncated: false }) } }
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
    expect(await driver.readDom(target.id, { offsetBytes: 0, maxBytes: 64 }, signal)).toEqual({
      content: "<main>bounded</main>",
      contentBytes: 20,
      offsetBytes: 0,
      nextOffsetBytes: 20,
      totalBytes: 20,
      snapshotSha256: "ef".repeat(32),
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


test("CdpBrowserDriver DOM chunks carry exact byte cursor and snapshot identity", async () => {
  const expressions: string[] = []
  const snapshotSha256 = "ab".repeat(32)
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { expression?: string } }
        if (message.params?.expression) expressions.push(message.params.expression)
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            result: {
              value: JSON.stringify({
                content: "chunk",
                contentBytes: 5,
                offsetBytes: 7,
                nextOffsetBytes: 12,
                totalBytes: 20,
                snapshotSha256,
                truncated: true,
              }),
            },
          },
        }))
      },
    },
  })
  const target = {
    id: "target:chunk",
    type: "page",
    title: "Chunk fixture",
    url: "https://example.test/chunk",
    webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}`,
  }
  const http = new CdpHttp("fixture", 9222, {
    fetch: async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      return Response.json([target])
    },
  })
  const driver = new CdpBrowserDriver(http)
  try {
    expect(await driver.readDom(target.id, {
      offsetBytes: 7,
      maxBytes: 64,
      expectedSnapshotSha256: snapshotSha256,
    }, new AbortController().signal)).toEqual({
      content: "chunk",
      contentBytes: 5,
      offsetBytes: 7,
      nextOffsetBytes: 12,
      totalBytes: 20,
      snapshotSha256,
      truncated: true,
    })
    expect(expressions[0]).toContain("offsetBytes")
    expect(expressions[0]).toContain("crypto.subtle.digest")
    expect(expressions[0]).toContain(snapshotSha256)
  } finally {
    server.stop(true)
  }
})


test("CdpBrowserDriver same-origin resource read never exposes arbitrary evaluation", async () => {
  const expressions: string[] = []
  let websocketMessages = 0
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message(socket, raw) {
        websocketMessages++
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { expression?: string } }
        if (message.params?.expression) expressions.push(message.params.expression)
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            result: {
              value: JSON.stringify({
                url: "https://chatgpt.com/backend-api/conversations/fixture",
                status: 200,
                contentType: "application/json",
                body: "{\"ok\":true}",
                bodyBytes: 11,
                offsetBytes: 0,
                nextOffsetBytes: 11,
                totalBytes: 11,
                snapshotSha256: "12".repeat(32),
                truncated: false,
              }),
            },
          },
        }))
      },
    },
  })
  const target = {
    id: "target:resource",
    type: "page",
    title: "ChatGPT fixture",
    url: "https://chatgpt.com/c/fixture",
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
    expect(await driver.readResource(target.id, {
      url: "/backend-api/conversations/fixture",
      offsetBytes: 0,
      maxBytes: 1024,
    }, signal)).toEqual({
      url: "https://chatgpt.com/backend-api/conversations/fixture",
      status: 200,
      contentType: "application/json",
      body: "{\"ok\":true}",
      bodyBytes: 11,
      offsetBytes: 0,
      nextOffsetBytes: 11,
      totalBytes: 11,
      snapshotSha256: "12".repeat(32),
      truncated: false,
    })
    expect(expressions[0]).toContain("credentials")
    expect(expressions[0]).toContain("include")
    expect(expressions[0]).toContain("redirect")
    expect(expressions[0]).toContain("error")
    const beforeCrossOrigin = websocketMessages
    await expect(driver.readResource(target.id, {
      url: "https://example.test/private",
      offsetBytes: 0,
      maxBytes: 1024,
    }, signal)).rejects.toThrow("same-origin")
    expect(websocketMessages).toBe(beforeCrossOrigin)
  } finally {
    server.stop(true)
  }
})
