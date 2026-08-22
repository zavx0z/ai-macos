import type {
  DesktopActionAdapter,
  ScreenshotEvidence,
  WindowIdentity,
  WindowObservation,
} from "./contracts.ts"

type Json = Record<string, unknown>

export class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) { super(message) }
}

export async function requestJson(
  base: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: Json } = {},
): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  if (!response.ok) throw new RestError(`${options.method ?? "GET"} ${path} failed (${response.status})`, response.status, parsed)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RestError(`${path} returned invalid JSON object`, response.status, parsed)
  return parsed as Json
}

export class RestDesktopActionAdapter implements DesktopActionAdapter {
  constructor(
    private readonly windowApi: string,
    private readonly screenApi: string,
    private readonly inputApi: string,
  ) {}

  async observe(app?: string): Promise<WindowObservation> {
    const query = app ? `?app=${encodeURIComponent(app)}` : ""
    return await requestJson(this.windowApi, `/v2/windows${query}`) as WindowObservation
  }

  async focused(): Promise<{ epoch: string; focused: WindowIdentity | null }> {
    return await requestJson(this.windowApi, "/v2/focus") as { epoch: string; focused: WindowIdentity | null }
  }

  async focusExact(identity: WindowIdentity): Promise<void> {
    const result = await requestJson(this.windowApi, "/v2/focus", { method: "POST", body: identity })
    if (result.verified !== true) throw new Error("window service did not verify exact focus")
  }

  async shortcut(shortcut: string): Promise<void> {
    await requestJson(this.inputApi, "/keyboard/shortcut", { method: "POST", body: { shortcut } })
  }

  async capture(identity: WindowIdentity, caption: string): Promise<ScreenshotEvidence> {
    const [observed, focused] = await Promise.all([this.observe(), this.focused()])
    const target = observed.windows.find((window) => window.pid === identity.pid && window.windowId === identity.windowId)
    if (!target) throw new Error("target closed before screenshot")
    if (!focused.focused || focused.focused.pid !== identity.pid || focused.focused.windowId !== identity.windowId) {
      throw new Error("exact target is not focused before screenshot")
    }
    const result = await requestJson(this.screenApi, "/rect", {
      method: "POST",
      body: {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        detail: "medium",
        format: "json",
        restore: false,
        caption,
      },
    })
    if (typeof result.base64 !== "string") throw new Error("screenshot did not return base64 PNG")
    return { data: result.base64, mimeType: "image/png", width: target.width, height: target.height, caption }
  }

  sleep(ms: number) { return Bun.sleep(ms) }
  now() { return Date.now() }
}
