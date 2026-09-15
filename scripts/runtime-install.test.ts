import { afterEach, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { CAPABILITY_IDS } from "../shared/src/contracts/index.ts"
import {
  HELPER_SIGNING_IDENTIFIER,
  RUNTIME_SERVICE_LABEL,
  applyRuntimeInstall,
  planRuntimeInstall,
  readinessProfileFromArguments,
  type CommandResult,
  type CommandRunner,
  type RuntimeAdmin,
  type RuntimeInstallOptions,
  type RuntimeInspection,
} from "./runtime-install.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async path => {
    const releases = join(path, "home", "Library", "Application Support", "ai-macos", "runtime", "releases")
    for (const name of await readdir(releases).catch(() => [])) await chmod(join(releases, name), 0o700).catch(() => undefined)
    await rm(path, { recursive: true, force: true })
  }))
})

test("dry-run строит reviewable plan без login identity и execute публикует immutable release", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  expect(plan.gates).toMatchObject({ sourceClean: true, exactHostname: true, permissionsRequested: false, liveDesktopProbe: false })
  expect(plan.steps.some(step => step.id === "build-native" && step.command?.args[2] === plan.release.nativeBuildId)).toBe(true)
  expect(plan.legacyRetirement.every(candidate => candidate.disposition === "inspect-only")).toBe(true)
  expect(fixture.runner.mutations).toBe(0)

  const result = await applyRuntimeInstall(plan, fixture.options)
  expect(result).toMatchObject({ state: "installed", rollbackUsed: false, releaseId: plan.release.releaseId })
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(plan.release.releasePath)
  const manifest = JSON.parse(await readFile(join(plan.release.releasePath, "manifest.json"), "utf8"))
  expect(manifest).toMatchObject({
    format: "meta-ai-macos-runtime-release-v1",
    builds: { runtimeBuildId: plan.release.runtimeBuildId, nativeBuildId: plan.release.nativeBuildId },
    artifacts: { nativeHelper: { signingIdentifier: HELPER_SIGNING_IDENTIFIER } },
    entrypoint: { source: "scripts/runtime-entry.ts", modes: ["runtime", "doctor", "mcp"], mcpTransport: "stdio" },
  })
  expect((await lstat(plan.release.releasePath)).mode & 0o777).toBe(0o555)
  const plist = await readFile(fixture.options.paths.launchAgentPath, "utf8")
  expect(plist).toContain(`<string>${RUNTIME_SERVICE_LABEL}</string>`)
  expect(plist).toContain("META_NATIVE_HELPER")
  expect(plist).toContain("META_RUNTIME_BROWSER_CONFIG")
  expect(plist).toContain("META_RUNTIME_MANAGED")
  expect(plist).not.toContain("META_LOGIN_SESSION_ID")
  expect(await readFile(fixture.options.paths.stableHelperPath, "utf8")).toContain(plan.release.nativeBuildId)
})

test("loaded update требует exact drain, повтор того же release идемпотентен", async () => {
  const fixture = await createFixture()
  const firstPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(firstPlan, fixture.options)
  fixture.runner.loaded = true
  const inspection: RuntimeInspection = {
    running: true,
    runtimeEpoch: "runtime:installed",
    runtimeBuildId: firstPlan.release.runtimeBuildId,
    nativeBuildId: firstPlan.release.nativeBuildId,
    activeOperations: 0,
    quarantinedResources: 0,
  }
  let drains = 0
  const admin: RuntimeAdmin = {
    async inspect() { return inspection },
    async drain(expected) {
      drains++
      return {
        runtimeEpoch: expected.runtimeEpoch!,
        runtimeBuildId: expected.runtimeBuildId!,
        nativeBuildId: expected.nativeBuildId!,
        cleanup: "complete",
        activeOperations: 0,
        quarantinedResources: 0,
      }
    },
  }
  const options = { ...fixture.options, runtimeAdmin: admin }
  fixture.runner.auditSessionId = 2
  const repeatedPlan = await planRuntimeInstall(options)
  const result = await applyRuntimeInstall(repeatedPlan, options)
  expect(result.state).toBe("already-installed")
  const manifest = JSON.parse(await readFile(join(repeatedPlan.release.releasePath, "manifest.json"), "utf8"))
  expect(manifest.artifacts.nativeHelper.auditSession.auditSessionId).toBe(1)
  expect(drains).toBe(0)
  expect(fixture.runner.builds).toBe(2)

  fixture.runner.commit = "d".repeat(40)
  const changedPlan = await planRuntimeInstall(options)
  await expect(applyRuntimeInstall(changedPlan, {
    ...options,
    runtimeAdmin: {
      async inspect() { return inspection },
      async drain(expected) { return { ...await admin.drain(expected), runtimeEpoch: "runtime:foreign" } },
    },
  })).rejects.toThrow("admission остаётся sealed")
})

