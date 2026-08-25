import {closeSync, mkdirSync, openSync} from "node:fs"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import {spawn} from "bun"

type JsonObject = Record<string, unknown>

type RestService = {
  name: "window" | "screen" | "chrome" | "input"
  port: number
  probePath: string
  validate(payload: JsonObject): boolean
}

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const LOG_DIR = join(PROJECT_ROOT, "logs", "mcp-services")
const STARTUP_TIMEOUT_MS = positiveInteger(Bun.env.AI_MACOS_REST_STARTUP_TIMEOUT_MS, 15_000)
const PROBE_INTERVAL_MS = 100

const services: readonly RestService[] = [
  {
    name: "window",
    port: 7878,
    probePath: "/screen",
    validate: (payload) => typeof payload["width"] === "number" && typeof payload["height"] === "number",
  },
  {
    name: "screen",
    port: 7879,
    probePath: "/health",
    validate: (payload) => payload["ok"] === true && typeof payload["windowApi"] === "string",
  },
  {
    name: "chrome",
    port: 7880,
    probePath: "/health",
    validate: (payload) => payload["ok"] === true && isObject(payload["cdp"]),
  },
  {
    name: "input",
    port: 7882,
    probePath: "/health",
    validate: (payload) => payload["ok"] === true && typeof payload["backend"] === "string",
  },
]

await ensureRestServices(services)
await import("./index.ts")

async function ensureRestServices(definitions: readonly RestService[]): Promise<void> {
  mkdirSync(LOG_DIR, {recursive: true})
  for (const service of definitions) {
    if (await isReady(service)) {
      diagnostic("rest_already_ready", {service: service.name, port: service.port})
      continue
    }
    const logPath = join(LOG_DIR, `${service.name}.log`)
    const pid = launchService(service, logPath)
    diagnostic("rest_starting", {service: service.name, port: service.port, pid, logPath})
    await waitUntilReady(service, logPath)
    diagnostic("rest_ready", {service: service.name, port: service.port, pid})
  }
}

function launchService(service: RestService, logPath: string): number {
  const logFd = openSync(logPath, "a")
  try {
    const child = spawn([process.execPath, "run", "start"], {
      cwd: join(PROJECT_ROOT, service.name),
      env: {...process.env},
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    })
    child.unref()
    return child.pid
  } finally {
    closeSync(logFd)
  }
}

async function waitUntilReady(service: RestService, logPath: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isReady(service)) return
    await Bun.sleep(PROBE_INTERVAL_MS)
  }
  throw new Error(`ai-macos ${service.name} REST did not become ready on port ${service.port}; inspect ${logPath}`)
}

async function isReady(service: RestService): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}${service.probePath}`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return false
    const payload = await response.json() as unknown
    return isObject(payload) && service.validate(payload)
  } catch {
    return false
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function diagnostic(event: string, fields: JsonObject): void {
  process.stderr.write(`${JSON.stringify({time: new Date().toISOString(), component: "ai-macos-mcp-launcher", event, ...fields})}\n`)
}
