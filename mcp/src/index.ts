import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { SCREENSHOT_UI_URI, screenshotUiHtml } from "./screenshot-ui.ts"

const WINDOW_API = Bun.env.WINDOW_API ?? "http://127.0.0.1:7878"
const SCREEN_API = Bun.env.SCREEN_API ?? "http://127.0.0.1:7879"
const INPUT_API = Bun.env.INPUT_API ?? "http://127.0.0.1:7882"

type JsonObject = Record<string, unknown>

async function requestJson(
  baseUrl: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: JsonObject } = {},
): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let result: JsonObject
  try {
    result = JSON.parse(text) as JsonObject
  } catch {
    throw new Error(`${options.method ?? "GET"} ${path} returned non-JSON (${response.status})`)
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`)
  }
  return result
}

function textResult(result: JsonObject, summary: string) {
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(result, null, 2)}` }],
  }
}

async function capture(path: "/desktop" | "/window", body: JsonObject) {
  const result = await requestJson(SCREEN_API, path, {
    method: "POST",
    body: { ...body, detail: "medium", format: "json" },
  })
  const data = result.base64
  if (typeof data !== "string") throw new Error(`Screenshot response from ${path} did not include base64 data`)

  const { base64: _base64, ...metadata } = result
  return {
    structuredContent: { ...metadata, imageIncluded: true, mimeType: "image/png" },
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      { type: "image" as const, data, mimeType: "image/png" },
    ],
  }
}

const server = new McpServer(
  { name: "ai-macos", version: "0.2.0" },
  {
    instructions:
      "Control this Mac only for the user's explicit request. Before desktop input, call list_windows, then capture_window or capture_desktop with a precise expectation in caption. Compare the image with that expectation before acting. After every mouse or keyboard action, capture again and verify. Use clipboard_read and clipboard_write instead of Cmd+C/Cmd+V; read clipboard content only when explicitly requested and never expose secrets. Never type secrets or confirm authentication, purchases, account changes, sending, deletion, or other consequential actions without the user's explicit confirmation.",
  },
)

server.registerResource("ai-macos-screenshot", SCREENSHOT_UI_URI, {
  mimeType: "text/html;profile=mcp-app",
}, async () => ({
  contents: [
    {
      uri: SCREENSHOT_UI_URI,
      mimeType: "text/html;profile=mcp-app",
      text: screenshotUiHtml,
      _meta: {
        ui: { prefersBorder: true },
        "openai/widgetPrefersBorder": true,
      },
    },
  ],
}))

server.registerTool(
  "system_health",
  {
    title: "Check ai-macos services",
    description: "Check whether the local window, screen, and native input services are ready before using them.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const [window, screen, input] = await Promise.all([
      requestJson(WINDOW_API, "/health"),
      requestJson(SCREEN_API, "/health"),
      requestJson(INPUT_API, "/health"),
    ])
    return textResult({ window, screen, input }, "ai-macos service status")
  },
)

server.registerTool(
  "list_windows",
  {
    title: "List visible macOS windows",
    description: "List visible windows and canonical macOS process names. Always use this before targeting an application.",
    inputSchema: { app: z.string().min(1).optional().describe("Optional exact canonical macOS process name") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ app }) => {
    const query = app ? `?app=${encodeURIComponent(app)}` : ""
    const result = await requestJson(WINDOW_API, `/windows${query}`)
    return textResult(result, "Visible macOS windows")
  },
)

server.registerTool(
  "capture_desktop",
  {
    title: "Capture the macOS desktop",
    description: "Take a medium-detail desktop screenshot. State exactly what should be visible in caption before calling.",
    inputSchema: { caption: z.string().min(1).describe("One sentence describing what should be visible") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: SCREENSHOT_UI_URI },
      "openai/outputTemplate": SCREENSHOT_UI_URI,
      "openai/toolInvocation/invoking": "Capturing desktop…",
      "openai/toolInvocation/invoked": "Desktop captured.",
    },
  },
  async ({ caption }) => capture("/desktop", { caption }),
)

server.registerTool(
  "capture_window",
  {
    title: "Capture a macOS window",
    description: "Take a medium-detail screenshot of a specific visible window after list_windows identifies its canonical app name.",
    inputSchema: {
      app: z.string().min(1).describe("Canonical macOS process name from list_windows"),
      index: z.number().int().positive().optional(),
      title: z.string().min(1).optional().describe("Optional window-title substring"),
      caption: z.string().min(1).describe("One sentence describing what should be visible"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: SCREENSHOT_UI_URI },
      "openai/outputTemplate": SCREENSHOT_UI_URI,
      "openai/toolInvocation/invoking": "Capturing window…",
      "openai/toolInvocation/invoked": "Window captured.",
    },
  },
  async ({ app, index, title, caption }) => capture("/window", { app, index, title, caption }),
)

