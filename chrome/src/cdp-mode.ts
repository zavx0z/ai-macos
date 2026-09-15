import { CdpHttp, withSession, type CdpSession, type CdpTarget } from "@meta/shared"
import {
  armReadiness,
  waitOnSession,
  type WaitReadyOptions,
  type WaitReadyResult,
} from "./wait-ready.ts"

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
  throw new CdpTargetSelectionError(
    `CDP target selection by URL is disabled: ${selector.url}; pass targetId from GET /cdp/targets`,
    409,
  )
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
    return await session.send(method, params, { timeoutMs: boundedTimeout })
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
  maxDimension?: number
  maxPixels?: number
  maxBytes?: number
  maxWidth?: number
  maxHeight?: number
  scale?: number
  clip?: { x: number; y: number; width: number; height: number }
}

export class CdpCaptureLimitError extends Error {
  constructor(
    message: string,
    readonly limit: "dimension" | "pixels" | "bytes",
  ) {
    super(message)
    this.name = "CdpCaptureLimitError"
  }
}

const DEFAULT_CAPTURE_MAX_DIMENSION = 16_384
const DEFAULT_CAPTURE_MAX_PIXELS = 32_000_000
const DEFAULT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024

export async function cdpCaptureScreenshot(
  target: CdpTarget,
  options: CdpScreenshotOptions = {},
  signal?: AbortSignal,
): Promise<{ data: string; contentType: string; width: number; height: number; bytes: number }> {
  return await withSession(target, async (session) => {
    await session.send("Page.enable")
    const format = options.format ?? "png"
    const maxDimension = Math.max(1, Math.round(options.maxDimension ?? DEFAULT_CAPTURE_MAX_DIMENSION))
    const maxWidth = Math.min(maxDimension, Math.max(1, Math.round(options.maxWidth ?? maxDimension)))
    const maxHeight = Math.min(maxDimension, Math.max(1, Math.round(options.maxHeight ?? maxDimension)))
    const maxPixels = Math.max(1, Math.round(options.maxPixels ?? DEFAULT_CAPTURE_MAX_PIXELS))
    const maxBytes = Math.max(1, Math.round(options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES))
    const params: Record<string, unknown> = {
      format,
      fromSurface: true,
      captureBeyondViewport: options.fullPage === true,
    }
    if (format !== "png" && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(Math.round(options.quality), 100))
    }
    const metrics = await session.send<{
      cssContentSize?: { x: number; y: number; width: number; height: number }
      contentSize?: { x: number; y: number; width: number; height: number }
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
      visualViewport?: { clientWidth: number; clientHeight: number }
    }>("Page.getLayoutMetrics")
    const fullSize = metrics.cssContentSize ?? metrics.contentSize
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    const selected = options.clip ?? (options.fullPage ? fullSize : viewport)
    if (!selected) throw new Error("CDP did not return measured capture dimensions")
    const sourceWidth = Math.max(1, Math.ceil("width" in selected ? selected.width : selected.clientWidth))
    const sourceHeight = Math.max(1, Math.ceil("height" in selected ? selected.height : selected.clientHeight))
    const scale = options.scale ?? 1
    const width = Math.max(1, Math.ceil(sourceWidth * scale))
    const height = Math.max(1, Math.ceil(sourceHeight * scale))
    assertCaptureDimensions(width, height, maxDimension, maxPixels)
    if (width > maxWidth || height > maxHeight) {
      throw new CdpCaptureLimitError(`CDP capture exceeds output extent: ${width}x${height}`, "dimension")
    }
    if (options.fullPage || options.clip || scale !== 1) {
      const origin = options.clip ?? fullSize ?? { x: 0, y: 0 }
      params.clip = {
        x: origin.x,
        y: origin.y,
        width: sourceWidth,
        height: sourceHeight,
        scale,
      }
    }
    const result = await session.send<{ data: string }>("Page.captureScreenshot", params)
    const bytes = decodedBase64Bytes(result.data)
    if (bytes > maxBytes) {
      throw new CdpCaptureLimitError(
        `CDP capture exceeds byte limit: ${bytes} > ${maxBytes}`,
        "bytes",
      )
    }
    return { data: result.data, contentType: `image/${format}`, width, height, bytes }
  }, {
    signal,
    maxIncomingMessageBytes: Math.ceil((options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES) * 4 / 3) + 64 * 1024,
  })
}

