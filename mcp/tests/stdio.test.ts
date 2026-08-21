import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

let transport: StdioClientTransport | undefined

afterEach(async () => {
  await transport?.close()
  transport = undefined
})

describe("ai-macos MCP server", () => {
  test("advertises tools and reaches the running local services", async () => {
    transport = new StdioClientTransport({
      command: "/opt/local/bin/bun",
      args: ["src/index.ts"],
      cwd: new URL("..", import.meta.url).pathname,
    })
    const client = new Client({ name: "ai-macos-test", version: "0.1.0" })
    await client.connect(transport)

    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toContain("list_windows")
    expect(names).toContain("capture_window")
    expect(names).toContain("mouse_click")
    expect(names).toContain("keyboard_type")

    const health = await client.callTool({ name: "system_health", arguments: {} })
    expect(health.isError).not.toBe(true)
    expect(health.structuredContent).toMatchObject({
      window: { ok: true },
      screen: { ok: true },
      input: { ok: true, accessibility: true },
    })
  })
})
