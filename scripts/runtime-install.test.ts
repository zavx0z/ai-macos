import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { CAPABILITY_IDS } from "../shared/src/contracts/index.ts"
import { runInstalledLauncher, type InstalledRunner } from "../mcp/src/installed-launcher.ts"
import {
  HELPER_SIGNING_IDENTIFIER,
  RUNTIME_SERVICE_LABEL,
  RUNTIME_SIGNING_IDENTIFIER,
  applyRuntimeInstall,
  planRuntimeInstall,
  readinessProfileFromArguments,
  signingFromArguments,
  type CommandResult,
  type CommandRunner,
  type RuntimeAdmin,
  type RuntimeInstallOptions,
  type RuntimeInspection,
} from "./runtime-install.ts"

const roots: string[] = []
type FakeStartupPermissionState = "not-required" | "checking" | "requesting" | "waiting" | "ready" | "restart-needed" | "timed-out" | "failed"

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async path => {
    await makeRemovable(path)
    await rm(path, { recursive: true, force: true })
  }))
})

async function makeRemovable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink()) return
  if (info.isDirectory()) {
    await chmod(path, 0o700)
    for (const entry of await readdir(path)) await makeRemovable(join(path, entry))
  } else if (info.isFile()) await chmod(path, 0o600)
}

async function makeLegacyV1Release(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  plan: Awaited<ReturnType<typeof planRuntimeInstall>>,
  withoutNativeCdhash = false,
): Promise<string> {
  const releasePath = plan.release.releasePath
  const manifestPath = join(releasePath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const applicationPath = join(releasePath, "computer-use.app")
  const legacyRuntimePath = join(releasePath, "runtime")
  const legacyHelperPath = join(releasePath, "native-helper")
  await chmod(releasePath, 0o700)
  await copyFile(join(applicationPath, "Contents/MacOS/computer-use"), legacyRuntimePath)
  await copyFile(join(applicationPath, "Contents/Helpers/meta-input-helper"), legacyHelperPath)
  await chmod(legacyRuntimePath, 0o555)
  await chmod(legacyHelperPath, 0o555)
  await copyFile(legacyHelperPath, fixture.options.paths.stableHelperPath)
  await chmod(fixture.options.paths.stableHelperPath, 0o755)
  const stableApplication = join(fixture.options.paths.installRoot, "computer-use.app")
  await makeRemovable(stableApplication)
  await rm(stableApplication, { recursive: true })
  await makeRemovable(applicationPath)
  await rm(applicationPath, { recursive: true })

  let legacyPlist = (await readFile(fixture.options.paths.launchAgentPath, "utf8"))
    .replace(join(fixture.options.paths.installRoot, "computer-use.app/Contents/MacOS/computer-use"),
      join(fixture.options.paths.installRoot, "current/runtime"))
    .replace(join(fixture.options.paths.installRoot, "computer-use.app/Contents/Helpers/meta-input-helper"),
      fixture.options.paths.stableHelperPath)
  if (withoutNativeCdhash) {
    legacyPlist = legacyPlist.replace(
      `    <key>META_NATIVE_CDHASH</key>\n    <string>${manifest.artifacts.nativeHelper.cdhash}</string>\n`,
      "",
    )
  }
  manifest.format = "meta-ai-macos-runtime-release-v1"
  manifest.artifacts.runtime.path = "runtime"
  manifest.artifacts.nativeHelper.path = "native-helper"
  delete manifest.artifacts.application
  delete manifest.stableApplication
  delete manifest.entrypoint.path
  delete manifest.signing
  delete manifest.artifacts.runtime.signingIdentifier
  delete manifest.artifacts.runtime.designatedRequirement
  delete manifest.artifacts.runtime.cdhash
  manifest.tcc.subjectPath = fixture.options.paths.stableHelperPath
  if (withoutNativeCdhash) manifest.tcc.requiredPassiveChecks = ["accessibility", "screen-recording"]
  manifest.launchAgent.sha256 = sha256(legacyPlist)
  await chmod(manifestPath, 0o600)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  await chmod(manifestPath, 0o444)
  await chmod(releasePath, 0o555)
  await writeFile(fixture.options.paths.launchAgentPath, legacyPlist)
  fixture.runner.launchProgram = join(fixture.options.paths.installRoot, "current/runtime")
  return legacyPlist
}

test("dry-run строит reviewable plan без login identity и execute публикует immutable release", async () => {
  const fixture = await createFixture()
  fixture.runner.implicitRequirement = true
  const plan = await planRuntimeInstall(fixture.options)
  expect(plan.gates).toMatchObject({ sourceClean: true, exactHostname: true, permissionsRequested: false, liveDesktopProbe: false })
  expect(plan.steps.some(step => step.id === "build-runtime"
    && step.command?.args.at(-1)?.endsWith(".staging/computer-use.app/Contents/MacOS/computer-use"))).toBe(true)
  expect(plan.steps.some(step => step.id === "build-native" && step.command?.args[2] === plan.release.nativeBuildId)).toBe(true)
  expect(plan.legacyRetirement.every(candidate => candidate.disposition === "inspect-only")).toBe(true)
  expect(fixture.runner.mutations).toBe(0)

  const result = await applyRuntimeInstall(plan, fixture.options)
  expect(result).toMatchObject({ state: "installed", rollbackUsed: false, releaseId: plan.release.releaseId })
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(plan.release.releasePath)
  const manifest = JSON.parse(await readFile(join(plan.release.releasePath, "manifest.json"), "utf8"))
  expect(manifest).toMatchObject({
    format: "meta-ai-macos-runtime-release-v2",
    builds: { runtimeBuildId: plan.release.runtimeBuildId, nativeBuildId: plan.release.nativeBuildId },
    signing: { mode: "adhoc" },
    stableApplication: { path: "computer-use.app" },
    artifacts: {
      application: { path: "computer-use.app", signingIdentifier: RUNTIME_SIGNING_IDENTIFIER,
        infoPlist: { path: "computer-use.app/Contents/Info.plist" } },
      runtime: { path: "computer-use.app/Contents/MacOS/computer-use" },
      nativeHelper: { path: "computer-use.app/Contents/Helpers/meta-input-helper",
        signingIdentifier: HELPER_SIGNING_IDENTIFIER,
        designatedRequirement: expect.stringContaining("designated => cdhash") } },
    entrypoint: { source: "scripts/runtime-entry.ts", modes: ["runtime", "doctor", "mcp"],
      mcpTransport: "stdio", path: "computer-use.app/Contents/MacOS/computer-use" },
  })
  expect((await lstat(plan.release.releasePath)).mode & 0o777).toBe(0o555)
  const plist = await readFile(fixture.options.paths.launchAgentPath, "utf8")
  expect(plist).toContain(`<string>${RUNTIME_SERVICE_LABEL}</string>`)
  expect(plist).toContain(`${join(fixture.options.paths.installRoot,
    "computer-use.app", "Contents/MacOS/computer-use")}</string>`)
  expect(plist).toContain("META_NATIVE_HELPER")
  expect(plist).toContain("META_NATIVE_CDHASH")
  expect(plist).toContain(`<string>${manifest.artifacts.nativeHelper.cdhash}</string>`)
  expect(manifest.launchAgent.sha256).toBe(sha256(plist))
  expect(plist).toContain("META_RUNTIME_BROWSER_CONFIG")
  expect(plist).toContain("META_RUNTIME_MANAGED")
  expect(plist).not.toContain("META_LOGIN_SESSION_ID")
  expect(await readFile(join(fixture.options.paths.installRoot,
    "computer-use.app", "Contents/Helpers/meta-input-helper"), "utf8")).toContain(plan.release.nativeBuildId)
  await expect(lstat(fixture.options.paths.stableHelperPath)).rejects.toThrow()
})

test("generated v2 release и stable app запускаются реальным installed launcher contract", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(plan, fixture.options)
  const spawned: Array<{ file: string, args: readonly string[], cwd: string }> = []
  const runner: InstalledRunner = {
    run: (file, args) => fixture.runner.run(file, args),
    spawn(file, args, options) {
      spawned.push({ file, args, cwd: options.cwd })
      return { exited: Promise.resolve(0), kill() {} }
    },
  }

  const result = await runInstalledLauncher({
    expectedHostname: hostname(),
    actualHostname: hostname(),
    homeDirectory: join(fixture.root, "home"),
    uid: process.getuid?.() ?? 501,
    runner,
    testOnlyAllowNonCanonicalSourceRoot: true,
    serveUnavailable: async reason => { throw new Error(`unexpected launcher fallback: ${reason}`) },
  })

  const stableApplication = join(fixture.options.paths.installRoot, "computer-use.app")
  expect(result).toEqual({ state: "launched", releaseId: plan.release.releaseId,
    runtimePath: join(stableApplication, "Contents/MacOS/computer-use"), exitCode: 0 })
  expect(spawned).toEqual([{ file: join(stableApplication, "Contents/MacOS/computer-use"),
    args: ["--mcp"], cwd: stableApplication }])
})

