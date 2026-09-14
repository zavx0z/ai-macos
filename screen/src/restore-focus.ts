import { sameWindowIdentity, stableWindowTarget, validWindowId } from "@meta/shared"
import { isFocusedSheet } from "../../window/src/focus.ts"
import type { FrontmostWindow, WindowApi, WindowInfo } from "./window-api.ts"

function sameWindow(a: WindowInfo | null, b: WindowInfo | null): boolean {
  return a !== null && b !== null && sameWindowIdentity(a, b)
}

export async function restoreFocus(
  api: WindowApi,
  state: FrontmostWindow | null,
  enabled: boolean,
): Promise<{ ok: boolean; app: string | null; error?: string }> {
  if (!enabled || state === null) return { ok: true, app: state?.app ?? null }
  try {
    const current = await api.frontmost()
    // AXRaise normally leaves focus unchanged. In particular, do not try to
    // resolve a focused sheet's index 0 as a top-level window selector.
    if (current.pid === state.pid && sameWindow(current.window, state.window)) {
      return { ok: true, app: state.app }
    }
    if (state.window && (validWindowId(state.window.ownerWindowId) || state.window.index === 0)) {
      const sheet = state.window
      const owners = (await api.listWindows(state.app)).filter(window =>
        window.index > 0 && isFocusedSheet(window, sheet))
      if (owners.length !== 1) {
        throw new Error(`cannot restore focused sheet: expected one visible owner, found ${owners.length}`)
      }
      await api.focus(stableWindowTarget(owners[0]!))
      const restored = await api.frontmost()
      if (restored.pid !== state.pid || !sameWindow(restored.window, sheet)) {
        throw new Error("focused sheet was not restored after focusing its owner")
      }
    } else {
      await api.focus(state.window ? stableWindowTarget(state.window) : { app: state.app, pid: state.pid })
    }
    return { ok: true, app: state.app }
  } catch (error) {
    return { ok: false, app: state.app, error: error instanceof Error ? error.message : String(error) }
  }
}
