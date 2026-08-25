import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { hostname } from "node:os"

let transport: StdioClientTransport | undefined
let fakeClipboard = ""
let fakeClickCount = 0
let fakeClickStatus = 200
let fakeClickDelayMs = 0
let fakeScreenFailure = false
let fakeFocusApps: string[] = []
let fakeRequestCount = 0
let fakeClickEntered: Promise<void> = Promise.resolve()
let resolveFakeClickEntered: () => void = () => {}
let fakeServers: Array<{stop(closeActiveConnections?: boolean): void}> = []
let serviceEnv: Record<string, string> = {}

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {status})
}

beforeEach(() => {
  fakeClipboard = ""
  fakeClickCount = 0
  fakeClickStatus = 200
  fakeClickDelayMs = 0
  fakeScreenFailure = false
  fakeFocusApps = []
  fakeRequestCount = 0
  fakeClickEntered = new Promise<void>((resolve) => { resolveFakeClickEntered = resolve })
  const targetWindow = {
    app: "TestApp",
    pid: 101,
    title: "Test window",
    index: 1,
    x: 100,
    y: 80,
    width: 640,
    height: 480,
  }
  const previousWindow = {
    app: "PreviousApp",
    pid: 202,
    title: "Previous window",
    index: 1,
    x: 20,
    y: 30,
    width: 500,
    height: 400,
  }
  const windowServer = Bun.serve({
    port: 0,
    async fetch(req) {
      fakeRequestCount += 1
      const url = new URL(req.url)
      const path = url.pathname
      if (path === "/health") return jsonResponse({ok: true, service: "@meta/window"})
      if (path === "/windows") {
        const app = url.searchParams.get("app")
        const windows = app === previousWindow.app ? [previousWindow] : [targetWindow]
        return jsonResponse({count: windows.length, windows})
      }
      if (path === "/frontmost") {
        return jsonResponse({app: targetWindow.app, pid: targetWindow.pid, window: targetWindow})
      }
      if (path === "/focus" && req.method === "POST") {
        const body = await req.json() as {app?: string}
        fakeFocusApps.push(body.app ?? "")
        const target = body.app === previousWindow.app ? previousWindow : targetWindow
        return jsonResponse({
          ok: true,
          target,
          frontmost: {app: targetWindow.app, pid: targetWindow.pid},
          previous: {app: previousWindow.app, window: previousWindow},
        })
      }
      return jsonResponse({error: "not implemented"}, 404)
    },
  })
  const screenServer = Bun.serve({
    port: 0,
    async fetch(req) {
      fakeRequestCount += 1
      const url = new URL(req.url)
      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "@meta/screen",
          windowApi: windowServer.url.origin,
          window: {ok: true, service: "@meta/window"},
        })
      }
      if (url.pathname === "/desktop" && req.method === "POST") {
        const body = await req.json() as {caption?: string}
        return jsonResponse({
          ok: true,
          target: "desktop",
          mime: "image/png",
          caption: body.caption,
          base64: ONE_PIXEL_PNG,
        })
      }
      if (url.pathname === "/window" && req.method === "POST") {
        if (fakeScreenFailure) return jsonResponse({error: "capture failed"}, 500)
        const body = await req.json() as {caption?: string}
        return jsonResponse({
          ok: true,
          target: "window",
          mime: "image/png",
          caption: body.caption,
          window: targetWindow,
          restored: {ok: true, app: previousWindow.app},
          base64: ONE_PIXEL_PNG,
        })
      }
      return jsonResponse({error: "not implemented"}, 404)
    },
  })
  const chromeServer = Bun.serve({
    port: 0,
    fetch(req) {
      fakeRequestCount += 1
      if (new URL(req.url).pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "@meta/chrome",
          running: false,
          cdp: {available: false},
          browserProcesses: [],
          appleScriptAmbiguous: false,
        })
      }
      return jsonResponse({error: "not implemented"}, 404)
    },
  })
  const inputServer = Bun.serve({
    port: 0,
    async fetch(req) {
      fakeRequestCount += 1
      const path = new URL(req.url).pathname
      if (path === "/status" || path === "/health") {
        return jsonResponse({
          ok: true,
          service: "@meta/input",
          backend: "native-helper",
          helper: "/test/meta-input-helper",
          accessibility: true,
          inputReady: true,
          clipboardReady: true,
          clipboard: {ok: true, backend: "pbpaste/pbcopy"},
          probe: path === "/status" ? "passive-preflight" : "active-event",
        })
      }
      if (path === "/clipboard" && req.method === "GET") {
        return jsonResponse({
          ok: true,
          backend: "pbpaste/pbcopy",
          text: fakeClipboard,
          length: fakeClipboard.length,
          bytes: new TextEncoder().encode(fakeClipboard).byteLength,
        })
      }
      if (path === "/clipboard" && req.method === "POST") {
        const body = await req.json() as {text?: string}
        fakeClipboard = body.text ?? ""
        return jsonResponse({
          ok: true,
          backend: "pbpaste/pbcopy",
          length: fakeClipboard.length,
          bytes: new TextEncoder().encode(fakeClipboard).byteLength,
        })
      }
      if (path === "/mouse/click" && req.method === "POST") {
        resolveFakeClickEntered()
        if (fakeClickDelayMs > 0) await Bun.sleep(fakeClickDelayMs)
        if (fakeClickStatus !== 200) return jsonResponse({error: "click rejected"}, fakeClickStatus)
        fakeClickCount += 1
        return jsonResponse({ok: true})
      }
      return jsonResponse({error: "not implemented"}, 404)
    },
  })
  fakeServers = [windowServer, screenServer, chromeServer, inputServer]
  serviceEnv = {
    WINDOW_API: windowServer.url.origin.replace("localhost", "127.0.0.1"),
    SCREEN_API: screenServer.url.origin,
    CHROME_API: chromeServer.url.origin,
    INPUT_API: inputServer.url.origin,
  }
})

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((item) =>
    !!item
    && typeof item === "object"
    && (item as { type?: unknown }).type === "image"
  )
}

