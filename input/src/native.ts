import { access, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"

const INPUT_ROOT = join(import.meta.dir, "..")
const NATIVE_SOURCE = join(INPUT_ROOT, "native", "meta_input_helper.c")
const NATIVE_HELPER = join(INPUT_ROOT, "bin", "meta-input-helper")
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

async function sourceIsNewerThanInstalledHelper(): Promise<boolean> {
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
  try {
    await access(NATIVE_HELPER, constants.X_OK)
  } catch {
    throw new Error(
      `установленный meta-input-helper отсутствует или не исполняем: ${NATIVE_HELPER}; требуется явный apply-update`,
    )
  }
  if (await sourceIsNewerThanInstalledHelper()) {
    throw new Error(
      `исходник native helper новее установленного ${NATIVE_HELPER}; автоматическая пересборка запрещена, требуется согласованный apply-update`,
    )
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
