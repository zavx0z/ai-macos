import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { hostname } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { acquireHostLock } from "../runtime/src/host-lock.ts"
import { parseBrowserHostConfig } from "../runtime/src/browser-config.ts"
import { CAPABILITY_IDS, type CapabilityId } from "../shared/src/contracts/index.ts"

const execFileAsync = promisify(execFile)

export const RUNTIME_SERVICE_LABEL = "com.meta.ai-macos.runtime"
export const HELPER_SIGNING_IDENTIFIER = "com.meta.input.helper"
const RELEASE_FORMAT = "meta-ai-macos-runtime-release-v1"
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024
const MAX_BROWSER_CONFIG_BYTES = 64 * 1024
export type RuntimeReadinessProfile = "full" | "foundation" | "desktop-browser-selected"

export type DeferredCapability = {
  id: CapabilityId
  reason: string
}

const SELECTED_INTERACTION_REASON =
  "Выбранный agent API использует observation-bound input guard; explicit focus session и automatic old-focus restore отложены"

// Установка проверяется внешней транзакцией, а не самооценкой устанавливаемого
// runtime. Android включается в обязательный набор только по явному выбору.
const DEFAULT_FULL_CAPABILITIES = CAPABILITY_IDS.filter(id => id !== "android.chrome" && id !== "runtime.install")

export type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options?: {
    cwd?: string
    env?: Readonly<Record<string, string>>
    timeoutMs?: number
  }): Promise<CommandResult>
}

export type RuntimeInspection = {
  running: boolean
  runtimeEpoch?: string
  runtimeBuildId?: string
  nativeBuildId?: string
  activeOperations: number
  quarantinedResources: number
}

export type RuntimeDrainReceipt = {
  runtimeEpoch: string
  runtimeBuildId: string
  nativeBuildId: string
  cleanup: "complete"
  activeOperations: 0
  quarantinedResources: 0
}

export interface RuntimeAdmin {
  inspect(): Promise<RuntimeInspection>
  drain(expected: RuntimeInspection): Promise<RuntimeDrainReceipt>
}

export type RuntimeInstallPaths = {
  repositoryRoot: string
  installRoot: string
  runRoot: string
  launchAgentPath: string
  stableHelperPath: string
}

export type RuntimeInstallOptions = {
  paths: RuntimeInstallPaths
  runner: CommandRunner
  expectedHostname: string
  uid: number
  now?: () => Date
  runtimeAdmin?: RuntimeAdmin
  testOnlyAllowNonCanonicalRoot?: boolean
  doctorTimeoutMs?: number
  browserConfig?: string
  readinessProfile?: RuntimeReadinessProfile
  requiredCapabilities?: readonly CapabilityId[]
  failpoint?: (stage: InstallFailpoint) => void | Promise<void>
}

export type InstallFailpoint =
  | "after-installer-lock"
  | "after-rollback-prepared"
  | "after-helper-switch"
  | "after-release-switch"
  | "after-plist-switch"
  | "after-bootstrap"

export type InstallPlanStep = {
  id: string
  description: string
  mutates: boolean
  command?: { file: string, args: string[] }
}

export type LegacyRetirementCandidate = {
  package: "window" | "screen" | "chrome" | "android" | "input"
  port: number
  expectedEntrypoint: string
  disposition: "inspect-only"
  requiredEvidence: readonly ["pid", "executable", "cwd", "listener-port", "canonical-root"]
}

export type RuntimeInstallPlan = {
  kind: "meta-runtime-install-plan"
  createdAt: string
  machine: { expectedHostname: string, observedHostname: string }
  source: {
    repositoryRoot: string
    commit: string
    clean: boolean
  }
  release: {
    releaseId: string
    runtimeBuildId: string
    nativeBuildId: string
    releasePath: string
    alreadyInstalled: boolean
  }
  configuration: {
    browser: Record<string, unknown>
    browserJson: string
    sha256: string
    readinessProfile: RuntimeReadinessProfile
    requiredCapabilities: CapabilityId[]
    deferredCapabilities: DeferredCapability[]
  }
  paths: RuntimeInstallPaths
  service: {
    label: string
    domain: string
    loaded: boolean
  }
  gates: {
    sourceClean: boolean
    exactHostname: boolean
    existingRuntimeRequiresDrain: boolean
    drainAvailable: boolean
    permissionsRequested: false
    liveDesktopProbe: false
    requiredConfigurationPresent: boolean
  }
  steps: InstallPlanStep[]
  legacyRetirement: LegacyRetirementCandidate[]
}

export type ReleaseManifest = {
  format: typeof RELEASE_FORMAT
  releaseId: string
  createdAt: string
  source: { repositoryRoot: string, commit: string, clean: true }
  builds: { runtimeBuildId: string, nativeBuildId: string }
  artifacts: {
    runtime: { path: "runtime", sha256: string, bytes: number }
    nativeHelper: {
      path: "native-helper"
      sha256: string
      bytes: number
      signingIdentifier: typeof HELPER_SIGNING_IDENTIFIER
      designatedRequirement: string
      cdhash: string
      auditSession: NativeAuditIdentity
    }
  }
  launchAgent: { label: typeof RUNTIME_SERVICE_LABEL, sha256: string }
  entrypoint: {
    source: "scripts/runtime-entry.ts"
    modes: readonly ["runtime", "doctor", "mcp"]
    mcpTransport: "stdio"
  }
  configuration: RuntimeInstallPlan["configuration"]
  tcc: {
    subjectPath: string
    candidateCdhash: string
    automaticGrantPreservation: false
    requiredPassiveChecks: readonly ["accessibility", "screen-recording"]
  }
}

export type NativeAuditIdentity = {
  verified: true
  source: "darwin-audit"
  uid: number
  effectiveUid: number
  auditUserId: number
  auditSessionId: number
}

export type RuntimeInstallResult = {
  state: "installed" | "already-installed"
  releaseId: string
  manifestSha256: string
  rollbackUsed: boolean
  doctor: unknown
  readiness: {
    profile: RuntimeReadinessProfile
    requiredCapabilities: CapabilityId[]
    deferredCapabilities: DeferredCapability[]
    state: "ready"
  }
}

