import { describe, expect, test } from "bun:test"
import { isFocusedSheet } from "../src/focus.ts"

const target = { pid: 10, index: 1, x: 8, y: 25, width: 1912, height: 1175 }

describe("isFocusedSheet", () => {
  test("uses the native owner relationship when stable IDs are present", () => {
    const owner = { ...target, windowId: 6627 }
    const sheet = { ...target, windowId: 9999, ownerWindowId: 6627, index: 0 }
    expect(isFocusedSheet(owner, sheet)).toBe(true)
    expect(isFocusedSheet(owner, { ...sheet, ownerWindowId: 8006 })).toBe(false)
    expect(isFocusedSheet(owner, { ...sheet, ownerWindowId: 0 })).toBe(false)
    expect(isFocusedSheet(owner, { ...sheet, pid: 99 })).toBe(false)
  })
  test("accepts an unlisted focused sheet contained by its target window", () => {
    expect(isFocusedSheet(target, {
      pid: 10,
      index: 0,
      x: 219,
      y: 170,
      width: 1472,
      height: 834,
    })).toBe(true)
  })

  test("rejects another window or a sheet outside the target", () => {
    expect(isFocusedSheet(target, { ...target, index: 0, pid: 11 })).toBe(false)
    expect(isFocusedSheet(target, { ...target, index: 0, x: -1 })).toBe(false)
    expect(isFocusedSheet(target, { ...target, index: 2 })).toBe(false)
  })
})
