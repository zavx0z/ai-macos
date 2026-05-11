import { CdpHttp, withSession, type CdpSession, type CdpTarget } from "@meta/shared"
import { waitOnSession, type WaitReadyOptions, type WaitReadyResult } from "./wait-ready.ts"

const CDP_HOST = Bun.env.CHROME_CDP_HOST ?? "localhost"
const CDP_PORT = Number(Bun.env.CHROME_CDP_PORT ?? 9222)
const CHECK_TTL_MS = 5_000

const cdp = new CdpHttp(CDP_HOST, CDP_PORT)

let lastCheck = 0
let lastResult: { available: boolean; browser?: string; error?: string } = { available: false }

export async function detectCdp(force = false): Promise<typeof lastResult> {
  const now = Date.now()
  if (!force && now - lastCheck < CHECK_TTL_MS) return lastResult
  lastCheck = now
  try {
    const v = await cdp.version()
    lastResult = { available: true, browser: v.Browser }
  } catch (e) {
    lastResult = { available: false, error: e instanceof Error ? e.message : String(e) }
  }
  return lastResult
}

export async function isCdpAvailable(): Promise<boolean> {
  return (await detectCdp()).available
}

/**
 * Find a CDP target matching a tab from AppleScript listWindows.
 * Match by exact URL — most reliable cross-window.
 */
export async function findTargetByUrl(url: string): Promise<CdpTarget | null> {
  try {
    const targets = await cdp.list()
    return targets.find((t) => t.type === "page" && t.url === url) ?? null
  } catch {
    return null
  }
}

export async function cdpEval(target: CdpTarget, js: string): Promise<string> {
  return await withSession(target, async (s) => {
    const wrapped = `(function(){try{var __r=(function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`
    const result = await s.send<{
      result: { value?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "JS exception"
      throw new Error(msg)
    }
    return result.result.value ?? ""
  })
}

export async function cdpNavigate(
  target: CdpTarget,
  url: string,
  wait = true,
  waitOpts: WaitReadyOptions = {},
): Promise<{ waitMs: number; ready?: WaitReadyResult }> {
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    await s.send("Page.navigate", { url })
    if (!wait) return { waitMs: 0 }
    await waitForLoadEvent(s, 8_000)
    const ready = await waitOnSession(s, waitOpts)
    return { waitMs: Date.now() - t0, ready }
  })
}

export type ConsoleEntry = {
  type: string
  level: "log" | "info" | "warn" | "error" | "debug" | "verbose"
  text: string
  url?: string
  line?: number
  timestamp: number
}

export async function cdpConsoleListen(
  target: CdpTarget,
  durationMs: number,
  collectExisting = true,
): Promise<ConsoleEntry[]> {
  return await withSession(target, async (s) => {
    const entries: ConsoleEntry[] = []

    if (collectExisting) {
      // Enable Log domain to also catch network errors / browser warnings logged to console
      await s.send("Log.enable")
    }
    await s.send("Runtime.enable")

    // Listen via raw WebSocket events
    const ws = (s as unknown as { ws: WebSocket }).ws
    const handler = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(ev.data as string) as {
          method?: string
          params?: {
            type?: string
            args?: { value?: unknown; description?: string }[]
            stackTrace?: { callFrames: { url: string; lineNumber: number }[] }
            timestamp?: number
            entry?: { source: string; level: string; text: string; url?: string; lineNumber?: number; timestamp?: number }
          }
        }
        if (m.method === "Runtime.consoleAPICalled" && m.params) {
          const args = (m.params.args ?? []).map((a) => {
            if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value)
            return a.description ?? ""
          })
          const frame = m.params.stackTrace?.callFrames?.[0]
          const rawType = String(m.params.type ?? "log")
          // CDP типы: log, info, warning, error, debug, dir, ...
          const lvl: ConsoleEntry["level"] =
            rawType === "warning" ? "warn"
            : rawType === "error" ? "error"
            : rawType === "info" ? "info"
            : rawType === "debug" ? "debug"
            : rawType === "verbose" ? "verbose"
            : "log"
          entries.push({
            type: "console",
            level: lvl,
            text: args.join(" "),
            url: frame?.url,
            line: frame?.lineNumber,
            timestamp: m.params.timestamp ?? Date.now(),
          })
        } else if (m.method === "Log.entryAdded" && m.params?.entry) {
          const e = m.params.entry
          entries.push({
            type: e.source ?? "browser",
            level: (["error", "warning", "info", "verbose"].includes(e.level) ? (e.level === "warning" ? "warn" : e.level) : "log") as ConsoleEntry["level"],
            text: e.text,
            url: e.url,
            line: e.lineNumber,
            timestamp: e.timestamp ?? Date.now(),
          })
        }
      } catch {
        /* ignore parse errors */
      }
    }
    ws.addEventListener("message", handler)
    try {
      await new Promise((r) => setTimeout(r, durationMs))
    } finally {
      ws.removeEventListener("message", handler)
    }
    return entries
  })
}

export async function cdpReload(
  target: CdpTarget,
  ignoreCache = false,
  wait = true,
  waitOpts: WaitReadyOptions = {},
): Promise<{ waitMs: number; ready?: WaitReadyResult }> {
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    await s.send("Page.reload", { ignoreCache })
    if (!wait) return { waitMs: 0 }
    await waitForLoadEvent(s, 8_000)
    const ready = await waitOnSession(s, waitOpts)
    return { waitMs: Date.now() - t0, ready }
  })
}

