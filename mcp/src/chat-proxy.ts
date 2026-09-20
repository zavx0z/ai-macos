import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { parseWireValue, z } from "@meta/shared/contracts"
import type { ChatRuntimeOptions } from "./chat-executor.ts"
import { ChatProxyError, createLazyServices, type ServiceRegistration } from "./service-client.ts"
import { createCatalogServer } from "./catalog-server.ts"
import { VIEWER_UI_URI, viewerUiHtml } from "./viewer-ui.ts"
import { ViewerSessions, viewerScope } from "./viewer-session.ts"

const entryInput = z.strictObject({
  node: z.string().min(1).max(160).optional().describe("Раздел: root, <сервис> или <сервис>/<операция>. По умолчанию root."),
  action: z.string().min(1).max(127).optional().describe("Выполнить операцию из каталога выбранного раздела. Без action возвращается только справка."),
  input: z.record(z.string(), z.json()).optional().describe("Аргументы операции по её динамическому inputSchema. По умолчанию {}. Само наличие input не запускает действие."),
})
const viewerNextInput = z.strictObject({
  viewerId: z.string().uuid(), accessToken: z.string().uuid(), after: z.number().int().nonnegative(),
  mountId: z.string().uuid().optional(), displayedVersion: z.number().int().nonnegative().optional(),
  displayMode: z.enum(["inline", "fullscreen", "pip", "unknown"]).optional(),
  waitMs: z.number().int().min(0).max(20000).optional(),
  release: z.boolean().optional(),
})
const viewerWaitInput = z.strictObject({ after: z.number().int().nonnegative(), waitMs: z.number().int().min(0).max(20000).optional() })
const demoInput = z.strictObject({ service: z.enum(["demo-a", "demo-b"]), text: z.string().min(1).max(1000) })
const entryInputSchema = z.toJSONSchema(entryInput) as Tool["inputSchema"]
const computerProtocol = "zavx0z выполняет команды без UI. {} — корневая справка; {node:'computer'} — каталог; {node:'computer/<операция>'} — контракт без выполнения; {node:'computer',action:'<операция>',input:{...}} — выполнение. Сначала system_health и machine.matchesExpected=true. Ввод: check_input → свежее observe → одно действие. Для экрана используйте display target, для приложения — window. Общее приложение открывается отдельным codex_app один раз на беседу; При CODEX_APP_OPEN_REQUIRED вызови codex_app {} один раз, затем продолжай задачу без повтора предыдущей команды. Если приложение уже открыто или закрыто пользователем, не открывай его снова автоматически. Fullscreen и PiP выбираются кнопками внутри того же приложения. Первый ответ любой команды предлагает открыть приложение; последующие команды обновляют его без новых карточек. Справка и health не меняют показанные данные. {node:'viewer'} описывает прототип и диагностику. Не объявляйте fullscreen или один iframe подтверждёнными по одному успешному tool call. После timeout/unknown/partial не повторяйте mutation: проверьте get_operation/list_recent_operations. Не останавливайте proxy/tunnel через этот же управляющий канал; обновление выполняется внешним scripts/chat-proxy-install.ts."

const entryProtocol = "zavx0z: {} — зарегистрированные сервисы; node:<сервис> — краткий каталог; node:<сервис>/<операция> — контракт без выполнения; явный action — выполнение. Сервис загружается только при первом обращении к нему; контракт операции запрашивается только для выбранной операции. Специфические правила сервиса раскрываются в его каталоге. После неизвестного результата действие не повторять автоматически."

/** Пустой запрос раскрывает протокол; только явный action запускает исполнитель. */
export interface ChatProxyOptions {
  runtime?: ChatRuntimeOptions
  knowledge?: { baseUrl?: string, idleTimeoutMs?: number }
  services?: readonly ServiceRegistration[]
}

