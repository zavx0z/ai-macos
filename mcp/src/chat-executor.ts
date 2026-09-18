import { hostname } from "node:os"
import { RuntimeUdsClient } from "@meta/runtime"

export const computerActions = [
  "system_health", "get_state", "observe", "show_window", "check_input", "click",
  "type_text", "press_key", "press_shortcut", "scroll", "get_target_status",
  "cancel_target", "get_operation", "list_recent_operations", "recover_startup_input",
] as const

export class ChatProxyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface ChatRuntimeOptions {
  expectedHostname: string
  socketPath: string
  credentialPath: string
  allowedActions?: readonly string[]
}

/** Ленивый исполнитель: проверяет машину, использует текущий API Runtime, не повторяет операции. */
export function createChatExecutor(options: ChatRuntimeOptions) {
  let client: RuntimeUdsClient | undefined
  let connecting: Promise<RuntimeUdsClient> | undefined
  let closed = false
  const allowed = new Set<string>(options.allowedActions ?? computerActions)
  const assertAllowed = (action: string) => {
    if (!allowed.has(action)) throw new ChatProxyError("TOOL_NOT_ALLOWED", "Операция не разрешена этим подключением")
  }
  const checkHealth = async (current: RuntimeUdsClient, signal: AbortSignal) => {
    const health = await current.callTool("system_health", {}, signal)
    const machine = health.structuredContent?.machine as { matchesExpected?: boolean, hostname?: string } | undefined
    if (health.isError || machine?.matchesExpected !== true || machine.hostname !== options.expectedHostname) {
      throw new Error("Машина Runtime не подтверждена")
    }
    return health
  }
  const connect = async () => {
    if (closed) throw new Error("Исполнитель закрыт")
    if (hostname() !== options.expectedHostname) throw new Error("Машина прокси не совпадает с ожидаемой")
    if (client) return client
    connecting ??= (async () => {
      const candidate = await RuntimeUdsClient.fromCredentialFile(options.socketPath, options.credentialPath)
      try {
        await candidate.open(`chat-proxy:${process.pid}`)
        await checkHealth(candidate, AbortSignal.timeout(5000))
        if (closed) throw new Error("Исполнитель закрыт")
        client = candidate
        return candidate
      } catch (error) {
        await candidate.close().catch(() => undefined)
        throw error
      }
    })().finally(() => { connecting = undefined })
    return connecting
  }
  return {
    async listTools() {
      const current = await connect()
      return (await current.listTools()).filter(tool => allowed.has(tool.name))
    },
    async call(action: string, input: Record<string, unknown>, signal: AbortSignal) {
      assertAllowed(action)
      signal.throwIfAborted()
      const current = await connect()
      signal.throwIfAborted()
      const health = await checkHealth(current, signal)
      if (action === "system_health") return health
      // Runtime сам проверяет текущие schema, admission и capabilities при вызове.
      signal.throwIfAborted()
      return await current.callTool(action, input, signal)
    },
    async close() {
      closed = true
      await connecting?.catch(() => undefined)
      await client?.close()
    },
  }
}
