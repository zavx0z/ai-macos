import { expect, test } from "bun:test"

const enabled = process.env.AI_MACOS_REAL_SAFARI_E2E === "1"

test.skipIf(!enabled)("real Safari cmd+r fixture reload is verified and previous focus is restored", async () => {
  const fixtureTitlePrefix = process.env.AI_MACOS_SAFARI_FIXTURE_TITLE_PREFIX ?? "ai-macos-reload-count:"
  const windowApi = process.env.WINDOW_API ?? "http://127.0.0.1:7878"
  const mcpHarness = process.env.AI_MACOS_MCP_E2E_URL
  expect(mcpHarness, "Set AI_MACOS_MCP_E2E_URL to the gated HTTP harness that invokes desktop_action once").toBeTruthy()

  const beforeFocus = await fetch(`${windowApi}/v2/focus`).then((response) => response.json()) as { focused: unknown }
  const safari = await fetch(`${windowApi}/v2/windows?app=Safari`).then((response) => response.json()) as {
    windows: Array<{ title: string }>
  }
  expect(safari.windows).toHaveLength(1)
  expect(safari.windows[0]!.title.startsWith(fixtureTitlePrefix)).toBe(true)

  const result = await fetch(mcpHarness!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: "Safari", shortcut: "cmd+r", verifyTitlePrefix: fixtureTitlePrefix, deadlineMs: 12_000 }),
  }).then((response) => response.json()) as {
    status: string
    effect: { status: string }
    artifact?: { imageIncluded: boolean }
    restoration: { status: string }
  }

  expect(result.status).toBe("verified")
  expect(result.effect.status).toBe("confirmed")
  expect(result.artifact?.imageIncluded).toBe(true)
  expect(result.restoration.status).toBe("restored")
  const afterFocus = await fetch(`${windowApi}/v2/focus`).then((response) => response.json()) as { focused: unknown }
  expect(afterFocus.focused).toEqual(beforeFocus.focused)
})