export async function startChatProxy(options: ChatProxyOptions = {}) {
  const services = createLazyServices(options.services ?? [{
    id: "computer", description: "Справка и контракты ai-macos", instructions: computerProtocol,
    create: async () => {
      const { createChatExecutor } = await import("./chat-executor.ts")
      const required = (name: string) => {
        const value = process.env[name]
        if (!value) throw new Error(`Отсутствует ${name}`)
        return value
      }
      return createChatExecutor(options.runtime ?? {
        expectedHostname: required("AI_MACOS_EXPECTED_HOSTNAME"),
        socketPath: required("META_RUNTIME_SOCKET"),
        credentialPath: required("META_RUNTIME_CREDENTIAL"),
      })
    },
  }, {
    id: "knowledge", description: "Поиск и исследование в Knowledge Base",
    create: async () => {
      const { createKnowledgeClient } = await import("./knowledge-client.ts")
      return createKnowledgeClient(options.knowledge)
    },
  }, {
    id: "ai", routing: "structured", description: "Универсальные файловые операции и Git status",
    instructions: "Полный node раскрывает описание без выполнения. input.view раскрывает контракт или сценарий. Только action: run выполняет операцию. Пути абсолютные; roots/open и Interpreter отсутствуют. Не повторять mutation после unknown/partial; сначала проверить файл.",
    create: async () => {
      const { createAiClient } = await import("./ai-client.ts")
      return createAiClient({
        expectedHostname: options.runtime?.expectedHostname ?? process.env.AI_MACOS_EXPECTED_HOSTNAME,
      })
    },
  }])
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
    if (scope) {
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
      name: "codex_app", title: "Codex App",
      description: "Открыть одно общее приложение для сервисов этой беседы. Вызывать один раз, не при каждом обновлении. Fullscreen и PiP выбираются внутри того же приложения. Обычные команды выполняются через zavx0z и не создают карточек.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: VIEWER_UI_URI, visibility: ["model"] }, "openai/outputTemplate": VIEWER_UI_URI },
    }, {
      name: "codex_app_next", title: "Обновление приложения",
      description: "Ожидание новой ревизии уже открытого приложения; без создания UI и без desktop-действий.",
      inputSchema: z.toJSONSchema(viewerNextInput) as Tool["inputSchema"],
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
    }],
    listResources: () => [{
      uri: VIEWER_UI_URI,
      name: "Codex App — общее приложение",
      mimeType: "text/html;profile=mcp-app",
    }],
    readResource: (uri) => {
      if (![VIEWER_UI_URI, "ui://zavx0z/codex-app-v2.html", "ui://zavx0z/codex-app-v1.html", "ui://zavx0z/viewer-v1.html", "ui://zavx0z/viewer-v2.html"].includes(uri)) throw new Error("Неизвестный UI resource")
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
            "openai/widgetDescription": "Codex App: снимки и данные сервисов этой беседы. Fullscreen, PiP и inline используют один mount.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": "https://ai-macos-local.zavx0z.app",
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        }],
      }
    },
    subscribeCatalogChanged: () => () => {},
    async callTool(name, args, signal, meta, onProgress) {
      const scope = viewerScope(meta)
      const executeRequest = async (): Promise<CallToolResult> => {
        if (name === "codex_app" || name === "codex_app_next" || name === "zavx0z_viewer" || name === "zavx0z_viewer_next") {
          try {
            if (name === "codex_app" || name === "zavx0z_viewer") {
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
            const firstService = services.entries[0]?.id
            return result({
              name: "zavx0z",
              node,
              executed: false,
              description: "Справка по доступным разделам. Контракты запрашиваются у выбранного сервиса по мере обращения.",
              children: [...services.entries.map(({ id, description }) => ({ node: id, description })), { node: "viewer", description: "Общее приложение Codex App" }],
              viewer: { opener: "codex_app", scopeAvailable: !!scope },
              contract: { inputSchema: entryInputSchema },
              protocol: entryProtocol,
              examples: {
                ...(firstService ? { catalog: { node: firstService } } : {}),
                ...(services.has("computer") ? {
                  contract: { node: "computer/system_health" },
                  execute: { node: "computer", action: "system_health", input: {} },
                } : {}),
              },
              ...(firstService ? { next: { node: firstService } } : {}),
            })
          }

          if (node === "viewer") {
            if (!request.action) return result({ node, prototype: true, opener: "codex_app",
              actions: { status: {}, publish_demo: { service: "demo-a | demo-b", text: "текст демонстрации" },
                wait: { after: "номер ревизии", waitMs: "0..20000" } },
              instruction: "Откройте codex_app один раз. Кнопки На весь экран, Поверх чата и В чате выбирают режим того же приложения. Публикуйте demo-a/demo-b через zavx0z. status показывает подтверждённый виджетом mode/mount/revision. wait — диагностический ожидающий запрос без UI. Никакого ввода на Mac этот прототип не выполняет." })
            if (request.action === "status") return result(viewers.status(scope))
            if (request.action === "publish_demo") {
              const input = demoInput.parse(request.input)
              return result(viewers.publish(scope, { kind: "text", ...input }, ++screenshotRequest))
            }
            if (request.action === "wait") {
              const input = viewerWaitInput.parse(request.input)
              const view = viewers.open(scope, false)
              return result(await viewers.next({ viewerId: view.viewerId, accessToken: view.accessToken, ...input }, signal))
            }
            throw new ChatProxyError("TOOL_NOT_ALLOWED", "Неизвестное действие viewer")
          }

          const [serviceId, pathAction, extraPath] = node.split("/")
          const structured = services.entries.find(item => item.id === serviceId)?.routing === "structured"
          if (!serviceId || !services.has(serviceId) || (extraPath !== undefined && !structured) || pathAction === "") {
            throw new ChatProxyError("TOOL_NOT_ALLOWED", "Неизвестный раздел")
          }
          if (!structured && pathAction !== undefined && request.action !== undefined && request.action !== pathAction) {
            throw new ChatProxyError("TOOL_NOT_ALLOWED", "action не соответствует пути node")
          }
          const client = await services.get(serviceId)
          if (structured) {
            if (!client.request) throw new ChatProxyError("INVALID_SERVICE", "Структурный сервис не предоставляет request")
            return client.request({ ...request, node }, signal, onProgress)
          }
          const action = request.action ?? pathAction
          if (action === undefined) {
            const catalog = await client.listTools(signal)
            return result({
              node,
              description: services.entries.find(item => item.id === serviceId)!.description,
              protocol: services.entries.find(item => item.id === serviceId)?.instructions,
              children: catalog.map(tool => ({
                node: `${serviceId}/${tool.name}`, action: tool.name, title: tool.title ?? tool.name, description: tool.description,
              })),
            })
          }
          if (request.action !== undefined) {
            const version = serviceId === "computer" ? ++screenshotRequest : 0
            const response = await client.call(action, request.input ?? {}, signal, onProgress)
            return serviceId === "computer" ? withScreenshot(response, version, request.input ?? {}, scope) : response
          }
          const contract = client.getTool ? await client.getTool(action, signal)
            : (await client.listTools(signal)).find(tool => tool.name === action)
          if (!contract) throw new ChatProxyError("TOOL_UNAVAILABLE", `Нет операции ${serviceId}/${action}`)
          return result({
            node: `${serviceId}/${action}`, action, contract: ToolSchema.parse(contract), executed: false,
            invocation: { node: serviceId, action },
            instruction: "Для выполнения добавьте action и input по contract.inputSchema. Без action возвращается только контракт.",
          })
        } catch (error) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: error instanceof ChatProxyError
                ? `${error.code}: ${error.message}`
                : error instanceof Error && error.message.startsWith("VIEWER_") ? error.message
                : `SERVICE_UNAVAILABLE_OR_UNKNOWN: ${request.node ?? "root"}. ${error instanceof Error ? error.message : "unknown"}. Автоматического повтора нет.`,
            }],
          }
        }
      }
      const response = await executeRequest()
      if (name === "zavx0z" && (args.node === "computer" || typeof args.node === "string" && args.node.startsWith("computer/"))) {
        try {
          if (viewers.suggestOpen(scope)) return {
            ...response,
            structuredContent: {
              ...response.structuredContent,
              codexApp: { status: "CODEX_APP_OPEN_REQUIRED", tool: "codex_app", arguments: {}, repeatPreviousCommand: false },
            },
            content: [...response.content, {
            type: "text",
            text: "CODEX_APP_OPEN_REQUIRED: вызови codex_app {} один раз сейчас, чтобы открыть общее приложение этой беседы. Затем продолжай задачу. Предыдущую команду НЕ повторяй. Режим fullscreen или PiP выбирается пользователем в приложении.",
          }] }
        } catch {
          // Ошибка необязательного UI не меняет результат уже выполненной команды.
        }
      }
      return response
    },
  }, { name: "zavx0z", version: "unversioned", instructions: entryProtocol })

  const previousOnClose = server.onclose
  server.onclose = () => {
    viewers.close()
    previousOnClose?.()
    void services.close().catch(() => undefined)
  }
  const close = server.close.bind(server)
  server.close = async () => {
    viewers.close()
    await close()
    await services.close()
  }
  return server
}

if (import.meta.main) {
  const server = await startChatProxy()
  await server.connect(new StdioServerTransport())
}
