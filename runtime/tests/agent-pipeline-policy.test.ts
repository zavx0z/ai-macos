import { describe, expect, test } from "bun:test"
import { computerActions } from "../src/agent-actions.ts"
import { assertChatPipelineRequest, chatPipelineDescription } from "../src/agent-pipeline-policy.ts"

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
  test("профиль Runtime не расширяет явное ограничение клиента", () => {
    expect(computerActions).toContain("run_pipeline")
    expect(() => check(plan().steps, new Set(["system_health"]))).toThrow("операция run_pipeline отсутствует")
  })

  test("разрешает только известные AX и Chrome шаги; полную схему проверяет Runtime", () => {
    for (const kind of ["wait", "press", "keys", "chrome-connect", "chrome-consent", "chrome-wait", "chrome-read", "chrome-disconnect"]) {
      expect(() => check([{ kind }])).not.toThrow()
    }
    for (const mode of [undefined, "dom", "accessibility", "resource"]) expect(() => check([{ kind: "chrome-read", mode }])).not.toThrow()
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

  test("проверяет весь план до первого дочернего действия", () => {
    const restricted = new Set<string>(computerActions.filter(action => action !== "click"))
    expect(() => check([...plan().steps, { kind: "press" }], restricted)).toThrow("операция click отсутствует")
    expect(() => check([{ kind: "evaluate" }])).toThrow("неизвестный вид шага")
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