export class LocalCommandRunner implements CommandRunner {
  async run(file: string, args: readonly string[], options: {
    cwd?: string
    env?: Readonly<Record<string, string>>
    timeoutMs?: number
  } = {}): Promise<CommandResult> {
    try {
      const result = await execFileAsync(file, [...args], {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
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
  }
}

export async function planRuntimeInstall(options: RuntimeInstallOptions): Promise<RuntimeInstallPlan> {
  const paths = normalizePaths(options.paths)
  await assertCanonicalRepository(paths.repositoryRoot, options.testOnlyAllowNonCanonicalRoot ?? false)
  const commit = (await checked(options.runner, "git", ["rev-parse", "HEAD"], paths.repositoryRoot)).stdout.trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git HEAD не является полным commit ID")
  const status = await checked(options.runner, "git", ["status", "--porcelain=v1", "-z"], paths.repositoryRoot)
  const clean = status.stdout.length === 0
  const configuration = installConfiguration(options)
  const sourceKey = sha256(`${commit}\n${RELEASE_FORMAT}`).slice(0, 24)
  const releaseKey = sha256(`${commit}\n${RELEASE_FORMAT}\n${stableJson(configuration)}`).slice(0, 24)
  const releaseId = `release-${releaseKey}`
  const runtimeBuildId = `runtime-${sourceKey}`
  const nativeBuildId = `native-${sourceKey}`
  const domain = `gui/${options.uid}`
  const loaded = (await options.runner.run("/bin/launchctl", ["print", `${domain}/${RUNTIME_SERVICE_LABEL}`], {
    timeoutMs: 5_000,
  })).exitCode === 0
  const exactHostname = hostname() === options.expectedHostname
  const plan: RuntimeInstallPlan = {
    kind: "meta-runtime-install-plan",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    machine: { expectedHostname: options.expectedHostname, observedHostname: hostname() },
    source: { repositoryRoot: paths.repositoryRoot, commit, clean },
    release: {
      releaseId,
      runtimeBuildId,
      nativeBuildId,
      releasePath: join(paths.installRoot, "releases", releaseId),
      alreadyInstalled: false,
    },
    configuration,
    paths,
    service: { label: RUNTIME_SERVICE_LABEL, domain, loaded },
    gates: {
      sourceClean: clean,
      exactHostname,
      existingRuntimeRequiresDrain: loaded,
      drainAvailable: options.runtimeAdmin !== undefined,
      permissionsRequested: false,
      liveDesktopProbe: false,
      requiredConfigurationPresent: requiredConfigurationPresent(configuration),
    },
    steps: installSteps(paths, releaseId, runtimeBuildId, nativeBuildId, domain),
    legacyRetirement: legacyCandidates(paths.repositoryRoot),
  }
  plan.release.alreadyInstalled = loaded && await installedReleaseMatches(plan)
  plan.gates.existingRuntimeRequiresDrain = loaded && !plan.release.alreadyInstalled
  if (!clean) plan.steps.unshift({
    id: "source-dirty-block",
    description: "Остановиться: immutable release требует clean canonical checkout",
    mutates: false,
  })
  if (!plan.gates.requiredConfigurationPresent) plan.steps.unshift({
    id: "required-configuration-block",
    description: "Остановиться: выбранный readiness profile требует explicit Chrome/Android configuration",
    mutates: false,
  })
  if (plan.gates.existingRuntimeRequiresDrain && options.runtimeAdmin === undefined) plan.steps.unshift({
    id: "drain-api-block",
    description: "Остановиться: loaded runtime нельзя заменять без exact admin drain API",
    mutates: false,
  })
  return plan
}

function installConfiguration(options: RuntimeInstallOptions): RuntimeInstallPlan["configuration"] {
  const browser = parseBrowserHostConfig(options.browserConfig)
  const browserJson = stableJson(browser)
  const readinessProfile = options.readinessProfile ?? "full"
  const selectedRequirements = selectedDesktopBrowserCapabilities(browser)
  if (readinessProfile === "desktop-browser-selected" && options.requiredCapabilities !== undefined
    && stableJson(normalizeCapabilities(options.requiredCapabilities)) !== stableJson(selectedRequirements)) {
    throw new Error("desktop-browser-selected имеет фиксированный required capability set")
  }
  const requested = options.requiredCapabilities ?? (readinessProfile === "full"
    ? DEFAULT_FULL_CAPABILITIES
    : readinessProfile === "desktop-browser-selected"
      ? selectedRequirements
      : [])
  const unique = new Set<CapabilityId>()
  for (const id of requested) {
    if (!(CAPABILITY_IDS as readonly string[]).includes(id)) throw new Error(`Unknown required capability: ${id}`)
    unique.add(id)
  }
  const requiredCapabilities = CAPABILITY_IDS.filter(id => unique.has(id))
  return {
    browser: browser as Record<string, unknown>,
    browserJson,
    sha256: sha256(browserJson),
    readinessProfile,
    requiredCapabilities,
    deferredCapabilities: readinessProfile === "desktop-browser-selected"
      ? [{ id: "input.interaction", reason: SELECTED_INTERACTION_REASON }]
      : [],
  }
}

function selectedDesktopBrowserCapabilities(
  browser: ReturnType<typeof parseBrowserHostConfig>,
): CapabilityId[] {
  const selected = new Set<CapabilityId>(
    DEFAULT_FULL_CAPABILITIES.filter(id => id !== "input.interaction"),
  )
  if (browser.android !== undefined) selected.add("android.chrome")
  return CAPABILITY_IDS.filter(id => selected.has(id))
}

function normalizeCapabilities(values: readonly CapabilityId[]): CapabilityId[] {
  const selected = new Set(values)
  return CAPABILITY_IDS.filter(id => selected.has(id))
}

function requiredConfigurationPresent(configuration: RuntimeInstallPlan["configuration"]): boolean {
  const chromeRequired = configuration.requiredCapabilities.some(id => id.startsWith("browser."))
  const androidRequired = configuration.requiredCapabilities.includes("android.chrome")
  const chrome = configuration.browser.chrome
  const android = configuration.browser.android
  return (!chromeRequired || chrome !== undefined) && (!androidRequired || android !== undefined)
}

function validManifestConfiguration(value: RuntimeInstallPlan["configuration"] | undefined): boolean {
  if (value === undefined || !["full", "foundation", "desktop-browser-selected"].includes(value.readinessProfile)
    || !Array.isArray(value.requiredCapabilities) || new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length
    || value.requiredCapabilities.some(id => !(CAPABILITY_IDS as readonly string[]).includes(id))
    || !Array.isArray(value.deferredCapabilities)
    || new Set(value.deferredCapabilities.map(capability => capability.id)).size !== value.deferredCapabilities.length
    || value.deferredCapabilities.some(capability => !(CAPABILITY_IDS as readonly string[]).includes(capability.id)
      || typeof capability.reason !== "string" || capability.reason.length < 1 || capability.reason.length > 1024)) return false
  try {
    const browser = parseBrowserHostConfig(value.browserJson)
    const baseValid = stableJson(browser) === stableJson(value.browser)
      && sha256(value.browserJson) === value.sha256
      && stableJson(value.requiredCapabilities) === stableJson(CAPABILITY_IDS.filter(id => value.requiredCapabilities.includes(id)))
    if (!baseValid) return false
    if (value.readinessProfile === "desktop-browser-selected") {
      return stableJson(value.requiredCapabilities) === stableJson(selectedDesktopBrowserCapabilities(browser))
        && stableJson(value.deferredCapabilities) === stableJson([{
          id: "input.interaction",
          reason: SELECTED_INTERACTION_REASON,
        }])
    }
    return value.deferredCapabilities.length === 0
  } catch { return false }
}

export async function applyRuntimeInstall(
  plan: RuntimeInstallPlan,
  options: RuntimeInstallOptions,
): Promise<RuntimeInstallResult> {
  const paths = normalizePaths(options.paths)
  assertPlanMatchesOptions(plan, paths, options)
  if (!plan.source.clean) throw new Error("Dirty checkout нельзя устанавливать как immutable release")
  if (!plan.gates.requiredConfigurationPresent) throw new Error("Readiness profile required configuration отсутствует")
  if (!plan.gates.exactHostname || hostname() !== options.expectedHostname
    || plan.machine.expectedHostname !== options.expectedHostname || plan.machine.observedHostname !== hostname()) {
    throw new Error("Hostname не совпадает с install plan")
  }
  const currentCommit = (await checked(options.runner, "git", ["rev-parse", "HEAD"], paths.repositoryRoot)).stdout.trim()
  const currentStatus = await checked(options.runner, "git", ["status", "--porcelain=v1", "-z"], paths.repositoryRoot)
  if (currentCommit !== plan.source.commit || currentStatus.stdout.length > 0) {
    throw new Error("Checkout изменился после формирования install plan")
  }

  await assertPrivateDirectoryRoot(paths.installRoot)
  await assertPrivateDirectoryRoot(paths.runRoot)
  await assertLaunchAgentDirectory(dirname(paths.launchAgentPath))
  await assertStableHelperParent(paths.stableHelperPath, paths.repositoryRoot)
  await verifyExistingHelperIdentity(paths.stableHelperPath, options.runner)
  const releaseInstallerLock = await acquireInstallerLock(paths)
  try { return await applyRuntimeInstallLocked(plan, options, paths) }
  finally { await releaseInstallerLock() }
}

async function applyRuntimeInstallLocked(
  plan: RuntimeInstallPlan,
  options: RuntimeInstallOptions,
  paths: RuntimeInstallPaths,
): Promise<RuntimeInstallResult> {
  await options.failpoint?.("after-installer-lock")
  const plist = launchAgentPlist(plan)
  const release = await ensureRelease(plan, options, plist)
  await assertNativeBuildStableAcrossConfiguration(plan, release.manifest)
  await assertSourceUnchanged(plan, options)
  if (await exists(pendingUpdatePath(paths))) {
    const pendingService = await inspectLaunchService(options.runner, plan)
    if (pendingService !== undefined) {
      if (options.runtimeAdmin === undefined) throw new Error("Pending update recovery требует exact drain authority")
      const pendingRuntime = await options.runtimeAdmin.inspect()
      const receipt = await options.runtimeAdmin.drain(pendingRuntime)
      assertDrainReceipt(pendingRuntime, receipt)
      await assertExactServiceAndRuntime(options, plan, pendingService, pendingRuntime, true)
    }
    await recoverPendingUpdate(plan, options, pendingService !== undefined)
  }
  const service = await inspectLaunchService(options.runner, plan)
  if (plan.service.loaded && service === undefined) throw new Error("Runtime service исчез после reviewable plan; ownership требует нового plan")
  const serviceWasLoaded = service !== undefined
  const previous = { ...await snapshotInstalledState(paths), serviceLoaded: serviceWasLoaded }
  const sameRelease = serviceWasLoaded
    && previous.currentRelease === plan.release.releasePath
    && previous.helperSha256 === release.manifest.artifacts.nativeHelper.sha256
    && previous.plistBytes !== undefined
    && new TextDecoder().decode(previous.plistBytes) === plist
  if (sameRelease) {
    const doctor = await runDoctor(plan, options.runner, release.manifest, doctorTimeout(options))
    return {
      state: "already-installed",
      releaseId: plan.release.releaseId,
      manifestSha256: release.manifestSha256,
      rollbackUsed: false,
      doctor,
      readiness: { profile: plan.configuration.readinessProfile,
        requiredCapabilities: [...plan.configuration.requiredCapabilities],
        deferredCapabilities: structuredClone(plan.configuration.deferredCapabilities), state: "ready" },
    }
  }
  const existing = serviceWasLoaded ? await options.runtimeAdmin?.inspect() : undefined
  if (serviceWasLoaded && (options.runtimeAdmin === undefined || existing === undefined)) {
    throw new Error("Loaded runtime требует injected exact drain authority")
  }
  await prepareRollback(plan, previous)
  await options.failpoint?.("after-rollback-prepared")
  if (!serviceWasLoaded && await inspectLaunchService(options.runner, plan) !== undefined) {
    await discardPendingUpdate(paths)
    throw new Error("Runtime service появился после admission check; cutover не начат")
  }
  let rollbackUsed = false
  let drainComplete = !serviceWasLoaded
  try {
    if (existing !== undefined) {
      const drained = await options.runtimeAdmin!.drain(existing)
      assertDrainReceipt(existing, drained)
      await assertExactServiceAndRuntime(options, plan, service!, existing, true)
      drainComplete = true
    }
    if (serviceWasLoaded) await checked(options.runner, "/bin/launchctl", ["bootout", `${plan.service.domain}/${RUNTIME_SERVICE_LABEL}`])
    if (await hashIfPresent(paths.stableHelperPath) !== release.manifest.artifacts.nativeHelper.sha256) {
      await atomicCopy(release.nativeHelperPath, paths.stableHelperPath, 0o755)
    }
    await options.failpoint?.("after-helper-switch")
    await atomicSymlink(plan.release.releasePath, join(paths.installRoot, "current"))
    await options.failpoint?.("after-release-switch")
    await atomicText(paths.launchAgentPath, plist, 0o600)
    await options.failpoint?.("after-plist-switch")
    await checked(options.runner, "/usr/bin/plutil", ["-lint", paths.launchAgentPath])
    await checked(options.runner, "/bin/launchctl", ["bootstrap", plan.service.domain, paths.launchAgentPath])
    await options.failpoint?.("after-bootstrap")
    const doctor = await runDoctor(plan, options.runner, release.manifest, doctorTimeout(options))
    await discardPendingUpdate(paths)
    return {
      state: previous.currentRelease === plan.release.releasePath
        && previous.helperSha256 === release.manifest.artifacts.nativeHelper.sha256
        ? "already-installed"
        : "installed",
      releaseId: plan.release.releaseId,
      manifestSha256: release.manifestSha256,
      rollbackUsed,
      doctor,
      readiness: { profile: plan.configuration.readinessProfile,
        requiredCapabilities: [...plan.configuration.requiredCapabilities],
        deferredCapabilities: structuredClone(plan.configuration.deferredCapabilities), state: "ready" },
    }
  } catch (error) {
    rollbackUsed = true
    if (!drainComplete) {
      await discardPendingUpdate(paths).catch(() => undefined)
      throw new Error("Runtime drain не подтвердил safe cutover; installed files не менялись, admission остаётся sealed", { cause: error })
    }
    const rollbackErrors = await rollback(plan, options, previous)
    if (rollbackErrors.length === 0) await discardPendingUpdate(paths)
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Runtime update failed; rollback incomplete")
    }
    throw error
  }
}

export async function doctorInstalledRuntime(
  plan: RuntimeInstallPlan,
  runner: CommandRunner,
): Promise<unknown> {
  const manifest = parseManifest(JSON.parse(await readFile(join(plan.release.releasePath, "manifest.json"), "utf8")))
  return runDoctor(plan, runner, manifest, 10_000)
}

function installSteps(
  paths: RuntimeInstallPaths,
  releaseId: string,
  runtimeBuildId: string,
  nativeBuildId: string,
  domain: string,
): InstallPlanStep[] {
  const releasePath = join(paths.installRoot, "releases", releaseId)
  return [
    { id: "verify-source", description: "Проверить canonical checkout, HEAD и отсутствие uncommitted source", mutates: false },
    { id: "build-runtime", description: `Собрать runtime ${runtimeBuildId} во временный release`, mutates: true,
      command: { file: process.execPath, args: ["build", "scripts/runtime-entry.ts", "--compile", "--outfile", `${releasePath}.staging/runtime`] } },
    { id: "build-native", description: `Собрать native helper ${nativeBuildId} во временный release`, mutates: true,
      command: { file: "/bin/sh", args: [join(paths.repositoryRoot, "native/scripts/build-broker.sh"), `${releasePath}.staging/native-helper`, nativeBuildId] } },
    { id: "verify-candidate", description: `Подписать ${HELPER_SIGNING_IDENTIFIER}, проверить signature, metadata, build IDs и digests`, mutates: true },
    { id: "publish-release", description: "Опубликовать immutable manifest и release атомарным rename", mutates: true },
    { id: "drain", description: "Для loaded runtime получить exact complete drain receipt до bootout", mutates: false },
    { id: "switch", description: "Атомарно переключить stable helper, current release symlink и LaunchAgent plist", mutates: true },
    { id: "bootstrap", description: `Загрузить единственный ${domain}/${RUNTIME_SERVICE_LABEL}`, mutates: true,
      command: { file: "/bin/launchctl", args: ["bootstrap", domain, paths.launchAgentPath] } },
    { id: "doctor", description: "Проверить запущенные runtime/native build IDs через authenticated UDS doctor", mutates: false },
    { id: "rollback", description: "При failed doctor вернуть previous helper/current/plist и проверить старый комплект", mutates: true },
    { id: "legacy-inspect", description: "Только инвентаризировать legacy listeners; bootout/kill без exact ownership запрещён", mutates: false },
  ]
}

async function ensureRelease(plan: RuntimeInstallPlan, options: RuntimeInstallOptions, plist: string) {
  const releasePath = plan.release.releasePath
  const manifestPath = join(releasePath, "manifest.json")
  if (await exists(manifestPath)) {
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")))
    assertManifestMatchesPlan(manifest, plan, sha256(plist))
    await verifyReleaseArtifacts(releasePath, manifest, options.runner, plan)
    return {
      manifest,
      manifestSha256: sha256(stableJson(manifest)),
      nativeHelperPath: join(releasePath, manifest.artifacts.nativeHelper.path),
    }
  }

  const stagingRoot = join(plan.paths.installRoot, "staging")
  await ensureDirectoryDurably(stagingRoot, 0o700)
  const staging = join(stagingRoot, `${plan.release.releaseId}.${randomUUID()}`)
  await mkdir(staging, { recursive: false, mode: 0o700 })
  try {
    const runtimePath = join(staging, "runtime")
    const nativeHelperPath = join(staging, "native-helper")
    await checked(options.runner, process.execPath, [
      "build",
      "scripts/runtime-entry.ts",
      "--compile",
      "--define",
      `__META_RUNTIME_BUILD_ID__=${JSON.stringify(plan.release.runtimeBuildId)}`,
      "--outfile",
      runtimePath,
    ], plan.paths.repositoryRoot, 120_000)
    await checked(options.runner, "/bin/sh", [
      join(plan.paths.repositoryRoot, "native/scripts/build-broker.sh"),
      nativeHelperPath,
      plan.release.nativeBuildId,
    ], plan.paths.repositoryRoot, 120_000)
    await checked(options.runner, "/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      HELPER_SIGNING_IDENTIFIER,
      nativeHelperPath,
    ])
    await checked(options.runner, "/usr/bin/codesign", ["--verify", "--strict", nativeHelperPath])
    const signature = await inspectCodeSignature(options.runner, nativeHelperPath)
    if (signature.identifier !== HELPER_SIGNING_IDENTIFIER) {
      throw new Error("Native candidate имеет другой codesign identifier")
    }
    const architectures = await checked(options.runner, "/usr/bin/lipo", ["-archs", nativeHelperPath])
    if (!architectures.stdout.split(/\s+/).includes("x86_64")) throw new Error("Native candidate не содержит x86_64")
    const metadataResult = await checked(options.runner, nativeHelperPath, ["--metadata"], undefined, 5_000)
    const metadata = parseNativeMetadata(metadataResult.stdout)
    if (metadata.nativeBuildId !== plan.release.nativeBuildId) throw new Error("Native metadata содержит другой build ID")
    if (metadata.installRoot !== plan.paths.repositoryRoot) throw new Error("Native metadata содержит другой canonical install root")
    assertCurrentAuditUser(metadata.session)
    await chmod(runtimePath, 0o555)
    await chmod(nativeHelperPath, 0o555)
    const [runtimeArtifact, nativeArtifact] = await Promise.all([
      artifact(runtimePath),
      artifact(nativeHelperPath),
    ])
    const manifest: ReleaseManifest = {
      format: RELEASE_FORMAT,
      releaseId: plan.release.releaseId,
      createdAt: plan.createdAt,
      source: { repositoryRoot: plan.source.repositoryRoot, commit: plan.source.commit, clean: true },
      builds: { runtimeBuildId: plan.release.runtimeBuildId, nativeBuildId: plan.release.nativeBuildId },
      artifacts: {
        runtime: { path: "runtime", ...runtimeArtifact },
        nativeHelper: { path: "native-helper", ...nativeArtifact, signingIdentifier: HELPER_SIGNING_IDENTIFIER,
          designatedRequirement: signature.designatedRequirement, cdhash: signature.cdhash,
          auditSession: metadata.session },
      },
      launchAgent: { label: RUNTIME_SERVICE_LABEL, sha256: sha256(plist) },
      entrypoint: { source: "scripts/runtime-entry.ts", modes: ["runtime", "doctor", "mcp"], mcpTransport: "stdio" },
      configuration: plan.configuration,
      tcc: {
        subjectPath: plan.paths.stableHelperPath,
        candidateCdhash: signature.cdhash,
        automaticGrantPreservation: false,
        requiredPassiveChecks: ["accessibility", "screen-recording"],
      },
    }
    await durableText(join(staging, "manifest.json"), `${stableJson(manifest)}\n`, 0o444)
    await syncDirectory(staging)
    await ensureDirectoryDurably(dirname(releasePath), 0o700)
    await rename(staging, releasePath)
    await syncDirectory(dirname(releasePath))
    await chmod(releasePath, 0o555)
    return { manifest, manifestSha256: sha256(stableJson(manifest)), nativeHelperPath: join(releasePath, "native-helper") }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function verifyReleaseArtifacts(
  releasePath: string,
  manifest: ReleaseManifest,
  runner: CommandRunner,
  plan: RuntimeInstallPlan,
): Promise<void> {
  await assertOwnedNode(releasePath, "directory", 0o555)
  await assertOwnedNode(join(releasePath, "manifest.json"), "file", 0o444)
  const runtimePath = safeChild(releasePath, manifest.artifacts.runtime.path)
  const helperPath = safeChild(releasePath, manifest.artifacts.nativeHelper.path)
  await assertOwnedNode(runtimePath, "file", 0o555)
  await assertOwnedNode(helperPath, "file", 0o555)
  const [runtimeArtifact, helperArtifact] = await Promise.all([artifact(runtimePath), artifact(helperPath)])
  if (stableJson(runtimeArtifact) !== stableJson({ sha256: manifest.artifacts.runtime.sha256, bytes: manifest.artifacts.runtime.bytes })
    || stableJson(helperArtifact) !== stableJson({ sha256: manifest.artifacts.nativeHelper.sha256, bytes: manifest.artifacts.nativeHelper.bytes })) {
    throw new Error("Immutable release artifact digest mismatch")
  }
  await checked(runner, "/usr/bin/codesign", ["--verify", "--strict", helperPath])
  const signature = await inspectCodeSignature(runner, helperPath)
  if (signature.identifier !== manifest.artifacts.nativeHelper.signingIdentifier
    || signature.cdhash !== manifest.artifacts.nativeHelper.cdhash
    || signature.designatedRequirement !== manifest.artifacts.nativeHelper.designatedRequirement) {
    throw new Error("Immutable release codesign identity не совпадает с manifest")
  }
  const metadata = parseNativeMetadata((await checked(runner, helperPath, ["--metadata"], undefined, 5_000)).stdout)
  if (metadata.nativeBuildId !== manifest.builds.nativeBuildId || metadata.installRoot !== plan.paths.repositoryRoot
    || !freshAuditUser(metadata.session)) {
    throw new Error("Immutable release native metadata/build/audit не совпадает с manifest")
  }
}

async function assertOwnedNode(path: string, kind: "file" | "directory", mode: number): Promise<void> {
  const info = await lstat(path)
  const correctKind = kind === "file" ? info.isFile() : info.isDirectory()
  if (!correctKind || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== mode) {
    throw new Error(`Immutable release ${kind} имеет foreign/symlink/mode mismatch: ${path}`)
  }
}

async function snapshotInstalledState(paths: RuntimeInstallPaths) {
  const currentPath = join(paths.installRoot, "current")
  const currentRelease = await readLinkIfPresent(currentPath)
  if (currentRelease !== undefined) assertPreviousReleasePath(paths, currentRelease)
  return {
    currentRelease,
    helperBytes: await readRegularFileIfPresent(paths.stableHelperPath),
    helperSha256: await hashIfPresent(paths.stableHelperPath),
    plistBytes: await readRegularFileIfPresent(paths.launchAgentPath),
  }
}

type InstalledState = Awaited<ReturnType<typeof snapshotInstalledState>> & { serviceLoaded: boolean }

type RollbackRecord = {
  format: "meta-runtime-pending-update-v1"
  releaseId: string
  previousCurrentRelease: string | null
  helperPresent: boolean
  plistPresent: boolean
  serviceLoaded: boolean
}

type LaunchServiceIdentity = {
  pid: number
  program: string
  plistPath: string
}

async function acquireInstallerLock(paths: RuntimeInstallPaths): Promise<() => Promise<void>> {
  if (await exists(join(paths.installRoot, ".installer-owner"))) {
    throw new Error("Legacy installer ownership требует отдельной проверки; каталог не удаляется по PID")
  }
  // Kernel lock освобождается после crash и не позволяет двум stale-reclaimers
  // переименовать новый lock другого installer после проверки старого PID.
  return acquireHostLock(join(paths.installRoot, "installer"))
}

async function prepareRollback(
  plan: RuntimeInstallPlan,
  previous: InstalledState,
): Promise<void> {
  const directory = pendingUpdatePath(plan.paths)
  if (await exists(directory)) throw new Error("Незавершённый pending-update должен быть восстановлен до нового cutover")
  await mkdir(directory, { mode: 0o700 })
  try {
    if (previous.helperBytes !== undefined) await durableBytes(join(directory, "helper"), previous.helperBytes, 0o600)
    if (previous.plistBytes !== undefined) await durableBytes(join(directory, "launch-agent.plist"), previous.plistBytes, 0o600)
    const record: RollbackRecord = {
      format: "meta-runtime-pending-update-v1",
      releaseId: plan.release.releaseId,
      previousCurrentRelease: previous.currentRelease ?? null,
      helperPresent: previous.helperBytes !== undefined,
      plistPresent: previous.plistBytes !== undefined,
      serviceLoaded: previous.serviceLoaded,
    }
    await durableText(join(directory, "record.json"), `${stableJson(record)}\n`, 0o600)
    await syncDirectory(directory)
    await syncDirectory(dirname(directory))
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function recoverPendingUpdate(
  plan: RuntimeInstallPlan,
  options: RuntimeInstallOptions,
  serviceLoaded: boolean,
): Promise<void> {
  const directory = pendingUpdatePath(plan.paths)
  if (!await exists(directory)) return
  const record = parseRollbackRecord(JSON.parse(await readFile(join(directory, "record.json"), "utf8")))
  const helper = record.helperPresent ? await readFile(join(directory, "helper")) : undefined
  const plist = record.plistPresent ? await readFile(join(directory, "launch-agent.plist")) : undefined
  if (serviceLoaded) await checked(options.runner, "/bin/launchctl", ["bootout", `${plan.service.domain}/${RUNTIME_SERVICE_LABEL}`])
  if (helper === undefined) await rm(plan.paths.stableHelperPath, { force: true })
  else await atomicBytes(plan.paths.stableHelperPath, helper, 0o755)
  const current = join(plan.paths.installRoot, "current")
  if (record.previousCurrentRelease === null) await rm(current, { force: true })
  else {
    assertPreviousReleasePath(plan.paths, record.previousCurrentRelease)
    await atomicSymlink(record.previousCurrentRelease, current)
  }
  if (plist === undefined) await rm(plan.paths.launchAgentPath, { force: true })
  else await atomicBytes(plan.paths.launchAgentPath, plist, 0o600)
  if (record.serviceLoaded && plist !== undefined) {
    await checked(options.runner, "/usr/bin/plutil", ["-lint", plan.paths.launchAgentPath])
    await checked(options.runner, "/bin/launchctl", ["bootstrap", plan.service.domain, plan.paths.launchAgentPath])
    if (record.previousCurrentRelease === null) {
      throw new Error("Recovered legacy service не имеет immutable manifest для doctor; pending journal сохранён")
    }
    const oldManifest = parseManifest(JSON.parse(await readFile(join(record.previousCurrentRelease, "manifest.json"), "utf8")))
    const oldPlan: RuntimeInstallPlan = {
      ...plan,
      configuration: oldManifest.configuration,
      release: {
        releaseId: oldManifest.releaseId,
        runtimeBuildId: oldManifest.builds.runtimeBuildId,
        nativeBuildId: oldManifest.builds.nativeBuildId,
        releasePath: record.previousCurrentRelease,
        alreadyInstalled: true,
      },
    }
    await runDoctor(oldPlan, options.runner, oldManifest, doctorTimeout(options))
  }
  await discardPendingUpdate(plan.paths)
}

async function discardPendingUpdate(paths: RuntimeInstallPaths): Promise<void> {
  await rm(pendingUpdatePath(paths), { recursive: true, force: true })
  await syncDirectory(paths.installRoot)
}

function pendingUpdatePath(paths: RuntimeInstallPaths): string {
  return join(paths.installRoot, "pending-update")
}

function parseRollbackRecord(value: unknown): RollbackRecord {
  if (value === null || typeof value !== "object") throw new Error("Pending update record повреждён")
  const record = value as RollbackRecord
  if (record.format !== "meta-runtime-pending-update-v1" || typeof record.releaseId !== "string"
    || !(record.previousCurrentRelease === null || typeof record.previousCurrentRelease === "string")
    || typeof record.helperPresent !== "boolean" || typeof record.plistPresent !== "boolean"
    || typeof record.serviceLoaded !== "boolean") throw new Error("Pending update record повреждён")
  return record
}

function assertPreviousReleasePath(paths: RuntimeInstallPaths, path: string): void {
  const releases = join(paths.installRoot, "releases")
  if (relative(releases, resolve(path)).startsWith("..")) throw new Error("Pending update ссылается на foreign release")
}

async function rollback(
  plan: RuntimeInstallPlan,
  options: RuntimeInstallOptions,
  previous: InstalledState,
): Promise<Error[]> {
  const errors: Error[] = []
  const attempt = async (action: () => Promise<void>) => {
    try { await action() }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))) }
  }
  try {
    const service = await inspectLaunchService(options.runner, plan)
    if (service !== undefined) await checked(options.runner, "/bin/launchctl", ["bootout", `${plan.service.domain}/${RUNTIME_SERVICE_LABEL}`])
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error))]
  }
  await attempt(async () => {
    if (previous.helperBytes === undefined) await rm(plan.paths.stableHelperPath, { force: true })
    else await atomicBytes(plan.paths.stableHelperPath, previous.helperBytes, 0o755)
  })
  await attempt(async () => {
    const current = join(plan.paths.installRoot, "current")
    if (previous.currentRelease === undefined) await rm(current, { force: true })
    else await atomicSymlink(previous.currentRelease, current)
  })
  await attempt(async () => {
    if (previous.plistBytes === undefined) await rm(plan.paths.launchAgentPath, { force: true })
    else await atomicBytes(plan.paths.launchAgentPath, previous.plistBytes, 0o600)
  })
  if (previous.serviceLoaded && previous.plistBytes !== undefined) {
    await attempt(async () => {
      await checked(options.runner, "/bin/launchctl", ["bootstrap", plan.service.domain, plan.paths.launchAgentPath])
      if (previous.currentRelease !== undefined) {
        const oldManifest = parseManifest(JSON.parse(await readFile(join(previous.currentRelease, "manifest.json"), "utf8")))
        const oldPlan: RuntimeInstallPlan = {
          ...plan,
          configuration: oldManifest.configuration,
          release: {
            releaseId: oldManifest.releaseId,
            runtimeBuildId: oldManifest.builds.runtimeBuildId,
            nativeBuildId: oldManifest.builds.nativeBuildId,
            releasePath: previous.currentRelease,
            alreadyInstalled: true,
          },
        }
        await runDoctor(oldPlan, options.runner, oldManifest, doctorTimeout(options))
      }
    })
  }
  return errors
}

