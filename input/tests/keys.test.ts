import { describe, expect, test } from "bun:test"
import { modifierFlags, parseShortcut } from "../src/keys.ts"

describe("keyboard shortcuts", () => {
  test("parses a shortcut", () => {
    expect(parseShortcut("cmd+shift+t")).toEqual({
      key: "t",
      modifiers: ["cmd", "shift"],
    })
  })

  test("combines CoreGraphics modifier flags", () => {
    expect(modifierFlags(["cmd", "shift"])).toBe(0x0012_0000)
  })

  test("rejects unknown modifiers", () => {
    expect(() => modifierFlags(["hyper"])).toThrow("unknown modifier")
  })
})
