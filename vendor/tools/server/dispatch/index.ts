/**
 * Общий lazy-вход для встраивания в существующий Завхоз и для HTTP-адаптера.
 * @remarks Описание ничего не исполняет. run требует явного разрешения хоста.
 * Не запускает сервер, MCP, Interpreter, браузер или второй Runtime.
 * @packageDocumentation
 */
import {ToolError} from "../../shared/errors.ts"
import {object, text} from "../../shared/validation.ts"
import {absolutePath} from "../../filesystem/shared/paths.ts"
import {createDiscovery} from "../discovery/index.ts"
import {bindings} from "./src/bindings.ts"
import type {DispatcherInput, ToolRequest, ToolInvocation} from "./contract/input.ts"
import type {DispatcherOutput} from "./contract/output.ts"
export type {DispatcherInput, ToolRequest, ToolInvocation} from "./contract/input.ts"
export type {DispatcherOutput} from "./contract/output.ts"

function frozen<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value)) frozen(child, seen)
    Object.freeze(value)
  }
  return value
}

export function createDispatcher(options: DispatcherInput): DispatcherOutput {
  const handlers = bindings()
  const discovery = createDiscovery({repositoryRoot: options.repositoryRoot, readSource: options.readSource, runnable: new Set(handlers.keys())})
  // The authority is supplied by the host, not selected or replaced in a tool request.
  const authorize = options.authorize
  return {dispatch: async (request: ToolRequest = {}) => {
    options.signal?.throwIfAborted()
    object(request, ["node", "action", "input"])
    const node = request.node === undefined ? undefined : text(request.node, "node")
    const action = request.action === undefined ? undefined : text(request.action, "action")
    if (action === undefined) {
      const input = request.input ?? {}
      object(input, ["view"])
      return discovery.describe(node, input["view"] === undefined ? undefined : text(input["view"], "view"))
    }
    if (action !== "run") throw new ToolError("ACTION_NOT_ALLOWED", "Only action: run executes tools")
    if (node === undefined || !discovery.has(node)) throw new ToolError("UNKNOWN_NODE", "Unknown executable node", 404)
    const handler = handlers.get(node)
    if (handler === undefined) throw new ToolError("ACTION_NOT_ALLOWED", "This structural node is not executable", 403)
    if (authorize === undefined) throw new ToolError("AUTHORIZATION_REQUIRED", "The calling host must authorize tool execution", 403)
    const supplied = request.input ?? {}
    object(supplied, Object.keys(supplied))
    let input: Readonly<Record<string, unknown>>
    try { input = frozen(structuredClone(supplied)) }
    catch { throw new ToolError("INVALID_INPUT", "Arguments must be structured-cloneable data") }
    const paths = handler.fields.flatMap(field => {
      const value = input[field]
      if (field !== "paths") return [absolutePath(value)]
      if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new ToolError("INVALID_INPUT", "paths must contain 1 to 50 strings")
      return value.map(absolutePath)
    })
    const effect = handler.write && !(node === "tools/filesystem/apply-patch" && input["dryRun"] === true) ? "write" : "read"
    const invocation: ToolInvocation = Object.freeze({node, input, paths: Object.freeze(paths), effect})
    if (await authorize(invocation) !== true) throw new ToolError("AUTHORIZATION_REQUIRED", "The calling host did not authorize this invocation", 403)
    options.signal?.throwIfAborted()
    return handler.run(input)
  }}
}
