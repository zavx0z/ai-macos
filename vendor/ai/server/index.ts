/**
 * Запускает необязательный HTTP-host универсальных инструментов.
 * @remarks Для встраивания в Завхоз импортируют server/dispatch, а не запускают
 * этот listener. Никаких Interpreter, браузера или отдельного MCP-server.
 * @packageDocumentation
 */
import {createServer} from "node:http"
import {Readable} from "node:stream"
import {fileURLToPath} from "node:url"
import {dirname, resolve} from "node:path"
import type {AddressInfo} from "node:net"
import {integer, text, boolean} from "../shared/validation.ts"
import {createRequestHandler} from "./request/index.ts"
import {directoryAuthorizer} from "./request/src/authorize.ts"
import type {ServerInput} from "./contract/input.ts"
import type {ServerOutput} from "./contract/output.ts"
export type {ServerInput} from "./contract/input.ts"
export type {ServerOutput} from "./contract/output.ts"

export async function startServer(options: ServerInput): Promise<ServerOutput> {
  const authorize = directoryAuthorizer(options.allowedDirectories)
  const hostname = text(options.hostname ?? "127.0.0.1", "hostname")
  const port = integer(options.port, 8787, 0, 65535, "port")
  const log = boolean(options.log, true, "log")
  const handler = createRequestHandler({authorize, token: options.token,
    repositoryRoot: options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    logger: log ? event => process.stderr.write(JSON.stringify(event) + "\n") : undefined})
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? "GET"
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      const init: RequestInit & {duplex?: "half"} = {method, headers}
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        init.duplex = "half"
      }
      const response = await handler.handle(new Request(`http://localhost${incoming.url ?? "/"}`, init))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400, {"content-type": "application/json", "cache-control": "no-store"})
      outgoing.end(JSON.stringify({error: {code: "INVALID_REQUEST", message: "Could not process HTTP request"}}))
    }
  })
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(port, hostname, () => {server.off("error", reject); done()})
  })
  const address = server.address() as AddressInfo
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address
  return {url: `http://${host}:${address.port}/tools`, close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const allowedDirectories = JSON.parse(process.env["AI_TOOLS_ALLOWED_DIRECTORIES"] ?? "null") as string[]
    const host = await startServer({allowedDirectories, token: process.env["AI_TOOLS_TOKEN"] ?? "",
      hostname: process.env["AI_TOOLS_HOST"], port: process.env["AI_TOOLS_PORT"] === undefined ? undefined : Number(process.env["AI_TOOLS_PORT"])})
    process.stderr.write(`AI tools listening at ${host.url}\n`)
    const stop = (): void => { void host.close().catch(() => {process.exitCode = 1}) }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  } catch (error) {
    process.stderr.write(`Unable to start AI tools: ${error instanceof Error ? error.message : "invalid configuration"}\n`)
    process.exitCode = 1
  }
}
