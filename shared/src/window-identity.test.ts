import { expect, test } from "bun:test"
import { matchesWindow, sameWindowIdentity, selectUniqueWindow, stableWindowTarget } from "./window-identity.ts"

const main = { app: "Yandex", pid: 3355, windowId: 6627, index: 2, title: "Dzen", x: 544, y: 25, width: 1376, height: 1175 }
const status = { ...main, windowId: 8006, index: 1, title: "", width: 12, height: 22 }

test("CG identity survives reindex, rename, move and resize", () => {
  const changed = { ...main, index: 3, title: "Another article", x: 100, y: 80, width: 1000, height: 800 }
  expect(selectUniqueWindow([status, changed], main)).toEqual(changed)
  expect(sameWindowIdentity(main, changed)).toBe(true)
})

test("a closed ID cannot fall back to an identical replacement or a reused AX index", () => {
  const replacement = { ...main, windowId: 9000 }
  expect(selectUniqueWindow([replacement, { ...status, index: 2 }], main)).toBeUndefined()
  expect(sameWindowIdentity(main, replacement)).toBe(false)
})

test("PID and app remain identity constraints", () => {
  expect(matchesWindow({ ...main, pid: 9 }, main)).toBe(false)
  expect(matchesWindow({ ...main, app: "Other" }, main)).toBe(false)
})

test("missing or invalid stable IDs cannot silently downgrade", () => {
  for (const windowId of [0, -1, NaN, Infinity, 1.5, 0x100000000]) {
    expect(() => selectUniqueWindow([main], { app: "Yandex", windowId })).toThrow()
  }
  expect(sameWindowIdentity(main, { ...main, windowId: undefined })).toBe(false)
})

test("legacy unique selectors work; ambiguous selectors fail closed", () => {
  expect(selectUniqueWindow([main, status], { app: "yandex", title: "Dzen" })).toEqual(main)
  expect(() => selectUniqueWindow([main, status], { app: "Yandex" })).toThrow("ambiguous")
  expect(stableWindowTarget(main)).toEqual({ app: "Yandex", pid: 3355, windowId: 6627 })
})
