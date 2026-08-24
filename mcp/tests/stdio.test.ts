import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

let transport: StdioClientTransport | undefined

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((item) =>
    !!item
    && typeof item === "object"
    && (item as { type?: unknown }).type === "image"
  )
}

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
    expect(names).toContain("latest_capture")
    expect(names).toContain("open_screenshot_pip")
    expect(names).toContain("clipboard_read")
    expect(names).toContain("clipboard_write")
    expect(names).toContain("mouse_click")
    expect(names).toContain("keyboard_type")

    for (const name of ["mouse_click", "mouse_scroll", "keyboard_type", "keyboard_key", "keyboard_shortcut"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name)
      expect(tool?.inputSchema.required).toContain("app")
      expect(tool?.inputSchema.properties).toHaveProperty("app")
    }
    const missingTarget = await client.callTool({name: "keyboard_type", arguments: {text: "not delivered"}})
    expect(missingTarget.isError).toBe(true)

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
    expect(captureTool?._meta?.ui).toBeUndefined()
    expect(captureTool?._meta?.["openai/outputTemplate"]).toBeUndefined()
    expect(captureTool?.outputSchema).toBeDefined()

    const latestCaptureTool = listed.tools.find((tool) => tool.name === "latest_capture")
    expect(latestCaptureTool?._meta).toMatchObject({
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
    })
    expect(latestCaptureTool?._meta?.["openai/outputTemplate"]).toBeUndefined()

    const openPipTool = listed.tools.find((tool) => tool.name === "open_screenshot_pip")
    expect(openPipTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://widget/ai-macos-screenshot-v5.html" },
      "openai/outputTemplate": "ui://widget/ai-macos-screenshot-v5.html",
      "openai/widgetAccessible": true,
    })

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: "ui://widget/ai-macos-screenshot-v5.html",
      mimeType: "text/html;profile=mcp-app",
    }))
    const resource = await client.readResource({ uri: "ui://widget/ai-macos-screenshot-v5.html" })
    const screenshotResource = resource.contents[0]
    expect(screenshotResource).toBeDefined()
    expect(screenshotResource).toMatchObject({
      uri: "ui://widget/ai-macos-screenshot-v5.html",
      mimeType: "text/html;profile=mcp-app",
    })
    expect(screenshotResource?._meta).toMatchObject({
      ui: {
        domain: "https://ai-macos-local.zavx0z.app",
        csp: { connectDomains: [], resourceDomains: [] },
      },
    })
    const html = screenshotResource && "text" in screenshotResource ? screenshotResource.text : ""
    expect(html).toContain("ui/notifications/tool-result")
    expect(html).toContain("toolResponseMetadata")
    expect(html).toContain("openai:set_globals")
    expect(html).toContain("notifyIntrinsicHeight")
    expect(html).toContain("ui/notifications/size-changed")
    expect(html).toContain("requestDisplayMode")
    expect(html).toContain('mode: "pip"')
    expect(html).toContain('callTool("latest_capture"')
    expect(html).not.toContain("max-height: 70vh")

    const beforeCapture = await client.callTool({ name: "latest_capture", arguments: {} })
    expect(beforeCapture.structuredContent).toMatchObject({ available: false, changed: false, version: 0 })

    const modelCapture = await client.callTool({
      name: "capture_desktop",
      arguments: { caption: "MCP latest screenshot integration test" },
    })
    expect(modelCapture.isError).not.toBe(true)
    expect(hasImageContent(modelCapture.content)).toBe(true)
    expect(modelCapture._meta?.screenshot).toBeUndefined()

    const latestCapture = await client.callTool({ name: "latest_capture", arguments: { after: 0 } })
    expect(latestCapture.structuredContent).toMatchObject({ available: true, changed: true, imageIncluded: true })
    expect(hasImageContent(latestCapture.content)).toBe(true)
    const latestVersion = Number((latestCapture.structuredContent as { version?: unknown })?.version)
    expect(latestVersion).toBeGreaterThan(0)

    const unchangedCapture = await client.callTool({ name: "latest_capture", arguments: { after: latestVersion } })
    expect(unchangedCapture.structuredContent).toMatchObject({
      available: true,
      changed: false,
      version: latestVersion,
      imageIncluded: false,
    })
    expect(hasImageContent(unchangedCapture.content)).toBe(false)

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
