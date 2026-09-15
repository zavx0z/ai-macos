import { describe, expect, test } from "bun:test"
import type { CdpTarget } from "@meta/shared"
import { selectCreatedTarget } from "../src/target-identity.ts"

function target(id: string, url = "https://same.test"): CdpTarget {
  return {
    id,
    type: "page",
    title: id,
    url,
    webSocketDebuggerUrl: `ws://fixture/${id}`,
  }
}

describe("Android exact target creation", () => {
  test("выбирает новый targetId, а не совпавший URL или первый tab", () => {
    const created = selectCreatedTarget(
      new Set(["old-a", "old-b"]),
      [target("old-a"), target("new-c"), target("old-b")],
    )

    expect(created?.id).toBe("new-c")
  })

  test("отклоняет неоднозначное создание", () => {
    expect(() => selectCreatedTarget(
      new Set(["old"]),
      [target("old"), target("new-a"), target("new-b")],
    )).toThrow("ambiguous")
  })
})
