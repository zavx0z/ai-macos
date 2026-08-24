import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { installProcessDiagnostics } from "./process-diagnostics.ts"
import { SCREENSHOT_UI_DOMAIN, SCREENSHOT_UI_URI, screenshotUiHtml } from "./screenshot-ui.ts"

const diagnostics = installProcessDiagnostics("ai-macos-mcp")
const WINDOW_API = Bun.env.WINDOW_API ?? "http://127.0.0.1:7878"
const SCREEN_API = Bun.env.SCREEN_API ?? "http://127.0.0.1:7879"
const INPUT_API = Bun.env.INPUT_API ?? "http://127.0.0.1:7882"

type JsonObject = Record<string, unknown>

type LatestScreenshot = {
  version: number
  data: string
  mimeType: "image/png"
  metadata: JsonObject
}

let latestScreenshot: LatestScreenshot | null = null
let latestScreenshotVersion = 0

type WindowInfo = {
  app: string
  pid: number
  title: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

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

function parseWindowInfo(input: unknown, label: string): WindowInfo {
  if (!input || typeof input !== "object") throw new Error(`${label} did not include a window`)
  const value = input as Record<string, unknown>
  if (
    typeof value.app !== "string"
    || typeof value.pid !== "number"
    || typeof value.title !== "string"
    || typeof value.index !== "number"
    || typeof value.x !== "number"
    || typeof value.y !== "number"
    || typeof value.width !== "number"
    || typeof value.height !== "number"
  ) throw new Error(`${label} included an invalid window`)
  return value as WindowInfo
}

function windowFromResult(result: JsonObject): WindowInfo {
  return parseWindowInfo(result.target, "Verified focus response")
}

async function focusVisibleWindow(app: string, index?: number, title?: string) {
  const result = await requestJson(WINDOW_API, "/focus", {
    method: "POST",
    body: { app, index, title },
  })
  return { result, target: windowFromResult(result) }
}

async function restorePreviousFocus(focusResult: JsonObject) {
  const previous = focusResult.previous
  if (!previous || typeof previous !== "object") throw new Error("Verified focus response did not include previous focus")
  const state = previous as Record<string, unknown>
  const previousWindow = state.window == null ? null : parseWindowInfo(state.window, "Previous focus")
  if (previousWindow) {
    const restored = await requestJson(WINDOW_API, "/focus", {
      method: "POST",
      body: {
        app: previousWindow.app,
        pid: previousWindow.pid,
        title: previousWindow.title,
        x: previousWindow.x,
        y: previousWindow.y,
        width: previousWindow.width,
        height: previousWindow.height,
      },
    })
    return { ok: true, window: windowFromResult(restored) }
  }
  if (typeof state.app !== "string") throw new Error("Previous focus did not include an application")
  const restored = await requestJson(WINDOW_API, "/focus", { method: "POST", body: { app: state.app } })
  return { ok: true, window: windowFromResult(restored) }
}

async function currentTargetWindow(original: WindowInfo): Promise<WindowInfo> {
  const result = await requestJson(WINDOW_API, `/windows?app=${encodeURIComponent(original.app)}`)
  const values = Array.isArray(result.windows) ? result.windows : []
  const windows = values.flatMap((value) => {
    try {
      return [parseWindowInfo(value, "Window list")]
    } catch {
      return []
    }
  })
  const sameProcess = windows.filter((window) => window.pid === original.pid)
  return sameProcess.find((window) =>
    window.x === original.x
    && window.y === original.y
    && window.width === original.width
    && window.height === original.height
  ) ?? sameProcess.find((window) => window.title === original.title)
    ?? (sameProcess.length === 1 ? sameProcess[0]! : original)
}

async function captureWindowData(target: WindowInfo, caption: string) {
  const result = await requestJson(SCREEN_API, "/window", {
    method: "POST",
    body: {
      app: target.app,
      index: target.index,
      title: target.title || undefined,
      caption,
      detail: "medium",
      format: "json",
      restore: true,
    },
  })
  const data = result.base64
  if (typeof data !== "string") throw new Error("Post-action screenshot did not include base64 data")
  const { base64: _base64, ...metadata } = result
  return { data, metadata }
}

async function targetedInput(
  targetInput: { app: string; index?: number; title?: string },
  inputPath: string,
  inputBody: JsonObject,
  action: string,
  validateTarget?: (target: WindowInfo) => void,
) {
  const focused = await focusVisibleWindow(targetInput.app, targetInput.index, targetInput.title)
  let input: JsonObject | undefined
  let frontmostAfterInput: JsonObject | undefined
  let screenshot: Awaited<ReturnType<typeof captureWindowData>> | undefined
  let actionError: unknown
  let restored: Awaited<ReturnType<typeof restorePreviousFocus>> | undefined
  let restoreError: unknown

  try {
    validateTarget?.(focused.target)
    input = await requestJson(INPUT_API, inputPath, { method: "POST", body: inputBody })
    frontmostAfterInput = await requestJson(WINDOW_API, "/frontmost")
    const targetAfterInput = await currentTargetWindow(focused.target)
    screenshot = await captureWindowData(targetAfterInput, `Verification after: ${action}`)
  } catch (error) {
    actionError = error
  } finally {
    try {
      restored = await restorePreviousFocus(focused.result)
    } catch (error) {
      restoreError = error
    }
  }

  if (actionError) {
    const message = actionError instanceof Error ? actionError.message : String(actionError)
    const restoration = restoreError ? `; restoring previous focus also failed: ${String(restoreError)}` : "; previous focus was restored"
    throw new Error(`${action} failed: ${message}${restoration}`)
  }
  if (restoreError || !restored) {
    throw new Error(`${action} was delivered, but restoring previous focus failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
  }
  if (!input || !frontmostAfterInput || !screenshot) throw new Error(`${action} transaction completed without verification data`)

  const note = "The server selected one visible window, verified focus, delivered input, captured the target afterward, and restored the exact previously focused window. The screenshot is evidence for visual inspection, not an automatic guarantee of the application-level effect."
  const structuredContent = {
    ok: true,
    delivered: true,
    effectVerified: false,
    action,
    target: focused.target,
    previousFocus: focused.result.previous,
    frontmostBeforeInput: focused.result.frontmost,
    frontmostAfterInput,
    restored,
    input,
    verificationCapture: { ...screenshot.metadata, imageIncluded: true, mimeType: "image/png" },
    note,
  }
  return {
    structuredContent,
    content: [
      { type: "text" as const, text: `${action} delivered to verified target ${focused.target.app}; post-action screenshot captured; previous focus restored. Application-level effect still requires visual verification.\n${JSON.stringify(structuredContent, null, 2)}` },
      { type: "image" as const, data: screenshot.data, mimeType: "image/png" },
    ],
    _meta: { screenshot: { data: screenshot.data, mimeType: "image/png" } },
  }
}

const windowTargetInputSchema = {
  app: z.string().min(1).describe("Canonical process name. A sole visible window is selected automatically; a missing or ambiguous target is rejected before input"),
  index: z.number().int().positive().optional().describe("Only needed to disambiguate multiple visible windows; use the index returned in the rejection or list_windows"),
  title: z.string().min(1).optional().describe("Optional title substring to disambiguate multiple visible windows"),
}

const screenshotPipToolMeta = {
  ui: { resourceUri: SCREENSHOT_UI_URI },
  "openai/outputTemplate": SCREENSHOT_UI_URI,
  "openai/widgetAccessible": true,
}

async function capture(path: "/desktop" | "/window", body: JsonObject) {
  const result = await requestJson(SCREEN_API, path, {
    method: "POST",
    body: { ...body, detail: "medium", format: "json" },
  })
  const data = result.base64
  if (typeof data !== "string") throw new Error(`Screenshot response from ${path} did not include base64 data`)

  const { base64: _base64, ...metadata } = result
  latestScreenshot = {
    version: ++latestScreenshotVersion,
    data,
    mimeType: "image/png",
    metadata,
  }
  return {
    structuredContent: { ...metadata, imageIncluded: true, mimeType: "image/png" },
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      { type: "image" as const, data, mimeType: "image/png" },
    ],
  }
}

function latestCapture(after?: number) {
  if (!latestScreenshot) {
    const structuredContent = { available: false, changed: false, version: 0 }
    return {
      structuredContent,
      content: [{ type: "text" as const, text: "No screenshot has been captured yet." }],
    }
  }

  const changed = after !== latestScreenshot.version
  const structuredContent = {
    ...latestScreenshot.metadata,
    available: true,
    changed,
    version: latestScreenshot.version,
    imageIncluded: changed,
    mimeType: latestScreenshot.mimeType,
  }
  return {
    structuredContent,
    content: changed
      ? [
          { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
          { type: "image" as const, data: latestScreenshot.data, mimeType: latestScreenshot.mimeType },
        ]
      : [{ type: "text" as const, text: `Latest screenshot is unchanged at version ${latestScreenshot.version}.` }],
  }
}

const screenshotOutputSchema = {
  ok: z.boolean(),
  target: z.enum(["desktop", "window"]),
  mime: z.literal("image/png"),
  caption: z.string().optional(),
  imageIncluded: z.literal(true),
  mimeType: z.literal("image/png"),
  window: z.object({
    app: z.string(),
    pid: z.number().int(),
    title: z.string(),
    index: z.number().int(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
  restored: z.object({
    ok: z.boolean(),
    app: z.string().nullable(),
    error: z.string().optional(),
  }).optional(),
}

const server = new McpServer(
  { name: "ai-macos", version: "0.2.2" },
  {
    instructions:
      "Control this Mac only for the user's explicit request. All keyboard, click, and scroll tools require a visible target returned by list_windows and enforce target/focus verification server-side before input. A delivered input is not proof of its application-level effect: after every input action, capture or inspect the target and verify the requested outcome before claiming success. Use clipboard_read and clipboard_write instead of Cmd+C/Cmd+V; read clipboard content only when explicitly requested and never expose secrets. Never type secrets or confirm authentication, purchases, account changes, sending, deletion, or other consequential actions without the user's explicit confirmation.",
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
        ui: {
          prefersBorder: true,
          domain: SCREENSHOT_UI_DOMAIN,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Persistent picture-in-picture viewer for the latest macOS screenshot.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetDomain": SCREENSHOT_UI_DOMAIN,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
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
    description: "Take a medium-detail desktop screenshot for model vision and update the latest frame consumed by the separate PiP viewer. This tool does not open UI. State exactly what should be visible in caption before calling.",
    inputSchema: { caption: z.string().min(1).describe("One sentence describing what should be visible") },
    outputSchema: screenshotOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
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
    description: "Take a medium-detail screenshot of a specific visible window for model vision and update the latest frame consumed by the separate PiP viewer. This tool does not open UI. Use list_windows first to identify the canonical app name.",
    inputSchema: {
      app: z.string().min(1).describe("Canonical macOS process name from list_windows"),
      index: z.number().int().positive().optional(),
      title: z.string().min(1).optional().describe("Optional window-title substring"),
      caption: z.string().min(1).describe("One sentence describing what should be visible"),
    },
    outputSchema: screenshotOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      "openai/toolInvocation/invoking": "Capturing window…",
      "openai/toolInvocation/invoked": "Window captured.",
    },
  },
  async ({ app, index, title, caption }) => capture("/window", { app, index, title, caption }),
)

server.registerTool(
  "latest_capture",
  {
    title: "Read latest screenshot for the viewer",
    description: "App-only tool used by the screenshot PiP to fetch the latest capture when it changes.",
    inputSchema: {
      after: z.number().int().nonnegative().optional().describe("Last screenshot version already rendered by the PiP"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
    },
  },
  async ({ after }) => latestCapture(after),
)

server.registerTool(
  "open_screenshot_pip",
  {
    title: "Open screenshot PiP",
    description: "Open the single persistent picture-in-picture viewer for the latest capture. Do not call again while the PiP is already open.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ...screenshotPipToolMeta,
      "openai/toolInvocation/invoking": "Opening screenshot PiP…",
      "openai/toolInvocation/invoked": "Screenshot PiP opened.",
    },
  },
  async () => ({
    structuredContent: { ok: true },
    content: [{ type: "text" as const, text: "Screenshot PiP ready." }],
  }),
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
    description: "Bring an existing visible application window to the foreground and verify that it became frontmost. Never launches a missing application.",
    inputSchema: windowTargetInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ app, index, title }) => textResult(
    (await focusVisibleWindow(app, index, title)).result,
    `Focused and verified visible target ${app}`,
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
    description: "Focus a verified visible target and click coordinates inside that target window. Rejects missing targets and out-of-window coordinates.",
    inputSchema: {
      ...windowTargetInputSchema,
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ app, index, title, x, y, button, count }) => {
    const focused = await focusVisibleWindow(app, index, title)
    const target = focused.target
    if (x < target.x || y < target.y || x >= target.x + target.width || y >= target.y + target.height) {
      throw new Error(`Refusing click outside verified ${target.app} window bounds (${target.x},${target.y})–(${target.x + target.width},${target.y + target.height})`)
    }
    const input = await requestJson(INPUT_API, "/mouse/click", { method: "POST", body: { x, y, button, count } })
    const frontmostAfterInput = await requestJson(WINDOW_API, "/frontmost")
    return textResult({
      ok: true,
      delivered: true,
      effectVerified: false,
      action: `Clicked ${button} at (${x}, ${y})`,
      target,
      frontmostBeforeInput: focused.result.frontmost,
      frontmostAfterInput,
      input,
      note: "Click was delivered inside the verified target window. Capture or inspect the target window before claiming the application-level effect succeeded.",
    }, `Click delivered inside verified target ${target.app}. Application-level effect is not yet verified.`)
  },
)

server.registerTool(
  "mouse_scroll",
  {
    title: "Scroll the mouse",
    description: "Focus a verified visible target, scroll it, then capture the target before choosing new coordinates.",
    inputSchema: { ...windowTargetInputSchema, dx: z.number().optional(), dy: z.number().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ app, index, title, dx, dy }) => targetedInput(
    { app, index, title },
    "/mouse/scroll",
    { dx, dy },
    `Scrolled dx=${dx ?? 0}, dy=${dy ?? 0}`,
  ),
)

server.registerTool(
  "keyboard_type",
  {
    title: "Type text",
    description: "Focus a verified visible target and type non-secret text. This does not press Enter; capture afterward to verify the application-level result.",
    inputSchema: { ...windowTargetInputSchema, text: z.string(), delayMs: z.number().int().min(0).max(1000).default(30) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ app, index, title, text, delayMs }) => targetedInput(
    { app, index, title },
    "/keyboard/type",
    { text, delayMs },
    `Typed ${text.length} characters`,
  ),
)

server.registerTool(
  "keyboard_key",
  {
    title: "Press a keyboard key",
    description: "Press one key with optional modifiers. Enter can submit forms; destructive or externally visible actions require explicit user confirmation.",
    inputSchema: {
      ...windowTargetInputSchema,
      key: z.string().min(1),
      modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl", "fn"])).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ app, index, title, key, modifiers }) => targetedInput(
    { app, index, title },
    "/keyboard/key",
    { key, modifiers },
    `Pressed ${[...modifiers, key].join("+")}`,
  ),
)

server.registerTool(
  "keyboard_shortcut",
  {
    title: "Press a keyboard shortcut",
    description: "Focus a verified visible target, then press one macOS shortcut. Delivery does not prove the app-level effect; capture afterward before claiming success.",
    inputSchema: { ...windowTargetInputSchema, shortcut: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ app, index, title, shortcut }) => targetedInput(
    { app, index, title },
    "/keyboard/shortcut",
    { shortcut },
    `Pressed ${shortcut}`,
  ),
)

const transport = new StdioServerTransport()
await server.connect(transport)
diagnostics.log("bridge_ready", { windowApi: WINDOW_API, screenApi: SCREEN_API, inputApi: INPUT_API })

process.once("SIGINT", () => close("SIGINT", 130))
process.once("SIGTERM", () => close("SIGTERM", 143))

function close(signal: string, code: number): void {
  diagnostics.log("shutdown_requested", { signal, code })
  void server.close().finally(() => process.exit(code))
}
