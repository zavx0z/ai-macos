/**
 * Необязательный HTTP-адаптер lazy MCP: GET /tools и POST /tools.
 * @remarks Все запросы требуют Bearer token. Выполнение делегируется тому же
 * createDispatcher, что используется при встраивании, без второго исполнителя.
 * @packageDocumentation
 */
import {randomUUID, timingSafeEqual} from "node:crypto"
import {ToolError, asToolError} from "../../shared/errors.ts"
import {object, text} from "../../shared/validation.ts"
import {createDispatcher} from "../dispatch/index.ts"
import type {ToolRequest} from "../dispatch/contract/input.ts"
import {readBody} from "./src/body.ts"
import type {RequestInput} from "./contract/input.ts"
import type {RequestOutput} from "./contract/output.ts"
export type {RequestInput} from "./contract/input.ts"
export type {RequestOutput} from "./contract/output.ts"

export function createRequestHandler(options: RequestInput): RequestOutput {
  const token = text(options.token, "token")
  if (token.length < 32 || token.length > 256) throw new ToolError("INVALID_INPUT", "Token must contain 32 to 256 characters")
  const expected = Buffer.from(`Bearer ${token}`)
  const dispatcher = createDispatcher(options)
  return {handle: async request => {
    const requestId = randomUUID()
    const started = performance.now()
    let node: string | undefined
    let action: string | undefined
    let status = 200
    let errorCode: string | undefined
    let data: unknown
    try {
      const provided = Buffer.from(request.headers.get("authorization") ?? "")
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ToolError("UNAUTHORIZED", "A valid Bearer token is required", 401)
      if (request.headers.has("origin")) throw new ToolError("ORIGIN_NOT_ALLOWED", "Browser-origin requests are not enabled", 403)
      const url = new URL(request.url)
      if (url.pathname !== "/tools") throw new ToolError("NOT_FOUND", "Unknown endpoint", 404)
      if (url.search !== "") throw new ToolError("INVALID_INPUT", "Use the JSON request body, not URL query parameters")
      if (request.method !== "GET" && request.method !== "POST") throw new ToolError("METHOD_NOT_ALLOWED", "Use GET or POST", 405)
      const payload = request.method === "GET" ? {} : await readBody(request)
      object(payload, ["node", "action", "input"])
      const body = payload as ToolRequest
      node = body.node === undefined ? undefined : text(body.node, "node")
      action = body.action === undefined ? undefined : text(body.action, "action")
      data = await dispatcher.dispatch(body)
    } catch (error) {
      const failure = asToolError(error)
      status = failure.status
      errorCode = failure.code
      data = {error: {code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : {details: failure.details})}, requestId}
    }
    const headers: Record<string, string> = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId}
    if (status === 401) headers["www-authenticate"] = "Bearer"
    if (status === 405) headers["allow"] = "GET, POST"
    try { options.logger?.({requestId, method: request.method, node, action, status, durationMs: Math.round(performance.now() - started), errorCode}) }
    catch { /* Diagnostics must not change an already completed operation. */ }
    return new Response(JSON.stringify(data), {status, headers})
  }}
}
