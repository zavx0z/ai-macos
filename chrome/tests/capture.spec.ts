import { describe, expect, test } from "bun:test"
import { chromeScreenCaptureRequest } from "../src/chrome.ts"

describe("Chrome UI capture request", () => {
  test("передаёт scale владельцу screen ровно один раз", () => {
    const request = chromeScreenCaptureRequest(
      { x: 10, y: 20, width: 800, height: 600 },
      { detail: "medium", scale: 0.75, caption: "Проверка" },
    )

    expect(request).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      restore: false,
      format: "png",
      detail: "medium",
      scale: 0.75,
      caption: "Проверка",
    })
  })
})
