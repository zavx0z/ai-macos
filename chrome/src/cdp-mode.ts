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
