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
    const loaded = wait ? armLoadEvent(s, 8_000) : null
    await s.send("Page.navigate", { url })
    if (!wait) return { waitMs: 0 }
    await loaded!
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
    const loaded = wait ? armLoadEvent(s, 8_000) : null
    await s.send("Page.reload", { ignoreCache })
    if (!wait) return { waitMs: 0 }
    await loaded!
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
 * Subscribe NOW for the next Page.loadEventFired / Page.frameStoppedLoading and
 * return a promise. Caller subscribes *before* sending Page.reload/Page.navigate so
 * the event cannot fire between the command and the subscription — otherwise a fast
 * reload races past us and `Runtime.evaluate` issued downstream hangs because the
 * old context was already destroyed.
 *
 * After the event resolves we additionally wait for the new Runtime execution
 * context to be created. `Page.loadEventFired` arrives ~150 ms before the new
 * default isolated world is ready; the first `Runtime.evaluate` shot in that gap
 * silently disappears (no error, no answer — just hangs forever). Listening for
 * `Runtime.executionContextCreated` removes the race; a small timer is a fallback
 * for builds where the event arrives before our subscription.
 */
function armLoadEvent(s: CdpSession, timeoutMs: number): Promise<void> {
  const ws = (s as unknown as { ws: WebSocket }).ws
  return new Promise<void>((resolve) => {
    let loaded = false
    let contextReady = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = () => {
      if (timer) clearTimeout(timer)
      ws.removeEventListener("message", onMsg)
      resolve()
    }
    const maybeDone = () => {
      if (loaded && contextReady) settle()
    }
    timer = setTimeout(settle, timeoutMs)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(ev.data as string) as { method?: string }
        if (m.method === "Page.loadEventFired" || m.method === "Page.frameStoppedLoading") {
          loaded = true
          // Fallback: if the new context already arrived before we subscribed (or this
          // build does not surface executionContextCreated), give it 200 ms and move on.
          setTimeout(() => { contextReady = true; maybeDone() }, 200)
          maybeDone()
        } else if (m.method === "Runtime.executionContextCreated") {
          contextReady = true
          maybeDone()
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
    // Enable Runtime to receive executionContextCreated events. Fire-and-forget —
    // we don't await because we want the subscription armed before Page.reload.
    s.send("Runtime.enable").catch(() => {})
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
  /**
   * If true and `mode === "window"`, treat `width`/`height` as the desired **content
   * viewport** (`innerWidth`/`innerHeight`) rather than outer window bounds. The
   * service measures `window.innerWidth/innerHeight` after the first resize and
   * compensates for Chrome UI (tab bar + address bar) so the page sees exactly the
   * requested viewport. Ignored in `mode:"emulation"` (already sets viewport directly).
   */
  innerSize?: boolean
}

type WindowBounds = { left: number; top: number; width: number; height: number; windowState: string }
type WindowForTarget = { windowId: number; bounds: WindowBounds }

async function measureInner(s: CdpSession): Promise<{ width: number; height: number }> {
  const ev = await s.send<{ result: { value?: string } }>("Runtime.evaluate", {
    expression: "JSON.stringify({iw:innerWidth, ih:innerHeight})",
    returnByValue: true,
  })
  try {
    const p = JSON.parse((ev.result.value ?? "{}") as string) as { iw?: number; ih?: number }
    return { width: Math.round(p.iw ?? 0), height: Math.round(p.ih ?? 0) }
  } catch {
    return { width: 0, height: 0 }
  }
}

export async function cdpSetViewport(
  target: CdpTarget,
  override: ViewportOverride,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
): Promise<{
  applied: { width: number; height: number; deviceScaleFactor: number; mobile: boolean; mode: ViewportMode; innerSize: boolean }
  bounds?: { before: WindowBounds; after: WindowBounds }
  inner?: { width: number; height: number }
  reloaded: boolean
  ready?: WaitReadyResult
}> {
  // Default mode: physical window resize. Emulation override only when explicitly requested
  // or when mobile=true (need touch/meta-viewport emulation).
  const mode: ViewportMode = override.mode ?? (override.mobile ? "emulation" : "window")
  const innerSize = mode === "window" && override.innerSize === true
  const resizeResult = await withSession(target, async (s) => {
    let bounds: { before: WindowBounds; after: WindowBounds } | undefined
    let inner: { width: number; height: number } | undefined
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
      const targetW = Math.round(override.width)
      const targetH = Math.round(override.height)
      let outerW = targetW
      let outerH = targetH
      await s.send("Browser.setWindowBounds", { windowId: wfor.windowId, bounds: { width: outerW, height: outerH } })
      if (innerSize) {
        // Compensate Chrome UI overshoot: measure actual innerWidth/innerHeight and adjust
        // outer bounds. Two iterations are typically enough; bail out at zero delta.
        for (let i = 0; i < 3; i++) {
          const m = await measureInner(s)
          const dw = targetW - m.width
          const dh = targetH - m.height
          if (dw === 0 && dh === 0) { inner = m; break }
          outerW += dw
          outerH += dh
          await s.send("Browser.setWindowBounds", { windowId: wfor.windowId, bounds: { width: outerW, height: outerH } })
        }
      }
      if (!inner) inner = await measureInner(s)
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
      innerSize,
    }
    if (reload) {
      await s.send("Page.enable")
      const loaded = armLoadEvent(s, 8_000)
      await s.send("Page.reload", { ignoreCache: false })
      await loaded
    }
    return { applied, bounds, inner }
  })
  if (!wait) return { ...resizeResult, reloaded: reload }
  // Open the wait session AFTER the resize session is closed and Chrome has had a
  // moment to settle. Two concurrent CDP sessions to the same target plus an
  // immediate-after-close reconnection both produce a hang on the first evaluate
  // — empirically a ~700 ms gap is enough to keep readyState reliable.
  await new Promise((r) => setTimeout(r, reload ? 700 : 100))
  const ready = await cdpWaitReady(target, waitOpts)
  return { ...resizeResult, reloaded: reload, ready }
}

export async function cdpClearViewport(
  target: CdpTarget,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
): Promise<{ reloaded: boolean; ready?: WaitReadyResult }> {
  await withSession(target, async (s) => {
    // Only clears emulation override. Physical window resize is not auto-reverted —
    // call POST /viewport again with desired size, or use @meta/window /resize.
    await forceClearMetrics(s)
    if (reload) {
      await s.send("Page.enable")
      const loaded = armLoadEvent(s, 8_000)
      await s.send("Page.reload", { ignoreCache: false })
      await loaded
    }
  })
  if (!wait) return { reloaded: reload }
  // Fresh session for the readiness chain — see cdpSetViewport for rationale.
  const ready = await cdpWaitReady(target, waitOpts)
  return { reloaded: reload, ready }
}
