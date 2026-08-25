import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { logCaption, osa, quote } from "@meta/shared";
import {
  CdpTargetSelectionError,
  cdpClearViewport,
  cdpConsoleListen,
  cdpEval,
  cdpHistory,
  cdpNavigate,
  cdpReload,
  cdpSetViewport,
  cdpWaitReady,
  findTargetById,
  findTargetByUrl,
  isCdpAvailable,
  type ConsoleEntry,
  type ViewportOverride,
  type ViewportMode,
} from "./cdp-mode.ts";
import type { CdpTarget } from "@meta/shared";
import type { WaitReadyOptions, WaitReadyResult } from "./wait-ready.ts";
import {
  assertUnambiguousChromeProcess,
  listChromeBrowserProcesses,
} from "./browser-processes.ts";

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
  kind: "browser" | "appWindow";
  app?: string;
  pid?: number;
  url?: string;
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

const APPLE_SCRIPT_LIST_WINDOWS = `
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

const JXA_CHROME_HELPERS = `
function chromeWindow(app, id) {
  if (id === null || id === undefined) {
    var wins = app.windows();
    if (!wins.length) throw new Error("no Chrome windows");
    return wins[0];
  }
  return app.windows.byId(Number(id));
}

function chromeTab(w, index) {
  var n = index === null || index === undefined ? Number(w.activeTabIndex()) : Number(index);
  if (!n || n < 1) throw new Error("invalid tab index: " + index);
  return w.tabs[n - 1];
}

function chromeWindowPayload(w, fallbackIndex) {
  var b = w.bounds();
  return {
    id: Number(w.id()),
    index: Number(w.index()) || fallbackIndex,
    title: String(w.name() || ""),
    kind: "browser",
    app: "Google Chrome",
    x: Number(b.x) || 0,
    y: Number(b.y) || 0,
    width: Number(b.width) || 0,
    height: Number(b.height) || 0,
    activeTabIndex: Number(w.activeTabIndex()) || 0,
    mode: String(w.mode() || ""),
    tabs: w.tabs().map(function(t, i) {
      return {
        id: Number(t.id()) || 0,
        index: i + 1,
        title: String(t.title() || ""),
        url: String(t.url() || ""),
        loading: Boolean(t.loading()),
      };
    }),
  };
}
`

function jxaArg(value?: number): string {
  return value == null ? "null" : String(value)
}

function jsString(value: string): string {
  return JSON.stringify(value)
}

async function jxa(script: string): Promise<string> {
  const proc = spawn(["osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`jxa failed (${code}): ${errText.trim() || out.trim()}`)
  return out.trim()
}

async function jxaJson<T>(script: string): Promise<T> {
  const raw = await jxa(script)
  return JSON.parse(raw) as T
}

async function jxaValue<T>(body: string): Promise<T> {
  return await jxaJson<T>(`
${JXA_CHROME_HELPERS}
JSON.stringify((function() {
  var app = Application("Google Chrome");
  ${body}
})())
`)
}

async function chromeJxaValue<T>(body: string): Promise<T> {
  await assertUnambiguousChromeProcess()
  return await jxaValue<T>(body)
}

async function runJxa(body: string): Promise<void> {
  await assertUnambiguousChromeProcess()
  await jxa(`