/**
 * Triple-step viewport override reset. A single `clearDeviceMetricsOverride` is not
 * always sufficient — Chrome can resurrect a previously-applied override after
 * session teardown (observed when switching from mobile-emulation to window-mode
 * resize). The intermediate `setDeviceMetricsOverride({0,0,0,false})` writes a
 * neutral state that the final `clear` then wipes.
 */
async function forceClearMetrics(s: CdpSession): Promise<void> {
  await s.send("Emulation.clearDeviceMetricsOverride")
  await s.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false })
  await s.send("Emulation.clearDeviceMetricsOverride")
}

/**
 * Wait for Page.loadEventFired (or a short fallback timeout). After Page.reload /
 * Page.navigate, the old Runtime context is destroyed and Runtime.evaluate calls
 * issued before the new context is created can hang indefinitely. Listening for
 * loadEventFired makes downstream evaluates safe.
 */
async function waitForLoadEvent(s: CdpSession, timeoutMs: number): Promise<void> {
  const ws = (s as unknown as { ws: WebSocket }).ws
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", onMsg); resolve() }, timeoutMs)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(ev.data as string) as { method?: string }
        if (m.method === "Page.loadEventFired" || m.method === "Page.frameStoppedLoading") {
          clearTimeout(timer)
          ws.removeEventListener("message", onMsg)
          resolve()
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
  })
}

export async function cdpWaitReady(target: CdpTarget, waitOpts: WaitReadyOptions = {}): Promise<WaitReadyResult> {
  return await withSession(target, async (s) => waitOnSession(s, waitOpts))
}

export type ViewportMode = "window" | "emulation"

export type ViewportOverride = {
  width: number
  height: number
  deviceScaleFactor?: number
  mobile?: boolean
  mode?: ViewportMode
}

type WindowBounds = { left: number; top: number; width: number; height: number; windowState: string }
type WindowForTarget = { windowId: number; bounds: WindowBounds }

export async function cdpSetViewport(
  target: CdpTarget,
  override: ViewportOverride,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
): Promise<{
  applied: { width: number; height: number; deviceScaleFactor: number; mobile: boolean; mode: ViewportMode }
  bounds?: { before: WindowBounds; after: WindowBounds }
  reloaded: boolean
  ready?: WaitReadyResult
}> {
  // Default mode: physical window resize. Emulation override only when explicitly requested
  // or when mobile=true (need touch/meta-viewport emulation).
  const mode: ViewportMode = override.mode ?? (override.mobile ? "emulation" : "window")
  return await withSession(target, async (s) => {
    let bounds: { before: WindowBounds; after: WindowBounds } | undefined
    if (mode === "window") {
      // Drop any leftover emulation override from a previous mobile-emulation call —
      // otherwise the page keeps the old virtual viewport regardless of physical resize.
      // A bare clearDeviceMetricsOverride can be silently restored by Chrome between
      // sessions; the triple-step (clear → set zeros → clear) reliably wipes it.
      await forceClearMetrics(s)
      const wfor = await s.send<WindowForTarget>("Browser.getWindowForTarget", { targetId: target.id })
      const before = wfor.bounds
      // setWindowBounds rejects width/height changes while window is maximized/minimized.
      if (before.windowState !== "normal") {
        await s.send("Browser.setWindowBounds", { windowId: wfor.windowId, bounds: { windowState: "normal" } })
      }
      await s.send("Browser.setWindowBounds", {
        windowId: wfor.windowId,
        bounds: { width: Math.round(override.width), height: Math.round(override.height) },
      })
      const fresh = await s.send<WindowForTarget>("Browser.getWindowForTarget", { targetId: target.id })
      bounds = { before, after: fresh.bounds }
    } else {
      await s.send("Emulation.setDeviceMetricsOverride", {
        width: Math.round(override.width),
        height: Math.round(override.height),
        deviceScaleFactor: override.deviceScaleFactor ?? 1,
        mobile: override.mobile ?? false,
      })
    }
    const applied = {
      width: Math.round(override.width),
      height: Math.round(override.height),
      deviceScaleFactor: override.deviceScaleFactor ?? 1,
      mobile: override.mobile ?? false,
      mode,
    }
    if (reload) {
      await s.send("Page.enable")
      await s.send("Page.reload", { ignoreCache: false })
      await waitForLoadEvent(s, 8_000)
    }
    if (!wait) return { applied, bounds, reloaded: reload }
    const ready = await waitOnSession(s, waitOpts)
    return { applied, bounds, reloaded: reload, ready }
  })
}

export async function cdpClearViewport(
  target: CdpTarget,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
): Promise<{ reloaded: boolean; ready?: WaitReadyResult }> {
  return await withSession(target, async (s) => {
    // Only clears emulation override. Physical window resize is not auto-reverted —
    // call POST /viewport again with desired size, or use @meta/window /resize.
    await forceClearMetrics(s)
    if (reload) {
      await s.send("Page.enable")
      await s.send("Page.reload", { ignoreCache: false })
      await waitForLoadEvent(s, 8_000)
    }
    if (!wait) return { reloaded: reload }
    const ready = await waitOnSession(s, waitOpts)
    return { reloaded: reload, ready }
  })
}
