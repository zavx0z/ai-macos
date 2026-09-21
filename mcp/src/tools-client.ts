import { posix } from "node:path"
import { hostname } from "node:os"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createDispatcher, type DispatcherInput } from "../../vendor/tools/server/dispatch/index.ts"
import { ToolError } from "../../vendor/tools/shared/errors.ts"
import { toolsSources } from "./tools-metadata.ts"
import { ChatProxyError, type ServiceClient } from "./service-client.ts"

export interface ToolsClientOptions {
  expectedHostname?: string
  authorize?: DispatcherInput["authorize"]
}

function readSource(name: string, optional = false): string | null {
  name = posix.normalize(name)
  if (Object.hasOwn(toolsSources, name)) return toolsSources[name]!
  if (optional) return null
  throw new ToolError("METADATA_MISSING", "Нет упакованных метаданных tools", 500)
}

function result(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
    structuredContent: value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : { result: value },
  }
}

/** Встраивание без HTTP, второго MCP, Runtime и workspace. */
export function createToolsClient(options: ToolsClientOptions = {}): ServiceClient {
  const { expectedHostname, authorize = () => true } = options
  let closed = false
  function assertHost() {
    if (closed) throw new ChatProxyError("SERVICE_CLOSED", "Сервис tools закрыт")
    if (!expectedHostname || hostname() !== expectedHostname) {
      throw new ChatProxyError("MACHINE_MISMATCH", "Ожидаемая машина не подтверждена")
    }
  }
  return {
    listTools: async () => [],
    call: async () => {
      throw new ChatProxyError("STRUCTURED_SERVICE", "Используйте полный node ai и action: run")
    },
    request: async (request, signal) => {
      try {
        if (closed) throw new ChatProxyError("SERVICE_CLOSED", "Сервис tools закрыт")
        signal.throwIfAborted()
        const { node, action, input } = request
        if (action !== undefined && action !== "run") throw new ToolError("ACTION_NOT_ALLOWED", "Только action: run выполняет операцию")
        const dispatcher = createDispatcher({
          repositoryRoot: "embedded:tools", readSource, signal,
          authorize: async invocation => {
            assertHost()
            const allowed = await authorize?.(invocation)
            signal.throwIfAborted()
            assertHost()
            return allowed === true
          },
        })
        const value = await dispatcher.dispatch({ node, ...(action === undefined ? {} : { action }), ...(input === undefined ? {} : { input }) })
        // После синхронного эффекта не подменяем результат поздней отменой.
        return result(value)
      } catch (error) {
        const known = error instanceof ToolError || error instanceof ChatProxyError
        return {
          ...result({ error: {
            code: known ? error.code : signal.aborted ? "CANCELLED_OR_UNKNOWN" : "SERVICE_UNAVAILABLE_OR_UNKNOWN",
            message: known ? error.message : "Результат не подтверждён. Проверьте состояние, не повторяйте изменение.",
            ...(error instanceof ToolError && error.details !== undefined ? { details: error.details } : {}),
          }, automaticRetry: false }),
          isError: true,
        }
      }
    },
    close: () => { closed = true },
  }
}
