import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const enabled = process.env.AI_MACOS_REAL_SAFARI_E2E === "1"
let transport: StdioClientTransport | undefined

afterEach(async () => {
  await transport?.close()
  transport = undefined
})

test.skipIf(!enabled)("one desktop_action reloads the exact Safari fixture and restores exact focus", async () => {
  const fixtureTitlePrefix = "ai-macos-reload-count:"
  const windowApi = process.env.WINDOW_API ?? "http://127.0.0.1:7878"

  const beforeFocus = await fetch(`${windowApi}/v2/focus`).then((response) => response.json()) as { focused: unknown }
  const safari = await fetch(`${windowApi}/v2/windows?app=Safari`).then((response) => response.json()) as {
    windows: Array<{ title: string }>
  }
  expect(safari.windows, "Run `bun run safari:fixture`, then open http://127.0.0.1:18999/ in exactly one Safari window").toHaveLength(1)
  expect(safari.windows[0]!.title.startsWith(fixtureTitlePrefix)).toBe(true)

  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      WINDOW_API: windowApi,
      SCREEN_API: process.env.SCREEN_API ?? "http://127.0.0.1:7879",
      INPUT_API: process.env.INPUT_API ?? "http://127.0.0.1:7882",
    },
  })
  const client = new Client({ name: "safari-reload-e2e", version: "1.0.0" })
  await client.connect(transport)

  const called = await client.callTool({
    name: "desktop_action",
    arguments: {
      target: { kind: "app", value: "Safari" },
      shortcut: "cmd+r",
      verifyTitlePrefix: fixtureTitlePrefix,
      deadlineMs: 12_000,
    },
  })
  expect(called.isError).not.toBe(true)
  expect(called.structuredContent).toMatchObject({
    status: "verified",
    delivery: { status: "delivered" },
    effect: { status: "confirmed" },
    artifact: { imageIncluded: true, mimeType: "image/png" },
    restoration: { status: "restored" },
  })
  expect(called.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png" }))

  const afterFocus = await fetch(`${windowApi}/v2/focus`).then((response) => response.json()) as { focused: unknown }
  expect(afterFocus.focused).toEqual(beforeFocus.focused)
})
