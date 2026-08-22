import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { SCREENSHOT_UI_DOMAIN, SCREENSHOT_UI_URI, screenshotUiHtml } from "./screenshot-ui.ts"
import { DesktopActionTransaction } from "./v2/action-transaction.ts"
import { RestDesktopActionAdapter, requestJson } from "./v2/rest-adapter.ts"

const WINDOW_API = Bun.env.WINDOW_API ?? "http://127.0.0.1:7878"
const SCREEN_API = Bun.env.SCREEN_API ?? "http://127.0.0.1:7879"
const CHROME_API = Bun.env.CHROME_API ?? "http://127.0.0.1:7880"
const ANDROID_API = Bun.env.ANDROID_API ?? "http://127.0.0.1:7881"
const INPUT_API = Bun.env.INPUT_API ?? "http://127.0.0.1:7882"

const transaction = new DesktopActionTransaction(new RestDesktopActionAdapter(WINDOW_API, SCREEN_API, INPUT_API))

const candidateSchema = z.object({
  handle: z.string(), app: z.string(), title: z.string(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  expiresAt: z.string(),
})

const actionOutputSchema = {
  status: z.enum(["target_not_found", "needs_target", "rejected_stale_target", "action_failed", "delivered_unverified", "verified", "verified_without_artifact", "verified_restoration_failed"]),
  correlationId: z.string(),
  target: z.object({ handle: z.string(), app: z.string(), title: z.string() }).optional(),
  delivery: z.object({ status: z.enum(["not_attempted", "delivered", "failed", "unknown"]), error: z.string().optional() }),
  effect: z.object({
    status: z.enum(["not_checked", "confirmed", "unconfirmed", "check_failed"]),
    evidence: z.object({ kind: z.literal("window_title_changed"), before: z.string(), after: z.string() }).optional(),
    error: z.string().optional(),
  }),
  verification: z.object({ status: z.enum(["not_run", "confirmed", "unconfirmed", "failed"]) }),
  restoration: z.object({ status: z.enum(["not_needed", "restored", "previous_target_gone", "failed"]), error: z.string().optional() }),
  artifact: z.object({ kind: z.literal("screenshot"), mimeType: z.literal("image/png"), imageIncluded: z.literal(true), caption: z.string() }).optional(),
  error: z.object({
    code: z.string(), message: z.string(), nextAction: z.string(),
    candidates: z.array(candidateSchema).optional(), correlationId: z.string(),
  }).optional(),
  audit: z.array(z.object({
    stage: z.string(), outcome: z.enum(["ok", "skipped", "failed"]),
    atMs: z.number(), durationMs: z.number(), detail: z.string().optional(),
  })),
  timings: z.object({ totalMs: z.number(), boundedByMs: z.number() }),
}

const server = new McpServer(
  { name: "ai-macos", version: "0.3.0" },
  { instructions: "Use desktop_action for desktop input. It binds one exact visible window, verifies focus immediately before dispatch, captures proof, and restores the exact previous window. Never infer effect success from delivery: only status=verified with effect.status=confirmed proves the effect." },
)

server.registerResource("ai-macos-screenshot", SCREENSHOT_UI_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
  contents: [{
    uri: SCREENSHOT_UI_URI, mimeType: "text/html;profile=mcp-app", text: screenshotUiHtml,
    _meta: {
      ui: { prefersBorder: true, domain: SCREENSHOT_UI_DOMAIN, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Displays exact-target PNG evidence returned by ai-macos.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetDomain": SCREENSHOT_UI_DOMAIN,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  }],
}))

async function healthOf(base: string) {
  try { return { state: "ready", ...(await requestJson(base, "/health")) } }
  catch (error) { return { state: "unavailable", error: error instanceof Error ? error.message : String(error) } }
}

server.registerTool("system_health", {
  title: "Check ai-macos readiness",
  description: "Read readiness for every desktop, browser, Android, screenshot, and input adapter.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => {
  const [window, screen, chrome, android, input] = await Promise.all([
    healthOf(WINDOW_API), healthOf(SCREEN_API), healthOf(CHROME_API), healthOf(ANDROID_API), healthOf(INPUT_API),
  ])
  const structuredContent = { window, screen, chrome, android, input }
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }] }
})

server.registerTool("desktop_action", {
  title: "Act on one exact visible macOS window",
  description: "Resolve one exact visible macOS window from required target {kind,value}, focus it exactly, dispatch one shortcut, verify its effect when evidence is available, capture post-action PNG proof, and restore the exact previous window. Start with target kind app; if multiple windows match, repeat with target kind handle and one returned candidate handle. Never launches a missing app.",
  inputSchema: z.strictObject({
    target: z.strictObject({
      kind: z.enum(["app", "handle"]).describe("Use app for initial resolution or handle for a returned candidate"),
      value: z.string().min(1).describe("Canonical app name or opaque candidate handle, according to kind"),
    }),
    shortcut: z.string().min(1).max(80).describe("One shortcut such as cmd+r"),
    verifyTitlePrefix: z.string().min(1).max(200).optional().describe("Deterministic fixture title prefix; required to prove a reload by title transition"),
    deadlineMs: z.number().int().min(1_000).max(30_000).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  }),
  outputSchema: actionOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  _meta: {
    ui: { resourceUri: SCREENSHOT_UI_URI }, "openai/outputTemplate": SCREENSHOT_UI_URI,
    "openai/toolInvocation/invoking": "Acting on the exact window…", "openai/toolInvocation/invoked": "Window transaction finished.",
  },
}, async (request) => {
  const result = await transaction.execute(request)
  const { _image, ...structuredContent } = result
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> = [
    { type: "text", text: JSON.stringify(structuredContent, null, 2) },
  ]
  if (_image) content.push({ type: "image", data: _image.data, mimeType: _image.mimeType })
  return { structuredContent, content, ...(_image ? { _meta: { screenshot: { data: _image.data, mimeType: _image.mimeType } } } : {}) }
})

server.registerTool("capture_desktop", {
  title: "Capture the desktop", description: "Capture a medium-detail desktop PNG for observation only.",
  inputSchema: { caption: z.string().min(1).describe("One sentence describing what should be visible") },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: SCREENSHOT_UI_URI }, "openai/outputTemplate": SCREENSHOT_UI_URI },
}, async ({ caption }) => {
  const result = await requestJson(SCREEN_API, "/desktop", { method: "POST", body: { detail: "medium", format: "json", caption } })
  const data = result.base64
  if (typeof data !== "string") throw new Error("desktop screenshot did not include base64")
  const structuredContent = { target: "desktop", mimeType: "image/png", imageIncluded: true, caption }
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }, { type: "image" as const, data, mimeType: "image/png" }],
    _meta: { screenshot: { data, mimeType: "image/png" } },
  }
})

server.registerTool("clipboard_read", {
  title: "Read clipboard text", description: "Read clipboard text only when explicitly requested by the user.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => {
  const result = await requestJson(INPUT_API, "/clipboard")
  return { structuredContent: result, content: [{ type: "text" as const, text: String(result.text ?? "") }] }
})

server.registerTool("clipboard_write", {
  title: "Write clipboard text", description: "Write text directly to the clipboard without UI input.",
  inputSchema: { text: z.string().max(1_000_000) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ text }) => {
  const result = await requestJson(INPUT_API, "/clipboard", { method: "POST", body: { text } })
  return { structuredContent: result, content: [{ type: "text" as const, text: `Wrote ${text.length} characters.` }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
