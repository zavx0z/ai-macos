import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { parseWireValue, z } from "@meta/shared/contracts"
import { ChatProxyError, createChatExecutor, type ChatRuntimeOptions } from "./chat-executor.ts"
import { createCatalogServer } from "./catalog-server.ts"
import { SCREENSHOT_UI_DOMAIN, SCREENSHOT_UI_URI, chatScreenshotUiHtml } from "./screenshot-ui.ts"

const entryInput = z.strictObject({
  node: z.string().min(1).max(160).optional().describe("Раздел справки: root, computer или computer/<операция>. По умолчанию root."),
  action: z.string().min(1).max(127).optional().describe("Выполнить операцию из каталога выбранного раздела. Без action возвращается только справка."),
  input: z.record(z.string(), z.json()).optional().describe("Аргументы операции по её динамическому inputSchema. По умолчанию {}. Само наличие input не запускает действие."),
})
const entryInputSchema = z.toJSONSchema(entryInput) as Tool["inputSchema"]
const entryProtocol = "Один вход для справки и выполнения. {} возвращает корневую справку; {node:'computer'} — каталог; {node:'computer/<операция>'} — контракт без выполнения; {node:'computer',action:'<операция>',input:{...}} — выполнение. Сначала выполните system_health и проверьте machine.matchesExpected=true. Для ввода соблюдайте строгий порядок: check_input, затем fresh observe, затем одно действие; check_input после observe инвалидирует observation. Если пользователь просит посмотреть экран/рабочий стол, выбирайте display target; для конкретного приложения или окна — window target. После видимого изменения получите свежий screenshot нужной цели. UI получает кадр этого результата; открытие PiP и доставка следующих результатов зависят от хоста. Не объявляйте PiP работающим по одному успешному capture. Не дублируйте снимок отдельной картинкой в ответе. Не останавливайте proxy/tunnel через управляемый ими Terminal: обновление выполняет внешний scripts/chat-proxy-install.ts. После timeout/unknown/partial не повторяйте действие: запросите get_operation/list_recent_operations."

