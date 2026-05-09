import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "bun"
import { logCaption } from "@meta/shared"
import { CdpHttp, withSession, type CdpTarget } from "./cdp.ts"
import { adbForward, DEFAULT_DEBUG_PORT } from "./adb.ts"

const cdp = new CdpHttp("localhost", DEFAULT_DEBUG_PORT)

export type TabInfo = {
  id: string
  title: string
  url: string
  type: string
}

export async function ensureForward(): Promise<void> {
  await adbForward(DEFAULT_DEBUG_PORT)
}

export async function listTabs(): Promise<TabInfo[]> {
  const targets = await cdp.list()
  return targets
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type }))
}

export async function getActiveTab(): Promise<TabInfo | null> {
  const tabs = await listTabs()
  return tabs[0] ?? null
}

async function getTarget(id?: string): Promise<CdpTarget> {
  const targets = (await cdp.list()).filter((t) => t.type === "page")
  if (targets.length === 0) throw new Error("no Chrome tabs on Android device")
  if (id == null) return targets[0]!
  const t = targets.find((x) => x.id === id)
  if (!t) throw new Error(`tab not found: id=${id}`)
  return t
}

export async function newTab(url = "about:blank"): Promise<TabInfo> {
  const t = await cdp.newTab(url)
  return { id: t.id, title: t.title, url: t.url, type: t.type }
}

export async function closeTab(id: string): Promise<void> {
  await cdp.closeTab(id)
}

export async function activateTab(id: string): Promise<void> {
  await cdp.activateTab(id)
}

export async function navigate(url: string, tabId?: string): Promise<void> {
  const target = await getTarget(tabId)
  await withSession(target, async (s) => {
    await s.send("Page.navigate", { url })
  })
}

export async function reload(tabId?: string, wait = true, ignoreCache = false): Promise<number> {
  const target = await getTarget(tabId)
  return await withSession(target, async (s) => {
    await s.send("Page.enable")
    const t0 = Date.now()
    await s.send("Page.reload", { ignoreCache })
    if (!wait) return 0
    return await waitForLoad(s, 10_000) || (Date.now() - t0)
  })
}

async function waitForLoad(
  s: import("./cdp.ts").CdpSession,
  timeoutMs: number,
): Promise<number> {
  const t0 = Date.now()
  // brief delay so reload registers
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
}

export async function evalJs(js: string, tabId?: string): Promise<string> {
  const target = await getTarget(tabId)
  return await withSession(target, async (s) => {
    const wrapped = `(function(){try{var __r=(function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`
    const result = await s.send<{ result: { value?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression: wrapped,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "JS exception"
      throw new Error(msg)
    }
    return result.result.value ?? ""
  })
}

export async function getSource(tabId?: string): Promise<string> {
  return await evalJs("return document.documentElement.outerHTML;", tabId)
}

export async function getText(tabId?: string): Promise<string> {
  return await evalJs("return document.body && document.body.innerText || '';", tabId)
}

export type ScreenshotOptions = {
  tabId?: string
  detail?: string
  scale?: number
  caption?: string
  format?: "png" | "json"
  fullPage?: boolean
}

export type ScreenshotResult = {
  status: number
  contentType: string
  body: ArrayBuffer
  caption?: string
  base64?: string
}

export async function screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  if (opts.caption) logCaption(opts.caption)
  const target = await getTarget(opts.tabId)
  await cdp.activateTab(target.id)

  const buf = await withSession(target, async (s) => {
    await s.send("Page.enable")
    const params: Record<string, unknown> = { format: "png" }
    if (opts.fullPage) params.captureBeyondViewport = true
    const result = await s.send<{ data: string }>("Page.captureScreenshot", params)
    return Buffer.from(result.data, "base64")
  })

  let arr: ArrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const scale = resolveScale(opts.detail, opts.scale)
  if (scale < 1) arr = await downscalePng(arr, scale)

  if (opts.format === "json") {
    return {
      status: 200,
      contentType: "application/json",
      body: arr,
      caption: opts.caption,
      base64: Buffer.from(arr).toString("base64"),
    }
  }

  return {
    status: 200,
    contentType: "image/png",
    body: arr,
    caption: opts.caption,
  }
}

const DETAIL_SCALE: Record<string, number> = { low: 0.25, medium: 0.5, high: 0.75, full: 1.0 }

function resolveScale(detail?: string, scale?: number): number {
  if (detail && detail in DETAIL_SCALE) return DETAIL_SCALE[detail]!
  if (scale !== undefined && scale > 0 && scale <= 1) return scale
  return 1.0
}

async function downscalePng(buf: ArrayBuffer, scale: number): Promise<ArrayBuffer> {
  const dir = await mkdtemp(join(tmpdir(), "meta-android-"))
  const path = join(dir, "shot.png")
  try {
    await Bun.write(path, buf)
    const info = spawn(["sips", "-g", "pixelWidth", path], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(info.stdout).text()
    await info.exited
    const match = out.match(/pixelWidth:\s+(\d+)/)
    if (match) {
      const w = Math.max(1, Math.round(parseInt(match[1]!) * scale))
      const sips = spawn(["sips", "--resampleWidth", String(w), "--out", path, path], { stdout: "pipe", stderr: "pipe" })
      await sips.exited
    }
    const data = await readFile(path)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
