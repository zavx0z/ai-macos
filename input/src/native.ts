import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

const INPUT_ROOT = join(import.meta.dir, "..")
const NATIVE_SOURCE = join(INPUT_ROOT, "native", "meta_input_helper.c")
const NATIVE_DIR = join(INPUT_ROOT, "bin")
const NATIVE_HELPER = join(NATIVE_DIR, "meta-input-helper")
const ACCESSIBILITY_EXIT = 77

export class NativeInputError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message)
  }
}

async function run(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([executable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

async function needsBuild(): Promise<boolean> {
  try {
    const [source, helper] = await Promise.all([stat(NATIVE_SOURCE), stat(NATIVE_HELPER)])
    return source.mtimeMs > helper.mtimeMs
  } catch {
    return true
  }
}

export async function ensureNativeHelper(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("@meta/input native helper поддерживается только на macOS")
  }
  if (!(await needsBuild())) return NATIVE_HELPER

  await mkdir(NATIVE_DIR, { recursive: true })
  const compile = await run("/usr/bin/clang", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-mmacosx-version-min=12.0",
    "-framework",
    "ApplicationServices",
    "-framework",
    "CoreGraphics",
    "-framework",
    "AppKit",
    "-x",
    "objective-c",
    "-o",
    NATIVE_HELPER,
    NATIVE_SOURCE,
  ])
  if (compile.code !== 0) {
    throw new Error(`не удалось собрать meta-input-helper: ${compile.stderr}`)
  }

  const sign = await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.meta.input.helper",
    NATIVE_HELPER,
  ])
  if (sign.code !== 0) {
    throw new Error(`не удалось подписать meta-input-helper: ${sign.stderr}`)
  }
  return NATIVE_HELPER
}

export async function nativeResult(
  helper: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await run(helper, args)
}

export async function nativeCommand(helper: string, args: string[]): Promise<string> {
  const result = await nativeResult(helper, args)
  if (result.code === 0) return result.stdout
  const message =
    result.code === ACCESSIBILITY_EXIT
      ? "Accessibility не выдан meta-input-helper"
      : result.stderr || `meta-input-helper завершился с кодом ${result.code}`
  throw new NativeInputError(message, result.code, result.stderr)
}

export async function probeNativeAccessibility(helper: string): Promise<boolean> {
  return (await nativeResult(helper, ["check"])).code === 0
}

export async function preflightNativeAccessibility(helper: string): Promise<boolean> {
  return (await nativeResult(helper, ["preflight"])).code === 0
}

export async function requestNativeAccessibility(
  helper: string,
): Promise<{ accessibility: boolean; postEvents: boolean }> {
  const result = await nativeResult(helper, ["request"])
  try {
    return JSON.parse(result.stdout) as { accessibility: boolean; postEvents: boolean }
  } catch {
    return { accessibility: false, postEvents: false }
  }
}
