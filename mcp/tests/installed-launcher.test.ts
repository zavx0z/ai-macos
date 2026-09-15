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
const runtimePath = join(releasePath, "computer-use")
const applicationPath = join(releasePath, "computer-use.app")
const stableApplicationPath = join(installRoot, "computer-use.app")
const stableRuntimePath = join(stableApplicationPath, "Contents", "MacOS", "computer-use")
const stableHelperPath = join(stableApplicationPath, "Contents", "Helpers", "meta-input-helper")
const certificateSha1 = "c".repeat(40)
const applicationCdhash = "a".repeat(40)
const helperCdhash = "b".repeat(40)

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

test("v2 проверяет immutable и stable app, затем запускает только stable computer-use", async () => {
  const fs = installedV2Fs()
  const runner = new FakeRunner(0)
  runner.signingMode = "identity"
  const result = await runInstalledLauncher({
    expectedHostname: "mac",
    actualHostname: "mac",
    homeDirectory: home,
    uid,
    fs,
    runner,
    environment: { PATH: "/usr/bin" },
    serveUnavailable: async () => { throw new Error("must not fallback") },
  })

  expect(result).toEqual({ state: "launched", releaseId, runtimePath: stableRuntimePath, exitCode: 0 })
  expect(runner.calls).toEqual([{
    file: stableRuntimePath,
    args: ["--mcp"],
    options: {
      cwd: stableApplicationPath,
      env: {
        PATH: "/usr/bin",
        AI_MACOS_EXPECTED_HOSTNAME: "mac",
        META_RUNTIME_SOCKET: join(home, "Library", "Application Support", "ai-macos", "run", "runtime.sock"),
        META_RUNTIME_CREDENTIAL: join(home, "Library", "Application Support", "ai-macos", "run", "credential.json"),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  }])
  expect(runner.commandCalls.filter(call => call.args.includes("--test-requirement"))).toHaveLength(4)
  expect(runner.commandCalls.filter(call => call.args.includes("--test-requirement"))
    .map(call => call.args[call.args.indexOf("--test-requirement") + 1])).toEqual([
      `=certificate leaf = H"${certificateSha1}" and identifier "com.meta.ai-macos.runtime"`,
      `=certificate leaf = H"${certificateSha1}" and identifier "com.meta.input.helper"`,
      `=certificate leaf = H"${certificateSha1}" and identifier "com.meta.ai-macos.runtime"`,
      `=certificate leaf = H"${certificateSha1}" and identifier "com.meta.input.helper"`,
    ])
  expect(runner.commandCalls.every(call => call.file === "/usr/bin/codesign")).toBe(true)
  expect(runner.commandCalls.some(call => call.args.at(-1) === applicationPath)).toBe(true)
  expect(runner.commandCalls.some(call => call.args.at(-1) === stableApplicationPath)).toBe(true)
  expect(runner.commandCalls.some(call => call.args.at(-1) === stableHelperPath)).toBe(true)
})

test("v2 ad-hoc signature проверяется без certificate requirement", async () => {
  const runner = new FakeRunner(0)
  runner.signingMode = "adhoc"
  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid,
    fs: installedV2Fs("adhoc"), runner,
    serveUnavailable: async () => { throw new Error("must not fallback") },
  })

  expect(result.state).toBe("launched")
  expect(runner.commandCalls.filter(call => call.args.includes("--test-requirement"))).toHaveLength(0)
})

test("v2 icon variant проверяет exact Resources tree и digest в immutable и stable app", async () => {
  const fs = installedV2Fs("identity", true)
  const runner = new FakeRunner(0)
  runner.signingMode = "identity"
  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
    serveUnavailable: async () => { throw new Error("must not fallback") },
  })

  expect(result.state).toBe("launched")
  expect(fs.files.has(join(applicationPath, "Contents", "Resources", "computer-use.icns"))).toBe(true)
  expect(fs.files.has(join(stableApplicationPath, "Contents", "Resources", "computer-use.icns"))).toBe(true)
})

