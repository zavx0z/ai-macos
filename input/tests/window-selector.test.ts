import { expect, test } from "bun:test"
import { nativeWindowSelector } from "../src/windows.ts"

test("native commands use CGWindowID even if the cached index is stale", () => {
  expect(nativeWindowSelector(2, 6627)).toBe("id:6627")
  expect(nativeWindowSelector(9, 6627)).toBe("id:6627")
  expect(nativeWindowSelector(3)).toBe("3")
})

test("invalid stable ID never falls back to the legacy index", () => {
  for (const id of [0, -1, 1.5, NaN, Infinity, 0x100000000]) {
    expect(() => nativeWindowSelector(2, id)).toThrow("windowId")
  }
})