async function connectDirectClient(name: string): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: {...process.env, ...serviceEnv, AI_MACOS_EXPECTED_HOSTNAME: hostname()},
  })
  const client = new Client({name, version: "0.1.0"})
  await client.connect(transport)
  return client
}

afterEach(async () => {
  await transport?.close()
  transport = undefined
  for (const server of fakeServers) server.stop(true)
  fakeServers = []
})

describe("ai-macos MCP server", () => {
  test("advertises tools and reaches the running local services", async () => {
    const client = await connectDirectClient("ai-macos-test")

    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toContain("list_windows")
    expect(names).toContain("input_readiness")
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
      machine: {
        hostname: expect.any(String),
        expectedHostname: hostname(),
        matchesExpected: true,
        platform: "darwin",
        arch: expect.any(String),
        projectRoot: new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
      window: { ok: true },
      screen: { ok: true },
      chrome: { ok: true },
      input: {ok: true, inputReady: true, clipboardReady: true},
    })

    const readiness = await client.callTool({name: "input_readiness", arguments: {}})
    expect(readiness.isError).not.toBe(true)
    expect(readiness.structuredContent).toMatchObject({
      ok: true,
      serviceReady: true,
      inputReady: true,
      probe: "active-event",
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

  test("launcher reuses all compatible desktop listeners on the expected Mac", async () => {
    fakeRequestCount = 0
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/launcher.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      env: {...process.env, ...serviceEnv, AI_MACOS_EXPECTED_HOSTNAME: hostname()},
    })
    const client = new Client({name: "ai-macos-launcher-test", version: "0.1.0"})
    await client.connect(transport)

    const health = await client.callTool({name: "system_health", arguments: {}})
    expect(health.structuredContent).toMatchObject({
      servicesProbed: true,
      window: {ok: true, service: "@meta/window"},
      screen: {ok: true, service: "@meta/screen"},
      chrome: {ok: true, service: "@meta/chrome"},
      input: {ok: true, service: "@meta/input"},
    })
    expect(fakeRequestCount).toBeGreaterThanOrEqual(8)
  })

  test("reports a delivered click without retry when post-action capture fails", async () => {
    const client = await connectDirectClient("ai-macos-click-verification-test")
    fakeScreenFailure = true

    const result = await client.callTool({
      name: "mouse_click",
      arguments: {app: "TestApp", x: 20, y: 30, button: "left", count: 1},
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      ok: false,
      delivered: true,
      verificationComplete: false,
      restorationComplete: true,
    })
    expect(fakeClickCount).toBe(1)
    expect(fakeFocusApps).toEqual(["TestApp", "PreviousApp"])
  })

  test("distinguishes rejected and unknown click delivery", async () => {
    const client = await connectDirectClient("ai-macos-click-delivery-test")
    fakeClickStatus = 503
    const rejected = await client.callTool({
      name: "mouse_click",
      arguments: {app: "TestApp", x: 20, y: 30, button: "left", count: 1},
    })
    expect(rejected.structuredContent).toMatchObject({
      ok: false,
      delivered: false,
      delivery: "not-delivered",
    })
    expect(fakeClickCount).toBe(0)

    fakeClickStatus = 500
    const unknown = await client.callTool({
      name: "mouse_click",
      arguments: {app: "TestApp", x: 20, y: 30, button: "left", count: 1},
    })
    expect(unknown.structuredContent).toMatchObject({
      ok: false,
      delivered: null,
      delivery: "unknown",
    })
    expect(fakeClickCount).toBe(0)
  })

  test("fails fast instead of queueing a stale concurrent desktop mutation", async () => {
    const client = await connectDirectClient("ai-macos-mutation-guard-test")
    fakeClickDelayMs = 100
    const click = client.callTool({
      name: "mouse_click",
      arguments: {app: "TestApp", x: 20, y: 30, button: "left", count: 1},
    })
    await fakeClickEntered
    const focus = await client.callTool({
      name: "focus_window",
      arguments: {app: "TestApp"},
    })
    expect(focus.isError).toBe(true)
    expect(JSON.stringify(focus.content)).toContain("refusing queued stale action")
    expect((await click).structuredContent).toMatchObject({delivered: true})
  })

  test("does not probe or start REST services before physical machine identity matches", async () => {
    fakeRequestCount = 0
    const expectedHostname = `not-${hostname()}`
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/launcher.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      env: {...process.env, ...serviceEnv, AI_MACOS_EXPECTED_HOSTNAME: expectedHostname},
    })
    const client = new Client({name: "ai-macos-machine-gate-test", version: "0.1.0"})
    await client.connect(transport)

    const health = await client.callTool({name: "system_health", arguments: {}})
    expect(health.isError).not.toBe(true)
    expect(health.structuredContent).toEqual({
      machine: {
        hostname: hostname(),
        expectedHostname,
        matchesExpected: false,
        platform: "darwin",
        arch: expect.any(String),
        projectRoot: new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
      servicesProbed: false,
    })
    expect(fakeRequestCount).toBe(0)
  })
})
