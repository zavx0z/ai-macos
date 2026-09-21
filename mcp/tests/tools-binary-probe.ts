import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join, isAbsolute } from "node:path"
import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// Проверяет отдельный кандидат; рабочий tunnel, Runtime и proxy не затрагивает.
const binary = process.argv[2]
assert(binary && isAbsolute(binary), "Нужен абсолютный путь собранного кандидата")
const directory = mkdtempSync(join(tmpdir(), "cu-ai-binary-"))
const path = join(directory, "file.txt")
writeFileSync(path, "before")
const transport = new StdioClientTransport({ command: binary, cwd: directory,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AI_MACOS_EXPECTED_HOSTNAME: hostname() }, stderr: "pipe" })
const c = new Client({ name: "ai-binary-probe", version: "1" })
const call = (args: Record<string, unknown>) => c.callTool({ name: "zavx0z", arguments: args }, undefined, { timeout: 10000 })
async function run(args: Record<string, unknown>) {
  const r = await call(args)
  assert(!r.isError, JSON.stringify(r))
  return r.structuredContent as Record<string, unknown>
}
try {
  await c.connect(transport)
  assert(JSON.stringify(await run({})).includes('"node":"ai"'))
  const node = "tools/filesystem/write"
  assert(JSON.stringify(await run({ node, input: { view: "contract" } })).includes("expectedHash"))
  assert(JSON.stringify(await run({ node, input: { view: "scenarios" } })).includes("typescript"))
  const read = () => run({ node: "tools/filesystem/read", action: "run", input: { path } })
  assert.equal((await read()).content, "before")
  const q = { node, action: "run", input: { path, content: "after", expectedHash: createHash("sha256").update("before").digest("hex") } }
  await run(q)
  assert.equal((await read()).content, "after")
  assert.equal((await call(q)).isError, true)
  assert.equal(readFileSync(path, "utf8"), "after")
  assert.equal((await c.listResources()).resources.length, 1)
  console.log("BINARY_PROBE_OK outside_checkout read_write_read hash_conflict contracts scenarios viewer_resource")
} finally {
  await c.close()
  await transport.close()
  rmSync(directory, { recursive: true, force: true })
}