test("failed doctor атомарно возвращает previous helper, release pointer и plist", async () => {
  const fixture = await createFixture()
  const firstPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(firstPlan, fixture.options)
  const firstHelper = await readFile(fixture.options.paths.stableHelperPath)
  const firstPlist = await readFile(fixture.options.paths.launchAgentPath)

  fixture.runner.commit = "b".repeat(40)
  fixture.runner.loaded = true
  const inspection: RuntimeInspection = {
    running: true,
    runtimeEpoch: "runtime:first",
    runtimeBuildId: firstPlan.release.runtimeBuildId,
    nativeBuildId: firstPlan.release.nativeBuildId,
    activeOperations: 0,
    quarantinedResources: 0,
  }
  const options = { ...fixture.options, runtimeAdmin: successfulAdmin(inspection) }
  const secondPlan = await planRuntimeInstall(options)
  fixture.runner.failDoctorForBuild = secondPlan.release.runtimeBuildId
  await expect(applyRuntimeInstall(secondPlan, options)).rejects.toThrow("doctor")
  expect(await readlink(join(options.paths.installRoot, "current"))).toBe(firstPlan.release.releasePath)
  expect(await readFile(options.paths.stableHelperPath)).toEqual(firstHelper)
  expect(await readFile(options.paths.launchAgentPath)).toEqual(firstPlist)
})

test("symlink helper и foreign signing identity блокируются до cutover", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  const foreign = join(fixture.root, "foreign-helper")
  await writeFile(foreign, "foreign")
  await symlink(foreign, fixture.options.paths.stableHelperPath)
  await expect(applyRuntimeInstall(plan, fixture.options)).rejects.toThrow("Stable helper path небезопасен")
  await rm(fixture.options.paths.stableHelperPath)
  await writeFile(fixture.options.paths.stableHelperPath, "foreign")
  fixture.runner.foreignStableHelper = true
  await expect(applyRuntimeInstall(plan, fixture.options)).rejects.toThrow("codesign identifier")
})

test("durable pending-update восстанавливается при следующем запуске после потерянного cutover ответа", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  await expect(applyRuntimeInstall(plan, {
    ...fixture.options,
    failpoint(stage) {
      if (stage === "after-rollback-prepared") throw new Error("simulated process loss")
    },
  })).rejects.toThrow("simulated process loss")
  const pending = join(fixture.options.paths.installRoot, "pending-update", "record.json")
  expect(JSON.parse(await readFile(pending, "utf8"))).toMatchObject({
    format: "meta-runtime-pending-update-v1",
    previousCurrentRelease: null,
    helperPresent: false,
    plistPresent: false,
  })
  await writeFile(fixture.options.paths.stableHelperPath, "partial-new-helper")
  await symlink(plan.release.releasePath, join(fixture.options.paths.installRoot, "current"))
  await writeFile(fixture.options.paths.launchAgentPath, "partial plist")
  const recovered = await applyRuntimeInstall(plan, fixture.options)
  expect(recovered.state).toBe("installed")
  await expect(lstat(join(fixture.options.paths.installRoot, "pending-update"))).rejects.toThrow()
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(plan.release.releasePath)
})

test("слишком длинный macOS UDS path отклоняется до git и filesystem mutations", async () => {
  const fixture = await createFixture()
  fixture.options.paths.runRoot = join(fixture.root, "r".repeat(120))
  await expect(planRuntimeInstall(fixture.options)).rejects.toThrow("sockaddr_un")
  expect(fixture.runner.mutations).toBe(0)
})

