import { describe, expect, test } from "bun:test"
import { DesktopActionTransaction } from "../src/v2/action-transaction.ts"
import { LeaseStore } from "../src/v2/lease-store.ts"
import type { DesktopActionAdapter, ExactWindow, ScreenshotEvidence, WindowIdentity, WindowObservation } from "../src/v2/contracts.ts"

const safari = (windowId: number, title = `Safari ${windowId}`): ExactWindow => ({
  windowId, pid: 50, app: "Safari", title, x: windowId * 10, y: 25, width: 800, height: 600,
})
const editor: ExactWindow = { windowId: 9, pid: 70, app: "Code", title: "editor", x: 0, y: 0, width: 900, height: 700 }

class FakeAdapter implements DesktopActionAdapter {
  epoch = "epoch-1"
  clock = 1_000
  windows: ExactWindow[] = []
  focusedIdentity: WindowIdentity | null = null
  shortcutCalls: string[] = []
  focusCalls: WindowIdentity[] = []
  captureCalls: WindowIdentity[] = []
  onFocus?: (identity: WindowIdentity) => void
  onShortcut?: (shortcut: string) => void

  async observe(app?: string): Promise<WindowObservation> {
    const windows = app ? this.windows.filter((window) => window.app.toLowerCase() === app.toLowerCase()) : this.windows
    return { epoch: this.epoch, observedAt: new Date(this.clock).toISOString(), windows: structuredClone(windows) }
  }
  async focused() { return { epoch: this.epoch, focused: this.focusedIdentity && { ...this.focusedIdentity } } }
  async focusExact(identity: WindowIdentity) {
    this.focusCalls.push({ ...identity })
    if (!this.windows.some((window) => same(window, identity))) throw new Error("exact target not found")
    this.focusedIdentity = { ...identity }
    this.onFocus?.(identity)
  }
  async shortcut(shortcut: string) {
    this.shortcutCalls.push(shortcut)
    this.onShortcut?.(shortcut)
  }
  async capture(identity: WindowIdentity, caption: string): Promise<ScreenshotEvidence> {
    if (!this.windows.some((window) => same(window, identity))) throw new Error("target closed before screenshot")
    this.captureCalls.push({ ...identity })
    return { data: "iVBORw0KGgo=", mimeType: "image/png", caption }
  }
  async sleep(ms: number) { this.clock += ms }
  now() { return this.clock }
}

function same(a: WindowIdentity, b: WindowIdentity) {
  return a.pid === b.pid && a.windowId === b.windowId
}

function setup(windows: ExactWindow[], focused: WindowIdentity | null = editor) {
  const adapter = new FakeAdapter()
  adapter.windows = structuredClone(windows)
  adapter.focusedIdentity = focused && { pid: focused.pid, windowId: focused.windowId }
  const leases = new LeaseStore(30_000, () => adapter.clock)
  return { adapter, transaction: new DesktopActionTransaction(adapter, leases) }
}

