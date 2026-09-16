import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { parseWireValue, z } from "@meta/shared/contracts"
import { ChatProxyError, createChatExecutor, type ChatRuntimeOptions } from "./chat-executor.ts"
import { createCatalogServer } from "./catalog-server.ts"
import { VIEWER_UI_URI, viewerUiHtml } from "./viewer-ui.ts"
import { ViewerSessions, viewerScope } from "./viewer-session.ts"

const entryInput = z.strictObject({
  node: z.string().min(1).max(160).optional().describe("Раздел справки: root, computer или computer/<операция>. По умолчанию root."),
  action: z.string().min(1).max(127).optional().describe("Выполнить операцию из каталога выбранного раздела. Без action возвращается только справка."),
  input: z.record(z.string(), z.json()).optional().describe("Аргументы операции по её динамическому inputSchema. По умолчанию {}. Само наличие input не запускает действие."),
})
const viewerNextInput = z.strictObject({
  viewerId: z.string().uuid(), accessToken: z.string().uuid(), after: z.number().int().nonnegative(),
  mountId: z.string().uuid().optional(), displayedVersion: z.number().int().nonnegative().optional(),
  displayMode: z.enum(["inline", "fullscreen", "unknown"]).optional(),
  waitMs: z.number().int().min(0).max(20000).optional(),
  release: z.boolean().optional(),
})
const viewerWaitInput = z.strictObject({ after: z.number().int().nonnegative(), waitMs: z.number().int().min(0).max(20000).optional() })
const demoInput = z.strictObject({ service: z.enum(["demo-a", "demo-b"]), text: z.string().min(1).max(1000) })
const entryInputSchema = z.toJSONSchema(entryInput) as Tool["inputSchema"]
const entryProtocol = "zavx0z выполняет команды без UI. {} — корневая справка; {node:'computer'} — каталог; {node:'computer/<операция>'} — контракт без выполнения; {node:'computer',action:'<операция>',input:{...}} — выполнение. Сначала system_health и machine.matchesExpected=true. Ввод: check_input → свежее observe → одно действие. Для экрана используйте display target, для приложения — window. Общее приложение открывается отдельным zavx0z_viewer один раз на беседу; fullscreen включается кнопкой внутри него, PiP не используется. Снимки обновляют уже открытый просмотр; справка и health его не открывают. {node:'viewer'} описывает прототип и диагностику. Не объявляйте fullscreen или один iframe подтверждёнными по одному успешному tool call. После timeout/unknown/partial не повторяйте mutation: проверьте get_operation/list_recent_operations. Не останавливайте proxy/tunnel через этот же управляющий канал; обновление выполняется внешним scripts/chat-proxy-install.ts."

