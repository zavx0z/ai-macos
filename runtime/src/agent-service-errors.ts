import type { RuntimeToolResult } from './transport.ts'
export class AgentServiceError extends Error { constructor(readonly code: string, message: string) { super(message) } }
export interface ServiceClient {
  request?(request: { node: string; action?: string; input?: Record<string, unknown> }, signal: AbortSignal): Promise<RuntimeToolResult>
  listTools(): Promise<never[]>
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<RuntimeToolResult>
  close(): void | Promise<void>
}
