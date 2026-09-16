import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"

export interface RuntimeCatalogBackend {
  listTools(): Promise<Tool[]> | Tool[]
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult>
  subscribeCatalogChanged(listener: () => void): (() => void) | void
}

export function createCatalogServer(backend: RuntimeCatalogBackend, identity?: { name: string, version: string, instructions?: string }): Server {
  const server = new Server(
    { name: identity?.name ?? "ai-macos-runtime-catalog", version: identity?.version ?? "0.4.0" },
    { capabilities: { tools: { listChanged: true } }, ...(identity?.instructions === undefined ? {} : { instructions: identity.instructions }) },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await backend.listTools(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    return await backend.callTool(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal,
    )
  })

  let unsubscribed = false
  const unsubscribe = backend.subscribeCatalogChanged(() => {
    if (unsubscribed) return
    void server.sendToolListChanged().catch(() => undefined)
  })
  server.onclose = () => {
    if (unsubscribed) return
    unsubscribed = true
    unsubscribe?.()
  }

  return server
}