${JXA_CHROME_HELPERS}
(function() {
  var app = Application("Google Chrome");
  ${body}
})()
`)
}

export async function listWindows(): Promise<WindowInfo[]> {
  const browserWindows = await chromeJxaValue<WindowInfo[]>(`
    if (!app.running()) return [];
    return app.windows().map(function(w, i) {
      return chromeWindowPayload(w, i + 1);
    });
  `)
  const appWindows = await listChromeAppWindows(browserWindows).catch(() => [])
  return [...browserWindows, ...appWindows]
}

async function listChromeAppWindows(browserWindows: WindowInfo[]): Promise<WindowInfo[]> {
  const appProcesses = await listChromeAppProcesses()
  if (appProcesses.length === 0) return []

  const appByUrl = new Map(appProcesses.map((p) => [p.url, p]))
  const browserUrls = new Set(browserWindows.flatMap((w) => w.tabs.map((t) => t.url)))
  const raw = await osa(APPLE_SCRIPT_LIST_WINDOWS)
  if (!raw) return []

  const out: WindowInfo[] = []
  for (const win of parseAppleScriptWindows(raw)) {
    const url = win.tabs[0]?.url ?? ""
    const appProcess = appByUrl.get(url)
    if (!appProcess || browserUrls.has(url)) continue
    out.push({
      ...win,
      kind: "appWindow",
      app: "Google Chrome",
      pid: appProcess.pid,
      url,
      activeTabIndex: 0,
      tabs: [],
    })
  }
  return out
}

function parseAppleScriptWindows(raw: string): WindowInfo[] {
  return raw
    .split(RS)
    .filter((r) => r.length > 0)
    .map((rec) => {
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
        kind: "browser" as const,
        app: "Google Chrome",
        x: Number(x ?? 0),
        y: Number(y ?? 0),
        width: Number(width ?? 0),
        height: Number(height ?? 0),
        activeTabIndex: Number(activeTabIndex ?? 0),
        mode: mode ?? "",
        tabs,
      }
    })
}

async function listChromeAppProcesses(): Promise<Array<{ pid: number; url: string }>> {
  const proc = spawn(["ps", "-axo", "pid,args"], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (code !== 0) return []
  const processes: Array<{ pid: number; url: string }> = []
  for (const line of out.split("\n")) {
    if (!line.includes("/Google Chrome") || !line.includes(" --app=")) continue
    const row = line.match(/^\s*(\d+)\s+(.+)$/)
    const app = line.match(/(?:^|\s)--app=([^\s]+)/)
    if (!row || !app) continue
    processes.push({ pid: Number(row[1]), url: app[1] ?? "" })
  }
  return processes.filter((p) => p.pid > 0 && p.url.length > 0)
}

export async function getActiveTab(): Promise<TabInfo & { windowId: number } | null> {
  const wins = await listWindows()
  if (wins.length === 0) return null
  const w = wins[0]!
  const tab = w.tabs.find((t) => t.index === w.activeTabIndex) ?? w.tabs[0]
  if (!tab) return null
  return {...tab, windowId: w.id}
}

export type NewWindowOptions = {
  url?: string;
  incognito?: boolean;
};

export async function newWindow(options: NewWindowOptions = {}): Promise<{ id: number }> {
  const id = await chromeJxaValue<number>(`
    var before = app.windows().map(function(w) { return Number(w.id()); });
    try {
      app.windows.push(app.Window(${options.incognito ? `{mode: "incognito"}` : ""}));
    } catch (e) {
      // Chrome creates the window before JXA reports an invalid-index error.
    }
    var created = app.windows().filter(function(w) {
      return before.indexOf(Number(w.id())) === -1;
    })[0] || chromeWindow(app, null);
    ${options.url ? `chromeTab(created, 1).url = ${jsString(options.url)};` : ""}
    created.index = 1;
    app.activate();
    return Number(created.id());
  `)
  return {id}
}

export async function closeWindow(windowId: number): Promise<void> {
  await runJxa(`chromeWindow(app, ${jxaArg(windowId)}).close();`)
}

export type NewTabOptions = {
  windowId?: number;
  url?: string;
};

export async function newTab(options: NewTabOptions = {}): Promise<{ id: number; index: number }> {
  return await chromeJxaValue<{ id: number; index: number }>(`
    var w = chromeWindow(app, ${jxaArg(options.windowId)});
    var t = app.Tab({url: ${options.url ? jsString(options.url) : jsString("about:blank")}});
    w.tabs.push(t);
    var index = w.tabs().length;
    var created = chromeTab(w, index);
    w.activeTabIndex = index;
    w.index = 1;
    app.activate();
    return {id: Number(created.id()) || 0, index: index};
  `)
}

export async function closeTab(windowId: number, tabIndex: number): Promise<void> {
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)}).close();
  `)
}

export async function activateTab(windowId: number, tabIndex: number): Promise<void> {
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)});
    w.activeTabIndex = ${tabIndex};
    w.index = 1;
    app.activate();
  `)
}

async function tabUrl(windowId?: number, tabIndex?: number): Promise<string> {
  return await chromeJxaValue<string>(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    return String(chromeTab(w, ${jxaArg(tabIndex)}).url() || "");
  `)
}