async function installedReleaseMatches(plan: RuntimeInstallPlan): Promise<boolean> {
  try {
    const current = await readLinkIfPresent(join(plan.paths.installRoot, "current"))
    if (current !== plan.release.releasePath) return false
    const manifest = parseManifest(JSON.parse(await readFile(join(current, "manifest.json"), "utf8")))
    assertManifestMatchesPlan(manifest, plan, sha256(launchAgentPlist(plan)))
    const helperSha256 = await hashIfPresent(plan.paths.stableHelperPath)
    const plist = await readRegularFileIfPresent(plan.paths.launchAgentPath)
    return helperSha256 === manifest.artifacts.nativeHelper.sha256
      && plist !== undefined
      && new TextDecoder().decode(plist) === launchAgentPlist(plan)
  } catch { return false }
}

async function assertNativeBuildStableAcrossConfiguration(plan: RuntimeInstallPlan, candidate: ReleaseManifest): Promise<void> {
  const current = await readLinkIfPresent(join(plan.paths.installRoot, "current"))
  if (current === undefined) return
  assertPreviousReleasePath(plan.paths, current)
  const manifest = parseManifest(JSON.parse(await readFile(join(current, "manifest.json"), "utf8")))
  if (manifest.builds.nativeBuildId !== candidate.builds.nativeBuildId) return
  if (manifest.artifacts.nativeHelper.sha256 !== candidate.artifacts.nativeHelper.sha256
    || manifest.artifacts.nativeHelper.cdhash !== candidate.artifacts.nativeHelper.cdhash
    || manifest.artifacts.nativeHelper.designatedRequirement !== candidate.artifacts.nativeHelper.designatedRequirement) {
    throw new Error("Один source native build ID получил другой helper identity при смене runtime configuration")
  }
}

