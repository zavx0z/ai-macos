import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createUnavailableRuntimeMcpServer } from "./runtime-mcp.ts"

const execFileAsync = promisify(execFile)

const RELEASE_FORMAT_V1 = "meta-ai-macos-runtime-release-v1"
const RELEASE_FORMAT_V2 = "meta-ai-macos-runtime-release-v2"
const SERVICE_LABEL = "com.meta.ai-macos.runtime"
const APPLICATION_SIGNING_IDENTIFIER = "com.meta.ai-macos.runtime"
const HELPER_SIGNING_IDENTIFIER = "com.meta.input.helper"
const RUNTIME_ARTIFACT_NAMES = ["computer-use", "runtime"] as const
type RuntimeArtifactName = typeof RUNTIME_ARTIFACT_NAMES[number]
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RUNTIME_BYTES = 128 * 1024 * 1024
const MAX_INFO_PLIST_BYTES = 64 * 1024
const MAX_ICON_BYTES = 16 * 1024 * 1024
const MAX_CODE_RESOURCES_BYTES = 4 * 1024 * 1024
const MAX_COMMAND_OUTPUT = 1024 * 1024
const MAX_UNIX_SOCKET_BYTES = 103

const V2_APPLICATION_PATH = "computer-use.app"
const V2_INFO_PLIST_PATH = "computer-use.app/Contents/Info.plist"
const V2_ICON_PATH = "computer-use.app/Contents/Resources/computer-use.icns"
const V2_RUNTIME_PATH = "computer-use.app/Contents/MacOS/computer-use"
const V2_HELPER_PATH = "computer-use.app/Contents/Helpers/meta-input-helper"

export type InstalledFileInfo = {
  kind: "file" | "directory" | "symlink" | "other"
  uid: number
  mode: number
  size: number
}

export interface InstalledLauncherFs {
  info(path: string): Promise<InstalledFileInfo>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  entries(path: string): Promise<string[]>
  readLink(path: string): Promise<string>
  realPath(path: string): Promise<string>
}

export type InstalledCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type InstalledChild = {
  exited: Promise<number>
  kill(signal: NodeJS.Signals): void
}