test("explicit identity мигрирует ad-hoc и сохраняет certificate DR между source updates", async () => {
  const fixture = await createFixture()
  const certificateSha1 = "1".repeat(40)
  fixture.runner.availableSigningIdentities.add(certificateSha1)
  const adhocPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(adhocPlan, fixture.options)

  fixture.runner.loaded = true
  const migrationOptions = {
    ...fixture.options,
    signing: { mode: "identity" as const, certificateSha1 },
    runtimeAdmin: successfulAdmin({
      running: true,
      runtimeEpoch: "runtime:adhoc",
      runtimeBuildId: adhocPlan.release.runtimeBuildId,
      nativeBuildId: adhocPlan.release.nativeBuildId,
      activeOperations: 0,
      quarantinedResources: 0,
    }),
  }
  const migrationPlan = await planRuntimeInstall(migrationOptions)
  expect(migrationPlan.release.releaseId).not.toBe(adhocPlan.release.releaseId)
  expect(migrationPlan.release.runtimeBuildId).toBe(adhocPlan.release.runtimeBuildId)
  expect(migrationPlan.release.nativeBuildId).toBe(adhocPlan.release.nativeBuildId)
  const migrated = await applyRuntimeInstall(migrationPlan, migrationOptions)
  const migratedManifest = JSON.parse(await readFile(join(migrationPlan.release.releasePath, "manifest.json"), "utf8"))

  expect(migrated.state).toBe("installed")
  expect(migrationPlan.signing).toEqual({ mode: "identity", certificateSha1, identityAvailable: true })
  expect(migratedManifest.signing).toEqual({ mode: "identity", certificateSha1 })
  expect(migratedManifest.artifacts.application.signingIdentifier).toBe(RUNTIME_SIGNING_IDENTIFIER)
  expect(migratedManifest.artifacts.nativeHelper.signingIdentifier).toBe(HELPER_SIGNING_IDENTIFIER)
  expect(migratedManifest.artifacts.application.designatedRequirement).toContain(certificateSha1)
  expect(migratedManifest.artifacts.nativeHelper.designatedRequirement).toContain(certificateSha1)
  expect(migratedManifest.artifacts.application.designatedRequirement)
    .not.toBe(migratedManifest.artifacts.nativeHelper.designatedRequirement)

  fixture.runner.commit = "b".repeat(40)
  fixture.runner.loaded = true
  const updateOptions = {
    ...migrationOptions,
    runtimeAdmin: successfulAdmin({
      running: true,
      runtimeEpoch: "runtime:identity",
      runtimeBuildId: migrationPlan.release.runtimeBuildId,
      nativeBuildId: migrationPlan.release.nativeBuildId,
      activeOperations: 0,
      quarantinedResources: 0,
    }),
  }
  const updatePlan = await planRuntimeInstall(updateOptions)
  await applyRuntimeInstall(updatePlan, updateOptions)
  const updateManifest = JSON.parse(await readFile(join(updatePlan.release.releasePath, "manifest.json"), "utf8"))

  expect(updateManifest.artifacts.nativeHelper.cdhash)
    .not.toBe(migratedManifest.artifacts.nativeHelper.cdhash)
  expect(updateManifest.artifacts.nativeHelper.designatedRequirement)
    .toBe(migratedManifest.artifacts.nativeHelper.designatedRequirement)
  expect(updateManifest.artifacts.application.designatedRequirement)
    .toBe(migratedManifest.artifacts.application.designatedRequirement)
  expect(fixture.runner.testRequirementCalls).toBeGreaterThanOrEqual(4)
})