test("v2 icon variant отклоняет missing, phantom и tampered resources до codesign и spawn", async () => {
  const immutableIcon = join(applicationPath, "Contents", "Resources", "computer-use.icns")
  const stableIcon = join(stableApplicationPath, "Contents", "Resources", "computer-use.icns")
  const variants: Array<(fs: MemoryFs) => void> = [
    fs => {
      fs.nodes.delete(stableIcon)
      fs.files.delete(stableIcon)
    },
    fs => { fs.directoryEntries.get(join(applicationPath, "Contents", "Resources"))!.push("phantom.icns") },
    fs => { fs.files.set(immutableIcon, new TextEncoder().encode("tampered-icon")) },
  ]
  for (const mutate of variants) {
    const fs = installedV2Fs("identity", true)
    mutate(fs)
    const runner = new FakeRunner(0)
    runner.signingMode = "identity"
    const result = await runInstalledLauncher({
      expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
      serveUnavailable: async () => undefined,
    })
    expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
    expect(runner.calls).toHaveLength(0)
  }
})

test("v2 no-icon variant отклоняет phantom Resources directory", async () => {
  const fs = installedV2Fs()
  fs.nodes.set(join(applicationPath, "Contents", "Resources"), node("directory", 0o555))
  fs.directoryEntries.set(join(applicationPath, "Contents", "Resources"), [])
  fs.directoryEntries.get(join(applicationPath, "Contents"))!.push("Resources")
  const runner = new FakeRunner(0)
  runner.signingMode = "identity"

  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
    serveUnavailable: async () => undefined,
  })

  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(runner.calls).toHaveLength(0)
})

test("v2 отвергает unexpected leaf, symlink, tampered stable bytes и signature до spawn", async () => {
  const variants: Array<(fs: MemoryFs, runner: FakeRunner) => void> = [
    fs => { fs.directoryEntries.get(applicationPath + "/Contents")!.push("unexpected") },
    fs => { fs.nodes.set(stableHelperPath, { ...fs.nodes.get(stableHelperPath)!, kind: "symlink" }) },
    fs => { fs.files.set(stableRuntimePath, new TextEncoder().encode("tampered-stable-runtime")) },
    (_fs, runner) => { runner.foreignApplicationSignature = true },
  ]
  for (const mutate of variants) {
    const fs = installedV2Fs()
    const runner = new FakeRunner(0)
    runner.signingMode = "identity"
    mutate(fs, runner)
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

test("v2 exact schema отвергает path alias и другой stable TCC subject", async () => {
  type MutableManifest = {
    artifacts: { runtime: { path: string }, nativeHelper: { auditSession: { uid: number } } }
    stableApplication: { path: string }
    tcc: { subjectPath: string }
  }
  const variants: Array<(manifest: MutableManifest) => void> = [
    manifest => { manifest.artifacts.runtime.path = "computer-use.app/Contents/MacOS/../MacOS/computer-use" },
    manifest => { manifest.stableApplication.path = "./computer-use.app" },
    manifest => { manifest.tcc.subjectPath = join(installRoot, "input", "meta-input-helper") },
    manifest => { manifest.artifacts.nativeHelper.auditSession.uid = 777 },
  ]
  for (const mutate of variants) {
    const fs = installedV2Fs()
    const manifestPath = join(releasePath, "manifest.json")
    const manifest = JSON.parse(new TextDecoder().decode(fs.files.get(manifestPath)!))
    mutate(manifest)
    fs.setFile(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)), 0o444)
    const runner = new FakeRunner(0)
    runner.signingMode = "identity"
    const result = await runInstalledLauncher({
      expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
      serveUnavailable: async () => undefined,
    })
    expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
    expect(runner.calls).toHaveLength(0)
  }
})

test("v2 certificate DR отвергает дополнительный conjunct даже при совпадении manifest и codesign", async () => {
  const fs = installedV2Fs()
  const manifestPath = join(releasePath, "manifest.json")
  const manifest = JSON.parse(new TextDecoder().decode(fs.files.get(manifestPath)!))
  manifest.artifacts.application.designatedRequirement += " and anchor trusted"
  fs.setFile(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)), 0o444)
  const runner = new FakeRunner(0)
  runner.signingMode = "identity"
  runner.extraApplicationRequirementClause = true

  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
    serveUnavailable: async () => undefined,
  })

  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(runner.calls).toHaveLength(0)
})