async function runDoctor(
  plan: RuntimeInstallPlan,
  runner: CommandRunner,
  manifest: ReleaseManifest,
  timeoutMs: number,
): Promise<unknown> {
  const executable = join(plan.paths.installRoot, "current", "runtime")
  const deadlineAt = Date.now() + timeoutMs
  let lastFailure = "runtime doctor не ответил"
  while (Date.now() < deadlineAt) {
    const result = await runner.run(executable, ["--doctor"], {
      timeoutMs: Math.max(1, Math.min(2_000, deadlineAt - Date.now())),
      env: {
        META_RUNTIME_SOCKET: join(plan.paths.runRoot, "runtime.sock"),
        META_RUNTIME_CREDENTIAL: join(plan.paths.runRoot, "credential.json"),
      },
    })
    if (result.exitCode !== 0) {
      lastFailure = result.stderr.trim() || `doctor exit ${result.exitCode}`
      await boundedDelay(Math.min(50, Math.max(1, deadlineAt - Date.now())))
      continue
    }
    let doctor: {
    isError?: boolean
    structuredContent?: {
      runtime?: { buildId?: string, draining?: boolean, admissionSealed?: boolean,
        recoveryOperations?: number, recoveryReasons?: unknown[] }
      native?: { state?: string, buildId?: string }
      permissions?: {
        accessibility?: { granted?: boolean, helperPath?: string, cdhash?: string }
        screenRecording?: { granted?: boolean, ownerPath?: string, cdhash?: string }
      }
      capabilities?: { capabilities?: Array<{ id?: string, state?: string }> }
    }
    }
    try { doctor = JSON.parse(result.stdout) }
    catch {
      lastFailure = "runtime doctor вернул незавершённый JSON"
      await boundedDelay(Math.min(50, Math.max(1, deadlineAt - Date.now())))
      continue
    }
    const reportedRuntimeBuild = doctor.structuredContent?.runtime?.buildId
    const reportedNativeBuild = doctor.structuredContent?.native?.buildId
    if (reportedRuntimeBuild !== undefined && reportedRuntimeBuild !== plan.release.runtimeBuildId
      || reportedNativeBuild !== undefined && reportedNativeBuild !== plan.release.nativeBuildId) {
      throw new Error("Installed runtime doctor обнаружил другой runtime/native build; polling запрещён")
    }
    if (doctor.isError || reportedRuntimeBuild !== plan.release.runtimeBuildId
      || doctor.structuredContent?.runtime?.draining !== false
      || doctor.structuredContent?.native?.state !== "compatible"
      || reportedNativeBuild !== plan.release.nativeBuildId) {
      throw new Error("Installed runtime doctor не подтвердил exact runtime/native build IDs")
    }
    if (doctor.structuredContent.runtime.admissionSealed !== false
      || doctor.structuredContent.runtime.recoveryOperations !== 0
      || !Array.isArray(doctor.structuredContent.runtime.recoveryReasons)
      || doctor.structuredContent.runtime.recoveryReasons.length > 0) {
      throw new Error("Installed runtime admission закрыта или startup recovery не завершена")
    }
    const accessibility = doctor.structuredContent?.permissions?.accessibility
    const screenRecording = doctor.structuredContent?.permissions?.screenRecording
    if (accessibility?.granted !== true || accessibility.helperPath !== plan.paths.stableHelperPath
      || accessibility.cdhash !== manifest.artifacts.nativeHelper.cdhash
      || screenRecording?.granted !== true || screenRecording.ownerPath !== plan.paths.stableHelperPath
      || screenRecording.cdhash !== manifest.artifacts.nativeHelper.cdhash) {
      throw new Error("Installed runtime doctor не подтвердил passive TCC grants exact helper path/cdhash")
    }
    const capabilityStates = new Map((doctor.structuredContent?.capabilities?.capabilities ?? [])
      .map(capability => [capability.id, capability.state]))
    const missing = plan.configuration.requiredCapabilities.find(id => capabilityStates.get(id) !== "ready")
    if (missing !== undefined) throw new Error(`Installed runtime не подтвердил required capability ready: ${missing}`)
    return doctor
  }
  throw new Error(`Installed runtime doctor readiness deadline exceeded: ${lastFailure}`)
}