test("missing identity блокирует apply без ad-hoc fallback", async () => {
  const fixture = await createFixture()
  const options = {
    ...fixture.options,
    signing: { mode: "identity" as const, certificateSha1: "2".repeat(40) },
  }
  const plan = await planRuntimeInstall(options)

  expect(plan.gates.signingIdentityAvailable).toBe(false)
  expect(fixture.runner.mutations).toBe(0)
  await expect(applyRuntimeInstall(plan, options)).rejects.toThrow("ad-hoc fallback запрещён")
  expect(fixture.runner.mutations).toBe(0)
})

test("certificate signer нельзя молча ротировать или понизить до ad-hoc", async () => {
  const fixture = await createFixture()
  const firstCertificate = "3".repeat(40)
  const otherCertificate = "4".repeat(40)
  fixture.runner.availableSigningIdentities.add(firstCertificate)
  fixture.runner.availableSigningIdentities.add(otherCertificate)
  const signedOptions = {
    ...fixture.options,
    signing: { mode: "identity" as const, certificateSha1: firstCertificate },
  }
  const signedPlan = await planRuntimeInstall(signedOptions)
  await applyRuntimeInstall(signedPlan, signedOptions)
  fixture.runner.loaded = true
  const current = await readlink(join(fixture.options.paths.installRoot, "current"))
  const stableHelperPath = join(fixture.options.paths.installRoot,
    "computer-use.app/Contents/Helpers/meta-input-helper")
  const stableHelper = await readFile(stableHelperPath)

  const rotationOptions = {
    ...fixture.options,
    signing: { mode: "identity" as const, certificateSha1: otherCertificate },
  }
  const rotationPlan = await planRuntimeInstall(rotationOptions)
  await expect(applyRuntimeInstall(rotationPlan, rotationOptions))
    .rejects.toThrow("rotation требует отдельного explicit migration")
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(current)
  expect(await readFile(stableHelperPath)).toEqual(stableHelper)

  const adhocPlan = await planRuntimeInstall(fixture.options)
  await expect(applyRuntimeInstall(adhocPlan, fixture.options))
    .rejects.toThrow("нельзя молча заменить ad-hoc")
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(current)
  expect(await readFile(stableHelperPath)).toEqual(stableHelper)
})

test("identity signing отклоняет weak и wrong embedded DR при успешном external requirement", async () => {
  const certificateSha1 = "5".repeat(40)
  const cases = [
    [RUNTIME_SIGNING_IDENTIFIER, `designated => identifier "${RUNTIME_SIGNING_IDENTIFIER}"`],
    [HELPER_SIGNING_IDENTIFIER,
      `designated => certificate leaf = H"${"9".repeat(40)}" and identifier "${HELPER_SIGNING_IDENTIFIER}"`],
  ] as const
  for (const [identifier, designatedRequirement] of cases) {
    const fixture = await createFixture()
    fixture.runner.availableSigningIdentities.add(certificateSha1)
    fixture.runner.embeddedRequirementOverrides.set(identifier, designatedRequirement)
    const options = {
      ...fixture.options,
      signing: { mode: "identity" as const, certificateSha1 },
    }
    const plan = await planRuntimeInstall(options)

    await expect(applyRuntimeInstall(plan, options))
      .rejects.toThrow("Embedded designated requirement")
    expect(fixture.runner.testRequirementCalls).toBeGreaterThanOrEqual(1)
  }
})

test("embedded DR normalization принимает uppercase hash и обратный порядок conjuncts", async () => {
  const fixture = await createFixture()
  const certificateSha1 = "a".repeat(40)
  fixture.runner.availableSigningIdentities.add(certificateSha1)
  fixture.runner.embeddedRequirementOverrides.set(RUNTIME_SIGNING_IDENTIFIER,
    `designated => identifier = "${RUNTIME_SIGNING_IDENTIFIER}" and certificate 0 = H"${certificateSha1.toUpperCase()}"`)
  const options = {
    ...fixture.options,
    signing: { mode: "identity" as const, certificateSha1 },
  }
  const plan = await planRuntimeInstall(options)

  const result = await applyRuntimeInstall(plan, options)

  expect(result.state).toBe("installed")
})

test("CLI принимает только exact signing identity и absolute keychain path", () => {
  const certificateSha1 = "A".repeat(40)
  expect(signingFromArguments(["bun"])).toEqual({ mode: "adhoc" })
  expect(signingFromArguments(["bun", "--signing-identity-sha1", certificateSha1,
    "--signing-keychain", "/Users/tester/Library/Keychains/login.keychain-db"])).toEqual({
    mode: "identity",
    certificateSha1: certificateSha1.toLowerCase(),
    keychainPath: "/Users/tester/Library/Keychains/login.keychain-db",
  })
  expect(() => signingFromArguments(["bun", "--signing-identity-sha1", "Meta AI macOS Local Code Signing"]))
    .toThrow("exact certificate SHA-1")
  expect(() => signingFromArguments(["bun", "--signing-keychain", "/tmp/login.keychain-db"]))
    .toThrow("требует --signing-identity-sha1")
  expect(() => signingFromArguments(["bun", "--signing-identity-sha1", certificateSha1,
    "--signing-keychain", "relative.keychain-db"])).toThrow("абсолютным")
})

