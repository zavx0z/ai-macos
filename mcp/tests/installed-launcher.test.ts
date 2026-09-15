import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  runInstalledLauncher,
  type InstalledChild,
  type InstalledFileInfo,
  type InstalledLauncherFs,
  type InstalledRunner,
  type LauncherSignals,
} from "../src/installed-launcher.ts"

const home = "/Users/tester"
const uid = 501
const installRoot = join(home, "Library", "Application Support", "ai-macos", "runtime")
const releasesRoot = join(installRoot, "releases")
const releaseId = "release-fixture"
const releasePath = join(releasesRoot, releaseId)
const runtimePath = join(releasePath, "runtime")

test("wrong hostname отдаёт только passive unavailable server до filesystem/spawn", async () => {
  const fs = new MemoryFs()
  const runner = new FakeRunner(0)
  const unavailable: string[] = []
  const result = await runInstalledLauncher({
    expectedHostname: "expected-mac",
    actualHostname: "foreign-mac",
    homeDirectory: home,
    uid,
    fs,
    runner,
    serveUnavailable: async reason => { unavailable.push(reason) },
  })
  expect(result).toEqual({ state: "unavailable", reason: "machine-mismatch" })
  expect(unavailable).toEqual(["machine-mismatch"])
  expect(fs.accesses).toBe(0)
  expect(runner.calls).toHaveLength(0)
})

test("valid owned immutable release запускает тот же artifact с --mcp и inherited stdio", async () => {
  const fs = installedFs()
  const runner = new FakeRunner(0)
  const result = await runInstalledLauncher({
    expectedHostname: "mac",
    actualHostname: "mac",
    homeDirectory: home,
    uid,
    fs,
    runner,
    environment: { PATH: "/usr/bin", WINDOW_API: "http://legacy.invalid" },
    serveUnavailable: async () => { throw new Error("must not fallback") },
  })
  expect(result).toEqual({ state: "launched", releaseId, runtimePath, exitCode: 0 })
  expect(runner.calls).toEqual([{
    file: runtimePath,
    args: ["--mcp"],
    options: {
      cwd: releasePath,
      env: {
        PATH: "/usr/bin",
        WINDOW_API: "http://legacy.invalid",
        AI_MACOS_EXPECTED_HOSTNAME: "mac",
        META_RUNTIME_SOCKET: join(home, "Library", "Application Support", "ai-macos", "run", "runtime.sock"),
        META_RUNTIME_CREDENTIAL: join(home, "Library", "Application Support", "ai-macos", "run", "credential.json"),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  }])
})

test("missing, escaped, foreign или corrupted install никогда не запускает executable fallback", async () => {
  const variants: Array<(fs: MemoryFs) => void> = [
    fs => { fs.nodes.delete(join(releasePath, "manifest.json")) },
    fs => { fs.links.set(join(installRoot, "current"), "/Users/tester/production/archive") },
    fs => { fs.nodes.set(runtimePath, { ...fs.nodes.get(runtimePath)!, uid: 777 }) },
    fs => { fs.nodes.set(runtimePath, { ...fs.nodes.get(runtimePath)!, mode: 0o755 }) },
    fs => { fs.files.set(runtimePath, new TextEncoder().encode("tampered-runtime")) },
  ]
  for (const mutate of variants) {
    const fs = installedFs()
    mutate(fs)
    const runner = new FakeRunner(0)
    const unavailable: string[] = []
    const result = await runInstalledLauncher({
      expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
      serveUnavailable: async reason => { unavailable.push(reason) },
    })
    expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
    expect(unavailable).toEqual(["runtime-unavailable"])
    expect(runner.calls).toHaveLength(0)
  }
})

test("manifest bounds и contract mismatch закрываются passive diagnostic", async () => {
  const fs = installedFs()
  const manifestPath = join(releasePath, "manifest.json")
  fs.nodes.set(manifestPath, { ...fs.nodes.get(manifestPath)!, size: 1024 * 1024 + 1 })
  const unavailable: string[] = []
  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs,
    runner: new FakeRunner(0), serveUnavailable: async reason => { unavailable.push(reason) },
  })
  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(unavailable).toEqual(["runtime-unavailable"])
})

test("spawn verified artifact failure переключается на passive diagnostic без source fallback", async () => {
  const runner = new FakeRunner(0)
  runner.failSpawn = true
  const unavailable: string[] = []
  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs: installedFs(), runner,
    serveUnavailable: async reason => { unavailable.push(reason) },
  })
  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(unavailable).toEqual(["runtime-unavailable"])
  expect(runner.calls).toHaveLength(0)
})

