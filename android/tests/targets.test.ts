import { describe, expect, test } from "bun:test"
import type { CdpTarget } from "@meta/shared"
import { newTab, type AndroidTargetCreationDeps } from "../src/android.ts"
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

  test("intent всегда получает явный serial и возвращает exact diff target", async () => {
    let time = 0
    let inventory = 0
    const opened: Array<{ serial: string; url: string }> = []
    const deps: AndroidTargetCreationDeps = {
      async listTargets() {
        inventory += 1
        return inventory === 1 ? [target("old")] : [target("old"), target("created")]
      },
      async openUrl(serial, url) {
        opened.push({ serial, url })
      },
      async delay(ms) {
        time += ms
      },
      now() {
        return time
      },
    }

    const created = await newTab("phone-b", "https://same.test", deps)
    expect(opened).toEqual([{ serial: "phone-b", url: "https://same.test" }])
    expect(created.id).toBe("created")
  })
})