describe("desktop_action fail-closed transaction", () => {
  test("absent target returns target_not_found with zero focus and zero input", async () => {
    const { adapter, transaction } = setup([editor])
    const before = { ...adapter.focusedIdentity! }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r" })
    expect(result.status).toBe("target_not_found")
    expect(result.error?.code).toBe("target_not_found")
    expect(adapter.shortcutCalls).toEqual([])
    expect(adapter.focusCalls).toEqual([])
    expect(adapter.focusedIdentity).toEqual(before)
  })

  test("ambiguous target returns compact handles with zero input", async () => {
    const { adapter, transaction } = setup([editor, safari(1), safari(2)])
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r" })
    expect(result.status).toBe("needs_target")
    expect(result.error?.candidates).toHaveLength(2)
    expect(result.error?.candidates?.[0]).toEqual(expect.objectContaining({ handle: expect.stringMatching(/^win_/), app: "Safari" }))
    expect(adapter.shortcutCalls).toEqual([])
    expect(adapter.focusCalls).toEqual([])
  })

  test("a candidate handle selects the exact window among multiple", async () => {
    const { adapter, transaction } = setup([editor, safari(1, "fixture:1"), safari(2, "other")])
    const ambiguous = await transaction.execute({ app: "Safari", shortcut: "cmd+r" })
    const selected = ambiguous.error!.candidates!.find((candidate) => candidate.title === "fixture:1")!
    adapter.onShortcut = () => { adapter.windows.find((window) => window.windowId === 1)!.title = "fixture:2" }
    const result = await transaction.execute({ targetHandle: selected.handle, shortcut: "cmd+r", verifyTitlePrefix: "fixture:" })
    expect(result.status).toBe("verified")
    expect(adapter.shortcutCalls).toEqual(["cmd+r"])
    expect(adapter.focusCalls[0]).toEqual({ pid: 50, windowId: 1 })
    expect(result.effect).toEqual({ status: "confirmed", evidence: { kind: "window_title_changed", before: "fixture:1", after: "fixture:2" } })
  })

  test("restores the exact previous window rather than only its app", async () => {
    const previous = { ...editor, windowId: 10, title: "second editor" }
    const { adapter, transaction } = setup([editor, previous, safari(1)], previous)
    adapter.onShortcut = () => { adapter.windows.find((window) => window.windowId === 1)!.title = "reloaded" }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: "Safari" })
    expect(result.restoration.status).toBe("restored")
    expect(adapter.focusedIdentity).toEqual({ pid: previous.pid, windowId: previous.windowId })
    expect(adapter.focusCalls.at(-1)).toEqual({ pid: previous.pid, windowId: previous.windowId })
  })

  test("restoration runs after an action exception", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    adapter.onShortcut = () => { throw new Error("input backend failed") }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r" })
    expect(result.status).toBe("action_failed")
    expect(result.delivery.status).toBe("unknown")
    expect(result.restoration.status).toBe("restored")
    expect(adapter.focusedIdentity).toEqual({ pid: editor.pid, windowId: editor.windowId })
  })

  test("delivery is not effect and no unverified action is verified", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+l" })
    expect(result.delivery.status).toBe("delivered")
    expect(result.effect.status).toBe("not_checked")
    expect(result.status).toBe("delivered_unverified")
  })

  test("changed epoch before dispatch rejects stale lease with zero input", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    adapter.onFocus = (identity) => {
      if (identity.windowId === 1) adapter.epoch = "epoch-2"
    }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: "Safari" })
    expect(result.status).toBe("rejected_stale_target")
    expect(adapter.shortcutCalls).toEqual([])
    expect(result.restoration.status).toBe("restored")
  })

  test("target closing before dispatch produces zero input", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    adapter.onFocus = (identity) => {
      if (identity.windowId === 1) adapter.windows = adapter.windows.filter((window) => window.windowId !== 1)
    }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: "Safari" })
    expect(result.status).toBe("rejected_stale_target")
    expect(adapter.shortcutCalls).toEqual([])
  })

  test("reports when the previous exact target closes before restoration", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    adapter.onShortcut = () => {
      adapter.windows.find((window) => window.windowId === 1)!.title = "Safari reloaded"
      adapter.windows = adapter.windows.filter((window) => window.windowId !== editor.windowId)
    }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: "Safari" })
    expect(result.status).toBe("verified_restoration_failed")
    expect(result.restoration.status).toBe("previous_target_gone")
  })

  test("returns screenshot artifact metadata separately from private image bytes", async () => {
    const { adapter, transaction } = setup([editor, safari(1)])
    adapter.onShortcut = () => { adapter.windows.find((window) => window.windowId === 1)!.title = "reloaded" }
    const result = await transaction.execute({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: "Safari" })
    expect(result.artifact).toEqual(expect.objectContaining({ kind: "screenshot", mimeType: "image/png", imageIncluded: true }))
    expect(result._image).toEqual(expect.objectContaining({ data: "iVBORw0KGgo=", mimeType: "image/png" }))
    expect(adapter.captureCalls).toEqual([{ pid: 50, windowId: 1 }])
  })
})