test("browser configuration входит в release identity, а full readiness требует config и capabilities", async () => {
  const fixture = await createFixture()
  const fullMissing = await planRuntimeInstall({ ...fixture.options, readinessProfile: "full" })
  expect(fullMissing.gates.requiredConfigurationPresent).toBe(false)
  expect(fullMissing.configuration.requiredCapabilities).toContain("browser.instances")
  expect(fullMissing.configuration.requiredCapabilities).not.toContain("android.chrome")
  await expect(applyRuntimeInstall(fullMissing, { ...fixture.options, readinessProfile: "full" })).rejects.toThrow("required configuration")

  const browserConfig = JSON.stringify({ chrome: {
    bindingId: "chrome:installed",
    instances: [{ browserInstanceRef: "chrome:existing", initialTransportGeneration: "cdp:initial",
      endpointHost: "127.0.0.1", endpointPort: 9222, profilePath: "/Users/tester/Library/Application Support/Google/Chrome-CDP" }],
  } })
  const configured = await planRuntimeInstall({ ...fixture.options, browserConfig, requiredCapabilities: ["runtime.health", "browser.instances"] })
  const other = await planRuntimeInstall({ ...fixture.options, browserConfig: JSON.stringify({ chrome: {
    ...JSON.parse(browserConfig).chrome, bindingId: "chrome:other",
  } }), requiredCapabilities: ["runtime.health", "browser.instances"] })
  expect(configured.release.releaseId).not.toBe(other.release.releaseId)
  expect(configured.release.runtimeBuildId).toBe(other.release.runtimeBuildId)
  expect(configured.release.nativeBuildId).toBe(other.release.nativeBuildId)
  const configuredOptions = { ...fixture.options, browserConfig,
    requiredCapabilities: ["runtime.health", "browser.instances"] as const }
  const installed = await applyRuntimeInstall(configured, configuredOptions)
  expect(installed.readiness).toEqual({ profile: "foundation",
    requiredCapabilities: ["runtime.health", "browser.instances"],
    deferredCapabilities: [], state: "ready" })
  const plist = await readFile(fixture.options.paths.launchAgentPath, "utf8")
  expect(plist).toContain("META_RUNTIME_MANAGED")
  expect(plist).toContain("&quot;chrome&quot;")
  fixture.runner.unavailableCapabilities.add("browser.instances")
  await expect(applyRuntimeInstall(configured, configuredOptions)).rejects.toThrow("required capability")
})

test("desktop-browser-selected явно откладывает interaction и сохраняет обязательный desktop/browser set", async () => {
  const fixture = await createFixture()
  const browserConfig = JSON.stringify({
    chrome: {
      bindingId: "chrome:selected",
      instances: [{
        browserInstanceRef: "chrome:selected-instance",
        initialTransportGeneration: "cdp:selected-initial",
        endpointHost: "127.0.0.1",
        endpointPort: 9222,
        profilePath: "/Users/tester/Library/Application Support/Google/Chrome-CDP",
      }],
    },
  })
  const options = {
    ...fixture.options,
    browserConfig,
    readinessProfile: "desktop-browser-selected" as const,
  }
  const plan = await planRuntimeInstall(options)

  expect(plan.configuration.readinessProfile).toBe("desktop-browser-selected")
  expect(plan.configuration.requiredCapabilities).toEqual(
    CAPABILITY_IDS.filter(id => !["android.chrome", "runtime.install", "input.interaction"].includes(id)),
  )
  expect(plan.configuration.requiredCapabilities).toContain("input.pointer")
  expect(plan.configuration.requiredCapabilities).toContain("input.drag")
  expect(plan.configuration.requiredCapabilities).toContain("desktop.application.lifecycle")
  expect(plan.configuration.deferredCapabilities).toEqual([{
    id: "input.interaction",
    reason: expect.stringContaining("observation-bound input guard"),
  }])
  expect(plan.gates.requiredConfigurationPresent).toBe(true)

  const installed = await applyRuntimeInstall(plan, options)
  expect(installed.readiness).toEqual({
    profile: "desktop-browser-selected",
    requiredCapabilities: plan.configuration.requiredCapabilities,
    deferredCapabilities: plan.configuration.deferredCapabilities,
    state: "ready",
  })
  const manifest = JSON.parse(await readFile(join(plan.release.releasePath, "manifest.json"), "utf8"))
  expect(manifest.configuration).toEqual(plan.configuration)

  await expect(planRuntimeInstall({
    ...options,
    requiredCapabilities: ["runtime.health"],
  })).rejects.toThrow("фиксированный required capability set")
})