test("immutable release отклоняет plist cdhash, не совпадающий с signed helper", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(plan, fixture.options)
  const manifestPath = join(plan.release.releasePath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const installedPlist = await readFile(fixture.options.paths.launchAgentPath, "utf8")
  const tamperedCdhash = "d".repeat(40)
  const tamperedPlist = installedPlist.replace(manifest.artifacts.nativeHelper.cdhash, tamperedCdhash)
  manifest.artifacts.nativeHelper.cdhash = tamperedCdhash
  manifest.tcc.candidateCdhash = tamperedCdhash
  manifest.launchAgent.sha256 = sha256(tamperedPlist)
  await chmod(plan.release.releasePath, 0o700)
  const writableDirectories = [join(plan.release.releasePath, "computer-use.app"),
    join(plan.release.releasePath, "computer-use.app/Contents"),
    join(plan.release.releasePath, "computer-use.app/Contents/Helpers")]
  for (const directory of writableDirectories) await chmod(directory, 0o700)
  await chmod(manifestPath, 0o600)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  await chmod(manifestPath, 0o444)
  for (const directory of writableDirectories.reverse()) await chmod(directory, 0o555)
  await chmod(plan.release.releasePath, 0o555)
  const repeated = await planRuntimeInstall(fixture.options)

  await expect(applyRuntimeInstall(repeated, fixture.options))
    .rejects.toThrow("codesign identity не совпадает с manifest")
})

test("manifest runtime artifact принимает только exact computer-use или legacy runtime", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(plan, fixture.options)
  const manifestPath = join(plan.release.releasePath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.artifacts.runtime.path = "bin/computer-use"
  await chmod(plan.release.releasePath, 0o700)
  await chmod(manifestPath, 0o600)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  await chmod(manifestPath, 0o444)
  await chmod(plan.release.releasePath, 0o555)

  const repeated = await planRuntimeInstall(fixture.options)
  await expect(applyRuntimeInstall(repeated, fixture.options)).rejects.toThrow("strict format")
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
  const stableHelperPath = join(fixture.options.paths.installRoot,
    "computer-use.app/Contents/Helpers/meta-input-helper")
  const firstHelper = await readFile(stableHelperPath)
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
  expect(await readFile(stableHelperPath)).toEqual(firstHelper)
  expect(await readFile(options.paths.launchAgentPath)).toEqual(firstPlist)
})

test("loaded LaunchAgent со старым runtime program мигрирует на computer-use", async () => {
  const fixture = await createFixture()
  const firstPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(firstPlan, fixture.options)
  await makeLegacyV1Release(fixture, firstPlan)
  const legacyHelper = await readFile(fixture.options.paths.stableHelperPath)
  fixture.runner.loaded = true

  fixture.runner.commit = "8".repeat(40)
  const running: RuntimeInspection = {
    running: true,
    runtimeEpoch: "runtime:legacy-program",
    runtimeBuildId: firstPlan.release.runtimeBuildId,
    nativeBuildId: firstPlan.release.nativeBuildId,
    activeOperations: 0,
    quarantinedResources: 0,
  }
  const options = { ...fixture.options, runtimeAdmin: successfulAdmin(running) }
  const update = await planRuntimeInstall(options)
  const result = await applyRuntimeInstall(update, options)

  expect(result.state).toBe("installed")
  expect(fixture.runner.launchProgram).toBe(join(fixture.options.paths.installRoot,
    "computer-use.app/Contents/MacOS/computer-use"))
  expect(JSON.parse(await readFile(join(update.release.releasePath, "manifest.json"), "utf8"))
    .artifacts.runtime.path).toBe("computer-use.app/Contents/MacOS/computer-use")
  expect(await readFile(fixture.options.paths.stableHelperPath)).toEqual(legacyHelper)
})

test("rollback принимает старый manifest и plist без META_NATIVE_CDHASH", async () => {
  const fixture = await createFixture()
  const firstPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(firstPlan, fixture.options)
  const legacyPlist = await makeLegacyV1Release(fixture, firstPlan, true)

  fixture.runner.commit = "9".repeat(40)
  fixture.runner.loaded = true
  const inspection: RuntimeInspection = {
    running: true,
    runtimeEpoch: "runtime:legacy-rollback",
    runtimeBuildId: firstPlan.release.runtimeBuildId,
    nativeBuildId: firstPlan.release.nativeBuildId,
    activeOperations: 0,
    quarantinedResources: 0,
  }
  const options = { ...fixture.options, runtimeAdmin: successfulAdmin(inspection) }
  const update = await planRuntimeInstall(options)
  fixture.runner.failDoctorForBuild = update.release.runtimeBuildId

  await expect(applyRuntimeInstall(update, options)).rejects.toThrow("doctor")
  expect(await readFile(options.paths.launchAgentPath, "utf8")).toBe(legacyPlist)
  expect(await readlink(join(options.paths.installRoot, "current"))).toBe(firstPlan.release.releasePath)
})

test("installer пассивно ждёт startup permissions и после ready проверяет observer/view", async () => {
  const fixture = await createFixture()
  const options = {
    ...fixture.options,
    requiredCapabilities: ["input.pointer"] as const,
    permissionWaitMs: 500,
  }
  const plan = await planRuntimeInstall(options)
  fixture.runner.startupPermissionStatesByBuild.set(plan.release.runtimeBuildId,
    ["checking", "requesting", "waiting", "ready"])
  fixture.runner.observerUnavailableCountsByBuild.set(plan.release.runtimeBuildId, 1)

  const result = await applyRuntimeInstall(plan, options)

  expect(result.state).toBe("installed")
  expect(fixture.runner.doctorCalls).toBe(5)
  expect(fixture.runner.permissionUiRequests).toBe(0)
})

