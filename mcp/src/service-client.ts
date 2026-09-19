import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"

export type ProgressSink = (progress: number, message?: string) => void | Promise<void>
export type ServiceToolSummary = Pick<Tool, "name" | "title" | "description">

export interface ServiceClient {
  listTools(signal?: AbortSignal): Promise<ServiceToolSummary[]>
  getTool?(name: string, signal: AbortSignal): Promise<Tool | undefined>
  call(name: string, input: Record<string, unknown>, signal: AbortSignal, onProgress?: ProgressSink): Promise<CallToolResult>
  close(): void | Promise<void>
}

export interface ServiceRegistration {
  id: string
  description: string
  instructions?: string
  create(): ServiceClient | Promise<ServiceClient>
}

export class ChatProxyError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Регистрация хранит только фабрики; неиспользованные сервисы не загружаются даже при закрытии. */
export function createLazyServices(registrations: readonly ServiceRegistration[]) {
  const services = new Map<string, ServiceRegistration>()
  const loading = new Map<string, Promise<ServiceClient>>()
  let closed = false
  let closing: Promise<void> | undefined
  for (const item of registrations) {
    if (!/^[a-z][a-z0-9_-]*$/.test(item.id) || ["root", "viewer"].includes(item.id) || services.has(item.id)) {
      throw new Error(`Invalid or duplicate service: ${item.id}`)
    }
    services.set(item.id, item)
  }
  return {
    entries: [...services.values()],
    has: (id: string) => services.has(id),
    async get(id: string): Promise<ServiceClient> {
      if (closed) throw new ChatProxyError("SERVICE_CLOSED", id)
      const service = services.get(id)
      if (!service) throw new ChatProxyError("TOOL_NOT_ALLOWED", `Неизвестный сервис: ${id}`)
      let pending = loading.get(id)
      if (!pending) {
        pending = Promise.resolve().then(() => service.create())
        loading.set(id, pending)
        void pending.catch(() => { if (loading.get(id) === pending) loading.delete(id) })
      }
      const client = await pending
      if (closed) throw new ChatProxyError("SERVICE_CLOSED", id)
      return client
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = Promise.allSettled([...loading.values()].map(async pending => {
        const client = await pending
        await client.close()
      })).then(() => {})
      return closing
    },
  }
}
