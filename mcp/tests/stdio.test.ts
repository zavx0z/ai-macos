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
    expect(names).toContain("clipboard_read")
    expect(names).toContain("clipboard_write")
    expect(names).toContain("mouse_click")
    expect(names).toContain("keyboard_type")

    const health = await client.callTool({ name: "system_health", arguments: {} })
    expect(health.isError).not.toBe(true)
    expect(health.structuredContent).toMatchObject({
      window: { ok: true },
      screen: { ok: true },
      input: {
        ok: true,
        accessibility: true,
        clipboard: { ok: true, backend: "pbpaste/pbcopy" },
      },
    })

    const captureTool = listed.tools.find((tool) => tool.name === "capture_desktop")
    expect(captureTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://widget/ai-macos-screenshot.html" },
      "openai/outputTemplate": "ui://widget/ai-macos-screenshot.html",
    })

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: "ui://widget/ai-macos-screenshot.html",
      mimeType: "text/html;profile=mcp-app",
    }))
    const resource = await client.readResource({ uri: "ui://widget/ai-macos-screenshot.html" })
    const screenshotResource = resource.contents[0]
    expect(screenshotResource).toBeDefined()
    expect(screenshotResource).toMatchObject({
      uri: "ui://widget/ai-macos-screenshot.html",
      mimeType: "text/html;profile=mcp-app",
    })
    expect(screenshotResource && "text" in screenshotResource ? screenshotResource.text : "").toContain("ui/notifications/tool-result")

    const originalClipboard = await client.callTool({ name: "clipboard_read", arguments: {} })
    const originalText = String((originalClipboard.structuredContent as { text?: unknown })?.text ?? "")
    const marker = `ai-macos-mcp-${crypto.randomUUID()}-Привет`
    try {
      const written = await client.callTool({ name: "clipboard_write", arguments: { text: marker } })
      expect(written.isError).not.toBe(true)
      const read = await client.callTool({ name: "clipboard_read", arguments: {} })
      expect(read.structuredContent).toMatchObject({ text: marker, length: marker.length })
    } finally {
      await client.callTool({ name: "clipboard_write", arguments: { text: originalText } })
    }
  })
})
