import { mkdtemp, readFile, rm } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "bun"
import { logCaption } from "@meta/shared"
import { CdpHttp, withSession, type CdpTarget } from "./cdp.ts"
import { adbForward, adbOpenUrl, DEFAULT_DEBUG_PORT } from "./adb.ts"

const cdp = new CdpHttp("localhost", DEFAULT_DEBUG_PORT)

export type TabInfo = {
  id: string
  title: string
  url: string
  type: string
}

export type AndroidTargetCreationDeps = {
  listTargets(): Promise<CdpTarget[]>
  openUrl(serial: string, url: string): Promise<void>
  delay(ms: number): Promise<void>
  now(): number
}

export async function ensureForward(serial: string): Promise<void> {
  await adbForward(DEFAULT_DEBUG_PORT, serial)
}

export async function listTabs(): Promise<TabInfo[]> {
  const targets = await cdp.list()
  return targets
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type }))
}

async function getTarget(id: string): Promise<CdpTarget> {
  const targets = (await cdp.list()).filter((t) => t.type === "page")
  const t = targets.find((x) => x.id === id)
  if (!t) throw new Error(`tab not found: id=${id}`)
  return t
}

export async function newTab(
  serial: string,
  url = "about:blank",
  deps: AndroidTargetCreationDeps = {
    listTargets: () => cdp.list(),
    openUrl: adbOpenUrl,
    delay: Bun.sleep,
    now: Date.now,
  },
  timeoutMs = 5_000,
): Promise<TabInfo> {
  const before = new Set(
    (await deps.listTargets())
      .filter((target) => target.type === "page")
      .map((target) => target.id),
  )
  await deps.openUrl(serial, url)
  const deadline = deps.now() + Math.max(100, Math.min(timeoutMs, 10_000))
  while (deps.now() < deadline) {
    const created = selectCreatedTarget(before, await deps.listTargets())
    if (created) return { id: created.id, title: created.title, url: created.url, type: created.type }
    await deps.delay(50)
  }
  throw new Error(`Android target creation timed out for serial=${serial}`)
}

export function selectCreatedTarget(
  previousTargetIds: ReadonlySet<string>,
  currentTargets: readonly CdpTarget[],
): CdpTarget | null {
  const created = currentTargets.filter(
    (target) => target.type === "page" && !previousTargetIds.has(target.id),
  )
  if (created.length > 1) {
    throw new Error(`Android target creation is ambiguous: ${created.map((target) => target.id).join(", ")}`)
  }
  return created[0] ?? null
}

export async function closeTab(id: string): Promise<void> {
  await cdp.closeTab(id)
}

export async function activateTab(id: string): Promise<void> {
  await cdp.activateTab(id)
}

export async function navigate(url: string, tabId: string): Promise<void> {
  const target = await getTarget(tabId)
  await withSession(target, async (s) => {
    await s.send("Page.navigate", { url })
  })
}

export async function reload(tabId: string, wait = true, ignoreCache = false): Promise<number> {
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

export async function evalJs(js: string, tabId: string): Promise<string> {
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

export async function getSource(tabId: string): Promise<string> {
  return await evalJs("return document.documentElement.outerHTML;", tabId)
}

export async function getText(tabId: string): Promise<string> {
  return await evalJs("return document.body && document.body.innerText || '';", tabId)
}

export function getLocalIp(): string | null {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address
    }
  }
  return null
}

export async function openDev(opts: { port: number; tabId: string; path?: string }): Promise<{ url: string; tab: TabInfo }> {
  const ip = getLocalIp()
  if (!ip) throw new Error("локальный IPv4-адрес не найден")
  const url = `http://${ip}:${opts.port}${opts.path ?? "/"}`
  await navigate(url, opts.tabId)
  const tabs = await listTabs()
  const tab = tabs.find((candidate) => candidate.id === opts.tabId)
  if (!tab) throw new Error(`tab disappeared after navigation: id=${opts.tabId}`)
  return { url, tab }
}

export type ScreenshotOptions = {
  tabId: string
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
  measured: { width: number; height: number; fullPage: boolean }
}

const CAPTURE_MAX_DIMENSION = 16_384
const CAPTURE_MAX_PIXELS = 32_000_000
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024

export async function screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  if (opts.caption) logCaption(opts.caption)
  const target = await getTarget(opts.tabId)
  await cdp.activateTab(target.id)

  const buf = await withSession(target, async (s) => {
    await s.send("Page.enable")
    const params: Record<string, unknown> = { format: "png" }
    const metrics = await s.send<{
      cssContentSize?: { x: number; y: number; width: number; height: number }
      contentSize?: { x: number; y: number; width: number; height: number }
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
      visualViewport?: { clientWidth: number; clientHeight: number }
    }>("Page.getLayoutMetrics")
    const size = opts.fullPage
      ? metrics.cssContentSize ?? metrics.contentSize
      : metrics.cssVisualViewport ?? metrics.visualViewport
    if (!size) throw new Error("Android Chrome did not return measured capture dimensions")
    const width = Math.max(1, Math.ceil("width" in size ? size.width : size.clientWidth))
    const height = Math.max(1, Math.ceil("height" in size ? size.height : size.clientHeight))
    assertAndroidCaptureDimensions(width, height)
    if (opts.fullPage) {
      params.captureBeyondViewport = true
      params.clip = {
        x: "x" in size ? size.x : 0,
        y: "y" in size ? size.y : 0,
        width,
        height,
        scale: 1,
      }
    }
    const result = await s.send<{ data: string }>("Page.captureScreenshot", params)
    const bytes = decodedBase64Bytes(result.data)
    if (bytes > CAPTURE_MAX_BYTES) {
      throw new Error(`Android capture exceeds byte limit: ${bytes} > ${CAPTURE_MAX_BYTES}`)
    }
    return {
      buffer: Buffer.from(result.data, "base64"),
      measured: { width, height, fullPage: opts.fullPage === true },
    }
  })

  let arr: ArrayBuffer = buf.buffer.buffer.slice(
    buf.buffer.byteOffset,
    buf.buffer.byteOffset + buf.buffer.byteLength,
  ) as ArrayBuffer
  const scale = resolveScale(opts.detail, opts.scale)
  if (scale < 1) arr = await downscalePng(arr, scale)

  if (opts.format === "json") {
    return {
      status: 200,
      contentType: "application/json",
      body: arr,
      caption: opts.caption,
      base64: Buffer.from(arr).toString("base64"),
      measured: buf.measured,
    }
  }

  return {
    status: 200,
    contentType: "image/png",
    body: arr,
    caption: opts.caption,
    measured: buf.measured,
  }
}

export function assertAndroidCaptureDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid Android capture dimensions: ${width}x${height}`)
  }
  if (width > CAPTURE_MAX_DIMENSION || height > CAPTURE_MAX_DIMENSION) {
    throw new Error(`Android capture dimensions exceed limit: ${width}x${height}`)
  }
  if (width * height > CAPTURE_MAX_PIXELS) {
    throw new Error(`Android capture pixel count exceeds limit: ${width * height} > ${CAPTURE_MAX_PIXELS}`)
  }
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
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
