import { CdpHttp, withSession, type CdpTarget } from "@meta/shared"

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

export async function cdpNavigate(target: CdpTarget, url: string): Promise<void> {
  await withSession(target, async (s) => {
    await s.send("Page.navigate", { url })
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

export async function cdpReload(target: CdpTarget, ignoreCache = false, wait = true, timeoutMs = 10_000): Promise<number> {
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    await s.send("Page.reload", { ignoreCache })
    if (!wait) return 0
    await new Promise((r) => setTimeout(r, 150))
    while (Date.now() - t0 < timeoutMs) {
      const result = await s.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      })
      if (result.result.value === "complete") return Date.now() - t0
      await new Promise((r) => setTimeout(r, 200))
    }
    return Date.now() - t0
  })
}
