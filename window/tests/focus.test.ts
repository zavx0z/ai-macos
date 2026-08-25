import { describe, expect, test } from "bun:test"
import { isFocusedSheet } from "../src/focus.ts"

const target = { pid: 10, index: 1, x: 8, y: 25, width: 1912, height: 1175 }

describe("isFocusedSheet", () => {
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
