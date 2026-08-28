import { nativeCommand } from "./native.ts"

export type NativeWindowInfo = {
  app: string
  pid: number
  title: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

export type NativeFrontmost = {
  app: string
  pid: number
  window: NativeWindowInfo | null
}

let helperPath: string | null = null

export function setWindowNativeHelper(path: string | null): void {
  helperPath = path
}

function helper(): string {
  if (!helperPath) throw new Error("meta-input-helper недоступен")
  return helperPath
}

function parseJsonObject(output: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error(`${label}: native helper вернул некорректный JSON`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: native helper вернул не объект`)
  }
  return value as Record<string, unknown>
}

function parseWindow(value: unknown, label: string): NativeWindowInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: отсутствует окно`)
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
  ) {
    throw new Error(`${label}: некорректное описание окна`)
  }
  return window as NativeWindowInfo
}

export async function listNativeWindows(): Promise<NativeWindowInfo[]> {
  const payload = parseJsonObject(
    await nativeCommand(helper(), ["windows"]),
    "window inventory",
  )
  if (!Array.isArray(payload.windows)) {
    throw new Error("window inventory: отсутствует массив windows")
  }
  return payload.windows.map((value, index) => parseWindow(value, `window inventory[${index}]`))
}

export async function getNativeFrontmost(): Promise<NativeFrontmost> {
  const payload = parseJsonObject(
    await nativeCommand(helper(), ["frontmost"]),
    "frontmost window",
  )
  if (typeof payload.app !== "string" || typeof payload.pid !== "number") {
    throw new Error("frontmost window: отсутствует identity приложения")
  }
  return {
    app: payload.app,
    pid: payload.pid,
    window: payload.window === null ? null : parseWindow(payload.window, "frontmost window"),
  }
}

export async function focusNativeWindow(pid: number, index: number): Promise<void> {
  await nativeCommand(helper(), ["window-focus", String(pid), String(index)])
}

export async function focusNativeApplication(pid: number): Promise<void> {
  await nativeCommand(helper(), ["application-focus", String(pid)])
}

export async function raiseNativeWindow(pid: number, index: number): Promise<void> {
  await nativeCommand(helper(), ["window-raise", String(pid), String(index)])
}

export async function moveNativeWindow(
  pid: number,
  index: number,
  x: number,
  y: number,
): Promise<void> {
  await nativeCommand(helper(), [
    "window-move",
    String(pid),
    String(index),
    String(x),
    String(y),
  ])
}

export async function resizeNativeWindow(
  pid: number,
  index: number,
  width: number,
  height: number,
): Promise<void> {
  await nativeCommand(helper(), [
    "window-resize",
    String(pid),
    String(index),
    String(width),
    String(height),
  ])
}