test("post-grant observer preparation может временно держать чистую admission закрытой", async () => {
  const fixture = await createFixture()
  const options = { ...fixture.options, requiredCapabilities: ["input.pointer"] as const }
  const plan = await planRuntimeInstall(options)
  fixture.runner.startupPermissionStatesByBuild.set(plan.release.runtimeBuildId, ["ready"])
  fixture.runner.observerUnavailableCountsByBuild.set(plan.release.runtimeBuildId, 1)
  fixture.runner.sealAdmissionWhileObserverPreparingBuilds.add(plan.release.runtimeBuildId)

  const result = await applyRuntimeInstall(plan, options)

  expect(result.state).toBe("installed")
  expect(fixture.runner.doctorCalls).toBe(2)
})

test("foundation без observer capabilities не требует observer/view readiness", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  fixture.runner.observerUnavailableCountsByBuild.set(plan.release.runtimeBuildId, 100)

  const result = await applyRuntimeInstall(plan, fixture.options)

  expect(result.state).toBe("installed")
  expect(fixture.runner.doctorCalls).toBe(1)
})

test("permission deadline не обновляется после ready-to-waiting flap", async () => {
  const fixture = await createFixture()
  const options = {
    ...fixture.options,
    requiredCapabilities: ["input.pointer"] as const,
    permissionWaitMs: 160,
  }
  const plan = await planRuntimeInstall(options)
  fixture.runner.startupPermissionStatesByBuild.set(plan.release.runtimeBuildId, ["waiting", "ready", "waiting"])
  fixture.runner.observerUnavailableCountsByBuild.set(plan.release.runtimeBuildId, 100)
  fixture.runner.sealAdmissionWhileObserverPreparingBuilds.add(plan.release.runtimeBuildId)

  await expect(applyRuntimeInstall(plan, options)).rejects.toThrow("startup permission wait deadline exceeded")
  expect(fixture.runner.doctorCalls).toBeLessThanOrEqual(4)
})

test("исчерпанный startup permission budget откатывает предыдущий release", async () => {
  const fixture = await createFixture()
  const firstPlan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(firstPlan, fixture.options)
  const stableHelperPath = join(fixture.options.paths.installRoot,
    "computer-use.app/Contents/Helpers/meta-input-helper")
  const firstHelper = await readFile(stableHelperPath)

  fixture.runner.commit = "f".repeat(40)
  fixture.runner.loaded = true
  const inspection: RuntimeInspection = {
    running: true,
    runtimeEpoch: "runtime:permission-timeout",
    runtimeBuildId: firstPlan.release.runtimeBuildId,
    nativeBuildId: firstPlan.release.nativeBuildId,
    activeOperations: 0,
    quarantinedResources: 0,
  }
  const options = { ...fixture.options, runtimeAdmin: successfulAdmin(inspection), permissionWaitMs: 120 }
  const update = await planRuntimeInstall(options)
  fixture.runner.startupPermissionStatesByBuild.set(update.release.runtimeBuildId, ["waiting"])

  await expect(applyRuntimeInstall(update, options)).rejects.toThrow("startup permission wait deadline exceeded")
  expect(await readlink(join(options.paths.installRoot, "current"))).toBe(firstPlan.release.releasePath)
  expect(await readFile(stableHelperPath)).toEqual(firstHelper)
  expect(fixture.runner.permissionUiRequests).toBe(0)
})

test("pending permissions с чужим owner identity завершаются сразу без ожидания", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  fixture.runner.startupPermissionStatesByBuild.set(plan.release.runtimeBuildId, ["waiting"])
  fixture.runner.wrongPermissionIdentityForBuild.add(plan.release.runtimeBuildId)

  await expect(applyRuntimeInstall(plan, { ...fixture.options, permissionWaitMs: 500 }))
    .rejects.toThrow("другой permission owner path/cdhash")
  expect(fixture.runner.doctorCalls).toBe(1)
  expect(fixture.runner.permissionUiRequests).toBe(0)
})

test("уже готовые startup permissions проходят doctor без human wait", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  fixture.runner.startupPermissionStatesByBuild.set(plan.release.runtimeBuildId, ["ready"])

  const result = await applyRuntimeInstall(plan, { ...fixture.options, permissionWaitMs: 0 })

  expect(result.state).toBe("installed")
  expect(fixture.runner.doctorCalls).toBe(1)
  expect(fixture.runner.permissionUiRequests).toBe(0)
})

test("denied grants без explicit pending startup state отклоняются сразу", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  fixture.runner.legacyDeniedBuilds.add(plan.release.runtimeBuildId)

  await expect(applyRuntimeInstall(plan, { ...fixture.options, permissionWaitMs: 500 }))
    .rejects.toThrow("не подтвердил passive TCC grants")
  expect(fixture.runner.doctorCalls).toBe(1)
  expect(fixture.runner.permissionUiRequests).toBe(0)
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
    format: "meta-runtime-pending-update-v2",
    previousCurrentRelease: null,
    helperPresent: false,
    plistPresent: false,
    stableApplicationPresent: false,
  })
  const partialApplication = join(fixture.options.paths.installRoot, "computer-use.app")
  await mkdir(partialApplication)
  await writeFile(join(partialApplication, "partial"), "partial-new-application")
  await symlink(plan.release.releasePath, join(fixture.options.paths.installRoot, "current"))
  await writeFile(fixture.options.paths.launchAgentPath, "partial plist")
  const recovered = await applyRuntimeInstall(plan, fixture.options)
  expect(recovered.state).toBe("installed")
  await expect(lstat(join(fixture.options.paths.installRoot, "pending-update"))).rejects.toThrow()
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(plan.release.releasePath)
  expect(await readFile(join(partialApplication, "Contents/Info.plist"), "utf8")).toContain("CFBundleIdentifier")
})