export interface InstalledRunner {
  run(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<InstalledCommandResult>
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
  testOnlyAllowNonCanonicalSourceRoot?: boolean
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

type InstalledManifestV1 = {
  format: typeof RELEASE_FORMAT_V1
  releaseId: string
  source: { repositoryRoot: string }
  artifacts: { runtime: { path: RuntimeArtifactName, sha256: string, bytes: number } }
  launchAgent: { label: typeof SERVICE_LABEL }
  entrypoint: { source: "scripts/runtime-entry.ts", modes: readonly string[], mcpTransport: "stdio" }
}

type SignedArtifact = {
  signingIdentifier: string
  designatedRequirement: string
  cdhash: string
}

type InstalledManifestV2 = {
  format: typeof RELEASE_FORMAT_V2
  releaseId: string
  createdAt: string
  source: { repositoryRoot: string, commit: string, clean: true }
  builds: { runtimeBuildId: string, nativeBuildId: string }
  artifacts: {
    application: SignedArtifact & {
      path: typeof V2_APPLICATION_PATH
      infoPlist: { path: typeof V2_INFO_PLIST_PATH, sha256: string, bytes: number }
      icon?: { path: typeof V2_ICON_PATH, sha256: string, bytes: number }
    }
    runtime: { path: typeof V2_RUNTIME_PATH, sha256: string, bytes: number }
    nativeHelper: SignedArtifact & {
      path: typeof V2_HELPER_PATH
      sha256: string
      bytes: number
      auditSession: {
        verified: true
        source: "darwin-audit"
        uid: number
        effectiveUid: number
        auditUserId: number
        auditSessionId: number
      }
    }
  }
  signing: { mode: "adhoc" } | { mode: "identity", certificateSha1: string }
  stableApplication: { path: typeof V2_APPLICATION_PATH }
  launchAgent: { label: typeof SERVICE_LABEL, sha256: string }
  entrypoint: {
    source: "scripts/runtime-entry.ts"
    path: typeof V2_RUNTIME_PATH
    modes: readonly ["runtime", "doctor", "mcp"]
    mcpTransport: "stdio"
  }
  configuration: Record<string, unknown>
  tcc: {
    subjectPath: string
    candidateCdhash: string
    automaticGrantPreservation: false
    requiredPassiveChecks: readonly ["accessibility", "screen-recording", "post-events", "input-monitoring"]
  }
}

type InstalledManifest = InstalledManifestV1 | InstalledManifestV2

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
  const runner = options.runner ?? bunRunner
  let installed: Awaited<ReturnType<typeof resolveInstalledRuntime>>
  try {
    installed = await resolveInstalledRuntime(fs, runner, homeDirectory, uid,
      options.testOnlyAllowNonCanonicalSourceRoot ?? false)
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
  const signals = options.signals ?? processSignals
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 10 || cleanupTimeoutMs > 10_000) {
    await serveUnavailable("configuration-missing", expectedHostname)
    return { state: "unavailable", reason: "configuration-missing" }
  }
  let child: InstalledChild
  try {
    child = runner.spawn(installed.runtimePath, ["--mcp"], {
      cwd: installed.workingDirectory,
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

async function resolveInstalledRuntime(
  fs: InstalledLauncherFs,
  runner: InstalledRunner,
  home: string,
  uid: number,
  allowTestSourceRoot: boolean,
) {
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
  if (manifest.releaseId !== basename(releasePath)
    || !allowTestSourceRoot && !/^\/Users\/[^/]+\/repozitarium\/ai-macos$/.test(manifest.source.repositoryRoot)
    || manifest.source.repositoryRoot.includes("/production/")) throw new Error("Installed manifest source/release identity invalid")
  if (manifest.format === RELEASE_FORMAT_V1) {
    const runtimePath = join(releasePath, manifest.artifacts.runtime.path)
    await assertArtifact(fs, runtimePath, manifest.artifacts.runtime, uid, 0o555, MAX_RUNTIME_BYTES)
    return { installRoot, releasePath, runtimePath, workingDirectory: releasePath, manifest }
  }

  const stableApplicationPath = join(installRoot, manifest.stableApplication.path)
  const stableRuntimePath = join(installRoot, manifest.artifacts.runtime.path)
  const expectedHelperPath = join(installRoot, manifest.artifacts.nativeHelper.path)
  if (manifest.tcc.subjectPath !== expectedHelperPath) throw new Error("Installed manifest содержит другой stable TCC subject path")
  const audit = manifest.artifacts.nativeHelper.auditSession
  if (audit.uid !== uid || audit.effectiveUid !== uid || audit.auditUserId !== uid) {
    throw new Error("Installed manifest native audit identity не совпадает с launcher user")
  }
  await assertExactEntries(fs, releasePath, ["computer-use.app", "manifest.json"])
  const immutableApplicationPath = join(releasePath, manifest.artifacts.application.path)
  await verifyApplication(fs, runner, immutableApplicationPath, releasePath, manifest, uid)
  await verifyApplication(fs, runner, stableApplicationPath, installRoot, manifest, uid)
  return {
    installRoot,
    releasePath,
    runtimePath: stableRuntimePath,
    workingDirectory: stableApplicationPath,
    manifest,
  }
}

async function verifyApplication(
  fs: InstalledLauncherFs,
  runner: InstalledRunner,
  applicationPath: string,
  pathRoot: string,
  manifest: InstalledManifestV2,
  uid: number,
): Promise<void> {
  if (await fs.realPath(applicationPath) !== applicationPath) throw new Error("Installed application path не является direct owned directory")
  const contentsPath = join(applicationPath, "Contents")
  const macOSPath = join(contentsPath, "MacOS")
  const helpersPath = join(contentsPath, "Helpers")
  const signaturePath = join(contentsPath, "_CodeSignature")
  const resourcesPath = join(contentsPath, "Resources")
  await assertNode(fs, applicationPath, "directory", uid, 0o555)
  await assertNode(fs, contentsPath, "directory", uid, 0o555)
  await assertNode(fs, macOSPath, "directory", uid, 0o555)
  await assertNode(fs, helpersPath, "directory", uid, 0o555)
  await assertNode(fs, signaturePath, "directory", uid, 0o555)
  if (manifest.artifacts.application.icon !== undefined) {
    await assertNode(fs, resourcesPath, "directory", uid, 0o555)
  }
  await assertExactEntries(fs, applicationPath, ["Contents"])
  await assertExactEntries(fs, contentsPath, manifest.artifacts.application.icon === undefined
    ? ["Helpers", "Info.plist", "MacOS", "_CodeSignature"]
    : ["Helpers", "Info.plist", "MacOS", "Resources", "_CodeSignature"])
  await assertExactEntries(fs, macOSPath, ["computer-use"])
  await assertExactEntries(fs, helpersPath, ["meta-input-helper"])
  await assertExactEntries(fs, signaturePath, ["CodeResources"])
  if (manifest.artifacts.application.icon !== undefined) {
    await assertExactEntries(fs, resourcesPath, ["computer-use.icns"])
  }

  const infoPlistPath = join(pathRoot, manifest.artifacts.application.infoPlist.path)
  const runtimePath = join(pathRoot, manifest.artifacts.runtime.path)
  const helperPath = join(pathRoot, manifest.artifacts.nativeHelper.path)
  const infoPlist = await assertArtifact(fs, infoPlistPath,
    manifest.artifacts.application.infoPlist, uid, 0o444, MAX_INFO_PLIST_BYTES)
  if (new TextDecoder().decode(infoPlist) !== applicationInfoPlist(
    manifest.artifacts.application.icon !== undefined,
  )) {
    throw new Error("Installed application Info.plist не соответствует exact identity contract")
  }
  if (manifest.artifacts.application.icon !== undefined) {
    await assertArtifact(fs, join(pathRoot, manifest.artifacts.application.icon.path),
      manifest.artifacts.application.icon, uid, 0o444, MAX_ICON_BYTES)
  }
  await assertArtifact(fs, runtimePath, manifest.artifacts.runtime, uid, 0o555, MAX_RUNTIME_BYTES)
  await assertArtifact(fs, helperPath, manifest.artifacts.nativeHelper, uid, 0o555, MAX_RUNTIME_BYTES)
  await assertBoundedFile(fs, join(signaturePath, "CodeResources"), uid, 0o444, MAX_CODE_RESOURCES_BYTES)
  await verifySignedArtifact(runner, applicationPath, manifest.artifacts.application, manifest.signing)
  await verifySignedArtifact(runner, helperPath, manifest.artifacts.nativeHelper, manifest.signing)
}

async function assertArtifact(
  fs: InstalledLauncherFs,
  path: string,
  artifact: { sha256: string, bytes: number },
  uid: number,
  mode: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = await assertBoundedFile(fs, path, uid, mode, maxBytes)
  if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Installed artifact digest не совпадает с manifest: ${path}`)
  }
  return bytes
}

async function assertBoundedFile(
  fs: InstalledLauncherFs,
  path: string,
  uid: number,
  mode: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const info = await assertNode(fs, path, "file", uid, mode)
  if (info.size < 1 || info.size > maxBytes) throw new Error(`Installed file нарушает byte limit: ${path}`)
  const bytes = await fs.read(path, maxBytes)
  if (bytes.byteLength !== info.size || bytes.byteLength > maxBytes) {
    throw new Error(`Installed file изменился при bounded read: ${path}`)
  }
  return bytes
}

async function assertExactEntries(fs: InstalledLauncherFs, path: string, expected: readonly string[]): Promise<void> {
  const entries = [...await fs.entries(path)].sort()
  const sortedExpected = [...expected].sort()
  if (entries.length !== sortedExpected.length || entries.some((entry, index) => entry !== sortedExpected[index])) {
    throw new Error(`Installed directory содержит unexpected leaves: ${path}`)
  }
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
  const format = (value as { format?: unknown }).format
  if (format === RELEASE_FORMAT_V1) return parseManifestV1(value)
  if (format === RELEASE_FORMAT_V2) return parseManifestV2(value)
  throw new Error("Installed manifest contract mismatch")
}

function parseManifestV1(value: object): InstalledManifestV1 {
  const manifest = value as InstalledManifestV1
  if (typeof manifest.releaseId !== "string" || manifest.releaseId.length < 1
    || !RUNTIME_ARTIFACT_NAMES.some(name => name === manifest.artifacts?.runtime?.path)
    || !/^[a-f0-9]{64}$/.test(manifest.artifacts.runtime.sha256)
    || !validBytes(manifest.artifacts.runtime.bytes, MAX_RUNTIME_BYTES)
    || manifest.launchAgent?.label !== SERVICE_LABEL || manifest.entrypoint?.source !== "scripts/runtime-entry.ts"
    || !manifest.entrypoint.modes.includes("mcp") || manifest.entrypoint.mcpTransport !== "stdio") {
    throw new Error("Installed manifest contract mismatch")
  }
  return manifest
}

function parseManifestV2(value: object): InstalledManifestV2 {
  const manifest = value as InstalledManifestV2
  const application = manifest.artifacts?.application
  const runtime = manifest.artifacts?.runtime
  const helper = manifest.artifacts?.nativeHelper
  const audit = helper?.auditSession
  const exactTopLevel = exactKeys(manifest, [
    "artifacts", "builds", "configuration", "createdAt", "entrypoint", "format", "launchAgent", "releaseId",
    "signing", "source", "stableApplication", "tcc",
  ])
  const exactManifest = exactTopLevel
    && exactKeys(manifest.source, ["clean", "commit", "repositoryRoot"])
    && exactKeys(manifest.builds, ["nativeBuildId", "runtimeBuildId"])
    && exactKeys(manifest.artifacts, ["application", "nativeHelper", "runtime"])
    && exactKeys(application, application?.icon === undefined
      ? ["cdhash", "designatedRequirement", "infoPlist", "path", "signingIdentifier"]
      : ["cdhash", "designatedRequirement", "icon", "infoPlist", "path", "signingIdentifier"])
    && exactKeys(application?.infoPlist, ["bytes", "path", "sha256"])
    && (application?.icon === undefined || exactKeys(application.icon, ["bytes", "path", "sha256"]))
    && exactKeys(runtime, ["bytes", "path", "sha256"])
    && exactKeys(helper, ["auditSession", "bytes", "cdhash", "designatedRequirement", "path", "sha256", "signingIdentifier"])
    && exactKeys(audit, ["auditSessionId", "auditUserId", "effectiveUid", "source", "uid", "verified"])
    && exactKeys(manifest.stableApplication, ["path"])
    && exactKeys(manifest.launchAgent, ["label", "sha256"])
    && exactKeys(manifest.entrypoint, ["mcpTransport", "modes", "path", "source"])
    && exactKeys(manifest.tcc, ["automaticGrantPreservation", "candidateCdhash", "requiredPassiveChecks", "subjectPath"])
    && (manifest.signing?.mode === "adhoc"
      ? exactKeys(manifest.signing, ["mode"])
      : exactKeys(manifest.signing, ["certificateSha1", "mode"]))
  if (!exactManifest
    || typeof manifest.releaseId !== "string" || manifest.releaseId.length < 1
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || manifest.source.clean !== true || !/^[a-f0-9]{40,64}$/.test(manifest.source.commit)
    || typeof manifest.builds.runtimeBuildId !== "string" || manifest.builds.runtimeBuildId.length < 1
    || typeof manifest.builds.nativeBuildId !== "string" || manifest.builds.nativeBuildId.length < 1
    || application.path !== V2_APPLICATION_PATH || application.infoPlist.path !== V2_INFO_PLIST_PATH
    || application.icon !== undefined && (application.icon.path !== V2_ICON_PATH
      || !validBytes(application.icon.bytes, MAX_ICON_BYTES) || !validDigest(application.icon.sha256))
    || runtime.path !== V2_RUNTIME_PATH || helper.path !== V2_HELPER_PATH
    || manifest.stableApplication.path !== V2_APPLICATION_PATH
    || manifest.entrypoint.path !== V2_RUNTIME_PATH || manifest.entrypoint.source !== "scripts/runtime-entry.ts"
    || JSON.stringify(manifest.entrypoint.modes) !== JSON.stringify(["runtime", "doctor", "mcp"])
    || manifest.entrypoint.mcpTransport !== "stdio"
    || manifest.launchAgent.label !== SERVICE_LABEL || !validDigest(manifest.launchAgent.sha256)
    || !validBytes(application.infoPlist.bytes, MAX_INFO_PLIST_BYTES)
    || !validDigest(application.infoPlist.sha256)
    || !validBytes(runtime.bytes, MAX_RUNTIME_BYTES) || !validDigest(runtime.sha256)
    || !validBytes(helper.bytes, MAX_RUNTIME_BYTES) || !validDigest(helper.sha256)
    || !validSignedArtifact(application, APPLICATION_SIGNING_IDENTIFIER)
    || !validSignedArtifact(helper, HELPER_SIGNING_IDENTIFIER)
    || !validAuditSession(audit)
    || manifest.tcc.candidateCdhash !== helper.cdhash || manifest.tcc.automaticGrantPreservation !== false
    || JSON.stringify(manifest.tcc.requiredPassiveChecks)
      !== JSON.stringify(["accessibility", "screen-recording", "post-events", "input-monitoring"])
    || manifest.configuration === null || typeof manifest.configuration !== "object" || Array.isArray(manifest.configuration)
    || !validSigning(manifest.signing)) {
    throw new Error("Installed v2 manifest contract mismatch")
  }
  return manifest
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function validCdhash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value)
}

function validBytes(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
}

function validSignedArtifact(value: SignedArtifact | undefined, identifier: string): value is SignedArtifact {
  return value?.signingIdentifier === identifier
    && typeof value.designatedRequirement === "string" && value.designatedRequirement.startsWith("designated =>")
    && validCdhash(value.cdhash)
}

function validAuditSession(value: InstalledManifestV2["artifacts"]["nativeHelper"]["auditSession"] | undefined): boolean {
  return value?.verified === true && value.source === "darwin-audit"
    && [value.uid, value.effectiveUid, value.auditUserId, value.auditSessionId]
      .every(field => Number.isSafeInteger(field) && field >= 0)
}

function validSigning(value: InstalledManifestV2["signing"] | undefined): value is InstalledManifestV2["signing"] {
  return value?.mode === "adhoc"
    || value?.mode === "identity" && /^[a-f0-9]{40}$/.test(value.certificateSha1)
}

async function verifySignedArtifact(
  runner: InstalledRunner,
  path: string,
  artifact: SignedArtifact,
  signing: InstalledManifestV2["signing"],
): Promise<void> {
  await checked(runner, "/usr/bin/codesign", ["--verify", "--strict", path])
  const inspected = inspectCodeSignature(await checked(runner, "/usr/bin/codesign", [
    "--display", "--verbose=4", "-r-", path,
  ]))
  if (inspected.identifier !== artifact.signingIdentifier || inspected.cdhash !== artifact.cdhash
    || inspected.designatedRequirement !== artifact.designatedRequirement
    || inspected.adhoc !== (signing.mode === "adhoc")) {
    throw new Error(`Installed code signature не совпадает с manifest: ${path}`)
  }
  if (signing.mode === "identity") {
    const requirement = certificateRequirement(artifact.signingIdentifier, signing.certificateSha1)
    assertEmbeddedCertificateRequirement(artifact.designatedRequirement,
      artifact.signingIdentifier, signing.certificateSha1)
    await checked(runner, "/usr/bin/codesign", [
      "--verify", "--strict", "--test-requirement", `=${requirement}`, path,
    ])
  }
}

function inspectCodeSignature(result: InstalledCommandResult) {
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").map(line => line.trim()).filter(Boolean)
  const identifier = lines.find(line => line.startsWith("Identifier="))?.slice("Identifier=".length)
  const cdhash = lines.find(line => line.startsWith("CDHash="))?.slice("CDHash=".length).toLowerCase()
  const designatedRequirement = lines.map(line => line.replace(/^#\s*(?=designated =>)/, ""))
    .find(line => line.startsWith("designated =>"))
  if (identifier === undefined || cdhash === undefined || !validCdhash(cdhash) || designatedRequirement === undefined) {
    throw new Error("Codesign metadata не содержит identifier/cdhash/designated requirement")
  }
  return { identifier, cdhash, designatedRequirement, adhoc: lines.includes("Signature=adhoc") }
}

function certificateRequirement(identifier: string, certificateSha1: string): string {
  return `certificate leaf = H"${certificateSha1}" and identifier "${identifier}"`
}

function applicationInfoPlist(icon: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${APPLICATION_SIGNING_IDENTIFIER}</string>
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

function assertEmbeddedCertificateRequirement(
  designatedRequirement: string,
  identifier: string,
  certificateSha1: string,
): void {
  const expression = designatedRequirement.replace(/^#\s*/, "").replace(/^designated\s*=>\s*/i, "")
    .replace(/\s+/g, " ").trim()
  const clauses = expression.split(/\s+and\s+/i).map(clause => clause.trim())
  const expectedCertificate = certificateSha1.toLowerCase()
  let certificateMatches = false
  let identifierMatches = false
  for (const clause of clauses) {
    const certificate = clause.match(/^certificate\s+(?:leaf|0)\s*=\s*H"([a-fA-F0-9]{40})"$/i)
    if (certificate !== null) {
      certificateMatches = certificate[1]!.toLowerCase() === expectedCertificate
      continue
    }
    const signingIdentifier = clause.match(/^identifier\s*(?:=\s*)?"([^"]+)"$/i)
    if (signingIdentifier !== null) identifierMatches = signingIdentifier[1] === identifier
  }
  if (clauses.length !== 2 || !certificateMatches || !identifierMatches) {
    throw new Error("Embedded designated requirement не равен exact certificate+identifier contract")
  }
}

async function checked(
  runner: InstalledRunner,
  file: string,
  args: readonly string[],
): Promise<InstalledCommandResult> {
  const result = await runner.run(file, args, { timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    throw new Error(`Installed verification command failed: ${file} ${args[0] ?? ""}: ${result.stderr.trim()}`)
  }
  return result
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
  entries: path => readdir(path),
  readLink: path => readlink(path),
  realPath: path => realpath(path),
}

const bunRunner: InstalledRunner = {
  async run(file, args, options = {}) {
    try {
      const result = await execFileAsync(file, [...args], {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: MAX_COMMAND_OUTPUT,
        encoding: "utf8",
      })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error) {
      const failure = error as Error & { stdout?: string, stderr?: string, code?: number | string }
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      }
    }
  },
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
