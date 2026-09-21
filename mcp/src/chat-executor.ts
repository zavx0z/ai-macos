import { hostname } from "node:os"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { RuntimeUdsClient } from "../../runtime/src/transport.ts"
import { ChatProxyError, type ServiceClient, type ServiceRequest, type ServiceToolSummary } from "./service-client.ts"
export { ChatProxyError } from "./service-client.ts"

export interface ChatRuntimeOptions {
  expectedHostname: string
  socketPath: string
  credentialPath: string
  /** Optional narrowing; the Runtime owns all default and nested-operation permissions. */
  allowedActions?: readonly string[]
}

/** Stable authenticated transport. No feature names, schemas, implementations or policy tables. */
export function createChatExecutor(options: ChatRuntimeOptions): ServiceClient {
  let client: RuntimeUdsClient | undefined
  let connecting: Promise<RuntimeUdsClient> | undefined
  let closed = false
  const allowedActions = options.allowedActions === undefined ? undefined : Object.freeze([...options.allowedActions])
  const relay = async (current: RuntimeUdsClient, request: ServiceRequest, signal: AbortSignal): Promise<CallToolResult> => {
    const response = await current.callTool("agent_request", {
      ...request, ...(allowedActions === undefined ? {} : { allowedActions }),
    }, signal)
    const envelope = response.structuredContent
    const payload = envelope?.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      if (response.isError) return response
      throw new ChatProxyError("RUNTIME_PROTOCOL_MISMATCH", "Runtime did not return agent envelope v1; no legacy execution fallback")
    }
    return {
      ...response,
      content: [{ type: "text", text: JSON.stringify(payload) }, ...response.content.filter(item => item.type === "image")],
      structuredContent: payload as Record<string, unknown>,
      ...(response.isError || envelope.isError === true ? { isError: true } : {}),
    }
  }
  const checkHealth = async (current: RuntimeUdsClient, signal: AbortSignal) => {
    // Health is a fixed transport handshake, not a grant to the requested operation.
    const response = await current.callTool("agent_request", { node: "computer", action: "system_health", input: {} }, signal)
    const payload = response.structuredContent?.payload as Record<string, unknown> | undefined
    const machine = payload?.machine as { matchesExpected?: boolean, hostname?: string } | undefined
    if (response.isError || machine?.matchesExpected !== true || machine.hostname !== options.expectedHostname) {
      throw new ChatProxyError("MACHINE_OR_PROTOCOL_MISMATCH", "Машина Runtime или agent envelope v1 не подтверждены; обходного исполнения нет")
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload }
  }
  const connect = async () => {
    if (closed) throw new Error("Исполнитель закрыт")
    if (hostname() !== options.expectedHostname) throw new Error("Машина прокси не совпадает с ожидаемой")
    if (client) return client
    connecting ??= (async () => {
      const candidate = await RuntimeUdsClient.fromCredentialFile(options.socketPath, options.credentialPath)
      try {
        await candidate.open(`chat-proxy:${process.pid}`)
        await checkHealth(candidate, AbortSignal.timeout(5000))
        if (closed) throw new Error("Исполнитель закрыт")
        client = candidate
        return candidate
      } catch (error) { await candidate.close().catch(() => undefined); throw error }
    })().finally(() => { connecting = undefined })
    return connecting
  }
  const request = async (raw: ServiceRequest, signal: AbortSignal): Promise<CallToolResult> => {
    const snapshot = structuredClone(raw)
    signal.throwIfAborted()
    const current = await connect()
    signal.throwIfAborted()
    await checkHealth(current, signal)
    signal.throwIfAborted()
    return relay(current, snapshot, signal)
  }
  return {
    request,
    async listTools(signal = new AbortController().signal): Promise<ServiceToolSummary[]> {
      const result = await request({ node: "computer" }, signal)
      const children = result.structuredContent?.children
      if (result.isError || !Array.isArray(children)) throw new ChatProxyError("RUNTIME_CATALOG_UNAVAILABLE", "Runtime agent catalogue unavailable")
      return children.map(child => {
        if (!child || typeof child.action !== "string") throw new Error("Invalid runtime catalogue item")
        return { name: child.action, title: child.title, description: child.description }
      })
    },
    async getTool(name, signal): Promise<Tool | undefined> {
      const result = await request({ node: `computer/${name}` }, signal)
      if (result.isError) return undefined
      return result.structuredContent?.contract as Tool | undefined
    },
    call: (action, input, signal) => request({ node: "computer", action, input }, signal),
    async close() { closed = true; await connecting?.catch(() => undefined); await client?.close() },
  }
}