test("desktop-browser-selected включает Android только при explicit config, full остаётся строгим", async () => {
  const fixture = await createFixture()
  const browserConfig = JSON.stringify({
    chrome: {
      bindingId: "chrome:selected-with-android",
      instances: [{
        browserInstanceRef: "chrome:selected-instance",
        initialTransportGeneration: "cdp:selected-initial",
        endpointHost: "127.0.0.1",
        endpointPort: 9222,
        profilePath: "/Users/tester/Library/Application Support/Google/Chrome-CDP",
      }],
    },
    android: {
      bindingId: "android:selected",
      serial: "fixture-device",
      localPort: 9223,
      deviceRef: "device:selected",
      initialDeviceTransportGeneration: "usb:selected",
      browserInstanceRef: "android-browser:selected",
      initialBrowserTransportGeneration: "android-cdp:selected",
    },
  })
  const selected = await planRuntimeInstall({
    ...fixture.options,
    browserConfig,
    readinessProfile: "desktop-browser-selected",
  })
  const full = await planRuntimeInstall({
    ...fixture.options,
    browserConfig,
    readinessProfile: "full",
  })

  expect(selected.configuration.requiredCapabilities).toContain("android.chrome")
  expect(full.configuration.requiredCapabilities).toContain("input.interaction")
  expect(full.configuration.requiredCapabilities).not.toContain("android.chrome")
  expect(full.configuration.deferredCapabilities).toEqual([])
  expect(selected.release.releaseId).not.toBe(full.release.releaseId)
  expect(selected.release.runtimeBuildId).toBe(full.release.runtimeBuildId)
  expect(selected.release.nativeBuildId).toBe(full.release.nativeBuildId)
  expect(readinessProfileFromArguments(["bun", "--desktop-browser-selected"]))
    .toBe("desktop-browser-selected")
  expect(readinessProfileFromArguments(["bun", "--foundation"]))
    .toBe("foundation")
  expect(readinessProfileFromArguments(["bun"])).toBe("full")
  expect(() => readinessProfileFromArguments([
    "bun",
    "--foundation",
    "--desktop-browser-selected",
  ])).toThrow("взаимоисключающие")
})

test("failed bootout сохраняет pending journal и не меняет installed files", async () => {
  const fixture = await createFixture()
  const first = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(first, fixture.options)
  const helper = await readFile(fixture.options.paths.stableHelperPath)
  const current = await readlink(join(fixture.options.paths.installRoot, "current"))
  fixture.runner.commit = "e".repeat(40)
  fixture.runner.failBootout = true
  const running: RuntimeInspection = {
    running: true, runtimeEpoch: "runtime:bootout", runtimeBuildId: first.release.runtimeBuildId,
    nativeBuildId: first.release.nativeBuildId, activeOperations: 0, quarantinedResources: 0,
  }
  const options = { ...fixture.options, runtimeAdmin: successfulAdmin(running) }
  const update = await planRuntimeInstall(options)
  await expect(applyRuntimeInstall(update, options)).rejects.toThrow("rollback incomplete")
  expect(await readFile(options.paths.stableHelperPath)).toEqual(helper)
  expect(await readlink(join(options.paths.installRoot, "current"))).toBe(current)
  expect(JSON.parse(await readFile(join(options.paths.installRoot, "pending-update", "record.json"), "utf8"))).toMatchObject({ serviceLoaded: true })
})

test("owner lock и late service appearance блокируют concurrent cutover до helper switch", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  let unlock!: () => void
  const gate = new Promise<void>(resolve => { unlock = resolve })
  const running = applyRuntimeInstall(plan, {
    ...fixture.options,
    async failpoint(stage) { if (stage === "after-installer-lock") await gate },
  })
  await Bun.sleep(10)
  await expect(applyRuntimeInstall(plan, fixture.options)).rejects.toThrow("lock уже удерживается")
  unlock()
  await running

  const late = await createFixture()
  const latePlan = await planRuntimeInstall(late.options)
  late.runner.appearAtPrint = 3
  await expect(applyRuntimeInstall(latePlan, late.options)).rejects.toThrow("появился после admission")
  await expect(lstat(late.options.paths.stableHelperPath)).rejects.toThrow()
})