test("v2 не доверяет manifest digest для изменённого Info.plist identity", async () => {
  const fs = installedV2Fs()
  const wrongInfo = new TextEncoder().encode(applicationInfoPlist(false).replace(
    "<key>CFBundleDisplayName</key><string>computer-use</string>",
    "<key>CFBundleDisplayName</key><string>runtime</string>",
  ))
  const manifestPath = join(releasePath, "manifest.json")
  const manifest = JSON.parse(new TextDecoder().decode(fs.files.get(manifestPath)!))
  manifest.artifacts.application.infoPlist.sha256 = sha256(wrongInfo)
  manifest.artifacts.application.infoPlist.bytes = wrongInfo.byteLength
  fs.setFile(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)), 0o444)
  fs.setFile(join(applicationPath, "Contents", "Info.plist"), wrongInfo, 0o444)
  fs.setFile(join(stableApplicationPath, "Contents", "Info.plist"), wrongInfo, 0o444)
  const runner = new FakeRunner(0)
  runner.signingMode = "identity"

  const result = await runInstalledLauncher({
    expectedHostname: "mac", actualHostname: "mac", homeDirectory: home, uid, fs, runner,
    serveUnavailable: async () => undefined,
  })

  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(runner.commandCalls).toHaveLength(0)
  expect(runner.calls).toHaveLength(0)
})

test("старый manifest с artifact runtime остаётся запускаемым", async () => {
  const legacyRuntimePath = join(releasePath, "runtime")
  const runner = new FakeRunner(0)
  const result = await runInstalledLauncher({
    expectedHostname: "mac",
    actualHostname: "mac",
    homeDirectory: home,
    uid,
    fs: installedFs("runtime"),
    runner,
    serveUnavailable: async () => { throw new Error("must not fallback") },
  })

  expect(result).toEqual({ state: "launched", releaseId, runtimePath: legacyRuntimePath, exitCode: 0 })
  expect(runner.calls[0]?.file).toBe(legacyRuntimePath)
})