async function resolveCdpTarget(
  targetId?: string,
  windowId?: number,
  tabIndex?: number,
): Promise<CdpTarget | null> {
  if (!(await isCdpAvailable())) {
    if (targetId) {
      throw new CdpTargetSelectionError(
        "CDP not available — start Chrome with --remote-debugging-port=9222 (bun run cdp)",
        503,
      )
    }
    return null
  }
  if (targetId) return await findTargetById(targetId)
  const url = await tabUrl(windowId, tabIndex).catch(() => "")
  if (!url) return null
  try {
    return await findTargetByUrl(url)
  } catch (error) {
    if (error instanceof CdpTargetSelectionError && error.status === 503) return null
    throw error
  }
}

export async function navigate(
  url: string,
  windowId?: number,
  tabIndex?: number,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  targetId?: string,
): Promise<{ via: "cdp" | "applescript"; waitMs?: number; ready?: WaitReadyResult }> {
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) {
    const r = await cdpNavigate(target, url, wait, waitOpts)
    return { via: "cdp", ...r }
  }
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)}).url = ${jsString(url)};
  `)
  const waitMs = wait ? await waitForTabLoad(windowId, tabIndex) : 0
  return { via: "applescript", waitMs }
}

export async function reload(
  windowId?: number,
  tabIndex?: number,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  targetId?: string,
): Promise<{ waitMs: number; via: "cdp" | "applescript"; ready?: WaitReadyResult }> {
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) {
    const r = await cdpReload(target, false, wait, waitOpts)
    return { via: "cdp", ...r }
  }
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)}).reload();
  `)
  const waitMs = wait ? await waitForTabLoad(windowId, tabIndex) : 0
  return { waitMs, via: "applescript" }
}

export async function hardReload(
  windowId?: number,
  tabIndex?: number,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  targetId?: string,
): Promise<{ waitMs: number; via: "cdp" | "applescript"; ready?: WaitReadyResult }> {
  // CDP path: ignoreCache:true is the equivalent of Cmd+Shift+R, без воровства фокуса
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) {
    const r = await cdpReload(target, true, wait, waitOpts)
    return { via: "cdp", ...r }
  }
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    if (${jxaArg(tabIndex)} !== null) {
      chromeTab(w, ${jxaArg(tabIndex)});
      w.activeTabIndex = ${jxaArg(tabIndex)};
    }
    w.index = 1;
    app.activate();
  `)
  await osa(`
    delay 0.05
    tell application "System Events" to tell process "Google Chrome"
      key code 15 using {command down, shift down}
    end tell
  `)
  const waitMs = wait ? await waitForTabLoad(windowId, tabIndex) : 0
  return { waitMs, via: "applescript" }
}

async function waitForTabLoad(windowId?: number, tabIndex?: number, timeoutMs = 10_000): Promise<number> {
  const t0 = Date.now()
  // brief initial delay so loading=true has time to register
  await new Promise((r) => setTimeout(r, 150))
  while (Date.now() - t0 < timeoutMs) {
    const loading = await chromeJxaValue<boolean>(`
      var w = chromeWindow(app, ${jxaArg(windowId)});
      return Boolean(chromeTab(w, ${jxaArg(tabIndex)}).loading());
    `).catch(() => false)
    if (!loading) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 200))
  }
  return Date.now() - t0
}

export async function goBack(
  windowId?: number,
  tabIndex?: number,
  targetId?: string,
  wait = true,
  waitOpts: WaitReadyOptions = {},
): Promise<{ via: "cdp" | "applescript"; navigated?: boolean; waitMs?: number; ready?: WaitReadyResult }> {
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) return { via: "cdp", ...await cdpHistory(target, -1, wait, waitOpts) }
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)}).goBack();
  `)
  return { via: "applescript" }
}