test("existing release требует owned non-symlink tree, exact signature/metadata и doctor readiness polling", async () => {
  const fixture = await createFixture()
  fixture.runner.doctorUnavailableCount = 2
  const plan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(plan, fixture.options)
  expect(fixture.runner.doctorCalls).toBe(3)
  await chmod(plan.release.releasePath, 0o700)
  const helperPath = join(plan.release.releasePath, "native-helper")
  const moved = join(plan.release.releasePath, "native-helper.real")
  await Bun.write(moved, await readFile(helperPath))
  await chmod(moved, 0o555)
  await rm(helperPath)
  await symlink(moved, helperPath)
  await chmod(plan.release.releasePath, 0o555)
  const repeated = await planRuntimeInstall({ ...fixture.options, runtimeAdmin: successfulAdmin({
    running: true, runtimeEpoch: "runtime:existing", runtimeBuildId: plan.release.runtimeBuildId,
    nativeBuildId: plan.release.nativeBuildId, activeOperations: 0, quarantinedResources: 0,
  }) })
  await expect(applyRuntimeInstall(repeated, fixture.options)).rejects.toThrow("symlink/mode mismatch")
})

function successfulAdmin(inspection: RuntimeInspection): RuntimeAdmin {
  return {
    async inspect() { return inspection },
    async drain(expected) {
      return {
        runtimeEpoch: expected.runtimeEpoch!,
        runtimeBuildId: expected.runtimeBuildId!,
        nativeBuildId: expected.nativeBuildId!,
        cleanup: "complete",
        activeOperations: 0,
        quarantinedResources: 0,
      }
    },
  }
}

async function createFixture() {
  const root = await realpath(await mkdtemp("/tmp/runtime-installer-"))
  roots.push(root)
  const repositoryPath = join(root, "repozitarium", "ai-macos")
  const home = join(root, "home")
  await mkdir(join(repositoryPath, "native", "scripts"), { recursive: true })
  await mkdir(join(repositoryPath, "runtime", "src"), { recursive: true })
  await mkdir(join(repositoryPath, "input", "bin"), { recursive: true })
  const repositoryRoot = await realpath(repositoryPath)
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true })
  await writeFile(join(repositoryRoot, "native", "scripts", "build-broker.sh"), "fixture")
  const runner = new FakeRunner(repositoryRoot)
  const options: RuntimeInstallOptions = {
    paths: {
      repositoryRoot,
      installRoot: join(home, "Library", "Application Support", "ai-macos", "runtime"),
      runRoot: join(home, "Library", "Application Support", "ai-macos", "run"),
      launchAgentPath: join(home, "Library", "LaunchAgents", `${RUNTIME_SERVICE_LABEL}.plist`),
      stableHelperPath: join(repositoryRoot, "input", "bin", "meta-input-helper"),
    },
    runner,
    expectedHostname: hostname(),
    uid: process.getuid?.() ?? 501,
    now: () => new Date("2026-09-15T12:00:00.000Z"),
    testOnlyAllowNonCanonicalRoot: true,
    doctorTimeoutMs: 200,
    readinessProfile: "foundation",
  }
  runner.launchProgram = join(options.paths.installRoot, "current", "runtime")
  runner.launchPlist = options.paths.launchAgentPath
  return { root, runner, options }
}

class FakeRunner implements CommandRunner {
  commit = "a".repeat(40)
  loaded = false
  builds = 0
  mutations = 0
  failDoctorForBuild: string | undefined
  foreignStableHelper = false
  failBootout = false
  appearAtPrint: number | undefined
  printCalls = 0
  doctorUnavailableCount = 0
  doctorCalls = 0
  auditSessionId = 1
  readonly unavailableCapabilities = new Set<string>()
  launchProgram = ""
  launchPlist = ""

