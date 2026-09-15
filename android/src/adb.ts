import { spawn } from "bun"

export const DEFAULT_DEBUG_PORT = 9223

export type AdbDevice = {
  serial: string
  state: string
}

export type AdbForwardRecord = {
  serial: string
  local: string
  remote: string
}

export type AdbRun = (
  command: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; code: number }>

export class AdbCommandCleanupError extends Error {
  constructor(message: string, readonly cleanupUnknown = true) {
    super(message)
    this.name = "AdbCommandCleanupError"
  }
}

export class AdbOutputLimitError extends Error {
  constructor(message: string, readonly maxBytes: number) {
    super(message)
    this.name = "AdbOutputLimitError"
  }
}

export type AdbProcess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: number): void
}

export type AdbSpawn = (command: string[]) => AdbProcess

export async function runAdbCommand(
  cmd: string[],
  timeoutMs = 5_000,
  signal?: AbortSignal,
  spawnProcess: AdbSpawn = command => spawn(command, { stdout: "pipe", stderr: "pipe" }) as AdbProcess,
  cleanupStepMs = 500,
  maxOutputBytes = 1024 * 1024,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (signal?.aborted) throw new DOMException("ADB command aborted before spawn", "AbortError")
  const proc = spawnProcess(cmd)
  let timer: ReturnType<typeof setTimeout> | null = null
  let abortRequested = false
  let deadlineExceeded = false
  let exitConfirmed = false
  let rejectAbort: ((error: Error) => void) | null = null
  const ioController = new AbortController()
  const onAbort = () => {
    abortRequested = true
    proc.kill()
    rejectAbort?.(new DOMException("ADB command aborted", "AbortError"))
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
    if (signal?.aborted) onAbort()
  })
  const exited = proc.exited.then(code => {
    exitConfirmed = true
    return code
  })
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineExceeded = true
      proc.kill()
      reject(new Error(`${cmd[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        readAdbStream(proc.stdout, "stdout", maxOutputBytes, ioController.signal),
        readAdbStream(proc.stderr, "stderr", maxOutputBytes, ioController.signal),
        exited,
      ]),
      deadline,
      aborted,
    ])
    if (abortRequested) throw new DOMException("ADB command aborted", "AbortError")
    if (deadlineExceeded) throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`)
    return { stdout, stderr, code }
  } catch (error) {
    ioController.abort()
    let confirmed = exitConfirmed
    if (!confirmed) proc.kill()
    if (!confirmed) confirmed = await waitForExit(exited, cleanupStepMs)
    if (!confirmed) {
      proc.kill(9)
      confirmed = await waitForExit(proc.exited, cleanupStepMs)
    }
    if (!confirmed) {
      throw new AdbCommandCleanupError(
        `ADB command cleanup is unknown after TERM and KILL: ${cmd[0]}`,
      )
    }
    throw error
  } finally {
    ioController.abort()
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    rejectAbort = null
  }
}

async function readAdbStream(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const onAbort = () => reader.cancel("aborted").catch(() => {})
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel("output-too-large").catch(() => {})
        throw new AdbOutputLimitError(`ADB ${name} exceeds ${maxBytes} bytes`, maxBytes)
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

const run: AdbRun = (command, timeoutMs, signal) => runAdbCommand(command, timeoutMs, signal)

async function waitForExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    exited.then(() => true, () => false),
    Bun.sleep(timeoutMs).then(() => false),
  ])
}

export function adbArgs(serial: string, ...args: string[]): string[] {
  if (!serial.trim()) throw new Error("Android serial is required")
  return ["adb", "-s", serial, ...args]
}

export async function adbDevices(signal?: AbortSignal): Promise<AdbDevice[]> {
  const { stdout, stderr, code } = await run(["adb", "devices"], 5_000, signal)
  if (code !== 0) throw new Error(`adb devices failed: ${stderr.trim()}`)
  return parseAdbDevices(stdout)
}

export function parseAdbDevices(stdout: string): AdbDevice[] {
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((l) => l.length > 0 && l.includes("\t"))
    .map((line) => {
      const [serial, state] = line.split("\t")
      return { serial: serial!, state: state ?? "unknown" }
    })
}

export async function adbForward(localPort: number, serial: string, signal?: AbortSignal): Promise<void> {
  const { stderr, code } = await run(adbArgs(
    serial,
    "forward",
    "--no-rebind",
    `tcp:${localPort}`,
    "localabstract:chrome_devtools_remote",
  ), 5_000, signal)
  if (code !== 0) throw new Error(`adb forward failed: ${stderr.trim()}`)
}

export async function adbForwardList(runCommand: AdbRun = run, signal?: AbortSignal): Promise<AdbForwardRecord[]> {
  const { stdout, stderr, code } = await runCommand(["adb", "forward", "--list"], 5_000, signal)
  if (code !== 0) throw new Error(`adb forward --list failed: ${stderr.trim()}`)
  return parseAdbForwardList(stdout)
}

export function parseAdbForwardList(stdout: string): AdbForwardRecord[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [serial, local, remote] = line.split(/\s+/)
      return serial && local && remote ? [{ serial, local, remote }] : []
    })
}

export async function adbRemoveForward(localPort: number, serial: string, signal?: AbortSignal): Promise<void> {
  const { stderr, code } = await run(adbArgs(serial, "forward", "--remove", `tcp:${localPort}`), 5_000, signal)
  if (code !== 0) throw new Error(`adb forward --remove failed: ${stderr.trim()}`)
}

export async function adbGetState(serial: string): Promise<string> {
  const { stdout, stderr, code } = await run(adbArgs(serial, "get-state"))
  if (code !== 0) throw new Error(`adb get-state failed: ${stderr.trim()}`)
  return stdout.trim()
}

export async function adbOpenUrl(serial: string, url: string, signal?: AbortSignal): Promise<void> {
  const { stderr, code } = await run(adbArgs(
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    url,
    "com.android.chrome",
  ), 10_000, signal)
  if (code !== 0) throw new Error(`adb open URL failed: ${stderr.trim()}`)
}

export async function adbAvailable(): Promise<boolean> {
  try {
    const { code } = await run(["adb", "version"])
    return code === 0
  } catch {
    return false
  }
}
