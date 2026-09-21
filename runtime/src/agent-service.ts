import { z } from "../../shared/src/contracts/schema.ts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"
import { RuntimeContractError } from "./errors.ts"
import { AgentServiceError } from "./agent-service-errors.ts"
import { assertChatBrowserRequest, chatBrowserDescription } from "./agent-browser-policy.ts"
import { assertChatPipelineRequest, chatPipelineDescription } from "./agent-pipeline-policy.ts"
import { createToolsClient } from "./agent-tools.ts"
import { agentComputerProtocol } from "./agent-service-instructions.ts"

const jsonObject = z.record(z.string(), z.json())
const requestSchema = z.strictObject({
  node: z.string().min(1).max(160),
  action: z.string().min(1).max(127).optional(),
  input: jsonObject.optional(),
  // Can only narrow the server-owned profile. Never grants access to an otherwise hidden method.
  allowedActions: z.array(z.string().min(1).max(127)).max(256).optional(),
})
const outputSchema = z.strictObject({
  payload: jsonObject,
  frameRefs: z.array(z.string().min(1).max(127)).max(4),
  isError: z.boolean().optional(),
})

/** Stable wire envelope. All feature catalogues, validation and execution remain in this Runtime. */
export function registerAgentService(registry: MethodRegistry, core: RuntimeCore, options: { expectedHostname: string }): void {
  const files = createToolsClient({ expectedHostname: options.expectedHostname })
  const reply = (payload: Record<string, unknown>, frameRefs: string[] = [], isError?: boolean) =>
    outputSchema.parse({ payload, frameRefs, ...(isError === undefined ? {} : { isError }) })
  registry.register("agent_request", {
    agent: false, title: "Agent service envelope v1", description: "Runtime-owned catalogue and dispatch for the stable agent proxy. No arbitrary method forwarding.",
    input: requestSchema, output: outputSchema, readOnly: false, destructive: true,
    availableDuringDrain: true, maxRequestBytes: 8 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024, timeoutMs: 120_000,
    frames: result => result.frameRefs, isError: result => result.isError === true,
    async execute(context, request) {
      context.signal.throwIfAborted()
      const [service, pathAction, extra] = request.node.split("/")
      if (service === "tools") {
        if (request.action !== undefined && core.admissionSealed) throw new RuntimeContractError("capability-unavailable", "Runtime admission sealed", "agent-service")
        const response = await files.request!({ node: request.node, ...(request.action === undefined ? {} : { action: request.action }), ...(request.input === undefined ? {} : { input: request.input }) }, context.signal)
        return reply(response.structuredContent ?? {}, [], response.isError)
      }
      if (service !== "computer" || extra !== undefined || pathAction === ""
        || pathAction !== undefined && request.action !== undefined && pathAction !== request.action) {
        throw new RuntimeContractError("invalid-request", "Неизвестный раздел или action не соответствует node", "agent-service")
      }
      const permitted = registry.agentDescriptors().tools
      const narrowing = request.allowedActions === undefined ? undefined : new Set(request.allowedActions)
      const allowed = new Set(permitted.filter(t => narrowing === undefined || narrowing.has(t.name)).map(t => t.name))
      const action = request.action ?? pathAction
      if (action === undefined) return reply({
        node: "computer", description: "Справка и контракты ai-macos", protocol: agentComputerProtocol,
        children: permitted.filter(t => allowed.has(t.name)).map(tool => ({ node: `computer/${tool.name}`, action: tool.name, title: tool.title,
          description: chatPipelineDescription(tool.name, chatBrowserDescription(tool.name, tool.description)) })),
      })
      if (!allowed.has(action)) throw new RuntimeContractError("unauthorized", "Операция не разрешена профилем Runtime или недоступна", "agent-service")
      const tool = permitted.find(t => t.name === action)!
      if (request.action === undefined) return reply({
        node: `computer/${action}`, action, contract: { ...tool, description: chatPipelineDescription(action, chatBrowserDescription(action, tool.description)) }, executed: false,
        invocation: { node: "computer", action }, instruction: "Для выполнения добавьте action и input по contract.inputSchema. Без action возвращается только контракт.",
      })
      const input = request.input ?? {}
      try {
        assertChatBrowserRequest(action, input)
        assertChatPipelineRequest(action, input, allowed)
      } catch (error) {
        if (error instanceof AgentServiceError) throw new RuntimeContractError("unauthorized", error.message, "agent-service-policy")
        throw error
      }
      // The envelope must not lengthen a child method's own deadline (e.g. pipeline 30 seconds).
      const child = new AbortController()
      const abort = () => child.abort(context.signal.reason)
      context.signal.addEventListener("abort", abort, { once: true })
      if (context.signal.aborted) abort()
      try {
        const result: RuntimeMethodResponse = await registry.dispatch(context.session, action, input, child.signal)
        return reply(result.data, result.frameRefs, result.isError)
      } finally { context.signal.removeEventListener("abort", abort) }
    },
  })
}
