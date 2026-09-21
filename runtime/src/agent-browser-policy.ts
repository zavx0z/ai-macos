import { AgentServiceError as ChatProxyError } from "./agent-service-errors.ts"

export const chatBrowserActions = [
  "browser_chrome_instances", "browser_chrome_targets", "browser_chrome_operation",
  "browser_chrome_reservation", "browser_chrome_resume", "browser_chrome_recover",
] as const

export const chatBrowserOperationKinds = [
  "connect-instance", "disconnect-instance", "wait-target", "capture-target",
  "read-console", "read-dom", "read-resource", "read-accessibility",
] as const
const allowedKinds = new Set<string>(chatBrowserOperationKinds)

/** Connection/read-only rollout. No generic CDP, evaluation, navigation or tab mutation through ChatGPT. */
export function assertChatBrowserRequest(action: string, input: Record<string, unknown>): void {
  if (action !== "browser_chrome_operation") return
  const request = input.request
  const kind = request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>).kind
    : undefined
  if (typeof kind !== "string" || !allowedKinds.has(kind)) {
    throw new ChatProxyError("TOOL_NOT_ALLOWED", `Через Завхоз разрешены только CDP-подключение и чтение: ${chatBrowserOperationKinds.join(", ")}`)
  }
}

export function chatBrowserDescription(name: string, description?: string): string | undefined {
  if (name !== "browser_chrome_operation") return description
  return `${description ?? "Chrome operation"}. Дополнительное ограничение этого подключения: request.kind только ${chatBrowserOperationKinds.join(", ")}. Контракт Runtime не отменяет эту политику. После unknown сначала get_operation; не подключаться повторно автоматически.`
}
