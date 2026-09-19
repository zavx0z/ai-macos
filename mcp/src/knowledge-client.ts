import { CallToolResultSchema, ToolSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ChatProxyError, type ProgressSink, type ServiceClient } from "./service-client.ts"

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

/** HTTP-клиент без MCP-сессии. Ни создание, ни закрытие не делают сетевых запросов. */
export function createKnowledgeClient(options: { baseUrl?: string, idleTimeoutMs?: number } = {}): ServiceClient {
  const base = options.baseUrl ?? process.env.KNOWLEDGE_BASE_CORE_URL ?? "http://127.0.0.1:8771"
  const idleMs = options.idleTimeoutMs ?? 60000
  if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error("Invalid KB idle timeout")
  let closed = false
  const active = new Set<AbortController>()
  async function request(path: string, init: RequestInit, signal: AbortSignal, onProgress?: ProgressSink): Promise<unknown> {
    if (closed) throw new ChatProxyError("SERVICE_CLOSED", "knowledge")
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    active.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new Error("KB progress timeout")), idleMs)
    }
    reset()
    try {
      const response = await fetch(new URL(path, base), { ...init, redirect: "error", signal: controller.signal })
      if (response.status === 404 && path.startsWith("/v1/catalog/")) return undefined
      if (!response.ok) throw new ChatProxyError("KNOWLEDGE_HTTP_ERROR", `HTTP ${response.status}: ${(await response.text()).slice(0, 1024)}`)
      if (!response.headers.get("content-type")?.includes("application/x-ndjson")) return await response.json()
      if (!response.body) throw new Error("KB returned no body")
      const reader = response.body.getReader()
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let buffer = ""
      try {
        while (true) {
          const { value, done } = await reader.read()
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          if (buffer.length > 16 * 1024 * 1024) throw new Error("KB event exceeds response limit")
          let newline: number
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (!line.trim()) continue
            const event = record(JSON.parse(line))
            if (event.type === "result") return event.result
            if (event.type === "error") throw new ChatProxyError("KNOWLEDGE_TOOL_ERROR", String(event.message))
            if (event.type !== "progress" || typeof event.progress !== "number" || (!Number.isFinite(event.progress) || event.progress < 0)) {
              throw new Error("Invalid KB progress event")
            }
            reset()
            await onProgress?.(event.progress, typeof event.message === "string" ? event.message : undefined)
          }
          if (done) throw new Error("KB connection ended without a final result")
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      if (error instanceof ChatProxyError) throw error
      const reason = controller.signal.aborted ? controller.signal.reason : error
      throw new ChatProxyError("KNOWLEDGE_UNAVAILABLE_OR_UNKNOWN",
        `${reason instanceof Error ? reason.message : String(reason)}. Автоматического повтора нет; отмена ожидания не доказывает остановку Core.`)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      active.delete(controller)
    }
  }
  return {
    async listTools(signal = new AbortController().signal) {
      const value = record(await request("/v1/catalog", {}, signal))
      return ToolSchema.pick({ name: true, title: true, description: true }).array().parse(value.tools)
        .map(({ name, title, description }) => ({ name, title, description }))
    },
    async getTool(name, signal) {
      const value = await request(`/v1/catalog/${encodeURIComponent(name)}`, {}, signal)
      if (value === undefined) return undefined
      const tool = ToolSchema.parse(value)
      if (tool.name !== name) throw new ChatProxyError("KNOWLEDGE_CONTRACT_MISMATCH", name)
      return tool
    },
    async call(name, input, signal, onProgress) {
      const value = await request(`/v1/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(input),
      }, signal, onProgress)
      CallToolResultSchema.parse(value)
      return value as CallToolResult
    },
    close() {
      closed = true
      for (const controller of active) controller.abort(new Error("KB client closed"))
    },
  }
}
