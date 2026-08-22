import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

const WINDOW_ROOT = join(import.meta.dir, "..")
const SOURCE = join(WINDOW_ROOT, "native", "meta_window_helper.c")
const BIN_DIR = join(WINDOW_ROOT, "bin")
const HELPER = join(BIN_DIR, "meta-window-helper")

export class NativeWindowError extends Error {
  constructor(message: string, readonly code: number, readonly stderr: string) {
    super(message)
  }
}

async function run(executable: string, args: string[]) {
  const proc = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

async function needsBuild() {
  try {
    const [source, helper] = await Promise.all([stat(SOURCE), stat(HELPER)])
    return source.mtimeMs > helper.mtimeMs
  } catch {
    return true
  }
}

export async function ensureWindowHelper(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("meta-window-helper is supported only on macOS")
  if (!(await needsBuild())) return HELPER
  await mkdir(BIN_DIR, { recursive: true })
  const compiled = await run("/usr/bin/clang", [
    "-O2", "-Wall", "-Wextra", "-mmacosx-version-min=12.0",
    "-framework", "ApplicationServices", "-framework", "CoreGraphics",
    "-o", HELPER, SOURCE,
  ])
  if (compiled.code !== 0) throw new Error(`failed to build meta-window-helper: ${compiled.stderr}`)
  const signed = await run("/usr/bin/codesign", [
    "--force", "--sign", "-", "--identifier", "com.meta.window.helper", HELPER,
  ])
  if (signed.code !== 0) throw new Error(`failed to sign meta-window-helper: ${signed.stderr}`)
  return HELPER
}

export async function nativeWindowCommand(args: string[]): Promise<string> {
  const helper = await ensureWindowHelper()
  const result = await run(helper, args)
  if (result.code === 0) return result.stdout
  const messages: Record<number, string> = {
    77: `Accessibility is not granted to ${helper}`,
    78: "exact window target not found",
    79: "exact focus verification failed",
  }
  throw new NativeWindowError(messages[result.code] ?? result.stderr ?? `meta-window-helper exited ${result.code}`, result.code, result.stderr)
}

export function windowHelperPath(): string {
  return HELPER
}