server.registerTool(
  "clipboard_read",
  {
    title: "Read macOS clipboard text",
    description: "Read plain text directly from the macOS system clipboard using pbpaste. Use only when the user explicitly asks to inspect clipboard content.",
    inputSchema: {},
    outputSchema: {
      text: z.string(),
      length: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const result = await requestJson(INPUT_API, "/clipboard")
    const text = typeof result.text === "string" ? result.text : ""
    const structuredContent = {
      text,
      length: typeof result.length === "number" ? result.length : text.length,
      bytes: typeof result.bytes === "number" ? result.bytes : new TextEncoder().encode(text).byteLength,
    }
    return {
      structuredContent,
      content: [{ type: "text" as const, text: `Clipboard text (${structuredContent.length} characters):\n${text}` }],
    }
  },
)

server.registerTool(
  "clipboard_write",
  {
    title: "Write macOS clipboard text",
    description: "Write plain text directly to the macOS system clipboard using pbcopy, without keyboard shortcuts or UI automation.",
    inputSchema: { text: z.string().max(1_000_000) },
    outputSchema: {
      length: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ text }) => {
    const result = await requestJson(INPUT_API, "/clipboard", { method: "POST", body: { text } })
    const structuredContent = {
      length: typeof result.length === "number" ? result.length : text.length,
      bytes: typeof result.bytes === "number" ? result.bytes : new TextEncoder().encode(text).byteLength,
    }
    return {
      structuredContent,
      content: [{ type: "text" as const, text: `Wrote ${structuredContent.length} characters to the macOS clipboard.` }],
    }
  },
)

server.registerTool(
  "focus_window",
  {
    title: "Focus a macOS application",
    description: "Bring an application to the foreground using the canonical process name returned by list_windows.",
    inputSchema: { app: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ app }) => textResult(
    await requestJson(WINDOW_API, "/focus", { method: "POST", body: { app } }),
    `Focused ${app}`,
  ),
)

server.registerTool(
  "arrange_window",
  {
    title: "Arrange a macOS window",
    description: "Move and resize a visible application window using a named layout preset.",
    inputSchema: {
      app: z.string().min(1),
      index: z.number().int().positive().optional(),
      preset: z.enum(["left", "right", "top", "bottom", "max", "center"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ app, index, preset }) => textResult(
    await requestJson(WINDOW_API, "/arrange", { method: "POST", body: { app, index, preset } }),
    `Arranged ${app}`,
  ),
)

server.registerTool(
  "mouse_position",
  {
    title: "Get mouse position",
    description: "Read the current mouse position in logical screen pixels.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => textResult(await requestJson(INPUT_API, "/mouse/position"), "Mouse position"),
)

server.registerTool(
  "mouse_move",
  {
    title: "Move the mouse",
    description: "Move the pointer to coordinates chosen from the latest verified screenshot. Does not click.",
    inputSchema: { x: z.number(), y: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ x, y }) => textResult(
    await requestJson(INPUT_API, "/mouse/move", { method: "POST", body: { x, y } }),
    "Mouse moved",
  ),
)

server.registerTool(
  "mouse_click",
  {
    title: "Click the mouse",
    description: "Click coordinates chosen from the latest verified screenshot. A click may submit forms or change external state, so require confirmation for consequential targets.",
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ x, y, button, count }) => textResult(
    await requestJson(INPUT_API, "/mouse/click", { method: "POST", body: { x, y, button, count } }),
    "Mouse clicked",
  ),
)

server.registerTool(
  "mouse_scroll",
  {
    title: "Scroll the mouse",
    description: "Scroll the current application, then capture the window again before choosing new coordinates.",
    inputSchema: { dx: z.number().optional(), dy: z.number().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ dx, dy }) => textResult(
    await requestJson(INPUT_API, "/mouse/scroll", { method: "POST", body: { dx, dy } }),
    "Mouse scrolled",
  ),
)

server.registerTool(
  "keyboard_type",
  {
    title: "Type text",
    description: "Type non-secret text into the currently focused field. This does not press Enter; capture the window afterward.",
    inputSchema: { text: z.string(), delayMs: z.number().int().min(0).max(1000).default(30) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ text, delayMs }) => textResult(
    await requestJson(INPUT_API, "/keyboard/type", { method: "POST", body: { text, delayMs } }),
    `Typed ${text.length} characters`,
  ),
)

server.registerTool(
  "keyboard_key",
  {
    title: "Press a keyboard key",
    description: "Press one key with optional modifiers. Enter can submit forms; destructive or externally visible actions require explicit user confirmation.",
    inputSchema: {
      key: z.string().min(1),
      modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl", "fn"])).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ key, modifiers }) => textResult(
    await requestJson(INPUT_API, "/keyboard/key", { method: "POST", body: { key, modifiers } }),
    `Pressed ${[...modifiers, key].join("+")}`,
  ),
)

server.registerTool(
  "keyboard_shortcut",
  {
    title: "Press a keyboard shortcut",
    description: "Press a single macOS keyboard shortcut. Shortcuts may close or change work, so require explicit user confirmation when consequential.",
    inputSchema: { shortcut: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ shortcut }) => textResult(
    await requestJson(INPUT_API, "/keyboard/shortcut", { method: "POST", body: { shortcut } }),
    `Pressed ${shortcut}`,
  ),
)

const transport = new StdioServerTransport()
await server.connect(transport)
