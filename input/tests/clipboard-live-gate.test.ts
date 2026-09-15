import { describe, expect, test } from "bun:test"
import { LIVE_CLIPBOARD_ENV, liveClipboardEnabled } from "./clipboard-live-gate.ts"

describe("live clipboard test gate", () => {
  test("по умолчанию запрещает системный clipboard", () => {
    expect(liveClipboardEnabled({})).toBe(false)
  })

  test("разрешает live test только по точному opt-in", () => {
    expect(liveClipboardEnabled({ [LIVE_CLIPBOARD_ENV]: "true" })).toBe(true)
    expect(liveClipboardEnabled({ [LIVE_CLIPBOARD_ENV]: "1" })).toBe(false)
  })
})