  constructor(readonly repositoryRoot: string) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    if (file === "git" && args[0] === "rev-parse") return ok(`${this.commit}\n`)
    if (file === "git" && args[0] === "status") return ok("")
    if (file === "/bin/launchctl" && args[0] === "print") {
      this.printCalls++
      if (this.appearAtPrint === this.printCalls) this.loaded = true
      return this.loaded
      ? ok(`path = ${this.launchPlist}\nprogram = ${this.launchProgram}\npid = 4242\n`)
      : fail("not loaded")
    }
    if (file === process.execPath && args[0] === "build") {
      this.mutations++
      this.builds++
      const output = args[args.indexOf("--outfile") + 1]!
      const define = args[args.indexOf("--define") + 1]!
      await writeFile(output, `runtime:${define}`)
      await chmod(output, 0o755)
      return ok()
    }
    if (file === "/bin/sh" && args[0]?.endsWith("build-broker.sh")) {
      this.mutations++
      this.builds++
      await writeFile(args[1]!, `native:${args[2]}`)
      await chmod(args[1]!, 0o755)
      return ok()
    }
    if (file === "/usr/bin/codesign" && args.includes("--display")) {
      const target = args.at(-1)!
      const identifier = this.foreignStableHelper && target.endsWith("input/bin/meta-input-helper")
        ? "foreign.helper"
        : HELPER_SIGNING_IDENTIFIER
      return { stdout: "", stderr: `Identifier=${identifier}\nCDHash=${"c".repeat(40)}\ndesignated => identifier "${identifier}" and anchor apple generic\nSignature=adhoc\n`, exitCode: 0 }
    }
    if (file === "/usr/bin/codesign" || file === "/usr/bin/plutil") {
      this.mutations++
      return ok()
    }
    if (file === "/usr/bin/lipo") return ok("x86_64\n")
    if (args.length === 1 && args[0] === "--metadata") {
      const nativeBuildId = (await readFile(file, "utf8")).slice("native:".length)
      return ok(JSON.stringify({
        nativeBuildId,
        installRoot: this.repositoryRoot,
        session: { verified: true, source: "darwin-audit", uid: process.getuid?.() ?? 501,
          effectiveUid: process.geteuid?.() ?? 501, auditUserId: process.getuid?.() ?? 501, auditSessionId: this.auditSessionId },
      }))
    }
    if (file.endsWith("/current/runtime") && args[0] === "--doctor") {
      this.doctorCalls++
      if (this.doctorUnavailableCount > 0) {
        this.doctorUnavailableCount--
        return fail("credential not ready")
      }
      const releasePath = await readlink(file.slice(0, -"/runtime".length))
      const manifest = JSON.parse(await readFile(join(releasePath, "manifest.json"), "utf8"))
      if (manifest.builds.runtimeBuildId === this.failDoctorForBuild) return fail("doctor failed")
      return ok(JSON.stringify({ isError: false, structuredContent: {
        runtime: { buildId: manifest.builds.runtimeBuildId, draining: false,
          admissionSealed: false, recoveryOperations: 0, recoveryReasons: [] },
        native: { state: "compatible", buildId: manifest.builds.nativeBuildId },
        permissions: {
          accessibility: { granted: true, helperPath: join(this.repositoryRoot, "input/bin/meta-input-helper"), cdhash: manifest.artifacts.nativeHelper.cdhash },
          screenRecording: { granted: true, ownerPath: join(this.repositoryRoot, "input/bin/meta-input-helper"), cdhash: manifest.artifacts.nativeHelper.cdhash },
        },
        capabilities: { capabilities: CAPABILITY_IDS.map(id => ({
          id,
          state: this.unavailableCapabilities.has(id) ? "unavailable" : "ready",
        })) },
      } }))
    }
    if (file === "/bin/launchctl" && args[0] === "bootstrap") {
      this.mutations++
      this.loaded = true
      return ok()
    }
    if (file === "/bin/launchctl" && args[0] === "bootout") {
      this.mutations++
      if (this.failBootout) return fail("bootout denied")
      this.loaded = false
      return ok()
    }
    return fail(`unexpected command ${file} ${args.join(" ")}`)
  }
}

function ok(stdout = ""): CommandResult { return { stdout, stderr: "", exitCode: 0 } }
function fail(stderr: string): CommandResult { return { stdout: "", stderr, exitCode: 1 } }