test("whole-app promotion failpoints возвращают previous signed bundle", async () => {
  const stages = ["after-stable-old-writable", "after-stable-old-moved", "after-stable-next-writable",
    "after-stable-next-moved", "after-stable-mode-sealed"] as const
  const commits = ["6", "7", "8", "9", "b"] as const
  for (const [index, failStage] of stages.entries()) {
    const fixture = await createFixture()
    const firstPlan = await planRuntimeInstall(fixture.options)
    await applyRuntimeInstall(firstPlan, fixture.options)
    const stableHelperPath = join(fixture.options.paths.installRoot,
      "computer-use.app/Contents/Helpers/meta-input-helper")
    const previousHelper = await readFile(stableHelperPath)
    fixture.runner.commit = commits[index]!.repeat(40)
    fixture.runner.loaded = true
    const inspection: RuntimeInspection = {
      running: true,
      runtimeEpoch: `runtime:promotion:${index}`,
      runtimeBuildId: firstPlan.release.runtimeBuildId,
      nativeBuildId: firstPlan.release.nativeBuildId,
      activeOperations: 0,
      quarantinedResources: 0,
    }
    const options = {
      ...fixture.options,
      runtimeAdmin: successfulAdmin(inspection),
      failpoint(stage: Parameters<NonNullable<RuntimeInstallOptions["failpoint"]>>[0]) {
        if (stage === failStage) throw new Error(`promotion crash: ${stage}`)
      },
    }
    const update = await planRuntimeInstall(options)

    await expect(applyRuntimeInstall(update, options)).rejects.toThrow(`promotion crash: ${failStage}`)
    expect(await readlink(join(options.paths.installRoot, "current"))).toBe(firstPlan.release.releasePath)
    expect(await readFile(stableHelperPath)).toEqual(previousHelper)
    await expect(lstat(join(options.paths.installRoot, "pending-update"))).rejects.toThrow()
  }
})

test("whole-app restore failpoints продолжаются идемпотентно из durable journal", async () => {
  const stages = ["after-stable-restore-current-writable", "after-stable-restore-current-moved",
    "after-stable-restore-backup-writable", "after-stable-restore-backup-moved",
    "after-stable-restore-mode-sealed"] as const
  for (const [index, failStage] of stages.entries()) {
    const fixture = await createFixture()
    const firstPlan = await planRuntimeInstall(fixture.options)
    await applyRuntimeInstall(firstPlan, fixture.options)
    const stableHelperPath = join(fixture.options.paths.installRoot,
      "computer-use.app/Contents/Helpers/meta-input-helper")
    const previousHelper = await readFile(stableHelperPath)
    fixture.runner.commit = String(index + 4).repeat(40)
    fixture.runner.loaded = true
    const inspection: RuntimeInspection = {
      running: true,
      runtimeEpoch: `runtime:restore:${index}`,
      runtimeBuildId: firstPlan.release.runtimeBuildId,
      nativeBuildId: firstPlan.release.nativeBuildId,
      activeOperations: 0,
      quarantinedResources: 0,
    }
    const baseOptions = { ...fixture.options, runtimeAdmin: successfulAdmin(inspection) }
    const update = await planRuntimeInstall(baseOptions)
    fixture.runner.failDoctorForBuild = update.release.runtimeBuildId
    const crashingOptions = {
      ...baseOptions,
      failpoint(stage: Parameters<NonNullable<RuntimeInstallOptions["failpoint"]>>[0]) {
        if (stage === failStage) throw new Error(`restore crash: ${stage}`)
      },
    }

    await expect(applyRuntimeInstall(update, crashingOptions)).rejects.toThrow("rollback incomplete")
    expect(await lstat(join(baseOptions.paths.installRoot, "pending-update", "record.json"))).toBeTruthy()
    fixture.runner.failDoctorForBuild = undefined
    await expect(applyRuntimeInstall(update, {
      ...baseOptions,
      failpoint(stage) {
        if (stage === "after-rollback-prepared") throw new Error("stop after recovered state")
      },
    })).rejects.toThrow("stop after recovered state")
    expect(await readlink(join(baseOptions.paths.installRoot, "current"))).toBe(firstPlan.release.releasePath)
    expect(await readFile(stableHelperPath)).toEqual(previousHelper)
  }
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
  const stableHelperPath = join(fixture.options.paths.installRoot,
    "computer-use.app/Contents/Helpers/meta-input-helper")
  const helper = await readFile(stableHelperPath)
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
  expect(await readFile(stableHelperPath)).toEqual(helper)
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
  const writableDirectories = [join(plan.release.releasePath, "computer-use.app"),
    join(plan.release.releasePath, "computer-use.app/Contents"),
    join(plan.release.releasePath, "computer-use.app/Contents/Helpers")]
  for (const directory of writableDirectories) await chmod(directory, 0o700)
  const helperPath = join(plan.release.releasePath,
    "computer-use.app/Contents/Helpers/meta-input-helper")
  const moved = join(plan.release.releasePath,
    "computer-use.app/Contents/Helpers/meta-input-helper.real")
  await Bun.write(moved, await readFile(helperPath))
  await chmod(moved, 0o555)
  await rm(helperPath)
  await symlink(moved, helperPath)
  for (const directory of writableDirectories.reverse()) await chmod(directory, 0o555)
  await chmod(plan.release.releasePath, 0o555)
  const repeated = await planRuntimeInstall({ ...fixture.options, runtimeAdmin: successfulAdmin({
    running: true, runtimeEpoch: "runtime:existing", runtimeBuildId: plan.release.runtimeBuildId,
    nativeBuildId: plan.release.nativeBuildId, activeOperations: 0, quarantinedResources: 0,
  }) })
  await expect(applyRuntimeInstall(repeated, fixture.options)).rejects.toThrow("foreign/symlink")
})