test("artifact path вне точного allowlist отклоняется до spawn", async () => {
  const runner = new FakeRunner(0)
  const unavailable: string[] = []
  const result = await runInstalledLauncher({
    expectedHostname: "mac",
    actualHostname: "mac",
    homeDirectory: home,
    uid,
    fs: installedFs("bin/computer-use"),
    runner,
    serveUnavailable: async reason => { unavailable.push(reason) },
  })

  expect(result).toEqual({ state: "unavailable", reason: "runtime-unavailable" })
  expect(unavailable).toEqual(["runtime-unavailable"])
  expect(runner.calls).toHaveLength(0)
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
  readonly directoryEntries = new Map<string, string[]>()
  readonly links = new Map<string, string>()
  readonly resolved = new Map<string, string>()

  setFile(path: string, bytes: Uint8Array, mode: number) {
    this.nodes.set(path, node("file", mode, bytes.byteLength))
    this.files.set(path, bytes)
  }

  setDirectory(path: string, entries: string[], mode: number) {
    this.nodes.set(path, node("directory", mode))
    this.directoryEntries.set(path, [...entries])
  }

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

  async entries(path: string) {
    this.accesses++
    const value = this.directoryEntries.get(path)
    if (value === undefined) throw new Error(`ENOTDIR ${path}`)
    return [...value]
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
  readonly commandCalls: Array<{ file: string, args: readonly string[] }> = []
  readonly child: FakeChild
  failSpawn = false
  signingMode: "identity" | "adhoc" = "identity"
  foreignApplicationSignature = false
  extraApplicationRequirementClause = false

  constructor(exitCode: number | undefined, resolveOnKill = true) { this.child = new FakeChild(exitCode, resolveOnKill) }

  async run(file: string, args: readonly string[]) {
    this.commandCalls.push({ file, args: [...args] })
    if (file !== "/usr/bin/codesign") {
      return { stdout: "", stderr: `unexpected command ${file} ${args.join(" ")}`, exitCode: 1 }
    }
    if (!args.includes("--display")) return { stdout: "", stderr: "", exitCode: 0 }
    const target = args.at(-1)!
    const helper = target.endsWith("/meta-input-helper")
    const identifier = helper ? "com.meta.input.helper"
      : this.foreignApplicationSignature ? "foreign.application" : "com.meta.ai-macos.runtime"
    const cdhash = helper ? helperCdhash : applicationCdhash
    let designatedRequirement = this.signingMode === "identity"
      ? `designated => certificate leaf = H"${certificateSha1}" and identifier "${identifier}"`
      : `designated => cdhash H"${cdhash}"`
    if (!helper && this.extraApplicationRequirementClause) designatedRequirement += " and anchor trusted"
    const signature = this.signingMode === "adhoc" ? "Signature=adhoc\n" : "Signature size=9000\n"
    return {
      stdout: "",
      stderr: `Identifier=${identifier}\nCDHash=${cdhash}\n${designatedRequirement}\n${signature}`,
      exitCode: 0,
    }
  }

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

function installedFs(runtimeArtifactName = "computer-use"): MemoryFs {
  const fs = new MemoryFs()
  const runtime = new TextEncoder().encode("immutable-runtime-mcp")
  const installedRuntimePath = join(releasePath, runtimeArtifactName)
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: "meta-ai-macos-runtime-release-v1",
    releaseId,
    source: { repositoryRoot: "/Users/tester/repozitarium/ai-macos" },
    artifacts: { runtime: { path: runtimeArtifactName, sha256: sha256(runtime), bytes: runtime.byteLength } },
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
  fs.nodes.set(installedRuntimePath, node("file", 0o555, runtime.byteLength))
  fs.files.set(installedRuntimePath, runtime)
  return fs
}

function installedV2Fs(signingMode: "identity" | "adhoc" = "identity", icon = false): MemoryFs {
  const fs = new MemoryFs()
  const infoPlist = new TextEncoder().encode(applicationInfoPlist(icon))
  const iconBytes = new TextEncoder().encode("computer-use-icon-fixture")
  const runtime = new TextEncoder().encode("immutable-computer-use-app-runtime")
  const helper = new TextEncoder().encode("immutable-computer-use-app-helper")
  const codeResources = new TextEncoder().encode("sealed-code-resources")
  const applicationRequirement = signingMode === "identity"
    ? `designated => certificate leaf = H"${certificateSha1}" and identifier "com.meta.ai-macos.runtime"`
    : `designated => cdhash H"${applicationCdhash}"`
  const helperRequirement = signingMode === "identity"
    ? `designated => certificate leaf = H"${certificateSha1}" and identifier "com.meta.input.helper"`
    : `designated => cdhash H"${helperCdhash}"`
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: "meta-ai-macos-runtime-release-v2",
    releaseId,
    createdAt: "2026-09-15T12:00:00.000Z",
    source: { repositoryRoot: "/Users/tester/repozitarium/ai-macos", commit: "d".repeat(40), clean: true },
    builds: { runtimeBuildId: "runtime-v2", nativeBuildId: "native-v2" },
    artifacts: {
      application: {
        path: "computer-use.app",
        infoPlist: { path: "computer-use.app/Contents/Info.plist", sha256: sha256(infoPlist), bytes: infoPlist.byteLength },
        ...(icon ? { icon: { path: "computer-use.app/Contents/Resources/computer-use.icns",
          sha256: sha256(iconBytes), bytes: iconBytes.byteLength } } : {}),
        signingIdentifier: "com.meta.ai-macos.runtime",
        designatedRequirement: applicationRequirement,
        cdhash: applicationCdhash,
      },
      runtime: {
        path: "computer-use.app/Contents/MacOS/computer-use",
        sha256: sha256(runtime),
        bytes: runtime.byteLength,
      },
      nativeHelper: {
        path: "computer-use.app/Contents/Helpers/meta-input-helper",
        sha256: sha256(helper),
        bytes: helper.byteLength,
        signingIdentifier: "com.meta.input.helper",
        designatedRequirement: helperRequirement,
        cdhash: helperCdhash,
        auditSession: { verified: true, source: "darwin-audit", uid, effectiveUid: uid, auditUserId: uid, auditSessionId: 11 },
      },
    },
    signing: signingMode === "identity" ? { mode: "identity", certificateSha1 } : { mode: "adhoc" },
    stableApplication: { path: "computer-use.app" },
    launchAgent: { label: "com.meta.ai-macos.runtime", sha256: "e".repeat(64) },
    entrypoint: {
      source: "scripts/runtime-entry.ts",
      path: "computer-use.app/Contents/MacOS/computer-use",
      modes: ["runtime", "doctor", "mcp"],
      mcpTransport: "stdio",
    },
    configuration: {},
    tcc: {
      subjectPath: stableHelperPath,
      candidateCdhash: helperCdhash,
      automaticGrantPreservation: false,
      requiredPassiveChecks: ["accessibility", "screen-recording", "post-events", "input-monitoring"],
    },
  }))
  fs.setDirectory(installRoot, ["computer-use.app", "current", "releases"], 0o700)
  fs.setDirectory(releasesRoot, [releaseId], 0o700)
  fs.nodes.set(join(installRoot, "current"), node("symlink", 0o777))
  fs.links.set(join(installRoot, "current"), releasePath)
  fs.resolved.set(join(installRoot, "current"), releasePath)
  fs.setDirectory(releasePath, ["computer-use.app", "manifest.json"], 0o555)
  fs.setFile(join(releasePath, "manifest.json"), manifest, 0o444)
  addApplication(fs, applicationPath, infoPlist, runtime, helper, codeResources, icon ? iconBytes : undefined)
  addApplication(fs, stableApplicationPath, infoPlist, runtime, helper, codeResources, icon ? iconBytes : undefined)
  return fs
}

