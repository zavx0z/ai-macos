import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { RuntimeUdsClient } from "@meta/runtime"
import { z } from "zod"

export function createRuntimeMcpServer(client: RuntimeUdsClient): McpServer {
  const server = new McpServer({ name: "ai-macos-runtime", version: "0.4.0" })

  server.registerTool(
    "system_health",
    {
      title: "Check ai-macos runtime",
      description: "Passively read the authenticated user-session runtime, loaded adapter generations, capabilities, and quarantine state. This does not run an active input or capture probe.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => result(await client.health(), "ai-macos runtime health"),
  )

  server.registerTool(
    "get_operation",
    {
      title: "Get ai-macos operation",
      description: "Read a previously registered operation after reconnect or an uncertain transport result. This never replays the action.",
      inputSchema: {
        operationId: z.string().min(1).max(127),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ operationId }) => {
      const operation = await client.getOperation(operationId)
      return result(operation ?? { error: "operation-not-found", operationId }, "ai-macos operation status")
    },
  )

  server.registerTool(
    "cancel_operation",
    {
      title: "Cancel ai-macos operation",
      description: "Request cancellation of a registered operation. The returned state distinguishes the request from confirmed stop and cleanup.",
      inputSchema: {
        operationId: z.string().min(1).max(127),
        reason: z.string().min(1).max(1_024),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ operationId, reason }) => result(
      await client.cancelOperation(operationId, reason),
      "ai-macos cancellation status",
    ),
  )

  return server
}

export async function main(): Promise<void> {
  const socketPath = Bun.env.META_RUNTIME_SOCKET
  const credentialPath = Bun.env.META_RUNTIME_CREDENTIAL
  if (socketPath === undefined || credentialPath === undefined) {
    throw new Error("META_RUNTIME_SOCKET и META_RUNTIME_CREDENTIAL обязательны; MCP не запускает runtime автоматически")
  }
  const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
  await client.open(`mcp:${process.pid}`)
  const server = createRuntimeMcpServer(client)
  await server.connect(new StdioServerTransport())
}

function result(value: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(value, null, 2)}` }],
    structuredContent: value !== null && typeof value === "object"
      ? value as Record<string, unknown>
      : { value },
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
