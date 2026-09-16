import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
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
  listResources?(): Promise<Resource[]> | Resource[]
  readResource?(uri: string): Promise<ReadResourceResult> | ReadResourceResult
}

export function createCatalogServer(
  backend: RuntimeCatalogBackend,
  identity?: { name: string, version: string, instructions?: string },
): Server {
  const hasResources = backend.listResources !== undefined || backend.readResource !== undefined
  if (hasResources && (backend.listResources === undefined || backend.readResource === undefined)) {
    throw new Error("Resource backend требует listResources и readResource вместе")
  }

  const server = new Server(
    { name: identity?.name ?? "ai-macos-runtime-catalog", version: identity?.version ?? "0.4.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        ...(hasResources ? { resources: {} } : {}),
      },
      ...(identity?.instructions === undefined ? {} : { instructions: identity.instructions }),
    },
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

  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await backend.listResources!(),
    }))
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await backend.readResource!(request.params.uri)
    })
  }

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