export function assertCaptureDimensions(
  width: number,
  height: number,
  maxDimension = DEFAULT_CAPTURE_MAX_DIMENSION,
  maxPixels = DEFAULT_CAPTURE_MAX_PIXELS,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CdpCaptureLimitError(`Invalid CDP capture dimensions: ${width}x${height}`, "dimension")
  }
  if (width > maxDimension || height > maxDimension) {
    throw new CdpCaptureLimitError(
      `CDP capture dimensions exceed limit: ${width}x${height}, maxDimension=${maxDimension}`,
      "dimension",
    )
  }
  if (width * height > maxPixels) {
    throw new CdpCaptureLimitError(
      `CDP capture pixel count exceeds limit: ${width * height} > ${maxPixels}`,
      "pixels",
    )
  }
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
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
    let resolveComplete!: (stream: string) => void
    let rejectComplete!: (error: Error) => void
    const complete = new Promise<string>((resolve, reject) => {
      resolveComplete = resolve
      rejectComplete = reject
    })
    const unsubscribe = session.subscribe<{ stream?: string }>("Tracing.tracingComplete", (params) => {
      const stream = params.stream
      if (stream) resolveComplete(stream)
      else rejectComplete(new Error("CDP trace completed without a stream"))
    })
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
      unsubscribe()
      if (started) await session.send("Tracing.end").catch(() => {})
    }
  })
}

export async function cdpEval(target: CdpTarget, js: string, signal?: AbortSignal): Promise<string> {
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
  }, { signal })
}

export async function cdpNavigate(
  target: CdpTarget,
  url: string,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  signal?: AbortSignal,
  onDispatched?: () => void,
): Promise<{ waitMs: number; ready?: WaitReadyResult }> {
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    const tracker = wait ? await armReadiness(s, waitOpts) : null
    try {
      const loaded = wait ? armLoadEvent(s, 8_000) : null
      await s.send("Page.navigate", { url })
      onDispatched?.()
      if (!wait) return { waitMs: 0 }
      await loaded!
      const ready = await waitOnSession(s, waitOpts, tracker)
      return { waitMs: Date.now() - t0, ready }
    } finally {
      tracker?.close()
    }
  }, { signal, commandTimeoutMs: Math.min(waitOpts.maxMs ?? 15_000, 30_000) })
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
  signal?: AbortSignal,
  limits: { maxEvents?: number; maxBytes?: number; onDrop?: () => void } = {},
): Promise<ConsoleEntry[]> {
  return await withSession(target, async (s) => {
    const entries: ConsoleEntry[] = []
    let serializedBytes = 2
    const push = (entry: ConsoleEntry) => {
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + (entries.length === 0 ? 0 : 1)
      if (entries.length >= (limits.maxEvents ?? 1_000) || serializedBytes + bytes > (limits.maxBytes ?? 1024 * 1024)) {
        limits.onDrop?.()
        return
      }
      entries.push(entry)
      serializedBytes += bytes
    }

    if (collectExisting) {
      // Enable Log domain to also catch network errors / browser warnings logged to console
      await s.send("Log.enable")
    }
    await s.send("Runtime.enable")

    const unsubscribeConsole = s.subscribe<{
      type?: string
      args?: { value?: unknown; description?: string }[]
      stackTrace?: { callFrames: { url: string; lineNumber: number }[] }
      timestamp?: number
    }>("Runtime.consoleAPICalled", (params) => {
          const argumentBudget = Math.max(64, Math.floor((limits.maxBytes ?? 1024 * 1024) / Math.max(1, params.args?.length ?? 1)))
          const args = (params.args ?? []).map(argument => materializeConsoleArgument(argument, argumentBudget))
          const frame = params.stackTrace?.callFrames?.[0]
          const rawType = String(params.type ?? "log")
          const lvl: ConsoleEntry["level"] =
            rawType === "warning" ? "warn"
            : rawType === "error" ? "error"
            : rawType === "info" ? "info"
            : rawType === "debug" ? "debug"
            : rawType === "verbose" ? "verbose"
            : "log"
          push({
            type: "console",
            level: lvl,
            text: args.join(" "),
            url: frame?.url,
            line: frame?.lineNumber,
            timestamp: params.timestamp ?? Date.now(),
          })
    })
    const unsubscribeLog = s.subscribe<{
      entry?: { source: string; level: string; text: string; url?: string; lineNumber?: number; timestamp?: number }
    }>("Log.entryAdded", (params) => {
          const e = params.entry
          if (!e) return
          push({
            type: e.source ?? "browser",
            level: (["error", "warning", "info", "verbose"].includes(e.level) ? (e.level === "warning" ? "warn" : e.level) : "log") as ConsoleEntry["level"],
            text: e.text,
            url: e.url,
            line: e.lineNumber,
            timestamp: e.timestamp ?? Date.now(),
          })
    })
    try {
      await new Promise((r) => setTimeout(r, durationMs))
    } finally {
      unsubscribeConsole()
      unsubscribeLog()
    }
    return entries
  }, {
    signal,
    maxIncomingMessageBytes: Math.min(8 * 1024 * 1024, (limits.maxBytes ?? 1024 * 1024) * 2 + 64 * 1024),
  })
}

