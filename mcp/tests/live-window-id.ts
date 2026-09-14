/** Explicit opt-in integration test. Never run as part of the unit suite. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { join } from "node:path"

if (process.env.AI_MACOS_LIVE_TEST !== "1" || !process.env.AI_MACOS_EXPECTED_HOSTNAME) {
  throw new Error("Requires explicit AI_MACOS_LIVE_TEST=1 and expected hostname")
}
const phase = process.argv[2]
if (!["capture", "cancel", "open"].includes(phase ?? "")) throw new Error("phase must be capture, cancel or open")
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const target = await Bun.file(join(root, "tmp/live-window-target.json")).json()
const transport = new StdioClientTransport({
  command: process.execPath, args: ["src/index.ts"], cwd: join(root, "mcp"),
  env: {...process.env, AI_MACOS_EXPECTED_HOSTNAME: process.env.AI_MACOS_EXPECTED_HOSTNAME!},
})
const client = new Client({name: "explicit-live-window-id-test", version: "1.0.0"})
try {
  await client.connect(transport)
  const health = (await client.callTool({name: "system_health", arguments: {}})).structuredContent as any
  if (health?.machine?.matchesExpected !== true || !health.window?.ok || !health.screen?.ok || !health.input?.ok) throw new Error("preflight failed")
  const ready = (await client.callTool({name: "input_readiness", arguments: {}})).structuredContent as any
  if (ready?.inputReady !== true) {
    await Bun.write(join(root, `tmp/stable-window-${phase}-preflight-failure.json`), JSON.stringify({health, ready}, null, 2))
    throw new Error("input not ready; no input dispatched")
  }
  const inventory = (await client.callTool({name: "list_windows", arguments: {app: target.app}})).structuredContent as any
  const before = inventory.windows.find((w: any) => w.pid === target.pid && w.windowId === target.windowId)
  if (!before) throw new Error("provided stable target no longer exists")
  const focus = await client.callTool({name: "focus_window", arguments: {...target, index: 999, title: "intentionally stale title"}})
  if ((focus.structuredContent as any)?.target?.windowId !== target.windowId) throw new Error("stable focus selected wrong window")
  const focused = focus.structuredContent as any
  if (phase === "cancel" && focused.focusedSheet?.ownerWindowId !== target.windowId) throw new Error("expected an owned native Save/Open sheet before cancel")
  if (phase === "open" && focused.focusedSheet) throw new Error("a sheet is already open; do not open or submit it again")
  let result: any
  if (phase === "cancel") {
    result = await client.callTool({name: "keyboard_key", arguments: {...target, key: "escape"}})
  } else if (phase === "open") {
    result = await client.callTool({name: "keyboard_shortcut", arguments: {...target, shortcut: "cmd+s"}})
  } else {
    result = await client.callTool({name: "capture_window", arguments: {...target, index: 999, title: "stale title", caption: "Expected Yandex Save dialog attached to stable parent window 6627"}})
  }
  const afterInventory = (await client.callTool({name: "list_windows", arguments: {app: target.app}})).structuredContent as any
  const after = afterInventory.windows.find((w: any) => w.pid === target.pid && w.windowId === target.windowId)
  if (!after) throw new Error("parent stable ID disappeared")
  const proof = {phase, server: client.getServerVersion(), before, after, focus: focus.structuredContent, result: result.structuredContent}
  const image = result.content?.find((c: any) => c.type === "image")
  if (image) await Bun.write(join(root, `tmp/stable-window-${phase}.png`), Buffer.from(image.data, "base64"))
  await Bun.write(join(root, `tmp/stable-window-${phase}.json`), JSON.stringify(proof, null, 2))
  if (result.isError || result.structuredContent?.ok !== true) throw new Error(`phase failed; inspect tmp/stable-window-${phase}.json`)
  if (phase === "open" && result.structuredContent.frontmostAfterInput?.window?.ownerWindowId !== target.windowId) throw new Error("sheet owner ID not verified")
  if (phase === "cancel" && result.structuredContent.frontmostAfterInput?.window?.windowId !== target.windowId) throw new Error("parent focus not verified after sheet closed")
  console.log(JSON.stringify({phase, server: proof.server, windowId: target.windowId, beforeIndex: before.index, afterIndex: after.index, ok: true, screenshot: join(root, `tmp/stable-window-${phase}.png`)}))
} finally {
  await transport.close()
}
