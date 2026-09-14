import { expect, test } from "bun:test"
import { restoreFocus } from "../src/restore-focus.ts"
import type { FrontmostWindow, WindowApi, WindowTarget } from "../src/window-api.ts"

const owner = { app: "Yandex", pid: 3355, title: "Dzen", index: 2, x: 544, y: 25, width: 1376, height: 1175 }
const sheet = { ...owner, title: "", index: 0, x: 996, y: 498, width: 473, height: 228 }
const before = { app: owner.app, pid: owner.pid, window: sheet }
const other = { app: "ChatGPT", pid: 99, window: { ...owner, app: "ChatGPT", pid: 99 } }

function fixture(current: FrontmostWindow, windows = [owner], after = before) {
  const calls: WindowTarget[] = []
  const api: WindowApi = {
    baseUrl: "unused",
    health: async () => ({ ok: true }),
    listWindows: async () => windows,
    frontmost: async () => current,
    raise: async () => {},
    focus: async target => { calls.push(target); current = after },
  }
  return { api, calls }
}

test("unchanged native save sheet needs no focus mutation", async () => {
  const { api, calls } = fixture(before)
  expect(await restoreFocus(api, before, true)).toEqual({ ok: true, app: "Yandex" })
  expect(calls).toEqual([])
})

test("a top-level window reindexed after Save retains the same focus", async () => {
  const state = { ...before, window: { ...owner, index: 3 } }
  const { api, calls } = fixture({ ...before, window: owner })
  expect((await restoreFocus(api, state, true)).ok).toBe(true)
  expect(calls).toEqual([])
})

test("restores a sheet through its unique visible owner, never index 0", async () => {
  const { api, calls } = fixture(other)
  expect((await restoreFocus(api, before, true)).ok).toBe(true)
  expect(calls).toEqual([owner])
})

test("rejects ambiguous owners and a different process without focusing", async () => {
  for (const windows of [[owner, { ...owner, index: 3 }], [{ ...owner, pid: 44 }], []]) {
    const { api, calls } = fixture(other, windows)
    expect((await restoreFocus(api, before, true)).ok).toBe(false)
    expect(calls).toEqual([])
  }
})

test("does not claim restoration when the owner focused but the sheet disappeared", async () => {
  const { api } = fixture(other, [owner], { ...before, window: owner })
  expect((await restoreFocus(api, before, true)).ok).toBe(false)
})

test("disabled restoration does not observe or change focus", async () => {
  const { api, calls } = fixture(other)
  api.frontmost = async () => { throw new Error("must not run") }
  expect((await restoreFocus(api, before, false)).ok).toBe(true)
  expect(calls).toEqual([])
})