test("SIGTERM передаётся child, handlers снимаются, bounded timeout отправляет SIGKILL", async () => {
  const signals = new FakeSignals()
  const runner = new FakeRunner(undefined, false)
  const running = runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs: installedFs(), runner,
    signals, cleanupTimeoutMs: 10, serveUnavailable: async () => { throw new Error("must not fallback") },
  })
  while (runner.calls.length === 0) await Promise.resolve()
  signals.emit("SIGTERM")
  expect(await running).toMatchObject({ state: "launched", exitCode: 137 })
  expect(runner.child.kills).toEqual(["SIGTERM", "SIGKILL"])
  expect(signals.listenerCount("SIGTERM")).toBe(0)
  expect(signals.listenerCount("SIGINT")).toBe(0)
})

class MemoryFs implements InstalledLauncherFs {
  accesses = 0
  readonly nodes = new Map<string, InstalledFileInfo>()
  readonly files = new Map<string, Uint8Array>()
  readonly links = new Map<string, string>()
  readonly resolved = new Map<string, string>()

  async info(path: string) {
    this.accesses++
    const value = this.nodes.get(path)
    if (value === undefined) throw new Error(`ENOENT ${path}`)
    return value
  }

  async read(path: string, maxBytes: number) {
    this.accesses++
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`ENOENT ${path}`)
    if (value.byteLength > maxBytes) throw new Error("bounded read")
    return value.slice()
  }

  async readLink(path: string) {
    this.accesses++
    const value = this.links.get(path)
    if (value === undefined) throw new Error(`EINVAL ${path}`)
    return value
  }

  async realPath(path: string) {
    this.accesses++
    return this.resolved.get(path) ?? path
  }
}

class FakeChild implements InstalledChild {
  readonly kills: NodeJS.Signals[] = []
  readonly exited: Promise<number>
  private resolveExit!: (code: number) => void

  constructor(exitCode: number | undefined, readonly resolveOnKill = true) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    if (exitCode !== undefined) this.resolveExit(exitCode)
  }

  kill(signal: NodeJS.Signals) {
    this.kills.push(signal)
    if (signal === "SIGKILL" && this.resolveOnKill) this.resolveExit(137)
  }
}

class FakeRunner implements InstalledRunner {
  readonly calls: Array<{ file: string, args: readonly string[], options: Parameters<InstalledRunner["spawn"]>[2] }> = []
  readonly child: FakeChild
  failSpawn = false

  constructor(exitCode: number | undefined, resolveOnKill = true) { this.child = new FakeChild(exitCode, resolveOnKill) }

  spawn(file: string, args: readonly string[], options: Parameters<InstalledRunner["spawn"]>[2]) {
    if (this.failSpawn) throw new Error("exec format")
    this.calls.push({ file, args, options })
    return this.child
  }
}

class FakeSignals extends EventEmitter implements LauncherSignals {
  override on(signal: "SIGINT" | "SIGTERM", listener: () => void): this { return super.on(signal, listener) }
  override off(signal: "SIGINT" | "SIGTERM", listener: () => void): this { return super.off(signal, listener) }
}

function installedFs(): MemoryFs {
  const fs = new MemoryFs()
  const runtime = new TextEncoder().encode("immutable-runtime-mcp")
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: "meta-ai-macos-runtime-release-v1",
    releaseId,
    source: { repositoryRoot: "/Users/tester/repozitarium/ai-macos" },
    artifacts: { runtime: { path: "runtime", sha256: sha256(runtime), bytes: runtime.byteLength } },
    launchAgent: { label: "com.meta.ai-macos.runtime" },
    entrypoint: { source: "scripts/runtime-entry.ts", modes: ["runtime", "doctor", "mcp"], mcpTransport: "stdio" },
  }))
  fs.nodes.set(installRoot, node("directory", 0o700))
  fs.nodes.set(releasesRoot, node("directory", 0o700))
  fs.nodes.set(join(installRoot, "current"), node("symlink", 0o777))
  fs.links.set(join(installRoot, "current"), releasePath)
  fs.resolved.set(join(installRoot, "current"), releasePath)
  fs.nodes.set(releasePath, node("directory", 0o555))
  fs.nodes.set(join(releasePath, "manifest.json"), node("file", 0o444, manifest.byteLength))
  fs.files.set(join(releasePath, "manifest.json"), manifest)
  fs.nodes.set(runtimePath, node("file", 0o555, runtime.byteLength))
  fs.files.set(runtimePath, runtime)
  return fs
}

function node(kind: InstalledFileInfo["kind"], mode: number, size = 0): InstalledFileInfo {
  return { kind, uid, mode, size }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
