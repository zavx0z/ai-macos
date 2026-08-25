import { describe, expect, test } from "bun:test"
import type { CdpTarget } from "@meta/shared"
import {
  CdpTargetSelectionError,
  cdpCommand,
  selectCdpTarget,
  summarizeCdpTarget,
} from "../src/cdp-mode.ts"

const target = (id: string, url: string): CdpTarget => ({
  id,
  type: "page",
  title: id,
  url,
  webSocketDebuggerUrl: `ws://localhost/devtools/page/${id}`,
})

describe("CDP target selection", () => {
  test("targetId remains exact even when URLs are duplicated", () => {
    const targets = [target("A", "https://example.test"), target("B", "https://example.test")]
    expect(selectCdpTarget(targets, { targetId: "B" })?.id).toBe("B")
  })

  test("URL fallback refuses an ambiguous target", () => {
    const targets = [target("A", "https://example.test"), target("B", "https://example.test")]
    expect(() => selectCdpTarget(targets, { url: "https://example.test" })).toThrow(
      CdpTargetSelectionError,
    )
    try {
      selectCdpTarget(targets, { url: "https://example.test" })
    } catch (error) {
      expect(error).toBeInstanceOf(CdpTargetSelectionError)
      expect((error as CdpTargetSelectionError).status).toBe(409)
    }
  })

  test("missing explicit targetId is a not-found error", () => {
    expect(() => selectCdpTarget([], { targetId: "missing" })).toThrow(CdpTargetSelectionError)
    try {
      selectCdpTarget([], { targetId: "missing" })
    } catch (error) {
      expect((error as CdpTargetSelectionError).status).toBe(404)
    }
  })

  test("public summary never exposes the debugger WebSocket URL", () => {
    const input = {
      ...target("A", "https://example.test"),
      devtoolsFrontendUrl: "https://devtools.example/?ws=localhost/devtools/page/A",
    } as CdpTarget
    expect(summarizeCdpTarget(input)).toEqual({
      targetId: "A",
      type: "page",
      title: "A",
      url: "https://example.test",
    })
  })

  test("one-shot command rejects malformed protocol methods before connecting", async () => {
    await expect(cdpCommand(target("A", "https://example.test"), "Runtime")).rejects.toThrow(
      "Invalid CDP method",
    )
  })
})
