import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseWireValue, z } from "@meta/shared/contracts"
import { ChatProxyError, createChatExecutor, type ChatRuntimeOptions } from "./chat-executor.ts"
import { createCatalogServer } from "./catalog-server.ts"

const entryInput = z.strictObject({
  node: z.string().min(1).max(160).optional(),
  action: z.string().min(1).max(127).optional(),
  input: z.record(z.string(), z.json()).optional(),
})

/** Пустой запрос раскрывает протокол; только явный action запускает исполнитель. */
export async function startChatProxy(options: { runtime: ChatRuntimeOptions }) {
  const executor = createChatExecutor(options.runtime)
  const result = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value,
  })
  const server = createCatalogServer({
    listTools: () => [{
      name: "zavx0z", title: "Завхоз",
      description: "",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }],
    subscribeCatalogChanged: () => () => {},
    async callTool(name, args, signal) {
      if (name !== "zavx0z") return { isError: true, content: [{ type: "text", text: "Единственный MCP-инструмент — zavx0z" }] }
      try {
        const request = parseWireValue(entryInput, args, { maxBytes: 1024 * 1024, maxDepth: 32 })
        const node = request.node ?? "root"
        if (node === "root" && request.action === undefined) {
          return result({ name: "zavx0z",
            node, description: "Справка по доступным разделам. Контракты запрашиваются у Runtime при обращении к разделу.",
            children: [{ node: "computer", description: "Справка и контракты ai-macos" }],
            contract: { inputSchema: z.toJSONSchema(entryInput) },
            protocol: "Без action — справка. С action — выполнение; input необязателен и по умолчанию {}. Сначала вызовите system_health и проверьте machine.matchesExpected. Для ввода нужны check_input и свежий observe. После timeout/unknown не повторяйте действие: получите статус через get_operation/list_recent_operations.",
            next: { node: "computer" } })
        }
        if (node === "computer" && request.action === undefined) {
          const catalog = ToolSchema.array().parse(await executor.listTools())
          return result({ node, description: "Справка по операциям Mac. node с путём операции раскрывает контракт; action выполняет операцию.",
            children: catalog.map(tool => ({ node: `computer/${tool.name}`, action: tool.name, title: tool.title ?? tool.name })) })
        }
        const pathAction = node.startsWith("computer/") ? node.slice("computer/".length) : undefined
        if (node !== "computer" && pathAction === undefined) throw new ChatProxyError("TOOL_NOT_ALLOWED", "Неизвестный раздел")
        if (pathAction !== undefined && request.action !== undefined && request.action !== pathAction) {
          throw new ChatProxyError("TOOL_NOT_ALLOWED", "action не соответствует пути node")
        }
        const action = request.action ?? pathAction
        if (action === undefined) throw new ChatProxyError("TOOL_NOT_ALLOWED", "Не указано действие для справки")
        if (request.action !== undefined) {
          return await executor.call(action, request.input ?? {}, signal)
        }
        const contract = (await executor.listTools()).find(tool => tool.name === action)
        if (!contract) throw new ChatProxyError("TOOL_UNAVAILABLE", "Операция отсутствует в текущем каталоге подключения")
        return result({ node: `computer/${action}`, action, contract: ToolSchema.parse(contract),
          executed: false, invocation: { node: "computer", action },
          instruction: "Для выполнения добавьте action и при необходимости input по contract.inputSchema. Без action запрос только раскрывает контракт." })
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof ChatProxyError
          ? `${error.code}: ${error.message}` : "Запрос некорректен или Runtime недоступен. Автоматического повтора нет. Если исход действия неизвестен, запросите get_operation/list_recent_operations." }] }
      }
    },
  }, { name: "zavx0z", version: "unversioned" })
  const previousOnClose = server.onclose
  server.onclose = () => {
    previousOnClose?.()
    void executor.close().catch(() => undefined)
  }
  const close = server.close.bind(server)
  server.close = async () => {
    await close()
    await executor.close()
  }
  return server
}

if (import.meta.main) {
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw new Error(`Отсутствует ${name}`)
    return value
  }
  const server = await startChatProxy({ runtime: {
    expectedHostname: required("AI_MACOS_EXPECTED_HOSTNAME"),
    socketPath: required("META_RUNTIME_SOCKET"),
    credentialPath: required("META_RUNTIME_CREDENTIAL"),
  } })
  await server.connect(new StdioServerTransport())
}
