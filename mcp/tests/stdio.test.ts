import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

let transport: StdioClientTransport | undefined

afterEach(async () => {
  await transport?.close()
  transport = undefined
})

describe("ai-macos MCP server", () => {
  test("advertises the small intent-level tool surface and screenshot app", async () => {
    transport = new StdioClientTransport({
      command: "/opt/local/bin/bun",
      args: ["src/index.ts"],
      cwd: new URL("..", import.meta.url).pathname,
    })
    const client = new Client({ name: "ai-macos-test", version: "0.1.0" })
    await client.connect(transport)

    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toContain("desktop_action")
    expect(names).toContain("system_health")
    expect(names).toContain("capture_desktop")
    expect(names).toContain("clipboard_read")
    expect(names).toContain("clipboard_write")
    expect(names).not.toContain("mouse_click")
    expect(names).not.toContain("keyboard_type")
    expect(names).not.toContain("keyboard_shortcut")

    const health = await client.callTool({ name: "system_health", arguments: {} })
    expect(health.isError).not.toBe(true)
    expect(health.structuredContent).toMatchObject({ window: { state: expect.any(String) }, screen: { state: expect.any(String) }, chrome: { state: expect.any(String) }, android: { state: expect.any(String) }, input: { state: expect.any(String) } })

    const captureTool = listed.tools.find((tool) => tool.name === "desktop_action")
    expect(captureTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://widget/ai-macos-screenshot-v4.html" },
      "openai/outputTemplate": "ui://widget/ai-macos-screenshot-v4.html",
    })
    expect(captureTool?.outputSchema).toBeDefined()

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: "ui://widget/ai-macos-screenshot-v4.html",
      mimeType: "text/html;profile=mcp-app",
    }))
    const resource = await client.readResource({ uri: "ui://widget/ai-macos-screenshot-v4.html" })
    const screenshotResource = resource.contents[0]
    expect(screenshotResource).toBeDefined()
    expect(screenshotResource).toMatchObject({
      uri: "ui://widget/ai-macos-screenshot-v4.html",
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
    expect(html).not.toContain("max-height: 70vh")

  })
})
