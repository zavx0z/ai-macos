import { assertChatBrowserRequest } from "./browser-policy.ts"
import { ChatProxyError } from "./service-client.ts"

// Это политика подключения, не вторая схема Runtime. Новый вид шага
// не получает разрешение автоматически после обновления одного Runtime.
const stepActions = new Map<string, readonly string[]>([
  ["wait", []],
  ["press", ["check_input", "click"]],
  ["keys", ["check_input", "press_shortcut"]],
  ["chrome-connect", ["browser_chrome_instances", "browser_chrome_operation", "get_operation"]],
  ["chrome-consent", ["check_input", "click", "get_operation"]],
  ["chrome-wait", ["browser_chrome_instances", "browser_chrome_reservation", "get_operation"]],
  ["chrome-read", ["browser_chrome_targets", "browser_chrome_operation"]],
  ["chrome-disconnect", ["browser_chrome_instances", "browser_chrome_operation", "browser_chrome_reservation"]],
])

function denied(reason: string): never {
  throw new ChatProxyError("TOOL_NOT_ALLOWED", `Конвейер не разрешён этим подключением: ${reason}`)
}

/** Проверяет весь план до подключения к Runtime, включая чтение receipt и cleanup. */
export function assertChatPipelineRequest(
  action: string,
  input: Record<string, unknown>,
  allowedActions: ReadonlySet<string>,
): void {
  if (action !== "run_pipeline") return
  const steps = input.steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 16) denied("требуется от 1 до 16 шагов")
  const requireAction = (name: string) => {
    if (!allowedActions.has(name)) denied(`операция ${name} отсутствует в whitelist`)
  }
  // Общие проверки окна и финальное наблюдение тоже сохраняют политику клиента.
  for (const name of ["run_pipeline", "system_health", "get_state", "observe"]) requireAction(name)
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) denied("некорректный шаг")
    const kind: unknown = step.kind
    const required = typeof kind === "string" ? stepActions.get(kind) : undefined
    if (!required) denied("неизвестный вид шага")
    for (const name of required) requireAction(name)
    let browserKind: string | undefined
    if (kind === "chrome-connect") browserKind = "connect-instance"
    if (kind === "chrome-disconnect") browserKind = "disconnect-instance"
    if (kind === "chrome-read") {
      const mode: unknown = step.mode
      if (mode !== undefined && mode !== "dom" && mode !== "accessibility") denied("неизвестный режим чтения Chrome")
      browserKind = mode === "accessibility" ? "read-accessibility" : "read-dom"
    }
    if (browserKind) assertChatBrowserRequest("browser_chrome_operation", { request: { kind: browserKind } })
  }
}

export function chatPipelineDescription(name: string, description?: string): string | undefined {
  if (name !== "run_pipeline") return description
  return `${description ?? "Локальный конвейер"}. Политика чата проверяет весь план до выполнения: вложенные действия не расширяют whitelist этого подключения; неизвестные шаги запрещены. Ограничения Chrome на подключение и чтение сохраняются. Полную схему, фокус, lineage, admission и receipts проверяет Runtime. После unknown сначала get_operation/list_recent_operations, без повторного исполнения.`
}
