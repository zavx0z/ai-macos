import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { logCaption, osa, quote } from "@meta/shared";

export type TabInfo = {
  id: number;
  index: number;
  title: string;
  url: string;
  loading: boolean;
};

export type WindowInfo = {
  id: number;
  index: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  activeTabIndex: number;
  mode: string;
  tabs: TabInfo[];
};

const FS = String.fromCharCode(31)
const RS = String.fromCharCode(30)
const TS = String.fromCharCode(29)

const LIST_SCRIPT = `
set fs to (ASCII character 31)
set rs to (ASCII character 30)
set ts to (ASCII character 29)
set out to ""
if application "Google Chrome" is not running then return ""
tell application "Google Chrome"
  set winList to every window
  set wIdx to 0
  repeat with w in winList
    set wIdx to wIdx + 1
    try
      set wId to id of w
    on error
      set wId to 0
    end try
    try
      set wTitle to title of w
    on error
      set wTitle to ""
    end try
    try
      set {wx, wy, wx2, wy2} to bounds of w
    on error
      set wx to 0
      set wy to 0
      set wx2 to 0
      set wy2 to 0
    end try
    try
      set wActive to active tab index of w
    on error
      set wActive to 0
    end try
    try
      set wMode to mode of w
    on error
      set wMode to ""
    end try
    set out to out & wId & fs & wIdx & fs & wTitle & fs & wx & fs & wy & fs & (wx2 - wx) & fs & (wy2 - wy) & fs & wActive & fs & wMode
    set tabList to every tab of w
    set tIdx to 0
    repeat with t in tabList
      set tIdx to tIdx + 1
      try
        set tId to id of t
      on error
        set tId to 0
      end try
      try
        set tTitle to title of t
      on error
        set tTitle to ""
      end try
      try
        set tUrl to URL of t
      on error
        set tUrl to ""
      end try
      try
        set tLoading to loading of t
      on error
        set tLoading to false
      end try
      set out to out & ts & tId & fs & tIdx & fs & tTitle & fs & tUrl & fs & tLoading
    end repeat
    set out to out & rs
  end repeat
end tell
return out
`

export async function listWindows(): Promise<WindowInfo[]> {
  const raw = await osa(LIST_SCRIPT)
  if (!raw) return []
  return raw
    .split(RS)
    .filter((r) => r.length > 0)
    .map(parseWindowRecord)
}

function parseWindowRecord(rec: string): WindowInfo {
  const parts = rec.split(TS)
  const head = parts[0] ?? ""
  const [id, index, title, x, y, width, height, activeTabIndex, mode] = head.split(FS)
  const tabs: TabInfo[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i] ?? ""
    if (!p) continue
    const [tId, tIdx, tTitle, tUrl, tLoading] = p.split(FS)
    tabs.push({
      id: Number(tId ?? 0),
      index: Number(tIdx ?? 0),
      title: tTitle ?? "",
      url: tUrl ?? "",
      loading: (tLoading ?? "false") === "true",
    })
  }
  return {
    id: Number(id ?? 0),
    index: Number(index ?? 0),
    title: title ?? "",
    x: Number(x ?? 0),
    y: Number(y ?? 0),
    width: Number(width ?? 0),
    height: Number(height ?? 0),
    activeTabIndex: Number(activeTabIndex ?? 0),
    mode: mode ?? "",
    tabs,
  }
}

export async function getActiveTab(): Promise<TabInfo & { windowId: number } | null> {
  const wins = await listWindows()
  if (wins.length === 0) return null
  const w = wins[0]!
  const tab = w.tabs.find((t) => t.index === w.activeTabIndex) ?? w.tabs[0]
  if (!tab) return null
  return {...tab, windowId: w.id}
}

function windowRef(windowId?: number): string {
  return windowId == null ? "front window" : `window id ${windowId}`
}