/** Пустой запрос раскрывает протокол; только явный action запускает исполнитель. */
export async function startChatProxy(options: { runtime: ChatRuntimeOptions }) {
  const executor = createChatExecutor(options.runtime)
  const viewers = new ViewerSessions()
  const screenshotStream = crypto.randomUUID()
  let screenshotRequest = 0

  const result = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  })

  const withScreenshot = (response: CallToolResult, version: number, input: Record<string, unknown>, scope: string | undefined): CallToolResult => {
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
    let viewerUpdate: Record<string, unknown> | undefined
    if (scope && viewers.status(scope).viewerId) {
      try {
        viewerUpdate = viewers.publish(scope, { kind: "image", service: "computer", data, mimeType,
          caption: typeof input.caption === "string" ? input.caption : "Снимок" }, version)
      } catch (error) { viewerUpdate = { error: error instanceof Error ? error.message : "VIEWER_PUBLISH_FAILED" } }
    }
    // Состояние просмотра разделено по беседам, ошибка UI не меняет исход операции.
    // ImageContent сохраняется: без него модель потеряет визуальное наблюдение.
    return {
      ...response,
      _meta: {
        ...response._meta,
        ...(viewerUpdate ? { viewerUpdate } : {}),
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
    }, {
      name: "zavx0z_viewer", title: "Открыть Завхоз",
      description: "Открыть одно общее приложение для сервисов этой беседы. Вызывать один раз, не при каждом обновлении. Fullscreen включается кнопкой внутри приложения. Обычные команды выполняются через zavx0z и не создают карточек.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: VIEWER_UI_URI, visibility: ["model"] }, "openai/outputTemplate": VIEWER_UI_URI },
    }, {
      name: "zavx0z_viewer_next", title: "Обновление приложения",
      description: "Ожидание новой ревизии уже открытого приложения; без создания UI и без desktop-действий.",
      inputSchema: z.toJSONSchema(viewerNextInput) as Tool["inputSchema"],
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
    }],
    listResources: () => [{
      uri: VIEWER_UI_URI,
      name: "Завхоз — общее приложение",
      mimeType: "text/html;profile=mcp-app",
    }],
    readResource: (uri) => {
      if (uri !== VIEWER_UI_URI && uri !== "ui://zavx0z/viewer-v1.html") throw new Error("Неизвестный UI resource")
      return {
        contents: [{
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: viewerUiHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: "https://ai-macos-local.zavx0z.app",
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription": "Общее приложение этой беседы; данные разных сервисов обновляют его через ожидающие запросы, без PiP.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": "https://ai-macos-local.zavx0z.app",
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        }],
      }
    },
    subscribeCatalogChanged: () => () => {},
    async callTool(name, args, signal, meta) {
      const scope = viewerScope(meta)
      if (name === "zavx0z_viewer" || name === "zavx0z_viewer_next") {
        try {
          if (name === "zavx0z_viewer") {
            parseWireValue(z.strictObject({}), args, { maxBytes: 4096, maxDepth: 4 })
            const snapshot = viewers.open(scope)
            return { ...result({ viewerId: snapshot.viewerId, opened: true }), _meta: { viewer: snapshot } }
          }
          const input = parseWireValue(viewerNextInput, args, { maxBytes: 4096, maxDepth: 4 })
          const snapshot = await viewers.next(input, signal)
          return { ...result({ version: snapshot.version, changed: snapshot.changed }), _meta: { viewer: snapshot } }
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "VIEWER_FAILED" }] }
        }
      }
      if (name !== "zavx0z") {
        return { isError: true, content: [{ type: "text", text: "Неизвестный MCP-инструмент" }] }
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
            children: [{ node: "computer", description: "Справка и контракты ai-macos" }, { node: "viewer", description: "Общее fullscreen-приложение" }],
            viewer: { opener: "zavx0z_viewer", scopeAvailable: !!scope },
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

        if (node === "viewer") {
          if (!request.action) return result({ node, prototype: true, opener: "zavx0z_viewer",
            actions: { status: {}, publish_demo: { service: "demo-a | demo-b", text: "текст демонстрации" },
              wait: { after: "номер ревизии", waitMs: "0..20000" } },
            instruction: "Откройте zavx0z_viewer один раз и нажмите Развернуть приложение. Публикуйте demo-a/demo-b через zavx0z. status показывает подтверждённый виджетом mode/mount/revision. wait — диагностический ожидающий запрос без UI. Никакого ввода на Mac этот прототип не выполняет." })
          if (request.action === "status") return result(viewers.status(scope))
          if (request.action === "publish_demo") {
            const input = demoInput.parse(request.input)
            return result(viewers.publish(scope, { kind: "text", ...input }, ++screenshotRequest))
          }
          if (request.action === "wait") {
            const input = viewerWaitInput.parse(request.input)
            const view = viewers.open(scope)
            return result(await viewers.next({ viewerId: view.viewerId, accessToken: view.accessToken, ...input }, signal))
          }
          throw new ChatProxyError("TOOL_NOT_ALLOWED", "Неизвестное действие viewer")
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
          return withScreenshot(response, version, request.input ?? {}, scope)
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
              : error instanceof Error && error.message.startsWith("VIEWER_") ? error.message
              : "RUNTIME_UNAVAILABLE_OR_UNKNOWN: вызов не завершён подтверждённым результатом. Автоматического повтора нет. Для action проверьте get_operation/list_recent_operations; справка сама действие не выполняет.",
          }],
        }
      }
    },
  }, { name: "zavx0z", version: "unversioned", instructions: entryProtocol })

  const previousOnClose = server.onclose
  server.onclose = () => {
    viewers.close()
    previousOnClose?.()
    void executor.close().catch(() => undefined)
  }
  const close = server.close.bind(server)
  server.close = async () => {
    viewers.close()
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