/** Пустой запрос раскрывает протокол; только явный action запускает исполнитель. */
export async function startChatProxy(options: { runtime: ChatRuntimeOptions }) {
  const executor = createChatExecutor(options.runtime)
  const screenshotStream = crypto.randomUUID()
  let screenshotRequest = 0

  const result = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  })

  const withScreenshot = (response: CallToolResult, version: number, input: Record<string, unknown>): CallToolResult => {
    const image = response.content?.find(item => item.type === "image" && typeof item.data === "string")
    const responseMeta = response._meta as Record<string, unknown> | undefined
    const privateScreenshot = responseMeta?.screenshot as { data?: unknown, mimeType?: unknown } | undefined
    const data = image?.type === "image" ? image.data
      : typeof privateScreenshot?.data === "string" ? privateScreenshot.data
      : undefined
    if (data === undefined) return response
    const mimeType = image?.type === "image" ? image.mimeType
      : typeof privateScreenshot?.mimeType === "string" ? privateScreenshot.mimeType
      : "image/png"
    const structured = response.structuredContent && typeof response.structuredContent === "object"
      ? response.structuredContent as Record<string, unknown>
      : {}
    // Кадр принадлежит конкретному результату. Общего latest-frame между чатами нет.
    // ImageContent сохраняется: без него модель потеряет визуальное наблюдение.
    return {
      ...response,
      _meta: {
        ...response._meta,
        screenshot: {
          data, mimeType, version, streamId: screenshotStream,
          ...(typeof input.caption === "string" ? { caption: input.caption }
            : typeof structured.caption === "string" ? { caption: structured.caption } : {}),
        },
      },
    }
  }

  const server = createCatalogServer({
    listTools: () => [{
      name: "zavx0z",
      title: "Завхоз",
      description: entryProtocol,
      inputSchema: entryInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: SCREENSHOT_UI_URI, visibility: ["model"] },
        "openai/outputTemplate": SCREENSHOT_UI_URI,
        "openai/widgetAccessible": false,
        "openai/toolInvocation/invoking": "Working on Mac…",
        "openai/toolInvocation/invoked": "Mac state updated.",
      },
    }],
    listResources: () => [{
      uri: SCREENSHOT_UI_URI,
      name: "zavx0z desktop PiP",
      mimeType: "text/html;profile=mcp-app",
    }],
    readResource: (uri) => {
      if (uri !== SCREENSHOT_UI_URI) throw new Error("Неизвестный UI resource")
      return {
        contents: [{
          uri: SCREENSHOT_UI_URI,
          mimeType: "text/html;profile=mcp-app",
          text: chatScreenshotUiHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: SCREENSHOT_UI_DOMAIN,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription": "Просмотр снимка текущего результата; новые доставленные кадры обновляют то же изображение.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": SCREENSHOT_UI_DOMAIN,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        }],
      }
    },
    subscribeCatalogChanged: () => () => {},
    async callTool(name, args, signal) {
      if (name !== "zavx0z") {
        return { isError: true, content: [{ type: "text", text: "Единственный MCP-инструмент — zavx0z" }] }
      }
      let request: z.infer<typeof entryInput>
      try {
        request = parseWireValue(entryInput, args, { maxBytes: 1024 * 1024, maxDepth: 32 })
      } catch {
        return { isError: true, content: [{ type: "text", text: "INVALID_REQUEST: ожидаются node, action и input по публичной схеме. Выполнение не начиналось." }] }
      }
      try {
        const node = request.node ?? "root"

        if (node === "root" && request.action === undefined) {
          return result({
            name: "zavx0z",
            node,
            executed: false,
            description: "Справка по доступным разделам. Контракты запрашиваются у Runtime при обращении к разделу.",
            children: [{ node: "computer", description: "Справка и контракты ai-macos" }],
            contract: { inputSchema: entryInputSchema },
            protocol: entryProtocol,
            examples: {
              catalog: { node: "computer" },
              contract: { node: "computer/system_health" },
              execute: { node: "computer", action: "system_health", input: {} },
            },
            next: { node: "computer" },
          })
        }

        if (node === "computer" && request.action === undefined) {
          const catalog = ToolSchema.array().parse(await executor.listTools())
          return result({
            node,
            description: "Справка по операциям Mac. node с путём операции раскрывает контракт; action выполняет операцию.",
            children: catalog.map(tool => ({
              node: `computer/${tool.name}`,
              action: tool.name,
              title: tool.title ?? tool.name,
            })),
          })
        }

        const pathAction = node.startsWith("computer/") ? node.slice("computer/".length) : undefined
        if (node !== "computer" && pathAction === undefined) {
          throw new ChatProxyError("TOOL_NOT_ALLOWED", "Неизвестный раздел")
        }
        if (pathAction !== undefined && request.action !== undefined && request.action !== pathAction) {
          throw new ChatProxyError("TOOL_NOT_ALLOWED", "action не соответствует пути node")
        }
        const action = request.action ?? pathAction
        if (action === undefined) throw new ChatProxyError("TOOL_NOT_ALLOWED", "Не указано действие для справки")

        if (request.action !== undefined) {
          const version = ++screenshotRequest
          const response = await executor.call(action, request.input ?? {}, signal)
          return withScreenshot(response, version, request.input ?? {})
        }

        const contract = (await executor.listTools()).find(tool => tool.name === action)
        if (!contract) {
          throw new ChatProxyError("TOOL_UNAVAILABLE", "Операция отсутствует в текущем каталоге подключения")
        }
        return result({
          node: `computer/${action}`,
          action,
          contract: ToolSchema.parse(contract),
          executed: false,
          invocation: { node: "computer", action },
          instruction: "Для выполнения добавьте action и при необходимости input по contract.inputSchema. Без action запрос только раскрывает контракт.",
        })
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: error instanceof ChatProxyError
              ? `${error.code}: ${error.message}`
              : "RUNTIME_UNAVAILABLE_OR_UNKNOWN: вызов не завершён подтверждённым результатом. Автоматического повтора нет. Для action проверьте get_operation/list_recent_operations; справка сама действие не выполняет.",
          }],
        }
      }
    },
  }, { name: "zavx0z", version: "unversioned", instructions: entryProtocol })

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