export async function goForward(
  windowId?: number,
  tabIndex?: number,
  targetId?: string,
  wait = true,
  waitOpts: WaitReadyOptions = {},
): Promise<{ via: "cdp" | "applescript"; navigated?: boolean; waitMs?: number; ready?: WaitReadyResult }> {
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) return { via: "cdp", ...await cdpHistory(target, 1, wait, waitOpts) }
  await runJxa(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    chromeTab(w, ${jxaArg(tabIndex)}).goForward();
  `)
  return { via: "applescript" }
}

export async function evalJs(
  js: string,
  windowId?: number,
  tabIndex?: number,
  targetId?: string,
): Promise<string> {
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (target) return await cdpEval(target, js)
  const wrapped = `(function(){try{var __r=(function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`
  return await chromeJxaValue<string>(`
    var w = chromeWindow(app, ${jxaArg(windowId)});
    return String(chromeTab(w, ${jxaArg(tabIndex)}).execute({javascript: ${jsString(wrapped)}}) || "");
  `)
}

export async function consoleListen(
  windowId?: number,
  tabIndex?: number,
  durationMs = 1000,
  targetId?: string,
): Promise<{ entries: ConsoleEntry[]; via: "cdp" } | { entries: []; via: "unavailable"; error: string }> {
  if (!(await isCdpAvailable())) {
    return { entries: [], via: "unavailable", error: "CDP not available — bun run cdp" }
  }
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (!target) {
    return { entries: [], via: "unavailable", error: "CDP target not found for selected Chrome tab" }
  }
  const entries = await cdpConsoleListen(target, Math.max(50, Math.min(durationMs, 60_000)))
  return { entries, via: "cdp" }
}

export async function getSource(windowId?: number, tabIndex?: number, targetId?: string): Promise<string> {
  return await evalJs("return document.documentElement.outerHTML;", windowId, tabIndex, targetId)
}

export async function getText(windowId?: number, tabIndex?: number, targetId?: string): Promise<string> {
  return await evalJs("return document.body && document.body.innerText || '';", windowId, tabIndex, targetId)
}

export async function isRunning(): Promise<boolean> {
  return (await listChromeBrowserProcesses().catch(() => [])).length > 0
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
  waitReady?: boolean;
  waitOpts?: WaitReadyOptions;
};

export async function waitReady(
  windowId?: number,
  tabIndex?: number,
  opts: WaitReadyOptions = {},
  targetId?: string,
): Promise<{ via: "cdp"; result: WaitReadyResult } | { via: "unavailable"; error: string }> {
  if (!(await isCdpAvailable())) {
    return { via: "unavailable", error: "CDP not available — start Chrome with --remote-debugging-port=9222 (bun run cdp)" }
  }
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (!target) {
    return { via: "unavailable", error: "CDP target not found for selected Chrome tab" }
  }
  const result = await cdpWaitReady(target, opts)
  return { via: "cdp", result }
}

export async function setViewport(
  windowId: number | undefined,
  tabIndex: number | undefined,
  override: ViewportOverride,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
  targetId?: string,
): Promise<{ via: "cdp"; applied: { width: number; height: number; deviceScaleFactor: number; mobile: boolean; mode: ViewportMode; innerSize: boolean }; bounds?: { before: unknown; after: unknown }; inner?: { width: number; height: number }; reloaded: boolean; ready?: WaitReadyResult } | { via: "unavailable"; error: string }> {
  if (!(await isCdpAvailable())) {
    return { via: "unavailable", error: "CDP not available — start Chrome with --remote-debugging-port=9222 (bun run cdp)" }
  }
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (!target) {
    return { via: "unavailable", error: "CDP target not found for selected Chrome tab" }
  }
  const r = await cdpSetViewport(target, override, wait, waitOpts, reload)
  return { via: "cdp", ...r }
}

export async function clearViewport(
  windowId: number | undefined,
  tabIndex: number | undefined,
  wait = true,
  waitOpts: WaitReadyOptions = {},
  reload = true,
  targetId?: string,
): Promise<{ via: "cdp"; reloaded: boolean; ready?: WaitReadyResult } | { via: "unavailable"; error: string }> {
  if (!(await isCdpAvailable())) {
    return { via: "unavailable", error: "CDP not available — start Chrome with --remote-debugging-port=9222 (bun run cdp)" }
  }
  const target = await resolveCdpTarget(targetId, windowId, tabIndex)
  if (!target) {
    return { via: "unavailable", error: "CDP target not found for selected Chrome tab" }
  }
  const r = await cdpClearViewport(target, wait, waitOpts, reload)
  return { via: "cdp", ...r }
}

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

  // Bring the exact Chrome window to front before capture.
  await runJxa(`
    var w = chromeWindow(app, ${fresh.id});
    w.index = 1;
    app.activate();
  `)

  // Wait for page to be fully ready before capture (lazy images, fonts, animations, ...).
  // Best-effort: silently skip if CDP is unavailable or target can't be matched.
  const shouldWait = opts.waitReady !== false
  if (shouldWait && await isCdpAvailable()) {
    const u = fresh.tabs.find((t) => t.index === fresh.activeTabIndex)?.url ?? ""
    const target = u ? await findTargetByUrl(u) : null
    if (target) await cdpWaitReady(target, opts.waitOpts ?? {})
  }

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