test("installer не перезаписывает stable app с unexpected leaf без exact rollback source", async () => {
  const fixture = await createFixture()
  const plan = await planRuntimeInstall(fixture.options)
  await applyRuntimeInstall(plan, fixture.options)
  const stableContents = join(fixture.options.paths.installRoot, "computer-use.app/Contents")
  await chmod(stableContents, 0o700)
  await writeFile(join(stableContents, "unexpected"), "foreign")
  await chmod(join(stableContents, "unexpected"), 0o444)
  await chmod(stableContents, 0o555)
  fixture.runner.loaded = true
  const repeatedOptions = {
    ...fixture.options,
    runtimeAdmin: successfulAdmin({
      running: true,
      runtimeEpoch: "runtime:stable-tamper",
      runtimeBuildId: plan.release.runtimeBuildId,
      nativeBuildId: plan.release.nativeBuildId,
      activeOperations: 0,
      quarantinedResources: 0,
    }),
  }
  const repeated = await planRuntimeInstall(repeatedOptions)

  await expect(applyRuntimeInstall(repeated, repeatedOptions)).rejects.toThrow("topology")
  expect(await readlink(join(fixture.options.paths.installRoot, "current"))).toBe(plan.release.releasePath)
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
  runner.launchProgram = join(options.paths.installRoot, "current", "computer-use")
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
  implicitRequirement = false
  failBootout = false
  appearAtPrint: number | undefined
  printCalls = 0
  doctorUnavailableCount = 0
  doctorCalls = 0
  permissionUiRequests = 0
  testRequirementCalls = 0
  auditSessionId = 1
  readonly unavailableCapabilities = new Set<string>()
  readonly startupPermissionStatesByBuild = new Map<string, FakeStartupPermissionState[]>()
  readonly startupPermissionIndexesByBuild = new Map<string, number>()
  readonly observerUnavailableCountsByBuild = new Map<string, number>()
  readonly sealAdmissionWhileObserverPreparingBuilds = new Set<string>()
  readonly wrongPermissionIdentityForBuild = new Set<string>()
  readonly legacyDeniedBuilds = new Set<string>()
  readonly availableSigningIdentities = new Set<string>()
  readonly embeddedRequirementOverrides = new Map<string, string>()
  readonly signaturesByContent = new Map<string, {
    identifier: string
    cdhash: string
    designatedRequirement: string
    adhoc: boolean
    certificateSha1?: string
  }>()
  launchProgram = ""
  launchPlist = ""

  constructor(readonly repositoryRoot: string) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    if (args.includes("--request-permissions")) {
      this.permissionUiRequests++
      return fail("installer не должен запрашивать permission UI")
    }
    if (file === "git" && args[0] === "rev-parse") return ok(`${this.commit}\n`)
    if (file === "git" && args[0] === "status") return ok("")
    if (file === "/usr/bin/security" && args[0] === "find-identity") {
      return ok([...this.availableSigningIdentities]
        .map((identity, index) => `  ${index + 1}) ${identity.toUpperCase()} "Meta AI macOS Local Code Signing"`)
        .join("\n"))
    }
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
    if (file === "/usr/bin/codesign" && args.includes("--sign")) {
      this.mutations++
      const target = args.at(-1)!
      const identity = args[args.indexOf("--sign") + 1]!
      const identifier = args[args.indexOf("--identifier") + 1]!
      if ((await lstat(target)).isDirectory()) {
        const signatureDirectory = join(target, "Contents/_CodeSignature")
        await mkdir(signatureDirectory, { recursive: true })
        await writeFile(join(signatureDirectory, "CodeResources"),
          `sealed:${identity}:${identifier}:${await signatureContentKey(join(target, "Contents"))}`)
      } else {
        const unsigned = (await readFile(target, "utf8")).split("\ncode-signature:")[0]!
        await writeFile(target, `${unsigned}\ncode-signature:${identity}:${identifier}`)
      }
      const content = await signatureContentKey(target)
      const cdhash = createHash("sha1").update(content).digest("hex")
      const certificateSha1 = identity === "-" ? undefined : identity.toLowerCase()
      this.signaturesByContent.set(content, {
        identifier,
        cdhash,
        designatedRequirement: this.embeddedRequirementOverrides.get(identifier) ?? (certificateSha1 === undefined
          ? `designated => cdhash H"${cdhash}"`
          : `designated => certificate leaf = H"${certificateSha1}" and identifier "${identifier}"`),
        adhoc: certificateSha1 === undefined,
        ...(certificateSha1 === undefined ? {} : { certificateSha1 }),
      })
      return ok()
    }
    if (file === "/usr/bin/codesign" && args.includes("--display")) {
      const target = args.at(-1)!
      const recorded = this.signaturesByContent.get(await signatureContentKey(target))
      const identifier = this.foreignStableHelper && target.endsWith("input/bin/meta-input-helper")
        ? "foreign.helper"
        : recorded?.identifier ?? HELPER_SIGNING_IDENTIFIER
      const cdhash = recorded?.cdhash ?? "c".repeat(40)
      const requirement = this.implicitRequirement && recorded?.adhoc !== false
        ? `# designated => cdhash H"${cdhash}"`
        : recorded?.designatedRequirement ?? `designated => identifier "${identifier}" and anchor apple generic`
      const signature = recorded?.adhoc === false ? "Authority=Meta AI macOS Local Code Signing" : "Signature=adhoc"
      return { stdout: "", stderr: `Identifier=${identifier}\nCDHash=${cdhash}\n${requirement}\n${signature}\n`, exitCode: 0 }
    }
    if (file === "/usr/bin/codesign" && args.includes("--test-requirement")) {
      this.testRequirementCalls++
      const target = args.at(-1)!
      const recorded = this.signaturesByContent.get(await signatureContentKey(target))
      const requirement = args[args.indexOf("--test-requirement") + 1]!
      return recorded?.adhoc === false
        && requirement.includes(recorded.certificateSha1!)
        && requirement.includes(`identifier "${recorded.identifier}"`)
        ? ok()
        : fail("explicit requirement failed")
    }
    if (file === "/usr/bin/codesign" || file === "/usr/bin/plutil") {
      this.mutations++
      return ok()
    }
    if (file === "/usr/bin/lipo") return ok("x86_64\n")
    if (args.length === 1 && args[0] === "--metadata") {
      const nativeBuildId = (await readFile(file, "utf8")).split("\ncode-signature:")[0]!.slice("native:".length)
      return ok(JSON.stringify({
        nativeBuildId,
        installRoot: this.repositoryRoot,
        session: { verified: true, source: "darwin-audit", uid: process.getuid?.() ?? 501,
          effectiveUid: process.geteuid?.() ?? 501, auditUserId: process.getuid?.() ?? 501, auditSessionId: this.auditSessionId },
      }))
    }
    if ((file.endsWith("/current/computer-use") || file.endsWith("/current/runtime")
      || file.endsWith("/computer-use.app/Contents/MacOS/computer-use")) && args[0] === "--doctor") {
      this.doctorCalls++
      if (this.doctorUnavailableCount > 0) {
        this.doctorUnavailableCount--
        return fail("credential not ready")
      }
      const stableSuffix = "/computer-use.app/Contents/MacOS/computer-use"
      const stableBundle = file.endsWith(stableSuffix) && !file.includes("/current/")
      const artifactName = file.endsWith("/computer-use") ? "computer-use" : "runtime"
      const releasePath = stableBundle
        ? await readlink(join(file.slice(0, -stableSuffix.length), "current"))
        : await readlink(file.slice(0, -`/${artifactName}`.length))
      const manifest = JSON.parse(await readFile(join(releasePath, "manifest.json"), "utf8"))
      if (manifest.builds.runtimeBuildId === this.failDoctorForBuild) return fail("doctor failed")
      const runtimeBuildId = manifest.builds.runtimeBuildId as string
      const permissionStates = this.startupPermissionStatesByBuild.get(runtimeBuildId)
      const permissionIndex = this.startupPermissionIndexesByBuild.get(runtimeBuildId) ?? 0
      const permissionState = permissionStates?.[Math.min(permissionIndex, permissionStates.length - 1)] ?? "ready"
      if (permissionStates !== undefined) this.startupPermissionIndexesByBuild.set(runtimeBuildId, permissionIndex + 1)
      const pendingPermissions = ["checking", "requesting", "waiting", "restart-needed"].includes(permissionState)
      const observerUnavailableCount = this.observerUnavailableCountsByBuild.get(runtimeBuildId) ?? 0
      const observerReady = !pendingPermissions && observerUnavailableCount === 0
      if (!pendingPermissions && observerUnavailableCount > 0) {
        this.observerUnavailableCountsByBuild.set(runtimeBuildId, observerUnavailableCount - 1)
      }
      const permissionsGranted = !pendingPermissions && !this.legacyDeniedBuilds.has(runtimeBuildId)
        && permissionState !== "failed" && permissionState !== "timed-out"
      const permissionOwnerPath = this.wrongPermissionIdentityForBuild.has(runtimeBuildId)
        ? join(this.repositoryRoot, "input/bin/foreign-helper")
        : manifest.tcc.subjectPath
      const startup = this.legacyDeniedBuilds.has(runtimeBuildId) ? {} : { startup: { permissions: {
        state: permissionState,
        required: ["accessibility", "screenRecording", "postEvents", "inputMonitoring"],
        missing: permissionsGranted ? [] : ["accessibility", "screenRecording", "postEvents", "inputMonitoring"],
        requestIssued: !["not-required", "checking"].includes(permissionState),
      } } }
      const admissionSealed = pendingPermissions
        || (!observerReady && this.sealAdmissionWhileObserverPreparingBuilds.has(runtimeBuildId))
      return ok(JSON.stringify({ isError: false, structuredContent: {
        runtime: { buildId: manifest.builds.runtimeBuildId, draining: false,
          admissionSealed, recoveryOperations: 0,
          recoveryReasons: pendingPermissions ? ["Startup permissions pending"] : [] },
        observer: { state: observerReady ? "ready" : "preparing", reason: "fixture", viewReady: observerReady },
        native: { state: "compatible", buildId: manifest.builds.nativeBuildId },
        permissions: {
          accessibility: { granted: permissionsGranted, helperPath: permissionOwnerPath, cdhash: manifest.artifacts.nativeHelper.cdhash },
          screenRecording: { granted: permissionsGranted, ownerPath: permissionOwnerPath, cdhash: manifest.artifacts.nativeHelper.cdhash },
          postEvents: { granted: permissionsGranted, helperPath: permissionOwnerPath, cdhash: manifest.artifacts.nativeHelper.cdhash },
          inputMonitoring: { granted: permissionsGranted, helperPath: permissionOwnerPath, cdhash: manifest.artifacts.nativeHelper.cdhash },
        },
        ...startup,
        capabilities: { capabilities: CAPABILITY_IDS.map(id => ({
          id,
          state: this.unavailableCapabilities.has(id) ? "unavailable" : "ready",
        })) },
        activeOperations: 0,
        quarantinedResources: 0,
      } }))
    }
    if (file === "/bin/launchctl" && args[0] === "bootstrap") {
      this.mutations++
      this.loaded = true
      const plist = await readFile(args[2]!, "utf8")
      this.launchProgram = plist.match(/<array><string>([^<]+)<\/string><\/array>/)?.[1] ?? this.launchProgram
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
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex") }

async function signatureContentKey(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isFile()) return sha256(await readFile(path))
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsupported signature fixture path ${path}`)
  const values: string[] = []
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory)).sort()) {
      const child = join(directory, entry)
      const relativePath = prefix === "" ? entry : join(prefix, entry)
      const childInfo = await lstat(child)
      if (childInfo.isDirectory()) await visit(child, relativePath)
      else if (childInfo.isFile()) values.push(`${relativePath}:${sha256(await readFile(child))}`)
      else throw new Error(`unsupported signature fixture node ${child}`)
    }
  }
  await visit(path, "")
  return sha256(values.join("\n"))
}
