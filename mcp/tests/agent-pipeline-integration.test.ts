import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntimeHost } from "@meta/runtime"
import { CAPABILITY_IDS } from "@meta/shared/contracts"
import { computerActions } from "../../runtime/src/agent-actions.ts"
import { createChatExecutor } from "../../mcp/src/chat-executor.ts"
import { assertChatPipelineRequest, chatPipelineDescription } from "../../runtime/src/agent-pipeline-policy.ts"
import { startChatProxy } from "../../mcp/src/chat-proxy.ts"

const allowed = new Set<string>(computerActions)
const condition = { anchors: [{ name: "button", selector: { role: "AXButton", text: "Fixture" } }], select: "button" }
const plan = () => ({
  clientRequestId: "pipeline:proxy-test", runtimeEpoch: "runtime:stale", targetId: "target:fixture",
  expectedBundleId: "com.google.Chrome", steps: [{ id: "wait", kind: "wait", when: condition }],
  final: { condition, caption: "Изолированный тест, без настоящего снимка" },
})
const check = (steps: unknown, permissions: ReadonlySet<string> = allowed) =>
  assertChatPipelineRequest("run_pipeline", { ...plan(), steps }, permissions)


test("единый zavx0z публикует конвейер только при доступности Runtime и не подменяет его схему", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-pipeline-catalog-"))
  const runtime = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"), expectedHostname: hostname() }
  const host = await createRuntimeHost({ ...runtime, loginSessionId: "login:pipeline-catalog",
    runtimeBuildId: "runtime:pipeline-catalog", expectedNativeBuildId: "native:unused" })
  const server = await startChatProxy({ runtime })
  const client = new Client({ name: "pipeline-catalog-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const call = (args: Record<string, unknown>) => client.callTool({ name: "zavx0z", arguments: args })
  try {
    await host.start()
    await Promise.all([client.connect(ct), server.connect(st)])
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["zavx0z", "codex_app", "codex_app_next"])
    expect((await call({ node: "computer/run_pipeline" })).isError).toBe(true)
    host.core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "test:pipeline-proxy",
      capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
    const contract = await call({ node: "computer/run_pipeline" })
    expect(contract.isError).not.toBe(true)
    expect(contract.structuredContent).toMatchObject({ executed: false, contract: { name: "run_pipeline", _meta: { timeoutMs: 30_000 } } })
    const invalid = await call({ node: "computer", action: "run_pipeline", input: {
      ...plan(), steps: [{ id: "wait", kind: "wait", when: condition, script: "not allowed" }],
    } })
    expect(invalid.isError).toBe(true)
    const stale = await call({ node: "computer", action: "run_pipeline", input: plan() })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain("epoch is stale")
    expect(host.core.activeOperationCount()).toBe(0)
  } finally {
    await client.close()
    await server.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("подмена исходного объекта во время await не изменяет проверенный план", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-pipeline-snapshot-"))
  const runtime = { socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"), expectedHostname: hostname() }
  const host = await createRuntimeHost({ ...runtime, loginSessionId: "login:pipeline-snapshot",
    runtimeBuildId: "runtime:pipeline-snapshot", expectedNativeBuildId: "native:unused" })
  const executor = createChatExecutor(runtime)
  try {
    await host.start()
    host.core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "test:pipeline-snapshot",
      capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
    const input = plan()
    const pending = executor.call("run_pipeline", input, new AbortController().signal)
    input.steps[0]!.kind = "evaluate"
    // Дошёл исходный валидный план с устаревшей epoch, а не подменённый шаг.
    const result = await pending
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("epoch is stale")
    expect(host.core.activeOperationCount()).toBe(0)
  } finally {
    await executor.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
