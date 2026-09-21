import { describe, expect, test } from "bun:test"
import { assertChatBrowserRequest, chatBrowserActions, chatBrowserDescription, chatBrowserOperationKinds } from "../src/agent-browser-policy.ts"
import { computerActions } from "../src/agent-actions.ts"

describe("ChatGPT browser connection/read policy", () => {
  test("publishes only the existing Runtime browser methods needed for attach/read/recovery", () => {
    for (const action of chatBrowserActions) expect(computerActions).toContain(action)
    expect(chatBrowserActions).toEqual([
      "browser_chrome_instances", "browser_chrome_targets", "browser_chrome_operation",
      "browser_chrome_reservation", "browser_chrome_resume", "browser_chrome_recover",
    ])
  })

  test("allows connect, disconnect, bounded reads and capture", () => {
    expect(chatBrowserOperationKinds).toContain("read-resource")
    for (const kind of chatBrowserOperationKinds) {
      expect(() => assertChatBrowserRequest("browser_chrome_operation", { request: { kind } })).not.toThrow()
    }
  })

  test("rejects page mutation and arbitrary commands, including malformed requests", () => {
    for (const kind of ["evaluate", "cdp-command", "open-target", "close-target", "activate-target", "navigate-target", "reload-target", "Browser.close"]) {
      expect(() => assertChatBrowserRequest("browser_chrome_operation", { request: { kind } })).toThrow("разрешены только")
    }
    for (const input of [{}, { request: null }, { request: [] }, { request: { kind: 1 } }, { request: "read-dom" }]) {
      expect(() => assertChatBrowserRequest("browser_chrome_operation", input)).toThrow()
    }
  })

  test("Runtime policy rejects before any browser child is invoked", () => {
    expect(() => assertChatBrowserRequest("browser_chrome_operation", { request: { kind: "navigate-target" } })).toThrow("разрешены только")
  })

  test("describes the extra restriction without changing other tool descriptions", () => {
    expect(chatBrowserDescription("system_health", "passive")).toBe("passive")
    const description = chatBrowserDescription("browser_chrome_operation", "Runtime operation")!
    expect(description).toContain("connect-instance")
    expect(description).toContain("read-dom")
    expect(description).toContain("get_operation")
    expect(description).not.toContain("navigate-target")
  })
})