function doctorTimeout(options: RuntimeInstallOptions): number {
  const timeout = options.doctorTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error("Doctor timeout должен быть 100..30000 ms")
  return timeout
}

async function boundedDelay(ms: number): Promise<void> {
  await new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function launchAgentPlist(plan: RuntimeInstallPlan): string {
  const runtime = join(plan.paths.installRoot, "current", "runtime")
  const environment: Record<string, string> = {
    META_RUNTIME_SOCKET: join(plan.paths.runRoot, "runtime.sock"),
    META_RUNTIME_CREDENTIAL: join(plan.paths.runRoot, "credential.json"),
    META_NATIVE_HELPER: plan.paths.stableHelperPath,
    META_NATIVE_BUILD_ID: plan.release.nativeBuildId,
    META_RUNTIME_BUILD_ID: plan.release.runtimeBuildId,
    META_RUNTIME_BROWSER_CONFIG: plan.configuration.browserJson,
    META_RUNTIME_MANAGED: "true",
    AI_MACOS_EXPECTED_HOSTNAME: plan.machine.expectedHostname,
  }
  const environmentXml = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${RUNTIME_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(runtime)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(join(plan.paths.installRoot, "current"))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(join(plan.paths.runRoot, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(plan.paths.runRoot, "stderr.log"))}</string>
</dict>
</plist>
`
}

function normalizePaths(value: RuntimeInstallPaths): RuntimeInstallPaths {
  for (const path of Object.values(value)) if (!isAbsolute(path)) throw new Error("Install path должен быть абсолютным")
  const paths = Object.fromEntries(Object.entries(value).map(([key, path]) => [key, resolve(path)])) as RuntimeInstallPaths
  if (paths.stableHelperPath !== join(paths.repositoryRoot, "input/bin/meta-input-helper")) {
    throw new Error("Stable helper path должен оставаться canonical input/bin/meta-input-helper")
  }
  if (paths.launchAgentPath !== join(dirname(dirname(paths.launchAgentPath)), "LaunchAgents", `${RUNTIME_SERVICE_LABEL}.plist`)) {
    throw new Error("LaunchAgent path должен иметь exact canonical label")
  }
  const socketPath = join(paths.runRoot, "runtime.sock")
  if (new TextEncoder().encode(socketPath).byteLength > 103) {
    throw new Error("Runtime UDS path превышает macOS sockaddr_un limit 103 UTF-8 байта")
  }
  return paths
}

async function assertCanonicalRepository(path: string, allowTestRoot: boolean): Promise<void> {
  const actual = await realpath(path)
  if (actual !== path || !allowTestRoot && (!path.startsWith("/Users/") || !path.includes("/repozitarium/ai-macos"))) {
    throw new Error("Installer разрешён только из canonical ai-macos checkout")
  }
  await assertNoSymlink(path)
}

async function verifyExistingHelperIdentity(path: string, runner: CommandRunner): Promise<void> {
  if (!await exists(path)) return
  const signature = await inspectCodeSignature(runner, path)
  if (signature.identifier !== HELPER_SIGNING_IDENTIFIER) {
    throw new Error("Installed stable helper имеет другой codesign identifier; TCC identity migration требует отдельного решения")
  }
}

async function inspectCodeSignature(runner: CommandRunner, path: string) {
  const result = await checked(runner, "/usr/bin/codesign", ["--display", "--verbose=4", "-r-", path])
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").map(line => line.trim())
  const identifier = lines.find(line => line.startsWith("Identifier="))?.slice("Identifier=".length)
  const cdhash = lines.find(line => line.startsWith("CDHash="))?.slice("CDHash=".length).toLowerCase()
  // codesign помечает вычисленное implicit requirement ad-hoc подписи символом #.
  const designatedRequirement = lines.map(line => line.replace(/^#\s*(?=designated =>)/, ""))
    .find(line => line.startsWith("designated =>"))
  if (identifier === undefined || cdhash === undefined || !/^[a-f0-9]{40,64}$/.test(cdhash)
    || designatedRequirement === undefined) throw new Error("Codesign metadata не содержит identifier/cdhash/designated requirement")
  return { identifier, cdhash, designatedRequirement }
}

async function assertPrivateDirectoryRoot(path: string): Promise<void> {
  await ensureDirectoryDurably(path, 0o700)
  await assertNoSymlink(path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error(`Install directory не принадлежит текущему user: ${path}`)
  await chmod(path, 0o700)
}

async function assertLaunchAgentDirectory(path: string): Promise<void> {
  await ensureDirectoryDurably(path, 0o700)
  await assertNoSymlink(path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error(`LaunchAgents directory небезопасен или принадлежит другому user: ${path}`)
  }
}

async function ensureDirectoryDurably(path: string, mode: number): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Directory path небезопасен: ${path}`)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const parent = dirname(path)
  if (parent === path) throw new Error(`Directory root отсутствует: ${path}`)
  await ensureDirectoryDurably(parent, mode)
  try {
    await mkdir(path, { mode })
    await syncDirectory(parent)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Concurrent directory path небезопасен: ${path}`)
  }
}

async function assertStableHelperParent(path: string, repositoryRoot: string): Promise<void> {
  if (relative(repositoryRoot, path).startsWith("..")) throw new Error("Stable helper находится вне canonical repository")
  await assertNoSymlink(dirname(path))
  if (await exists(path)) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Stable helper path небезопасен")
  }
}

async function assertNoSymlink(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`Symlink запрещён для owned install path: ${path}`)
}

function assertPlanMatchesOptions(plan: RuntimeInstallPlan, paths: RuntimeInstallPaths, options: RuntimeInstallOptions): void {
  if (plan.kind !== "meta-runtime-install-plan" || stableJson(plan.paths) !== stableJson(paths)) throw new Error("Install plan относится к другим paths")
  if (plan.service.domain !== `gui/${options.uid}` || plan.service.label !== RUNTIME_SERVICE_LABEL) throw new Error("Install plan относится к другому user service")
  if (plan.source.repositoryRoot !== paths.repositoryRoot) throw new Error("Install plan относится к другому checkout")
  if (stableJson(plan.configuration) !== stableJson(installConfiguration(options))) throw new Error("Install plan содержит другую runtime configuration")
}

function assertDrainReceipt(expected: RuntimeInspection, receipt: RuntimeDrainReceipt): void {
  if (!expected.running || receipt.cleanup !== "complete" || receipt.activeOperations !== 0 || receipt.quarantinedResources !== 0
    || receipt.runtimeEpoch !== expected.runtimeEpoch || receipt.runtimeBuildId !== expected.runtimeBuildId
    || receipt.nativeBuildId !== expected.nativeBuildId) {
    throw new Error("Runtime drain receipt не подтверждает exact running generation/builds")
  }
}

function assertManifestMatchesPlan(manifest: ReleaseManifest, plan: RuntimeInstallPlan, plistSha256: string): void {
  if (manifest.releaseId !== plan.release.releaseId || manifest.source.commit !== plan.source.commit
    || manifest.builds.runtimeBuildId !== plan.release.runtimeBuildId || manifest.builds.nativeBuildId !== plan.release.nativeBuildId
    || manifest.launchAgent.sha256 !== plistSha256 || manifest.tcc.subjectPath !== plan.paths.stableHelperPath
    || stableJson(manifest.configuration) !== stableJson(plan.configuration)) {
    throw new Error("Existing immutable release конфликтует с install plan")
  }
}

function parseManifest(value: unknown): ReleaseManifest {
  if (value === null || typeof value !== "object") throw new Error("Release manifest должен быть object")
  const manifest = value as ReleaseManifest
  if (manifest.format !== RELEASE_FORMAT || manifest.artifacts?.runtime?.path !== "runtime"
    || manifest.artifacts?.nativeHelper?.path !== "native-helper"
    || manifest.artifacts.nativeHelper.signingIdentifier !== HELPER_SIGNING_IDENTIFIER
    || !/^[a-f0-9]{64}$/.test(manifest.artifacts.runtime.sha256)
    || !/^[a-f0-9]{64}$/.test(manifest.artifacts.nativeHelper.sha256)
    || !/^[a-f0-9]{40,64}$/.test(manifest.artifacts.nativeHelper.cdhash)
    || !manifest.artifacts.nativeHelper.designatedRequirement.startsWith("designated =>")
    || manifest.artifacts.nativeHelper.auditSession?.verified !== true
    || manifest.artifacts.nativeHelper.auditSession.source !== "darwin-audit"
    || ![manifest.artifacts.nativeHelper.auditSession.uid, manifest.artifacts.nativeHelper.auditSession.effectiveUid,
      manifest.artifacts.nativeHelper.auditSession.auditUserId, manifest.artifacts.nativeHelper.auditSession.auditSessionId]
      .every(field => Number.isSafeInteger(field) && field >= 0)
    || manifest.tcc?.subjectPath === undefined || manifest.tcc.candidateCdhash !== manifest.artifacts.nativeHelper.cdhash
    || manifest.tcc.automaticGrantPreservation !== false
    || stableJson(manifest.tcc.requiredPassiveChecks) !== stableJson(["accessibility", "screen-recording"])
    || manifest.entrypoint?.source !== "scripts/runtime-entry.ts"
    || stableJson(manifest.entrypoint.modes) !== stableJson(["runtime", "doctor", "mcp"])
    || manifest.entrypoint.mcpTransport !== "stdio"
    || !validManifestConfiguration(manifest.configuration)) {
    throw new Error("Release manifest не соответствует strict format")
  }
  return manifest
}

async function assertSourceUnchanged(plan: RuntimeInstallPlan, options: RuntimeInstallOptions): Promise<void> {
  const commit = (await checked(options.runner, "git", ["rev-parse", "HEAD"], plan.paths.repositoryRoot)).stdout.trim()
  const status = await checked(options.runner, "git", ["status", "--porcelain=v1", "-z"], plan.paths.repositoryRoot)
  if (commit !== plan.source.commit || status.stdout.length > 0) {
    throw new Error("Checkout изменился во время candidate build; mixed-source release запрещён")
  }
}

async function inspectLaunchService(
  runner: CommandRunner,
  plan: RuntimeInstallPlan,
  allowAbsent = true,
): Promise<LaunchServiceIdentity | undefined> {
  const result = await runner.run("/bin/launchctl", ["print", `${plan.service.domain}/${RUNTIME_SERVICE_LABEL}`], { timeoutMs: 5_000 })
  if (result.exitCode !== 0) {
    if (!allowAbsent) throw new Error("Expected runtime LaunchAgent отсутствует при exact cutover recheck")
    return undefined
  }
  const lines = result.stdout.split("\n").map(line => line.trim())
  const pid = Number(lines.find(line => line.startsWith("pid = "))?.slice("pid = ".length))
  const program = lines.find(line => line.startsWith("program = "))?.slice("program = ".length)
  const plistPath = lines.find(line => line.startsWith("path = "))?.slice("path = ".length)
  const expectedProgram = join(plan.paths.installRoot, "current", "runtime")
  if (!Number.isSafeInteger(pid) || pid < 1 || program !== expectedProgram || plistPath !== plan.paths.launchAgentPath) {
    throw new Error("Loaded LaunchAgent не совпадает с exact canonical pid/program/plist ownership")
  }
  return { pid, program, plistPath }
}

async function assertExactServiceAndRuntime(
  options: RuntimeInstallOptions,
  plan: RuntimeInstallPlan,
  expectedService: LaunchServiceIdentity,
  expectedRuntime: RuntimeInspection,
  drained: boolean,
): Promise<void> {
  const service = await inspectLaunchService(options.runner, plan, false)
  if (stableJson(service) !== stableJson(expectedService)) throw new Error("LaunchAgent identity изменилась перед cutover")
  if (options.runtimeAdmin === undefined) throw new Error("Runtime admin authority отсутствует перед cutover")
  const runtime = await options.runtimeAdmin.inspect()
  if (!runtime.running || runtime.runtimeEpoch !== expectedRuntime.runtimeEpoch
    || runtime.runtimeBuildId !== expectedRuntime.runtimeBuildId || runtime.nativeBuildId !== expectedRuntime.nativeBuildId
    || drained && (runtime.activeOperations !== 0 || runtime.quarantinedResources !== 0)) {
    throw new Error("Runtime generation/build/cleanup изменились перед cutover")
  }
}

function parseNativeMetadata(text: string) {
  const value = JSON.parse(text) as {
    nativeBuildId?: unknown
    installRoot?: unknown
    session?: Partial<NativeAuditIdentity>
  }
  const session = value.session
  if (typeof value.nativeBuildId !== "string" || typeof value.installRoot !== "string"
    || session?.verified !== true || session.source !== "darwin-audit"
    || ![session.uid, session.effectiveUid, session.auditUserId, session.auditSessionId]
      .every(field => Number.isSafeInteger(field) && Number(field) >= 0)) {
    throw new Error("Native metadata не содержит verified build/install/audit identity")
  }
  return { nativeBuildId: value.nativeBuildId, installRoot: value.installRoot, session: session as NativeAuditIdentity }
}

function assertCurrentAuditUser(session: NativeAuditIdentity): void {
  if (!freshAuditUser(session)) throw new Error("Native metadata audit user не совпадает с installer user")
}

function freshAuditUser(session: NativeAuditIdentity): boolean {
  const uid = process.getuid?.()
  const effectiveUid = process.geteuid?.()
  return uid !== undefined && effectiveUid !== undefined
    && session.verified && session.source === "darwin-audit"
    && session.uid === uid && session.effectiveUid === effectiveUid && session.auditUserId === uid
}

function legacyCandidates(root: string): LegacyRetirementCandidate[] {
  return ([
    ["window", 7878],
    ["screen", 7879],
    ["chrome", 7880],
    ["android", 7881],
    ["input", 7882],
  ] as const).map(([name, port]) => ({
    package: name,
    port,
    expectedEntrypoint: join(root, name, "src/index.ts"),
    disposition: "inspect-only",
    requiredEvidence: ["pid", "executable", "cwd", "listener-port", "canonical-root"],
  }))
}

async function checked(
  runner: CommandRunner,
  file: string,
  args: readonly string[],
  cwd?: string,
  timeoutMs = 30_000,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const result = await runner.run(file, args, { cwd, timeoutMs, env })
  if (result.exitCode !== 0) throw new Error(`${basename(file)} failed (${result.exitCode}): ${result.stderr.trim()}`)
  return result
}

async function artifact(path: string): Promise<{ sha256: string, bytes: number }> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128 * 1024 * 1024) throw new Error(`Invalid release artifact: ${path}`)
  const bytes = await readFile(path)
  return { sha256: sha256(bytes), bytes: bytes.byteLength }
}

async function atomicCopy(source: string, target: string, mode: number): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await copyFile(source, temporary)
    await chmod(temporary, mode)
    await syncFile(temporary)
    await rename(temporary, target)
    await syncDirectory(dirname(target))
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function atomicText(path: string, text: string, mode: number): Promise<void> {
  await atomicBytes(path, new TextEncoder().encode(text), mode)
}

async function atomicBytes(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode })
    await syncFile(temporary)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function durableText(path: string, text: string, mode: number): Promise<void> {
  await durableBytes(path, new TextEncoder().encode(text), mode)
}

async function durableBytes(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode })
  await syncFile(path)
}

async function atomicSymlink(destination: string, path: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await symlink(destination, temporary)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r")
  try { await handle.sync() }
  finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r")
  try { await handle.sync() }
  finally { await handle.close() }
}

async function readRegularFileIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Installed file path небезопасен: ${path}`)
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function readLinkIfPresent(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isSymbolicLink()) throw new Error("Current release pointer должен быть symlink")
    return await readlink(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function hashIfPresent(path: string): Promise<string | undefined> {
  const bytes = await readRegularFileIfPresent(path)
  return bytes === undefined ? undefined : sha256(bytes)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if (isMissing(error)) return false; throw error }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function safeChild(root: string, child: string): string {
  const path = resolve(root, child)
  if (relative(root, path).startsWith("..")) throw new Error("Manifest artifact path выходит из release")
  return path
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]))
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function defaultPaths(repositoryRoot: string): RuntimeInstallPaths {
  const home = process.env.HOME
  if (home === undefined) throw new Error("HOME не определён")
  const installRoot = join(home, "Library/Application Support/ai-macos/runtime")
  return {
    repositoryRoot,
    installRoot,
    runRoot: join(home, "Library/Application Support/ai-macos/run"),
    launchAgentPath: join(home, "Library/LaunchAgents", `${RUNTIME_SERVICE_LABEL}.plist`),
    stableHelperPath: join(repositoryRoot, "input/bin/meta-input-helper"),
  }
}

async function cli(): Promise<void> {
  const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)))
  const execute = process.argv.includes("--execute")
  const expectedHostname = process.env.AI_MACOS_EXPECTED_HOSTNAME
  if (expectedHostname === undefined) throw new Error("AI_MACOS_EXPECTED_HOSTNAME обязателен")
  const runner = new LocalCommandRunner()
  const browserConfigIndex = process.argv.indexOf("--browser-config")
  const browserConfigPath = browserConfigIndex < 0 ? undefined : process.argv[browserConfigIndex + 1]
  if (browserConfigIndex >= 0 && browserConfigPath === undefined) throw new Error("--browser-config требует JSON file path")
  const browserConfig = browserConfigPath === undefined ? undefined : await readBrowserConfigFile(resolve(browserConfigPath))
  let options: RuntimeInstallOptions = {
    paths: defaultPaths(repositoryRoot),
    runner,
    expectedHostname,
    uid: process.getuid?.() ?? (() => { throw new Error("UID недоступен") })(),
    ...(browserConfig === undefined ? {} : { browserConfig }),
    readinessProfile: readinessProfileFromArguments(process.argv),
  }
  let plan = await planRuntimeInstall(options)
  if (execute && plan.service.loaded && !plan.release.alreadyInstalled) {
    const { createRuntimeAdmin } = await import("./runtime-admin.ts")
    options = { ...options, runtimeAdmin: createRuntimeAdmin({ runRoot: options.paths.runRoot }) }
    plan = await planRuntimeInstall(options)
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  if (!execute) return
  const result = await applyRuntimeInstall(plan, options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

export function readinessProfileFromArguments(argv: readonly string[]): RuntimeReadinessProfile {
  const foundation = argv.includes("--foundation")
  const selected = argv.includes("--desktop-browser-selected")
  if (foundation && selected) {
    throw new Error("--foundation и --desktop-browser-selected взаимоисключающие")
  }
  return foundation ? "foundation" : selected ? "desktop-browser-selected" : "full"
}

async function readBrowserConfigFile(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || info.size < 2 || info.size > MAX_BROWSER_CONFIG_BYTES) throw new Error("Browser config file owner/type/size invalid")
  const bytes = await readFile(path)
  if (bytes.byteLength !== info.size || bytes.byteLength > MAX_BROWSER_CONFIG_BYTES) throw new Error("Browser config изменился при bounded read")
  const text = new TextDecoder().decode(bytes)
  parseBrowserHostConfig(text)
  return text
}

if (import.meta.main) {
  cli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