function addApplication(
  fs: MemoryFs,
  root: string,
  infoPlist: Uint8Array,
  runtime: Uint8Array,
  helper: Uint8Array,
  codeResources: Uint8Array,
  icon?: Uint8Array,
) {
  const contents = join(root, "Contents")
  const macOS = join(contents, "MacOS")
  const helpers = join(contents, "Helpers")
  const signature = join(contents, "_CodeSignature")
  const resources = join(contents, "Resources")
  fs.setDirectory(root, ["Contents"], 0o555)
  fs.setDirectory(contents, icon === undefined
    ? ["Helpers", "Info.plist", "MacOS", "_CodeSignature"]
    : ["Helpers", "Info.plist", "MacOS", "Resources", "_CodeSignature"], 0o555)
  fs.setDirectory(macOS, ["computer-use"], 0o555)
  fs.setDirectory(helpers, ["meta-input-helper"], 0o555)
  fs.setDirectory(signature, ["CodeResources"], 0o555)
  fs.setFile(join(contents, "Info.plist"), infoPlist, 0o444)
  fs.setFile(join(macOS, "computer-use"), runtime, 0o555)
  fs.setFile(join(helpers, "meta-input-helper"), helper, 0o555)
  fs.setFile(join(signature, "CodeResources"), codeResources, 0o444)
  if (icon !== undefined) {
    fs.setDirectory(resources, ["computer-use.icns"], 0o555)
    fs.setFile(join(resources, "computer-use.icns"), icon, 0o444)
  }
}

function applicationInfoPlist(icon: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.meta.ai-macos.runtime</string>
  <key>CFBundleName</key><string>computer-use</string>
  <key>CFBundleDisplayName</key><string>computer-use</string>
  <key>CFBundleExecutable</key><string>computer-use</string>
${icon ? "  <key>CFBundleIconFile</key><string>computer-use.icns</string>\n" : ""}  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`
}

function node(kind: InstalledFileInfo["kind"], mode: number, size = 0): InstalledFileInfo {
  return { kind, uid, mode, size }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
