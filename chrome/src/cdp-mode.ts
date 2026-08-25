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

export type CdpTargetSummary = Omit<CdpTarget, "id" | "webSocketDebuggerUrl"> & {
  targetId: string
}

export class CdpTargetSelectionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 503,
  ) {
    super(message)
    this.name = "CdpTargetSelectionError"
  }
}

export function summarizeCdpTarget(target: CdpTarget): CdpTargetSummary {
  return {
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.faviconUrl === undefined ? {} : { faviconUrl: target.faviconUrl }),
  }
}

export function selectCdpTarget(
  targets: readonly CdpTarget[],
  selector: { targetId?: string; url?: string },
): CdpTarget | null {
  if (selector.targetId) {
    const target = targets.find((candidate) => candidate.id === selector.targetId)
    if (!target) {
      throw new CdpTargetSelectionError(`CDP target not found: ${selector.targetId}`, 404)
    }
    return target
  }
  if (!selector.url) return null
  const matches = targets.filter((target) => target.type === "page" && target.url === selector.url)
  if (matches.length > 1) {
    throw new CdpTargetSelectionError(
      `CDP target is ambiguous for URL: ${selector.url}; pass targetId from GET /cdp/targets`,
      409,
    )
  }
  return matches[0] ?? null
}

async function cdpTargets(): Promise<CdpTarget[]> {
  try {
    return await cdp.list()
  } catch (error) {
    throw new CdpTargetSelectionError(
      `CDP unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
    )
  }
}

export async function listCdpTargets(type: string | null = "page"): Promise<CdpTargetSummary[]> {
  const targets = await cdpTargets()
  return targets
    .filter((target) => type === null || target.type === type)
    .map(summarizeCdpTarget)
}

export async function findTargetById(targetId: string): Promise<CdpTarget> {
  return selectCdpTarget(await cdpTargets(), { targetId })!
}

export async function newCdpTarget(url = "about:blank"): Promise<CdpTargetSummary> {
  try {
    return summarizeCdpTarget(await cdp.newTab(url))
  } catch (error) {
    throw new CdpTargetSelectionError(
      `Could not create CDP target: ${error instanceof Error ? error.message : String(error)}`,
      503,
    )
  }
}

export async function activateCdpTarget(targetId: string): Promise<void> {
  await findTargetById(targetId)
  await cdp.activateTab(targetId)
}

export async function closeCdpTarget(targetId: string): Promise<void> {
  await findTargetById(targetId)
  await cdp.closeTab(targetId)
}

/** URL matching exists only for the AppleScript fallback surface. Agent workflows use targetId. */
export async function findTargetByUrl(url: string): Promise<CdpTarget | null> {
  return selectCdpTarget(await cdpTargets(), { url })
}

export async function cdpCommand(
  target: CdpTarget,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) {
    throw new Error(`Invalid CDP method: ${method}`)
  }
  const boundedTimeout = Math.max(100, Math.min(Math.round(timeoutMs), 30_000))
  return await withSession(target, async (session) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        session.send(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`CDP ${method} timed out after ${boundedTimeout}ms`)), boundedTimeout)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
}

export type CdpPerformanceSnapshot = {
  targetId: string
  capturedAt: string
  metrics: Record<string, number>
  domCounters: { documents: number; nodes: number; jsEventListeners: number } | null
  page: {
    url: string
    title: string
    visibilityState: string
    devicePixelRatio: number
    viewport: { width: number; height: number }
  } | null
}

export async function cdpPerformanceSnapshot(target: CdpTarget): Promise<CdpPerformanceSnapshot> {
  return await withSession(target, async (session) => {
    await session.send("Performance.enable")
    const raw = await session.send<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics")
    const domCounters = await session.send<{ documents: number; nodes: number; jsEventListeners: number }>(
      "Memory.getDOMCounters",
    ).catch(() => null)
    const evaluated = await session.send<{
      result: { value?: CdpPerformanceSnapshot["page"] }
    }>("Runtime.evaluate", {
      expression: `({
        url: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        devicePixelRatio,
        viewport: {width: innerWidth, height: innerHeight}
      })`,
      returnByValue: true,
    }).catch(() => null)
    return {
      targetId: target.id,
      capturedAt: new Date().toISOString(),
      metrics: Object.fromEntries(raw.metrics.map((metric) => [metric.name, metric.value])),
      domCounters,
      page: evaluated?.result.value ?? null,
    }
  })
}

export type CdpScreenshotOptions = {
  format?: "png" | "jpeg" | "webp"
  quality?: number
  fullPage?: boolean
}

export async function cdpCaptureScreenshot(
  target: CdpTarget,
  options: CdpScreenshotOptions = {},
): Promise<{ data: string; contentType: string }> {
  return await withSession(target, async (session) => {
    await session.send("Page.enable")
    const format = options.format ?? "png"
    const params: Record<string, unknown> = {
      format,
      fromSurface: true,
      captureBeyondViewport: options.fullPage === true,
    }
    if (format !== "png" && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(Math.round(options.quality), 100))
    }
    if (options.fullPage) {
      const metrics = await session.send<{
        cssContentSize?: { x: number; y: number; width: number; height: number }
        contentSize?: { x: number; y: number; width: number; height: number }
      }>("Page.getLayoutMetrics")
      const size = metrics.cssContentSize ?? metrics.contentSize
      if (size) {
        params.clip = {
          x: size.x,
          y: size.y,
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
          scale: 1,
        }
      }
    }
    const result = await session.send<{ data: string }>("Page.captureScreenshot", params)
    return { data: result.data, contentType: `image/${format}` }
  })
}

export type CdpTraceOptions = {
  durationMs?: number
  categories?: string[]
  maxBytes?: number
}

export type CdpTraceResult = {
  targetId: string
  durationMs: number
  categories: string[]
  bytes: number
  data: string
}

const DEFAULT_TRACE_CATEGORIES = ["*"]

export async function cdpTrace(target: CdpTarget, options: CdpTraceOptions = {}): Promise<CdpTraceResult> {
  const durationMs = Math.max(100, Math.min(Math.round(options.durationMs ?? 1_000), 30_000))
  const categories = (options.categories?.length ? options.categories : DEFAULT_TRACE_CATEGORIES)
    .map((category) => category.trim())
    .filter(Boolean)
    .slice(0, 64)
  const maxBytes = Math.max(1_000_000, Math.min(Math.round(options.maxBytes ?? 50_000_000), 100_000_000))

  const browser = await cdp.version().catch((error) => {
    throw new CdpTargetSelectionError(
      `CDP browser endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
    )
  })
  if (!browser.webSocketDebuggerUrl) {
    throw new CdpTargetSelectionError("CDP browser WebSocket endpoint is unavailable", 503)
  }
  const tracingTarget: CdpTarget = {
    ...target,
    webSocketDebuggerUrl: browser.webSocketDebuggerUrl,
  }

  return await withSession(tracingTarget, async (session) => {
    const ws = (session as unknown as { ws: WebSocket }).ws
    let resolveComplete!: (stream: string) => void
    let rejectComplete!: (error: Error) => void
    const complete = new Promise<string>((resolve, reject) => {
      resolveComplete = resolve
      rejectComplete = reject
    })
    const onMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          method?: string
          params?: { stream?: string }
        }
        if (message.method !== "Tracing.tracingComplete") return
        const stream = message.params?.stream
        if (stream) resolveComplete(stream)
        else rejectComplete(new Error("CDP trace completed without a stream"))
      } catch {}
    }
    ws.addEventListener("message", onMessage)
    let started = false
    try {
      await session.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: {
          recordMode: "recordContinuously",
          includedCategories: categories,
        },
      })
      started = true
      await new Promise((resolve) => setTimeout(resolve, durationMs))
      let completionTimer: ReturnType<typeof setTimeout> | null = null
      const streamPromise = Promise.race([
        complete,
        new Promise<never>((_, reject) => {
          completionTimer = setTimeout(() => reject(new Error("CDP trace completion timed out")), 10_000)
        }),
      ]).finally(() => {
        if (completionTimer) clearTimeout(completionTimer)
      })
      await session.send("Tracing.end")
      started = false
      const stream = await streamPromise
      const chunks: string[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await session.send<{ data: string; base64Encoded?: boolean; eof?: boolean }>("IO.read", {
            handle: stream,
            size: 1_000_000,
          })
          const text = chunk.base64Encoded
            ? Buffer.from(chunk.data, "base64").toString("utf8")
            : chunk.data
          bytes += Buffer.byteLength(text)
          if (bytes > maxBytes) throw new Error(`CDP trace exceeds maxBytes=${maxBytes}`)
          chunks.push(text)
          if (chunk.eof) break
        }
      } finally {
        await session.send("IO.close", { handle: stream }).catch(() => {})
      }
      return { targetId: target.id, durationMs, categories, bytes, data: chunks.join("") }
    } finally {
      ws.removeEventListener("message", onMessage)
      if (started) await session.send("Tracing.end").catch(() => {})
    }
  })
}

export async function cdpEval(target: CdpTarget, js: string): Promise<string> {
  return await withSession(target, async (s) => {
    const wrapped = `(async function(){try{var __r=await (async function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`
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

export async function cdpHistory(
  target: CdpTarget,
  direction: -1 | 1,
  wait = true,
  waitOpts: WaitReadyOptions = {},
): Promise<{ navigated: boolean; waitMs: number; ready?: WaitReadyResult }> {
  return await withSession(target, async (session) => {
    await session.send("Page.enable")
    const history = await session.send<{
      currentIndex: number
      entries: Array<{ id: number }>
    }>("Page.getNavigationHistory")
    const entry = history.entries[history.currentIndex + direction]
    if (!entry) return { navigated: false, waitMs: 0 }
    const startedAt = Date.now()
    await session.send("Page.navigateToHistoryEntry", { entryId: entry.id })
    if (!wait) return { navigated: true, waitMs: 0 }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const ready = await waitOnSession(session, waitOpts)
    return { navigated: true, waitMs: Date.now() - startedAt, ready }
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
