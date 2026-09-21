import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntimeHost } from "@meta/runtime"
import { CAPABILITY_IDS } from "@meta/shared/contracts"
import { computerActions, createChatExecutor } from "../src/chat-executor.ts"
import { assertChatPipelineRequest, chatPipelineDescription } from "../src/pipeline-policy.ts"
import { startChatProxy } from "../src/chat-proxy.ts"

const allowed = new Set<string>(computerActions)
const condition = { anchors: [{ name: "button", selector: { role: "AXButton", text: "Fixture" } }], select: "button" }
const plan = () => ({
  clientRequestId: "pipeline:proxy-test", runtimeEpoch: "runtime:stale", targetId: "target:fixture",
  expectedBundleId: "com.google.Chrome", steps: [{ id: "wait", kind: "wait", when: condition }],
  final: { condition, caption: "Изолированный тест, без настоящего снимка" },
})
const check = (steps: unknown, permissions: ReadonlySet<string> = allowed) =>
  assertChatPipelineRequest("run_pipeline", { ...plan(), steps }, permissions)

describe("Политика локального конвейера ChatGPT", () => {
  test("имя доступно по умолчанию, но не расширяет явный список клиента", async () => {
    expect(computerActions).toContain("run_pipeline")
    const executor = createChatExecutor({ expectedHostname: "not-this-machine.invalid",
      socketPath: "/does/not/exist", credentialPath: "/does/not/exist", allowedActions: ["system_health"] })
    try {
      await expect(executor.call("run_pipeline", plan(), new AbortController().signal)).rejects.toThrow("Операция не разрешена")
    } finally { await executor.close() }
  })

  test("разрешает только известные AX и Chrome шаги; полную схему проверяет Runtime", () => {
    for (const kind of ["wait", "press", "keys", "chrome-connect", "chrome-consent", "chrome-wait", "chrome-read", "chrome-disconnect"]) {
      expect(() => check([{ kind }])).not.toThrow()
    }
    for (const mode of [undefined, "dom", "accessibility"]) expect(() => check([{ kind: "chrome-read", mode }])).not.toThrow()
    expect(() => check(Array.from({ length: 16 }, () => ({ kind: "wait" })))).not.toThrow()
  })

  test("не принимает произвольные методы, вложенные конвейеры и будущие виды шагов", () => {
    for (const kind of ["evaluate", "cdp-command", "navigate-target", "chrome-evaluate", "shell", "run_pipeline", "type_text", "__proto__", "constructor"]) {
      expect(() => check([{ kind }])).toThrow("неизвестный вид шага")
    }
    for (const steps of [undefined, null, {}, [], "wait", Array.from({ length: 17 }, () => ({ kind: "wait" })),
      [null], [[]], ["wait"], [{}], [{ kind: 1 }]]) {
      expect(() => check(steps)).toThrow("Конвейер не разрешён")
    }
    for (const mode of ["evaluate", "console", "DOM.getDocument", "", null, 1, {}]) {
      expect(() => check([{ kind: "chrome-read", mode }])).toThrow("режим чтения")
    }
  })

  test("нельзя обойти запрет дочернего действия, receipt, reservation или финального observe", () => {
    const cases: Array<[string, string]> = [
      ["wait", "run_pipeline"], ["wait", "system_health"], ["wait", "get_state"], ["wait", "observe"],
      ["press", "click"], ["press", "check_input"], ["keys", "press_shortcut"], ["keys", "check_input"],
      ["chrome-consent", "click"], ["chrome-consent", "get_operation"], ["chrome-consent", "check_input"],
      ["chrome-connect", "browser_chrome_instances"], ["chrome-connect", "browser_chrome_operation"], ["chrome-connect", "get_operation"],
      ["chrome-wait", "get_operation"], ["chrome-wait", "browser_chrome_instances"], ["chrome-wait", "browser_chrome_reservation"],
      ["chrome-read", "browser_chrome_targets"], ["chrome-read", "browser_chrome_operation"],
      ["chrome-disconnect", "browser_chrome_instances"], ["chrome-disconnect", "browser_chrome_operation"],
      ["chrome-disconnect", "browser_chrome_reservation"],
    ]
    for (const [kind, missing] of cases) {
      const restricted = new Set(allowed)
      restricted.delete(missing)
      expect(() => check([{ kind }], restricted)).toThrow(`операция ${missing} отсутствует`)
    }
    // Чистое AX-ожидание не требует лишних прав на Chrome или клавиатуру.
    expect(() => check([{ kind: "wait" }], new Set(["run_pipeline", "system_health", "get_state", "observe"]))).not.toThrow()
  })

  test("отклоняет запрещённый поздний шаг до подключения, не исполняя разрешённый префикс", async () => {
    const executor = createChatExecutor({ expectedHostname: "not-this-machine.invalid",
      socketPath: "/does/not/exist", credentialPath: "/does/not/exist",
      allowedActions: computerActions.filter(action => action !== "click") })
    try {
      await expect(executor.call("run_pipeline", { ...plan(), steps: [
        ...plan().steps, { id: "press", kind: "press", when: condition },
      ] }, new AbortController().signal)).rejects.toThrow("операция click отсутствует")
      await expect(executor.call("run_pipeline", { ...plan(), steps: [{ id: "unsafe", kind: "evaluate" }] },
        new AbortController().signal)).rejects.toThrow("неизвестный вид шага")
    } finally { await executor.close() }
  })

  test("не меняет другие методы и сохраняет ограничения в описании", () => {
    expect(() => assertChatPipelineRequest("system_health", {}, new Set())).not.toThrow()
    expect(chatPipelineDescription("observe", "Прежнее описание")).toBe("Прежнее описание")
    const description = chatPipelineDescription("run_pipeline", "Runtime AX")!
    expect(description).toContain("Runtime AX")
    expect(description).toContain("whitelist")
    expect(description).toContain("get_operation/list_recent_operations")
    expect(description).toContain("неизвестные шаги запрещены")
  })
})

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
