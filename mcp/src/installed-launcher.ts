import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readlink, realpath } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createUnavailableRuntimeMcpServer } from "./runtime-mcp.ts"

const RELEASE_FORMAT = "meta-ai-macos-runtime-release-v1"
const SERVICE_LABEL = "com.meta.ai-macos.runtime"
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RUNTIME_BYTES = 128 * 1024 * 1024
const MAX_UNIX_SOCKET_BYTES = 103

export type InstalledFileInfo = {
  kind: "file" | "directory" | "symlink" | "other"
  uid: number
  mode: number
  size: number
}

export interface InstalledLauncherFs {
  info(path: string): Promise<InstalledFileInfo>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  readLink(path: string): Promise<string>
  realPath(path: string): Promise<string>
}

export type InstalledChild = {
  exited: Promise<number>
  kill(signal: NodeJS.Signals): void
}

export interface InstalledRunner {
  spawn(file: string, args: readonly string[], options: {
    cwd: string
    env: Readonly<Record<string, string | undefined>>
    stdin: "inherit"
    stdout: "inherit"
    stderr: "inherit"
  }): InstalledChild
}

export interface LauncherSignals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void
}

export type InstalledLauncherOptions = {
  expectedHostname?: string
  actualHostname?: string
  homeDirectory?: string
  uid?: number
  cleanupTimeoutMs?: number
  fs?: InstalledLauncherFs
  runner?: InstalledRunner
  signals?: LauncherSignals
  environment?: Readonly<Record<string, string | undefined>>
  serveUnavailable?: (
    reason: "machine-mismatch" | "configuration-missing" | "runtime-unavailable",
    expectedHostname: string | undefined,
  ) => Promise<void>
}

export type InstalledLauncherResult =
  | { state: "unavailable", reason: "machine-mismatch" | "configuration-missing" | "runtime-unavailable" }
  | { state: "launched", releaseId: string, runtimePath: string, exitCode: number }

type InstalledManifest = {
  format: typeof RELEASE_FORMAT
  releaseId: string
  source: { repositoryRoot: string }
  artifacts: { runtime: { path: "runtime", sha256: string, bytes: number } }
  launchAgent: { label: typeof SERVICE_LABEL }
  entrypoint: { source: "scripts/runtime-entry.ts", modes: readonly string[], mcpTransport: "stdio" }
}

