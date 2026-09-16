import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseWireValue, z } from "@meta/shared/contracts"
import { createCatalogServer } from "./catalog-server.ts"
import { assertToolAllowed, CatalogError, loadCatalogSnapshot } from "./catalog-snapshot.ts"

const entryInput = z.strictObject({
  node: z.string().min(1).max(160).optional(),
  action: z.string().min(1).max(127).optional(),
  input: z.record(z.string(), z.json()).optional(),
})

/** Readonly-точка входа: справка и контракты без подключения к Runtime и выполнения операций. */
export async function startChatProxy(options: { catalogPath: string }) {
  const snapshot = loadCatalogSnapshot(await Bun.file(options.catalogPath).json())
  const catalog = ToolSchema.array().min(1).max(256).parse(snapshot.tools)
  const result = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value,
  })
  return createCatalogServer({
    listTools: () => [{
      name: "zavx0z", title: "Завхоз",
      description: "",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }],
    subscribeCatalogChanged: () => () => {},
    async callTool(name, args) {
      if (name !== "zavx0z") return { isError: true, content: [{ type: "text", text: "Единственный MCP-инструмент — zavx0z" }] }
      try {
        const request = parseWireValue(entryInput, args, { maxBytes: 1024 * 1024, maxDepth: 32 })
        const node = request.node ?? "root"
        if (node === "root" && request.action === undefined) {
          return result({ name: "zavx0z", runtimeBuildId: snapshot.runtimeBuildId, catalogHash: snapshot.catalogHash,
            node, description: "Справка по доступным разделам. Контракты взяты из snapshot и не подтверждают текущую готовность Runtime.",
            children: [{ node: "computer", description: "Справка и контракты ai-macos" }],
            contract: { inputSchema: z.toJSONSchema(entryInput) },
            next: { node: "computer" } })
        }
        if (node === "computer" && request.action === undefined) {
          return result({ node, description: "Справка по операциям Mac. Для контракта укажите action или путь операции.",
            children: catalog.map(tool => ({ node: `computer/${tool.name}`, action: tool.name, title: tool.title ?? tool.name })) })
        }
        const pathAction = node.startsWith("computer/") ? node.slice("computer/".length) : undefined
        if (node !== "computer" && pathAction === undefined) throw new CatalogError("TOOL_NOT_ALLOWED", "Неизвестный раздел")
        if (pathAction !== undefined && request.action !== undefined && request.action !== pathAction) {
          throw new CatalogError("TOOL_NOT_ALLOWED", "action не соответствует пути node")
        }
        const action = request.action ?? pathAction
        if (action === undefined) throw new CatalogError("TOOL_NOT_ALLOWED", "Не указано действие для справки")
        assertToolAllowed(snapshot, action)
        return result({ node: `computer/${action}`, action, contract: catalog.find(tool => tool.name === action)!,
          executed: false, instruction: "Это справка и контракт. Операция не выполнена. input не запускает действие. Контракт не регистрирует отдельный MCP-инструмент." })
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof CatalogError
          ? `${error.code}: ${error.message}` : "Некорректный запрос справки." }] }
      }
    },
  }, { name: "zavx0z", version: "0.1.0" })
}

if (import.meta.main) {
  const catalogPath = process.env.AI_MACOS_CHAT_CATALOG
  if (!catalogPath) throw new Error("Отсутствует AI_MACOS_CHAT_CATALOG")
  const server = await startChatProxy({ catalogPath })
  await server.connect(new StdioServerTransport())
}
