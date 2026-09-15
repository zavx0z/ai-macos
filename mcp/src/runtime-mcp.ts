import { hostname } from "node:os"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { RuntimeUdsClient } from "@meta/runtime"
import { createCatalogServer } from "./catalog-server.ts"

export function createRuntimeMcpServer(client: RuntimeUdsClient) {
  return createCatalogServer({
    async listTools() {
      return (await client.listTools()).map(tool => ToolSchema.parse(tool))
    },
    callTool: (name, args, signal) => client.callTool(name, args, signal),
    subscribeCatalogChanged: listener => client.subscribeCatalogChanged(listener),
  })
}

export function createUnavailableRuntimeMcpServer(
  reason: "machine-mismatch" | "configuration-missing" | "runtime-unavailable",
  expectedHostname: string | undefined,
) {
  const report = {
    machine: {
      hostname: hostname(),
      expectedHostname: expectedHostname ?? null,
      matchesExpected: expectedHostname !== undefined && hostname() === expectedHostname,
    },
    runtime: { state: "unavailable", reason },
    servicesProbed: false,
  }
  return createCatalogServer({
    listTools: () => [{
      name: "system_health",
      title: "Диагностика подключения ai-macos",
      description: "Пассивная диагностика MCP до подключения runtime. Операции с компьютером недоступны.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }],
    async callTool(name) {
      if (name !== "system_health") return {
        isError: true,
        content: [{ type: "text", text: "Runtime недоступен; разрешена только пассивная диагностика." }],
      }
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        structuredContent: report,
      }
    },
    subscribeCatalogChanged: () => () => {},
  })
}

export async function main(): Promise<void> {
  const expectedHostname = Bun.env.AI_MACOS_EXPECTED_HOSTNAME
  let server: ReturnType<typeof createCatalogServer>
  if (expectedHostname === undefined || hostname() !== expectedHostname) {
    server = createUnavailableRuntimeMcpServer("machine-mismatch", expectedHostname)
  } else {
    const socketPath = Bun.env.META_RUNTIME_SOCKET
    const credentialPath = Bun.env.META_RUNTIME_CREDENTIAL
    if (socketPath === undefined || credentialPath === undefined) {
      server = createUnavailableRuntimeMcpServer("configuration-missing", expectedHostname)
    } else {
      try {
        const client = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
        await client.open(`mcp:${process.pid}`)
        await client.listTools()
        server = createRuntimeMcpServer(client)
      } catch {
        // Содержимое повреждённого credential не попадает в MCP или stderr.
        server = createUnavailableRuntimeMcpServer("runtime-unavailable", expectedHostname)
      }
    }
  }
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  main().catch(() => {
    console.error("Не удалось запустить MCP transport ai-macos")
    process.exitCode = 1
  })
}
