import {describe, expect, test} from "bun:test"
import {windowLocalPointToScreen} from "../src/window-coordinates.ts"

const window = {
  app: "ChatGPT",
  x: 320,
  y: 48,
  width: 1280,
  height: 900,
} as const

describe("window-local MCP pointer coordinates", () => {
  test("adds the verified window origin before sending input", () => {
    expect(windowLocalPointToScreen(window, {x: 40, y: 75})).toEqual({x: 360, y: 123})
    expect(windowLocalPointToScreen(window, {x: 0, y: 0})).toEqual({x: 320, y: 48})
  })

  test("rejects coordinates outside the window-local rectangle", () => {
    expect(() => windowLocalPointToScreen(window, {x: -1, y: 0})).toThrow("window-local bounds")
    expect(() => windowLocalPointToScreen(window, {x: 0, y: -1})).toThrow("window-local bounds")
    expect(() => windowLocalPointToScreen(window, {x: window.width, y: 0})).toThrow("window-local bounds")
    expect(() => windowLocalPointToScreen(window, {x: 0, y: window.height})).toThrow("window-local bounds")
  })
})
