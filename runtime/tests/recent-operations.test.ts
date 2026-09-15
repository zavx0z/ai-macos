import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeUdsClient } from "../src/transport.ts"
import { createProcessFixtureHost } from "./fixtures/process-host.ts"
import { recentOperationsInputSchema, recentOperationsResultSchema } from "../src/recent-operations.ts"
import { RuntimeCore } from "../src/core.ts"

test("lost reply + Host SIGKILL: resumed lineage находит durable operation без старого target/request ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recent-operations-crash-"))
  const child = Bun.spawn([Bun.which("bun")!, new URL("./fixtures/lost-reply-host.ts", import.meta.url).pathname, directory], { stdout: "pipe", stderr: "pipe" })
  const reader = child.stdout.getReader()
  let replacement: Awaited<ReturnType<typeof createProcessFixtureHost>> | undefined
  let client: RuntimeUdsClient | undefined
  let other: RuntimeUdsClient | undefined
  const readMarker = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture marker deadline")), 5000) })])
      return new TextDecoder().decode(value.value)
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  try {
    expect(await readMarker()).toBe("ready\n")
    client = await RuntimeUdsClient.fromCredentialFile(join(directory, "runtime.sock"), join(directory, "credential.json"))
    await client.open("lost-reply-client")
    const lost = client.callTool("fixture_lost_reply", { text: "PRIVATE TEXT MUST NOT APPEAR" }, new AbortController().signal)
    expect(await readMarker()).toBe("entered\n")
    child.kill("SIGKILL")
    await child.exited
    const missed = await lost
    expect(missed.structuredContent).toBeUndefined()
    replacement = await createProcessFixtureHost(directory)
    await replacement.start()
    const listed = await client.callTool("list_recent_operations", {}, new AbortController().signal)
    const summary = recentOperationsResultSchema.parse(listed.structuredContent)
    expect(summary.operations).toHaveLength(1)
    expect(summary.operations[0]).toMatchObject({ targetKind: "clipboard", state: "dispatching", cleanup: "pending" })
    expect(Object.keys(summary.operations[0]!).sort()).toEqual(["cleanup", "operationId", "state", "targetKind", "updatedAt"])
    expect(JSON.stringify(listed)).not.toContain("PRIVATE TEXT")
    expect(JSON.stringify(listed)).not.toContain("private-request")
    const operationId = summary.operations[0]!.operationId
    expect((await client.callTool("get_operation", { operationId }, new AbortController().signal)).structuredContent).toMatchObject({ operation: { context: { operationId } } })
    expect(replacement.core.admissionSealed).toBe(true)
    other = await RuntimeUdsClient.fromCredentialFile(join(directory, "runtime.sock"), join(directory, "credential.json"))
    await other.open("fresh-same-principal")
    expect((await other.callTool("list_recent_operations", {}, new AbortController().signal)).structuredContent).toEqual({ operations: [], truncated: false })
    expect((await other.callTool("get_operation", { operationId }, new AbortController().signal)).isError).toBe(true)
    expect((await client.callTool("list_recent_operations", { principalId: "forged" }, new AbortController().signal)).isError).toBe(true)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    reader.releaseLock()
    await client?.close().catch(() => undefined)
    await other?.close().catch(() => undefined)
    await replacement?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("recent summary limit ограничен и expired/foreign session не допускается", async () => {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:recent", loginSessionId: "login:recent" }, runtimeBuildId: "build:recent" })
  const session = core.openClient("principal:recent").session
  expect(recentOperationsInputSchema.parse({}).limit).toBe(20)
  expect(recentOperationsInputSchema.safeParse({ limit: 101 }).success).toBe(false)
  await expect(core.listRecentOperations(session, 0)).rejects.toThrow()
  core.disconnectClient(session.clientSessionId)
  await expect(core.listRecentOperations(session)).rejects.toThrow()
  await core.closeClientLifecycle()
})

test("recent list сортирует только свои операции и выдаёт bounded newest summaries", async () => {
  let now = Date.now()
  const generation = { runtimeEpoch: "runtime:recent-order", loginSessionId: "login:recent-order" }
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:recent-order", clock: { now: () => new Date(now) } })
  const session = core.openClient("principal:recent-order").session
  const target = { kind: "clipboard" as const, ref: { ...generation, clipboardRef: "system" as const } }
  core.targets.register(target, "inventory:recent-order", 1, "resolution:recent-order", "proof:recent-order", 0)
  const ids: string[] = []
  let calls = 0
  try {
    for (let index = 0; index < 3; index++) {
      now += 100
      const result = await core.runOperation(session, { intent: "read", clientRequestId: `request:${index}`,
        precondition: { target, inventoryId: "inventory:recent-order", inventoryRevision: 1 }, requestedResources: [],
        deadlineAt: new Date(now + 1000).toISOString(),
      }, { secret: "not-in-summary" }, async () => { calls++; throw new Error("fixture result unavailable") })
      ids.push(result.operation.context.operationId)
    }
    const recent = await core.listRecentOperations(session, 2)
    expect(recent.operations.map(operation => operation.operationId)).toEqual([ids[2]!, ids[1]!])
    expect(recent.truncated).toBe(true)
    expect((await core.listRecentOperations(session, 100)).truncated).toBe(false)
    const other = core.openClient("principal:recent-order").session
    expect(await core.listRecentOperations(other)).toEqual({ operations: [], truncated: false })
    expect(calls).toBe(3)
    expect(JSON.stringify(recent)).not.toContain("not-in-summary")
  } finally { await core.closeClientLifecycle() }
})
