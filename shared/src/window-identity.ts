export type WindowIdentity = {
  app: string; pid: number; index: number; title: string
  x: number; y: number; width: number; height: number
  windowId?: number; ownerWindowId?: number
}

export type WindowSelector = Partial<WindowIdentity>

export function validWindowId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

export function matchesWindow(window: WindowIdentity, target: WindowSelector): boolean {
  if (target.app !== undefined && window.app.toLowerCase() !== target.app.toLowerCase()) return false
  if (target.pid !== undefined && window.pid !== target.pid) return false
  if (target.windowId !== undefined) {
    if (!validWindowId(target.windowId)) throw new Error("windowId must be a positive CGWindowID")
    // Stable identity is authoritative. Index, title and frame are mutable hints.
    return window.windowId === target.windowId
  }
  return (target.index === undefined || window.index === target.index)
    && (target.title === undefined || window.title.toLowerCase().includes(target.title.toLowerCase()))
    && (target.x === undefined || window.x === target.x)
    && (target.y === undefined || window.y === target.y)
    && (target.width === undefined || window.width === target.width)
    && (target.height === undefined || window.height === target.height)
}

export function selectUniqueWindow<T extends WindowIdentity>(windows: T[], target: WindowSelector): T | undefined {
  if (target.windowId !== undefined && !validWindowId(target.windowId)) throw new Error("invalid windowId")
  const matches = windows.filter(window => matchesWindow(window, target))
  if (matches.length > 1) throw new Error(`ambiguous window target: ${matches.length} matches; use pid and windowId`)
  return matches[0]
}

export function sameWindowIdentity(a: WindowIdentity, b: WindowIdentity): boolean {
  if (a.pid !== b.pid) return false
  if (validWindowId(a.windowId) || validWindowId(b.windowId)) {
    return validWindowId(a.windowId) && a.windowId === b.windowId
  }
  return a.title === b.title && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height
}

export function stableWindowTarget(window: WindowIdentity): WindowSelector & { app: string; pid: number } {
  const { windowId, ownerWindowId, ...legacy } = window
  return validWindowId(window.windowId)
    ? { app: window.app, pid: window.pid, windowId: window.windowId }
    : legacy
}