function tabRef(windowId?: number, tabIndex?: number): string {
  if (tabIndex == null) return `active tab of ${windowRef(windowId)}`
  return `tab ${tabIndex} of ${windowRef(windowId)}`
}

export type NewWindowOptions = {
  url?: string;
  incognito?: boolean;
};

export async function newWindow(options: NewWindowOptions = {}): Promise<{ id: number }> {
  const props: string[] = []
  if (options.incognito) props.push(`mode:"incognito"`)
  const propsExpr = props.length ? ` with properties {${props.join(", ")}}` : ""
  const script = `
    tell application "Google Chrome"
      activate
      set w to make new window${propsExpr}
      ${options.url ? `set URL of active tab of w to ${quote(options.url)}` : ""}
      return id of w
    end tell
  `
  const out = await osa(script)
  return {id: Number(out)}
}

export async function closeWindow(windowId: number): Promise<void> {
  await osa(`tell application "Google Chrome" to close window id ${windowId}`)
}

export type NewTabOptions = {
  windowId?: number;
  url?: string;
};

export async function newTab(options: NewTabOptions = {}): Promise<{ id: number; index: number }> {
  const target = windowRef(options.windowId)
  const propsExpr = options.url ? ` with properties {URL:${quote(options.url)}}` : ""
  const script = `
    tell application "Google Chrome"
      activate
      tell ${target}
        set t to make new tab at end of tabs${propsExpr}
        set tIdx to count of tabs
        return (id of t as string) & "|" & tIdx
      end tell
    end tell
  `
  const out = await osa(script)
  const [id, idx] = out.split("|")
  return {id: Number(id ?? 0), index: Number(idx ?? 0)}
}

export async function closeTab(windowId: number, tabIndex: number): Promise<void> {
  await osa(
    `tell application "Google Chrome" to close tab ${tabIndex} of window id ${windowId}`,
  )
}

export async function activateTab(windowId: number, tabIndex: number): Promise<void> {
  await osa(`tell application "Google Chrome"
    set active tab index of window id ${windowId} to ${tabIndex}
    set index of window id ${windowId} to 1
  end tell`)
}

export async function navigate(
  url: string,
  windowId?: number,
  tabIndex?: number,
): Promise<void> {
  await osa(
    `tell application "Google Chrome" to set URL of ${tabRef(windowId, tabIndex)} to ${quote(url)}`,
  )
}

export async function reload(windowId?: number, tabIndex?: number, wait = true): Promise<number> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to reload`)
  if (wait) return await waitForTabLoad(windowId, tabIndex)
  return 0
}

export async function hardReload(windowId?: number, tabIndex?: number, wait = true): Promise<number> {
  if (windowId != null) {
    await osa(`tell application "Google Chrome" to set index of window id ${windowId} to 1`)
  }
  if (tabIndex != null) {
    const target = windowId != null ? `window id ${windowId}` : "front window"
    await osa(`tell application "Google Chrome" to set active tab index of ${target} to ${tabIndex}`)
  }
  await osa(`
    tell application "Google Chrome" to activate
    delay 0.05
    tell application "System Events" to tell process "Google Chrome"
      key code 15 using {command down, shift down}
    end tell
  `)
  if (wait) return await waitForTabLoad(windowId, tabIndex)
  return 0
}

async function waitForTabLoad(windowId?: number, tabIndex?: number, timeoutMs = 10_000): Promise<number> {
  const t0 = Date.now()
  // brief initial delay so loading=true has time to register
  await new Promise((r) => setTimeout(r, 150))
  while (Date.now() - t0 < timeoutMs) {
    const out = await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to return loading`).catch(() => "false")
    if (out.trim() === "false") return Date.now() - t0
    await new Promise((r) => setTimeout(r, 200))
  }
  return Date.now() - t0
}

export async function goBack(windowId?: number, tabIndex?: number): Promise<void> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to go back`)
}

export async function goForward(windowId?: number, tabIndex?: number): Promise<void> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to go forward`)
}

