import {closeSync, mkdirSync, openSync} from "node:fs"
import {hostname} from "node:os"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import {spawn} from "bun"

type JsonObject = Record<string, unknown>

type RestService = {
  name: "window" | "screen" | "chrome" | "input"
  baseUrl: string
  port: number
  probePath: string
  validate(payload: JsonObject): boolean
}

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const LOG_DIR = join(PROJECT_ROOT, "logs", "mcp-services")
const STARTUP_TIMEOUT_MS = positiveInteger(Bun.env.AI_MACOS_REST_STARTUP_TIMEOUT_MS, 15_000)
const PROBE_INTERVAL_MS = 100
const WINDOW_API = Bun.env.WINDOW_API ?? "http://127.0.0.1:7878"
const SCREEN_API = Bun.env.SCREEN_API ?? "http://127.0.0.1:7879"
const CHROME_API = Bun.env.CHROME_API ?? "http://127.0.0.1:7880"
const INPUT_API = Bun.env.INPUT_API ?? "http://127.0.0.1:7882"

const services: readonly RestService[] = [
  {
    name: "window",
    baseUrl: WINDOW_API,
    port: apiPort(WINDOW_API, 7878),
    probePath: "/health",
    validate: (payload) => payload["ok"] === true && payload["service"] === "@meta/window",
  },
  {
    name: "screen",
    baseUrl: SCREEN_API,
    port: apiPort(SCREEN_API, 7879),
    probePath: "/health",
    validate: (payload) =>
      payload["ok"] === true
      && payload["service"] === "@meta/screen"
      && typeof payload["windowApi"] === "string",
  },
  {
    name: "chrome",
    baseUrl: CHROME_API,
    port: apiPort(CHROME_API, 7880),
    probePath: "/health",
    validate: (payload) =>
      payload["ok"] === true
      && payload["service"] === "@meta/chrome"
      && isObject(payload["cdp"]),
  },
  {
    name: "input",
    baseUrl: INPUT_API,
    port: apiPort(INPUT_API, 7882),
    probePath: "/status",
    validate: (payload) =>
      payload["service"] === "@meta/input"
      && payload["backend"] === "native-helper"
      && typeof payload["accessibility"] === "boolean"
      && typeof payload["inputReady"] === "boolean"
      && typeof payload["clipboardReady"] === "boolean"
      && (typeof payload["helper"] === "string" || payload["helper"] === null)
      && isObject(payload["clipboard"]),
  },
]

const expectedHostname = Bun.env.AI_MACOS_EXPECTED_HOSTNAME
const actualHostname = hostname()
if (expectedHostname !== undefined && expectedHostname === actualHostname) {
  await ensureRestServices(services)
} else {
  diagnostic("rest_startup_skipped_machine_mismatch", {
    expectedHostname: expectedHostname ?? null,
    actualHostname,
  })
}
await import("./index.ts")

async function ensureRestServices(definitions: readonly RestService[]): Promise<void> {
  mkdirSync(LOG_DIR, {recursive: true})
  await Promise.all(definitions.map(async (service) => {
    const state = await probeService(service)
    if (state === "ready") {
      diagnostic("rest_already_ready", {service: service.name, port: service.port})
      return
    }
    if (state === "incompatible") {
      diagnostic("rest_incompatible_listener_preserved", {service: service.name, port: service.port})
      return
    }
    if (!isLoopbackApi(service.baseUrl)) {
      diagnostic("rest_missing_non_loopback_not_started", {
        service: service.name,
        baseUrl: service.baseUrl,
      })
      return
    }
    const logPath = join(LOG_DIR, `${service.name}.log`)
    const pid = launchService(service, logPath)
    diagnostic("rest_starting", {service: service.name, port: service.port, pid, logPath})
    await waitUntilReady(service, logPath)
    diagnostic("rest_ready", {service: service.name, port: service.port, pid})
  }))
}

function launchService(service: RestService, logPath: string): number {
  const logFd = openSync(logPath, "a")
  try {
    const child = spawn([process.execPath, "run", "start"], {
      cwd: join(PROJECT_ROOT, service.name),
      env: {
        ...process.env,
        PORT: String(service.port),
        ...(service.name === "input" ? {INPUT_AUTO_REQUEST_ACCESSIBILITY: "false"} : {}),
      },
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
  return await probeService(service) === "ready"
}

async function probeService(service: RestService): Promise<"ready" | "incompatible" | "missing"> {
  let response: Response
  try {
    response = await fetch(`${service.baseUrl}${service.probePath}`, {
      signal: AbortSignal.timeout(1_000),
    })
  } catch {
    return "missing"
  }
  if (!response.ok) return "incompatible"
  try {
    const payload = await response.json() as unknown
    return isObject(payload) && service.validate(payload) ? "ready" : "incompatible"
  } catch {
    return "incompatible"
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function apiPort(baseUrl: string, fallback: number): number {
  try {
    const port = Number(new URL(baseUrl).port)
    return Number.isInteger(port) && port > 0 ? port : fallback
  } catch {
    return fallback
  }
}

function isLoopbackApi(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  } catch {
    return false
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function diagnostic(event: string, fields: JsonObject): void {
  process.stderr.write(`${JSON.stringify({time: new Date().toISOString(), component: "ai-macos-mcp-launcher", event, ...fields})}\n`)
}
