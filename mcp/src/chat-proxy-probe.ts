import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/** Только initialize, каталог и справка отдельного кандидата; без desktop-действий. */
export async function probeChatProxy(command: string, env: Record<string, string>) {
  const client = new Client({ name: "chat-proxy-install-probe", version: "1" })
  const transport = new StdioClientTransport({ command, env, stderr: "pipe" })
  const deadline = AbortSignal.timeout(10_000)
  try {
    await client.connect(transport, { signal: deadline })
    const { tools } = await client.listTools({}, { signal: deadline })
    const tool = tools[0]
    if (tools.length !== 1 || tool?.name !== "zavx0z"
      || !["node", "action", "input"].every(key => key in (tool.inputSchema.properties ?? {}))) {
      throw new Error("Кандидат не публикует ожидаемый протокол zavx0z")
    }
    const uri = tool._meta?.["openai/outputTemplate"]
    if (typeof uri !== "string") throw new Error("Кандидат не публикует UI resource")
    const resource = await client.readResource({ uri }, { signal: deadline })
    const html = resource.contents.find(item => "text" in item)
    if (!html || !("text" in html) || html.text.includes("setInterval(")) {
      throw new Error("UI resource отсутствует или содержит периодический polling")
    }
    const root = await client.callTool({ name: "zavx0z", arguments: {} }, undefined, { signal: deadline })
    if (root.isError || (root.structuredContent as Record<string, unknown> | undefined)?.node !== "root") {
      throw new Error("Корневая справка кандидата недоступна")
    }
    return { tool: tool.name, resourceUri: uri }
  } finally {
    await client.close()
  }
}