export async function evalJs(
  js: string,
  windowId?: number,
  tabIndex?: number,
): Promise<string> {
  const wrapped = `(function(){try{var __r=(function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`
  return await osa(
    `tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to execute javascript ${quote(wrapped)}`,
  )
}

export async function getSource(windowId?: number, tabIndex?: number): Promise<string> {
  return await evalJs("return document.documentElement.outerHTML;", windowId, tabIndex)
}

export async function getText(windowId?: number, tabIndex?: number): Promise<string> {
  return await evalJs("return document.body && document.body.innerText || '';", windowId, tabIndex)
}

export async function isRunning(): Promise<boolean> {
  const out = await osa(`tell application "System Events" to (name of processes) contains "Google Chrome"`)
  return out === "true"
}

const SCREEN_API = Bun.env.SCREEN_API ?? "http://localhost:7879"

export type ScreenshotOptions = {
  windowId?: number;
  tabIndex?: number;
  shadow?: boolean;
  delayMs?: number;
  format?: "png" | "json";
  restore?: boolean;
  detail?: string;
  scale?: number;
  caption?: string;
};

export type ScreenshotResult = {
  status: number;
  contentType: string;
  body: ArrayBuffer;
  caption?: string;
};

export async function screenshotTab(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const wins = await listWindows()
  if (wins.length === 0) throw new Error("no Chrome windows")
  const target = opts.windowId != null
    ? wins.find((w) => w.id === opts.windowId)
    : wins.find((w) => w.index === 1) ?? wins[0]
  if (!target) throw new Error(`window not found: id=${opts.windowId}`)

  if (opts.tabIndex != null && opts.tabIndex !== target.activeTabIndex) {
    const tabExists = target.tabs.some((t) => t.index === opts.tabIndex)
    if (!tabExists) throw new Error(`tab ${opts.tabIndex} not found in window ${target.id}`)
    await activateTab(target.id, opts.tabIndex)
  }

  const fresh = (await listWindows()).find((w) => w.id === target.id) ?? target
  const restore = opts.restore !== false

  // Save frontmost app BEFORE activating Chrome
  let prevApp: string | null = null
  if (restore) {
    prevApp = await osa(`tell application "System Events" to get name of first application process whose frontmost is true`).catch(() => null)
  }

  if (opts.caption) logCaption(opts.caption)

  // Bring the exact Chrome window to front before capture
  await osa(`tell application "Google Chrome"
    set index of (first window whose id is ${fresh.id}) to 1
    activate
  end tell`)

  const body: Record<string, unknown> = {
    x: fresh.x,
    y: fresh.y,
    width: fresh.width,
    height: fresh.height,
    restore: false,
    format: opts.format ?? "png",
  }
  if (opts.shadow !== undefined) body.shadow = opts.shadow
  if (opts.delayMs !== undefined) body.delayMs = opts.delayMs
  if (opts.detail !== undefined) body.detail = opts.detail
  if (opts.scale !== undefined) body.scale = opts.scale
  if (opts.caption !== undefined) body.caption = opts.caption

  const res = await fetch(`${SCREEN_API}/rect`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  })
  let buf = await res.arrayBuffer()

  // Restore focus after screenshot
  if (restore && prevApp && prevApp !== "Google Chrome") {
    await osa(`tell application ${quote(prevApp)} to activate`).catch(() => {})
  }

  if (!res.ok) {
    const text = new TextDecoder().decode(buf)
    throw new Error(`screen api ${res.status}: ${text}`)
  }

  // Apply scale locally (screen service may be running without the detail feature)
  const scale = resolveScale(opts.detail, opts.scale)
  if (scale < 1) buf = await downscalePng(buf, scale)

  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    body: buf,
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
  const dir = await mkdtemp(join(tmpdir(), "meta-chrome-"))
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
    return data.buffer as ArrayBuffer
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