export function materializeConsoleArgument(
  argument: { value?: unknown; description?: string },
  maxBytes: number,
): string {
  const value = argument.value !== undefined
    ? typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value)
    : argument.description ?? ""
  if (Buffer.byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

export async function cdpReload(
  target: CdpTarget,
  ignoreCache = false,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  signal?: AbortSignal,
  onDispatched?: () => void,
): Promise<{ waitMs: number; ready?: WaitReadyResult }> {
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    const tracker = wait ? await armReadiness(s, waitOpts) : null
    try {
      const loaded = wait ? armLoadEvent(s, 8_000) : null
      await s.send("Page.reload", { ignoreCache })
      onDispatched?.()
      if (!wait) return { waitMs: 0 }
      await loaded!
      const ready = await waitOnSession(s, waitOpts, tracker)
      return { waitMs: Date.now() - t0, ready }
    } finally {
      tracker?.close()
    }
  }, { signal, commandTimeoutMs: Math.min(waitOpts.maxMs ?? 15_000, 30_000) })
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
    const tracker = wait ? await armReadiness(session, waitOpts) : null
    try {
      const loaded = wait ? armLoadEvent(session, 8_000) : null
      await session.send("Page.navigateToHistoryEntry", { entryId: entry.id })
      if (!wait) return { navigated: true, waitMs: 0 }
      await loaded!
      const ready = await waitOnSession(session, waitOpts, tracker)
      return { navigated: true, waitMs: Date.now() - startedAt, ready }
    } finally {
      tracker?.close()
    }
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
  const controller = new AbortController()
  const eventOptions = { timeoutMs, signal: controller.signal }
  const loaded = Promise.any([
    s.waitForEvent("Page.loadEventFired", eventOptions),
    s.waitForEvent("Page.frameStoppedLoading", eventOptions),
  ])
  const contextReady = s.waitForEvent("Runtime.executionContextCreated", eventOptions)
  s.send("Runtime.enable", {}, { timeoutMs, signal: controller.signal }).catch(() => {})
  return (async () => {
    try {
      await loaded
      await Promise.race([
        contextReady,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ])
    } finally {
      controller.abort()
      await contextReady.catch(() => {})
    }
  })()
}

export async function cdpWaitReady(target: CdpTarget, waitOpts: WaitReadyOptions = {}, signal?: AbortSignal): Promise<WaitReadyResult> {
  return await withSession(target, async (s) => waitOnSession(s, waitOpts), {
    signal,
    commandTimeoutMs: Math.min(waitOpts.maxMs ?? 15_000, 30_000),
  })
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
