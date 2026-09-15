import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeUdsClient } from "../src/transport.ts"
import { createProcessFixtureHost } from "./fixtures/process-host.ts"

test("RuntimeHost SIGKILL освобождает kernel lease, reclaim stale artifacts и сохраняет client lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-crash-"))
  const child = Bun.spawn([Bun.which("bun")!, new URL("./fixtures/process-host.ts", import.meta.url).pathname, directory], { stdout: "pipe", stderr: "pipe" })
  let replacement: Awaited<ReturnType<typeof createProcessFixtureHost>> | undefined
  let client: RuntimeUdsClient | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reader = child.stdout.getReader()
    try {
      const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture host startup timeout")), 5000) })])
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
    } finally { reader.releaseLock(); if (timer !== undefined) clearTimeout(timer) }
    client = await RuntimeUdsClient.fromCredentialFile(join(directory, "runtime.sock"), join(directory, "credential.json"))
    await client.open("process-crash")
    const first = (await client.callTool("lineage", {}, new AbortController().signal)).structuredContent!
    child.kill("SIGKILL")
    await child.exited
    expect((await stat(join(directory, "runtime.sock"))).isSocket()).toBe(true)
    expect((await stat(join(directory, "credential.json"))).isFile()).toBe(true)
    replacement = await createProcessFixtureHost(directory)
    await replacement.start()
    const next = (await client.callTool("lineage", {}, new AbortController().signal)).structuredContent!
    expect(next.lineage).toBe(first.lineage)
    expect(next.epoch).not.toBe(first.epoch)
    await client.close()
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await replacement?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
