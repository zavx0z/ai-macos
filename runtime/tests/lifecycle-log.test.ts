import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeLifecycleLog } from "../src/lifecycle-log.ts"

test("lifecycle log сохраняет bounded epoch/reason и не содержит пользовательских полей", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifecycle-log-"))
  try {
    const log = new RuntimeLifecycleLog({ directory, runtimeEpoch: "runtime:log", loginSessionId: "login:log",
      nativeGeneration: "native:log", nativeBuildId: "build:log" })
    await Promise.all([log.record("host-start"), log.record("rotation-trigger", "Native transport disconnected")])
    expect(await log.entries()).toMatchObject([
      { event: "host-start", runtimeEpoch: "runtime:log", nativeGeneration: "native:log" },
      { event: "rotation-trigger", reason: "Native transport disconnected" },
    ])
    const text = await readFile(join(directory, "lifecycle.json"), "utf8")
    expect(text).not.toContain("title")
    expect(text).not.toContain("clipboard")
    expect(text).not.toContain("payload")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("lifecycle history ограничена последними128 событиями", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifecycle-limit-"))
  try {
    const log = new RuntimeLifecycleLog({ directory, runtimeEpoch: "runtime:limit", loginSessionId: "login:limit" })
    for (let index = 0; index < 130; index++) await log.record("rotation-trigger", `reason:${index}`)
    const entries = await log.entries()
    expect(entries).toHaveLength(128)
    expect(entries[0]?.reason).toBe("reason:2")
    expect(entries[127]?.reason).toBe("reason:129")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