export async function runInstalledLauncher(options: InstalledLauncherOptions = {}): Promise<InstalledLauncherResult> {
  const expectedHostname = options.expectedHostname ?? process.env.AI_MACOS_EXPECTED_HOSTNAME
  const actualHostname = options.actualHostname ?? hostname()
  const serveUnavailable = options.serveUnavailable ?? defaultUnavailable
  if (expectedHostname === undefined || actualHostname !== expectedHostname) {
    await serveUnavailable("machine-mismatch", expectedHostname)
    return { state: "unavailable", reason: "machine-mismatch" }
  }

  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) {
    await serveUnavailable("configuration-missing", expectedHostname)
    return { state: "unavailable", reason: "configuration-missing" }
  }
  const fs = options.fs ?? nodeFileSystem
  let installed: Awaited<ReturnType<typeof resolveInstalledRuntime>>
  try {
    installed = await resolveInstalledRuntime(fs, homeDirectory, uid)
  } catch {
    await serveUnavailable("runtime-unavailable", expectedHostname)
    return { state: "unavailable", reason: "runtime-unavailable" }
  }

  const runRoot = join(homeDirectory, "Library", "Application Support", "ai-macos", "run")
  const socketPath = join(runRoot, "runtime.sock")
  if (new TextEncoder().encode(socketPath).byteLength > MAX_UNIX_SOCKET_BYTES) {
    await serveUnavailable("configuration-missing", expectedHostname)
    return { state: "unavailable", reason: "configuration-missing" }
  }
  const runner = options.runner ?? bunRunner
  const signals = options.signals ?? processSignals
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 10 || cleanupTimeoutMs > 10_000) {
    await serveUnavailable("configuration-missing", expectedHostname)
    return { state: "unavailable", reason: "configuration-missing" }
  }
  let child: InstalledChild
  try {
    child = runner.spawn(installed.runtimePath, ["--mcp"], {
      cwd: installed.releasePath,
      env: {
        ...(options.environment ?? process.env),
        AI_MACOS_EXPECTED_HOSTNAME: expectedHostname,
        META_RUNTIME_SOCKET: socketPath,
        META_RUNTIME_CREDENTIAL: join(runRoot, "credential.json"),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  } catch {
    await serveUnavailable("runtime-unavailable", expectedHostname)
    return { state: "unavailable", reason: "runtime-unavailable" }
  }
  const exitCode = await superviseChild(child, signals, cleanupTimeoutMs)
  return {
    state: "launched",
    releaseId: installed.manifest.releaseId,
    runtimePath: installed.runtimePath,
    exitCode,
  }
}

async function resolveInstalledRuntime(fs: InstalledLauncherFs, home: string, uid: number) {
  const installRoot = join(home, "Library", "Application Support", "ai-macos", "runtime")
  const releasesRoot = join(installRoot, "releases")
  const currentPath = join(installRoot, "current")
  await assertNode(fs, installRoot, "directory", uid, 0o700)
  await assertNode(fs, releasesRoot, "directory", uid, 0o700)
  await assertNode(fs, currentPath, "symlink", uid)
  const link = await fs.readLink(currentPath)
  const releasePath = resolve(dirname(currentPath), link)
  const inside = relative(releasesRoot, releasePath)
  if (inside.length === 0 || inside.startsWith("..") || dirname(releasePath) !== releasesRoot
    || resolve(await fs.realPath(currentPath)) !== releasePath
    || releasePath.includes("/production/") || releasePath.endsWith("/production")) {
    throw new Error("Installed current symlink выходит из immutable releases")
  }
  await assertNode(fs, releasePath, "directory", uid, 0o555)
  const manifestPath = join(releasePath, "manifest.json")
  const manifestInfo = await assertNode(fs, manifestPath, "file", uid, 0o444)
  if (manifestInfo.size < 1 || manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error("Installed manifest нарушает byte limit")
  const manifestBytes = await fs.read(manifestPath, MAX_MANIFEST_BYTES)
  if (manifestBytes.byteLength !== manifestInfo.size || manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Installed manifest изменился при bounded read")
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
  if (manifest.releaseId !== basename(releasePath) || !/^\/Users\/[^/]+\/repozitarium\/ai-macos$/.test(manifest.source.repositoryRoot)
    || manifest.source.repositoryRoot.includes("/production/")) throw new Error("Installed manifest source/release identity invalid")
  const runtimePath = join(releasePath, manifest.artifacts.runtime.path)
  const runtimeInfo = await assertNode(fs, runtimePath, "file", uid, 0o555)
  if (runtimeInfo.size !== manifest.artifacts.runtime.bytes || runtimeInfo.size < 1 || runtimeInfo.size > MAX_RUNTIME_BYTES) {
    throw new Error("Installed runtime size не совпадает с manifest")
  }
  const runtimeBytes = await fs.read(runtimePath, MAX_RUNTIME_BYTES)
  if (runtimeBytes.byteLength !== runtimeInfo.size || runtimeBytes.byteLength > MAX_RUNTIME_BYTES
    || sha256(runtimeBytes) !== manifest.artifacts.runtime.sha256) throw new Error("Installed runtime digest не совпадает с manifest")
  return { installRoot, releasePath, runtimePath, manifest }
}

async function assertNode(
  fs: InstalledLauncherFs,
  path: string,
  kind: InstalledFileInfo["kind"],
  uid: number,
  mode?: number,
): Promise<InstalledFileInfo> {
  const info = await fs.info(path)
  if (info.kind !== kind || info.uid !== uid || mode !== undefined && (info.mode & 0o777) !== mode) {
    throw new Error(`Installed path owner/type/mode mismatch: ${path}`)
  }
  return info
}

function parseManifest(value: unknown): InstalledManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Installed manifest должен быть object")
  const manifest = value as InstalledManifest
  if (manifest.format !== RELEASE_FORMAT || typeof manifest.releaseId !== "string" || manifest.releaseId.length < 1
    || manifest.artifacts?.runtime?.path !== "runtime" || !/^[a-f0-9]{64}$/.test(manifest.artifacts.runtime.sha256)
    || !Number.isSafeInteger(manifest.artifacts.runtime.bytes)
    || manifest.launchAgent?.label !== SERVICE_LABEL || manifest.entrypoint?.source !== "scripts/runtime-entry.ts"
    || !manifest.entrypoint.modes.includes("mcp") || manifest.entrypoint.mcpTransport !== "stdio") {
    throw new Error("Installed manifest contract mismatch")
  }
  return manifest
}

async function superviseChild(child: InstalledChild, signals: LauncherSignals, cleanupTimeoutMs: number): Promise<number> {
  let stopping = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let boundedExitTimer: ReturnType<typeof setTimeout> | undefined
  let finishBoundedExit!: (code: number) => void
  const boundedExit = new Promise<number>(resolveExit => { finishBoundedExit = resolveExit })
  const forward = (signal: "SIGINT" | "SIGTERM") => () => {
    if (stopping) return
    stopping = true
    try { child.kill(signal) } catch {}
    forceTimer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch {}
      boundedExitTimer = setTimeout(() => finishBoundedExit(137), cleanupTimeoutMs)
    }, cleanupTimeoutMs)
  }
  const interrupt = forward("SIGINT")
  const terminate = forward("SIGTERM")
  signals.on("SIGINT", interrupt)
  signals.on("SIGTERM", terminate)
  try { return await Promise.race([child.exited, boundedExit]) }
  finally {
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    if (boundedExitTimer !== undefined) clearTimeout(boundedExitTimer)
    signals.off("SIGINT", interrupt)
    signals.off("SIGTERM", terminate)
  }
}

const nodeFileSystem: InstalledLauncherFs = {
  async info(path) {
    const value = await lstat(path)
    return {
      kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other",
      uid: value.uid,
      mode: value.mode,
      size: value.size,
    }
  },
  async read(path, maxBytes) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size < 0 || before.size > maxBytes) throw new Error("Installed file превышает bounded read")
      const bytes = new Uint8Array(before.size + 1)
      let offset = 0
      while (offset < bytes.byteLength) {
        const part = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
        if (part.bytesRead === 0) break
        offset += part.bytesRead
      }
      const after = await handle.stat()
      if (offset !== before.size || after.size !== before.size || offset > maxBytes) throw new Error("Installed file изменился при bounded read")
      return bytes.slice(0, offset)
    } finally { await handle.close() }
  },
  readLink: path => readlink(path),
  realPath: path => realpath(path),
}

const bunRunner: InstalledRunner = {
  spawn(file, args, options) {
    const child = Bun.spawn([file, ...args], options)
    return { exited: child.exited, kill: signal => { child.kill(signal) } }
  },
}

const processSignals: LauncherSignals = {
  on: (signal, listener) => { process.on(signal, listener) },
  off: (signal, listener) => { process.off(signal, listener) },
}

async function defaultUnavailable(
  reason: "machine-mismatch" | "configuration-missing" | "runtime-unavailable",
  expectedHostname: string | undefined,
): Promise<void> {
  await createUnavailableRuntimeMcpServer(reason, expectedHostname).connect(new StdioServerTransport())
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function main(): Promise<void> {
  const result = await runInstalledLauncher()
  if (result.state === "launched") process.exitCode = result.exitCode
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write("Installed ai-macos launcher завершился внутренней ошибкой\n")
    process.exitCode = 1
  })
}
