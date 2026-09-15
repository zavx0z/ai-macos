import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  createCatalogServer,
  type RuntimeCatalogBackend,
} from "../src/catalog-server.ts"

class FakeCatalogBackend implements RuntimeCatalogBackend {
  tools: Tool[] = []
  result: CallToolResult = { content: [] }
  calls: Array<{ name: string, args: Record<string, unknown> }> = []
  signal: AbortSignal | undefined
  unsubscribes = 0
  readonly listeners = new Set<() => void>()

  listTools(): Tool[] {
    return this.tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    this.calls.push({ name, args })
    this.signal = signal
    return this.result
  }

  subscribeCatalogChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribes += 1
    }
  }

  catalogChanged(): void {
    for (const listener of this.listeners) listener()
  }
}

const connected: Array<{
  client: Client
  server: ReturnType<typeof createCatalogServer>
}> = []

afterEach(async () => {
  for (const pair of connected.splice(0)) {
    await pair.client.close()
    await pair.server.close()
  }
})

async function connect(backend: RuntimeCatalogBackend) {
  const server = createCatalogServer(backend)
  const client = new Client({ name: "catalog-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  connected.push({ client, server })
  return { client, server }
}

function descriptor(name: string): Tool {
  return {
    name,
    title: `Runtime ${name}`,
    description: `Runtime-owned descriptor for ${name}`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
      additionalProperties: false,
    },
    annotations: {
      title: `Runtime ${name}`,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { "runtime/revision": 7 },
  }
}

describe("runtime-owned MCP catalog", () => {
  test("передаёт динамические descriptors, output schema и image result без пересборки", async () => {
    const backend = new FakeCatalogBackend()
    backend.tools = [descriptor("inspect")]
    backend.result = {
      content: [
        { type: "text", text: "runtime result" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      structuredContent: { echoed: "hello" },
      _meta: { "runtime/operationId": "operation:1" },
    }
    const { client } = await connect(backend)

    const listed = await client.listTools()
    expect(listed.tools).toEqual(backend.tools)

    const result = await client.callTool({
      name: "inspect",
      arguments: { value: "hello" },
    })
    expect(result).toEqual(backend.result)
    expect(backend.calls).toEqual([{
      name: "inspect",
      args: { value: "hello" },
    }])
  })

  test("сохраняет typed tool error output без преобразования в protocol exception", async () => {
    const backend = new FakeCatalogBackend()
    backend.tools = [descriptor("inspect")]
    backend.result = {
      isError: true,
      content: [{ type: "text", text: "operation outcome unknown" }],
      structuredContent: {
        error: {
          code: "operation-outcome-unknown",
          replayAllowed: false,
        },
      },
    }
    const { client } = await connect(backend)

    await expect(client.callTool({
      name: "inspect",
      arguments: { value: "hello" },
    })).resolves.toEqual(backend.result)
  })

  test("передаёт cancellation signal в выполняющий backend call", async () => {
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const backend = new FakeCatalogBackend()
    backend.tools = [descriptor("wait")]
    backend.callTool = async (name, args, signal) => {
      backend.calls.push({ name, args })
      backend.signal = signal
      started?.()
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return {
        isError: true,
        content: [{ type: "text", text: "cancelled" }],
      }
    }
    const { client } = await connect(backend)
    const controller = new AbortController()
    const pending = client.callTool(
      { name: "wait", arguments: { value: "hello" } },
      undefined,
      { signal: controller.signal },
    )
    await startedPromise
    controller.abort("test cancellation")

    await expect(pending).rejects.toThrow()
    expect(backend.signal?.aborted).toBe(true)
  })

  test("уведомляет об изменении каталога и отписывается при disconnect", async () => {
    const backend = new FakeCatalogBackend()
    backend.tools = [descriptor("first")]
    const { client } = await connect(backend)
    let changed: (() => void) | undefined
    const changedPromise = new Promise<void>(resolve => { changed = resolve })
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed?.()
    })

    backend.tools = [descriptor("second")]
    backend.catalogChanged()
    await changedPromise
    expect((await client.listTools()).tools).toEqual(backend.tools)

    await client.close()
    expect(backend.unsubscribes).toBe(1)
    expect(backend.listeners.size).toBe(0)
  })
})
