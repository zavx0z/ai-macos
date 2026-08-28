import { osa } from "@meta/shared"

export type WindowInfo = {
  app: string
  pid: number
  title: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

export type FrontmostAppInfo = {
  app: string
  pid: number
}

type FrontmostState = FrontmostAppInfo & {
  window: WindowInfo | null
}

const INPUT_API = (Bun.env.INPUT_API ?? "http://127.0.0.1:7882").replace(/\/+$/, "")

async function requestJson(
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${INPUT_API}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`@meta/input ${path} returned non-JSON (${response.status})`)
  }
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : text
    const hint = typeof payload.hint === "string" ? `: ${payload.hint}` : ""
    throw new Error(`@meta/input ${path} failed (${response.status}): ${message}${hint}`)
  }
  return payload
}

function parseWindow(value: unknown, label: string): WindowInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: missing window object`)
  }
  const window = value as Record<string, unknown>
  if (
    typeof window.app !== "string"
    || typeof window.pid !== "number"
    || typeof window.title !== "string"
    || typeof window.index !== "number"
    || typeof window.x !== "number"
    || typeof window.y !== "number"
    || typeof window.width !== "number"
    || typeof window.height !== "number"
  ) throw new Error(`${label}: invalid window object`)
  return window as WindowInfo
}

export async function listWindows(): Promise<WindowInfo[]> {
  const payload = await requestJson("/window/windows")
  if (!Array.isArray(payload.windows)) {
    throw new Error("@meta/input window inventory did not include windows")
  }
  return uniqueWindows(
    payload.windows.map((value, index) => parseWindow(value, `window[${index}]`)),
  )
}

function uniqueWindows(windows: WindowInfo[]): WindowInfo[] {
  const seen = new Set<string>()
  const result: WindowInfo[] = []
  for (const window of windows) {
    const key = [
      window.app,
      window.pid,
      window.index,
      window.title,
      window.x,
      window.y,
      window.width,
      window.height,
    ].join("\u001f")
    if (seen.has(key)) continue
    seen.add(key)
    result.push(window)
  }
  return result
}

export async function getFrontmostState(): Promise<FrontmostState> {
  const payload = await requestJson("/window/frontmost")
  if (typeof payload.app !== "string" || typeof payload.pid !== "number") {
    throw new Error("@meta/input frontmost response did not include application identity")
  }
  return {
    app: payload.app,
    pid: payload.pid,
    window: payload.window === null ? null : parseWindow(payload.window, "frontmost"),
  }
}

export async function getFrontmostApp(): Promise<FrontmostAppInfo> {
  const state = await getFrontmostState()
  return { app: state.app, pid: state.pid }
}

export async function getFocusedWindow(): Promise<WindowInfo | null> {
  return (await getFrontmostState()).window
}

export async function focusWindow(window: WindowInfo): Promise<void> {
  await requestJson("/window/focus", {
    method: "POST",
    body: { pid: window.pid, index: window.index },
  })
}

export async function focusApplication(pid: number): Promise<void> {
  await requestJson("/window/focus-app", {
    method: "POST",
    body: { pid },
  })
}

async function resolveExactWindow(
  app: string,
  index: number,
  pid?: number,
): Promise<WindowInfo> {
  const matches = (await listWindows()).filter((window) =>
    window.app.toLowerCase() === app.toLowerCase()
    && window.index === index
    && (pid === undefined || window.pid === pid)
  )
  if (matches.length === 0) {
    throw new Error(`visible window not found: app=${app} index=${index}${pid ? ` pid=${pid}` : ""}`)
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous window target: app=${app} index=${index}; pass exact pid from GET /windows`,
    )
  }
  return matches[0]!
}

export async function raiseWindow(app: string, index: number, pid?: number): Promise<void> {
  const window = await resolveExactWindow(app, index, pid)
  await requestJson("/window/raise", {
    method: "POST",
    body: { pid: window.pid, index: window.index },
  })
}

export async function moveWindow(
  app: string,
  index: number,
  x: number,
  y: number,
  pid?: number,
): Promise<void> {
  const window = await resolveExactWindow(app, index, pid)
  await requestJson("/window/move", {
    method: "POST",
    body: { pid: window.pid, index: window.index, x, y },
  })
}

export async function resizeWindow(
  app: string,
  index: number,
  width: number,
  height: number,
  pid?: number,
): Promise<void> {
  const window = await resolveExactWindow(app, index, pid)
  await requestJson("/window/resize", {
    method: "POST",
    body: { pid: window.pid, index: window.index, width, height },
  })
}

export async function getScreen(): Promise<{ width: number; height: number }> {
  const raw = await osa("tell application \"Finder\" to get bounds of window of desktop")
  const parts = raw.split(",").map((value) => Number(value.trim()))
  return { width: parts[2] ?? 0, height: parts[3] ?? 0 }
}

export async function checkAccessibility(): Promise<{ granted: boolean; error?: string }> {
  try {
    const payload = await requestJson("/permissions/accessibility")
    return {
      granted: payload.granted === true,
      ...(typeof payload.hint === "string" ? { error: payload.hint } : {}),
    }
  } catch (error) {
    return {
      granted: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function requestAccessibility(): Promise<Record<string, unknown>> {
  return await requestJson("/permissions/accessibility", { method: "POST" })
}
