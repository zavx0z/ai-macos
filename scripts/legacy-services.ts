import { createHash, randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

export const CANONICAL_AI_MACOS_ROOT = "/Users/zavx0z/repozitarium/ai-macos"

export type LegacyPackage = "window" | "screen" | "chrome" | "android" | "input"

export type LegacyServiceSpec = {
  package: LegacyPackage
  port: 7878 | 7879 | 7880 | 7881 | 7882
  entrypoint: string
}

export type PathIdentity = {
  path: string
  realPath: string
  kind: "file" | "directory"
  symbolicLink: boolean
  uid: number
  device: number
  inode: number
}

export type LegacyProcessSnapshot = {
  pid: number
  parentPid: number
  startTimeMicros: number
  uid: number
  executable: string
  cwd: string
  argv: string[]
  listenerPorts: number[]
  state: "running" | "stopped"
  heldInputState?: "none" | "held" | "unknown"
}

export type ExactSignal = "SIGSTOP" | "SIGCONT" | "SIGTERM"

export interface LegacyServiceBackend {
  readonly signalSafety: "atomic-incarnation" | "checked-pid"
  readonly limitations: readonly string[]
  nowMillis(): number
  waitMillis(millis: number): Promise<void>
  pathIdentity(path: string): Promise<PathIdentity | undefined>
  listeners(port: number): Promise<LegacyProcessSnapshot[]>
  process(pid: number): Promise<LegacyProcessSnapshot | undefined>
  descendants(pid: number): Promise<LegacyProcessSnapshot[]>
  signalProcess(
    expected: LegacyProcessSnapshot,
    signal: ExactSignal,
  ): Promise<"sent" | "stale" | "failed">
}

export type LegacyRetirementPlanTarget = {
  spec: LegacyServiceSpec
  process: LegacyProcessSnapshot
  entrypointIdentity: PathIdentity
  helpers: LegacyProcessSnapshot[]
}

export type LegacyRetirementPlan = {
  kind: "meta-legacy-retirement-plan-v1"
  planId: string
  createdAt: string
  canonicalRoot: PathIdentity
  expectedBunExecutable: PathIdentity
  state: "ready" | "blocked"
  targets: LegacyRetirementPlanTarget[]
  absent: LegacyServiceSpec[]
  reasons: string[]
  signalSafety: "not-used" | LegacyServiceBackend["signalSafety"]
  limitations: string[]
  digest: string
}

export type LegacyRetirementResult = {
  state: "retired" | "blocked" | "stale" | "partial" | "unsupported"
  retired: LegacyServiceSpec[]
  remaining: LegacyServiceSpec[]
  resumed: LegacyServiceSpec[]
  reasons: string[]
  signalSafety: "not-used" | LegacyServiceBackend["signalSafety"]
  limitations: string[]
}

export type LegacyRetirementOptions = {
  repositoryRoot: string
  expectedBunExecutable: string
  uid: number
  helperWaitMs?: number
  exitWaitMs?: number
  pollMs?: number
  testOnlyAllowNonCanonicalRoot?: boolean
  now?: () => Date
}

type BoundPlan = {
  digest: string
  plan: LegacyRetirementPlan
}

export class LegacyServiceRetirementCoordinator {
  readonly #backend: LegacyServiceBackend
  readonly #options: Required<Pick<LegacyRetirementOptions,
    "helperWaitMs" | "exitWaitMs" | "pollMs">> & LegacyRetirementOptions
  readonly #plans = new Map<string, BoundPlan>()

  constructor(backend: LegacyServiceBackend, options: LegacyRetirementOptions) {
    this.#backend = backend
    this.#options = {
      ...options,
      helperWaitMs: boundedDuration(options.helperWaitMs ?? 2_000),
      exitWaitMs: boundedDuration(options.exitWaitMs ?? 5_000),
      pollMs: boundedPoll(options.pollMs ?? 20),
    }
  }

  async plan(): Promise<LegacyRetirementPlan> {
    if (this.#plans.size >= 16) {
      throw new Error("Слишком много неиспользованных legacy retirement plans")
    }
    const root = await this.#verifyRoot()
    const bun = await this.#verifyBun()
    const targets: LegacyRetirementPlanTarget[] = []
    const absent: LegacyServiceSpec[] = []
    const reasons: string[] = []
    for (const spec of legacySpecs(root.realPath)) {
      const listeners = await this.#backend.listeners(spec.port)
      if (listeners.length === 0) {
        absent.push(spec)
        continue
      }
      if (listeners.length !== 1) {
        reasons.push(`${spec.package}:${spec.port} имеет неоднозначный listener inventory`)
        continue
      }
      const process = listeners[0]!
      const processReason = await this.#processMismatch(process, spec, root, bun)
      if (processReason !== undefined) {
        reasons.push(`${spec.package}:${spec.port} ${processReason}`)
        continue
      }
      const entrypointIdentity = await this.#backend.pathIdentity(spec.entrypoint)
      if (entrypointIdentity === undefined) {
        reasons.push(`${spec.package}:${spec.port} canonical entrypoint исчез`)
        continue
      }
      const descendants = await this.#backend.descendants(process.pid)
      const helperCheck = await this.#classifyDescendants(descendants, root)
      if (helperCheck.reason !== undefined) {
        reasons.push(`${spec.package}:${spec.port} ${helperCheck.reason}`)
        continue
      }
      targets.push({
        spec,
        process: cloneProcess(process),
        entrypointIdentity,
        helpers: helperCheck.helpers,
      })
    }
    const signalSafety = targets.length === 0 ? "not-used" as const
      : this.#backend.signalSafety
    const limitations = [...this.#backend.limitations, ...(signalSafety === "checked-pid" ? [
      "macOS не предоставляет atomic process handle: после immediate incarnation check остаётся check-to-signal PID race",
    ] : [])].filter((value, index, all) => all.indexOf(value) === index)
    const unsigned = {
      kind: "meta-legacy-retirement-plan-v1" as const,
      planId: `legacy-plan:${randomUUID()}`,
      createdAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      canonicalRoot: root,
      expectedBunExecutable: bun,
      state: reasons.length === 0 ? "ready" as const : "blocked" as const,
      targets,
      absent,
      reasons,
      signalSafety,
      limitations,
    }
    const digest = sha256(stableJson(unsigned))
    const plan = deepFreeze(structuredClone({ ...unsigned, digest }))
    this.#plans.set(plan.planId, { digest, plan })
    return plan
  }

  async execute(plan: LegacyRetirementPlan): Promise<LegacyRetirementResult> {
    const binding = this.#plans.get(plan.planId)
    if (binding === undefined || binding.digest !== plan.digest
      || stableJson(binding.plan) !== stableJson(plan)) {
      return result("unsupported", plan.targets, [], [], ["Plan не выпущен этим coordinator или изменён"], "not-used", [])
    }
    this.#plans.delete(plan.planId)
    if (plan.state !== "ready") {
      return result("blocked", plan.targets, [], [], [...plan.reasons], plan.signalSafety, plan.limitations)
    }
    const currentRoot = await this.#verifyRoot().catch(() => undefined)
    const currentBun = await this.#verifyBun().catch(() => undefined)
    if (currentRoot === undefined || currentBun === undefined
      || !samePathIdentity(currentRoot, plan.canonicalRoot)
      || !samePathIdentity(currentBun, plan.expectedBunExecutable)) {
      return result("stale", plan.targets, [], [], ["Filesystem identity изменилась после plan"], plan.signalSafety, plan.limitations)
    }
    for (const spec of plan.absent) {
      if ((await this.#backend.listeners(spec.port)).length > 0) {
        return result("stale", plan.targets, [], [], [
          `${spec.package} listener появился после plan`,
        ], plan.signalSafety, plan.limitations)
      }
    }
    for (const target of plan.targets) {
      const listeners = await this.#backend.listeners(target.spec.port)
      if (listeners.length !== 1
        || !sameProcessIdentity(listeners[0]!, target.process)) {
        return result("stale", plan.targets, [], [], [
          `${target.spec.package} listener ownership изменилась после plan`,
        ], plan.signalSafety, plan.limitations)
      }
      const current = await this.#backend.process(target.process.pid)
      if (current === undefined || !sameProcessIdentity(current, target.process)
        || current.state !== "running") {
        return result("stale", plan.targets, [], [], [`${target.spec.package} process incarnation изменился`], plan.signalSafety, plan.limitations)
      }
      const mismatch = await this.#processMismatch(
        current,
        target.spec,
        currentRoot,
        currentBun,
      )
      const entrypoint = await this.#backend.pathIdentity(target.spec.entrypoint)
      if (mismatch !== undefined || entrypoint === undefined
        || !samePathIdentity(entrypoint, target.entrypointIdentity)) {
        return result("stale", plan.targets, [], [], [
          `${target.spec.package} executable/cwd/entrypoint identity изменилась`,
        ], plan.signalSafety, plan.limitations)
      }
    }

    const stopped: LegacyRetirementPlanTarget[] = []
    try {
    for (const target of plan.targets) {
      const status = await this.#backend.signalProcess(target.process, "SIGSTOP")
      if (status !== "sent") {
        const resumed = await this.#resume(stopped)
        return result(status === "stale" ? "stale" : "partial", plan.targets, [], resumed,
          [`Не удалось приостановить ${target.spec.package} admissions`], plan.signalSafety, plan.limitations)
      }
      stopped.push(target)
    }

    const stoppedCheck = await this.#validateStopped(stopped, plan.canonicalRoot)
    if (stoppedCheck.reason !== undefined) {
      const resumed = await this.#resume(stopped)
      return result("blocked", plan.targets, [], resumed, [stoppedCheck.reason], plan.signalSafety, plan.limitations)
    }
    const helperDeadline = this.#backend.nowMillis() + this.#options.helperWaitMs
    while (true) {
      const descendants = await this.#allDescendants(stopped)
      const classified = await this.#classifyDescendants(descendants, plan.canonicalRoot)
      if (classified.reason !== undefined) {
        const resumed = await this.#resume(stopped)
        return result("blocked", plan.targets, [], resumed, [classified.reason], plan.signalSafety, plan.limitations)
      }
      if (classified.helpers.length === 0) break
      if (this.#backend.nowMillis() >= helperDeadline) {
        const held = classified.helpers.some(helper => helper.heldInputState !== "none")
        const resumed = await this.#resume(stopped)
        return result("blocked", plan.targets, [], resumed, [held
          ? "Active meta-input-helper имеет held/unknown cleanup; force kill запрещён"
          : "Active meta-input-helper не завершился до bounded deadline"], plan.signalSafety, plan.limitations)
      }
      await this.#backend.waitMillis(this.#options.pollMs)
    }

    const termSent: LegacyRetirementPlanTarget[] = []
    for (const target of stopped) {
      const status = await this.#backend.signalProcess(target.process, "SIGTERM")
      if (status !== "sent") {
        const resumed = await this.#resume(stopped)
        return result(status === "stale" ? "stale" : "partial", plan.targets,
          [], resumed, [`Не удалось отправить SIGTERM ${target.spec.package}`], plan.signalSafety, plan.limitations)
      }
      termSent.push(target)
    }
    const resumed = await this.#resume(stopped)
    const exitDeadline = this.#backend.nowMillis() + this.#options.exitWaitMs
    const remaining = new Set(termSent)
    while (remaining.size > 0 && this.#backend.nowMillis() < exitDeadline) {
      for (const target of [...remaining]) {
        const current = await this.#backend.process(target.process.pid)
        if (current === undefined || !sameProcessIncarnation(current, target.process)) {
          remaining.delete(target)
        }
      }
      if (remaining.size > 0) await this.#backend.waitMillis(this.#options.pollMs)
    }
    const retired = termSent.filter(target => !remaining.has(target)).map(target => target.spec)
    return result(remaining.size === 0 ? "retired" : "partial", plan.targets,
      retired, resumed, remaining.size === 0 ? [] : [
        "Один или несколько legacy parents не завершились; force kill запрещён",
      ], plan.signalSafety, plan.limitations)
    } catch (error) {
      const resumed = await this.#resume(stopped).catch(() => [])
      return result("partial", plan.targets, [], resumed, [
        `Legacy backend failure после pause: ${error instanceof Error ? error.message : String(error)}`,
      ], plan.signalSafety, plan.limitations)
    }
  }

  async #verifyRoot(): Promise<PathIdentity> {
    const requested = resolve(this.#options.repositoryRoot)
    if (!this.#options.testOnlyAllowNonCanonicalRoot
      && requested !== CANONICAL_AI_MACOS_ROOT) {
      throw new Error("Legacy retirement разрешён только для canonical ai-macos root")
    }
    if (insideProduction(requested)) throw new Error("Archived production root запрещён")
    const identity = await this.#backend.pathIdentity(requested)
    if (identity === undefined || !validPathIdentity(identity)
      || identity.path !== requested || identity.kind !== "directory" || identity.symbolicLink
      || identity.realPath !== requested || identity.uid !== this.#options.uid
      || insideProduction(identity.realPath)) {
      throw new Error("Canonical repository root identity не подтверждена")
    }
    return identity
  }

  async #verifyBun(): Promise<PathIdentity> {
    const requested = resolve(this.#options.expectedBunExecutable)
    if (insideProduction(requested)) throw new Error("Archived Bun executable запрещён")
    const identity = await this.#backend.pathIdentity(requested)
    if (identity === undefined || !validPathIdentity(identity)
      || identity.path !== requested || identity.kind !== "file" || identity.symbolicLink
      || identity.realPath !== requested || identity.uid !== this.#options.uid
      || insideProduction(identity.realPath)) {
      throw new Error("Expected Bun executable identity не подтверждена")
    }
    return identity
  }

  async #processMismatch(
    process: LegacyProcessSnapshot,
    spec: LegacyServiceSpec,
    root: PathIdentity,
    bun: PathIdentity,
  ): Promise<string | undefined> {
    if (!validProcess(process) || process.uid !== this.#options.uid
      || process.state !== "running") return "не является owned running process"
    if (process.listenerPorts.length !== 1 || process.listenerPorts[0] !== spec.port) {
      return "слушает неожиданный набор портов"
    }
    if (!inside(root.realPath, resolve(process.cwd)) || insideProduction(resolve(process.cwd))
      || insideProduction(resolve(process.executable))) return "имеет foreign или archive cwd/executable"
    const executable = await this.#backend.pathIdentity(process.executable)
    const cwd = await this.#backend.pathIdentity(process.cwd)
    if (resolve(process.executable) !== bun.realPath || executable === undefined
      || !samePathIdentity(executable, bun)) {
      return "использует другой executable"
    }
    if (cwd === undefined || cwd.kind !== "directory" || cwd.symbolicLink
      || cwd.realPath !== resolve(process.cwd) || cwd.uid !== this.#options.uid
      || !inside(root.realPath, cwd.realPath)
      || insideProduction(cwd.realPath)) return "имеет foreign или symlink cwd"
    if ((process.argv[0] !== basename(bun.realPath) && resolve(process.argv[0] ?? "") !== bun.realPath)
      || directBunEntrypoint(process.argv, cwd.realPath) !== spec.entrypoint) {
      return "не содержит exact direct canonical entrypoint в argv"
    }
    const entrypointIdentity = await this.#backend.pathIdentity(spec.entrypoint)
    if (entrypointIdentity === undefined || entrypointIdentity.kind !== "file"
      || entrypointIdentity.symbolicLink
      || entrypointIdentity.realPath !== spec.entrypoint
      || entrypointIdentity.uid !== this.#options.uid
      || !inside(root.realPath, entrypointIdentity.realPath)
      || insideProduction(entrypointIdentity.realPath)) {
      return "canonical entrypoint identity не подтверждена"
    }
    return undefined
  }

  async #classifyDescendants(
    descendants: LegacyProcessSnapshot[],
    root: PathIdentity,
  ): Promise<{ helpers: LegacyProcessSnapshot[], reason?: string }> {
    const helpers: LegacyProcessSnapshot[] = []
    const helperPath = resolve(root.realPath, "input/bin/meta-input-helper")
    if (descendants.length > 256) {
      return { helpers, reason: "Legacy parent child inventory превышает limit" }
    }
    for (const child of descendants) {
      if (!validProcess(child) || child.uid !== this.#options.uid) {
        return { helpers, reason: "Legacy parent имеет unknown child process" }
      }
      const executable = await this.#backend.pathIdentity(child.executable)
      if (executable === undefined || executable.kind !== "file" || executable.symbolicLink
        || resolve(child.executable) !== helperPath
        || executable.realPath !== helperPath || executable.uid !== this.#options.uid
        || resolve(child.argv[0] ?? "") !== helperPath) {
        return { helpers, reason: "Legacy parent имеет foreign child process" }
      }
      helpers.push(cloneProcess(child))
    }
    return { helpers }
  }

  async #validateStopped(
    targets: LegacyRetirementPlanTarget[],
    root: PathIdentity,
  ): Promise<{ reason?: string }> {
    for (const target of targets) {
      const current = await this.#backend.process(target.process.pid)
      if (current === undefined || !sameProcessIdentity(current, target.process)
        || current.state !== "stopped") {
        return { reason: `${target.spec.package} не подтверждён stopped в exact incarnation` }
      }
      const descendants = await this.#backend.descendants(target.process.pid)
      const classified = await this.#classifyDescendants(descendants, root)
      if (classified.reason !== undefined) return { reason: classified.reason }
    }
    return {}
  }

  async #allDescendants(
    targets: LegacyRetirementPlanTarget[],
  ): Promise<LegacyProcessSnapshot[]> {
    const groups = await Promise.all(targets.map(target => {
      return this.#backend.descendants(target.process.pid)
    }))
    return groups.flat()
  }

  async #resume(targets: LegacyRetirementPlanTarget[]): Promise<LegacyServiceSpec[]> {
    const resumed: LegacyServiceSpec[] = []
    for (const target of targets) {
      const current = await this.#backend.process(target.process.pid)
      if (current === undefined || !sameProcessIncarnation(current, target.process)
        || current.state !== "stopped") continue
      if (await this.#backend.signalProcess(target.process, "SIGCONT") === "sent") {
        resumed.push(target.spec)
      }
    }
    return resumed
  }
}

function legacySpecs(root: string): LegacyServiceSpec[] {
  return ([
    ["window", 7878],
    ["screen", 7879],
    ["chrome", 7880],
    ["android", 7881],
    ["input", 7882],
  ] as const).map(([packageName, port]) => ({
    package: packageName,
    port,
    entrypoint: resolve(root, packageName, "src/index.ts"),
  }))
}

function result(
  state: LegacyRetirementResult["state"],
  targets: LegacyRetirementPlanTarget[],
  retired: LegacyServiceSpec[],
  resumed: LegacyServiceSpec[],
  reasons: string[],
  signalSafety: LegacyRetirementResult["signalSafety"],
  limitations: string[],
): LegacyRetirementResult {
  const retiredPorts = new Set(retired.map(spec => spec.port))
  return {
    state,
    retired,
    remaining: targets.filter(target => !retiredPorts.has(target.spec.port))
      .map(target => target.spec),
    resumed,
    reasons,
    signalSafety,
    limitations,
  }
}

function validProcess(process: LegacyProcessSnapshot): boolean {
  return Number.isInteger(process.pid) && process.pid > 0
    && Number.isInteger(process.parentPid) && process.parentPid >= 0
    && Number.isSafeInteger(process.startTimeMicros) && process.startTimeMicros > 0
    && Number.isInteger(process.uid) && process.uid >= 0
    && isAbsolute(process.executable) && isAbsolute(process.cwd)
    && process.argv.length > 0 && process.argv.length <= 256
    && process.argv.every(argument => argument.length <= 4_096)
    && process.listenerPorts.length <= 16
}

function validPathIdentity(identity: PathIdentity): boolean {
  return isAbsolute(identity.path) && isAbsolute(identity.realPath)
    && Number.isInteger(identity.uid) && identity.uid >= 0
    && Number.isSafeInteger(identity.device) && identity.device >= 0
    && Number.isSafeInteger(identity.inode) && identity.inode > 0
}

function directBunEntrypoint(argv: readonly string[], cwd: string): string | undefined {
  let index = 1
  while (["--hot", "--watch", "--smol"].includes(argv[index] ?? "")) index += 1
  if (argv[index] === "run") index += 1
  const candidate = argv[index]
  if (candidate === undefined || candidate.startsWith("-")) return undefined
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
}

function sameProcessIncarnation(
  left: LegacyProcessSnapshot,
  right: LegacyProcessSnapshot,
): boolean {
  return left.pid === right.pid && left.startTimeMicros === right.startTimeMicros
}

function sameProcessIdentity(
  left: LegacyProcessSnapshot,
  right: LegacyProcessSnapshot,
): boolean {
  return sameProcessIncarnation(left, right)
    && left.uid === right.uid
    && left.executable === right.executable
    && left.cwd === right.cwd
    && stableJson(left.argv) === stableJson(right.argv)
    && stableJson(left.listenerPorts) === stableJson(right.listenerPorts)
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.realPath === right.realPath && left.kind === right.kind
    && !left.symbolicLink && !right.symbolicLink && left.uid === right.uid
    && left.device === right.device && left.inode === right.inode
}

function cloneProcess(process: LegacyProcessSnapshot): LegacyProcessSnapshot {
  return structuredClone(process)
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === "" || child !== ".." && !child.startsWith(`..${separator()}`)
}

function insideProduction(path: string): boolean {
  return inside("/Users/zavx0z/production", resolve(path))
}

function separator(): string {
  return "/"
}

function boundedDuration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000) {
    throw new Error("Legacy retirement deadline должен быть 1..30000 ms")
  }
  return value
}

function boundedPoll(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Legacy retirement poll должен быть 1..1000 ms")
  }
  return value
}

function sha256(value: string): string {
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

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export type LegacyCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export interface LegacyCommandRunner {
  run(
    file: string,
    args: readonly string[],
    options: {
      timeoutMs: number
      maxOutputBytes: number
      env?: Readonly<Record<string, string>>
    },
  ): Promise<LegacyCommandResult>
}

export interface LegacyPathReader {
  identity(path: string): Promise<PathIdentity | undefined>
}

const nodePathReader: LegacyPathReader = {
  async identity(path) {
    try {
      const info = await lstat(path)
      const actual = await realpath(path)
      return {
        path,
        realPath: actual,
        kind: info.isDirectory() ? "directory" : "file",
        symbolicLink: info.isSymbolicLink(),
        uid: info.uid,
        device: info.dev,
        inode: info.ino,
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined
      }
      throw error
    }
  },
}

export class CheckedPidLegacyBackend implements LegacyServiceBackend {
  readonly signalSafety = "checked-pid" as const
  readonly limitations = [
    "Process start time получен из locale-fixed ps с секундной точностью; PID reuse в ту же секунду неразличим",
    "argv восстановлен из ps command line и принимается только в ограниченной direct Bun форме",
  ]
  readonly #runner: LegacyCommandRunner
  readonly #paths: LegacyPathReader
  readonly #now: () => number
  readonly #wait: (millis: number) => Promise<void>

  constructor(options: {
    runner: LegacyCommandRunner
    paths?: LegacyPathReader
    nowMillis?: () => number
    waitMillis?: (millis: number) => Promise<void>
  }) {
    this.#runner = options.runner
    this.#paths = options.paths ?? nodePathReader
    this.#now = options.nowMillis ?? (() => Date.now())
    this.#wait = options.waitMillis ?? (millis => Bun.sleep(millis))
  }

  nowMillis(): number {
    return this.#now()
  }

  async waitMillis(millis: number): Promise<void> {
    await this.#wait(millis)
  }

  async pathIdentity(path: string): Promise<PathIdentity | undefined> {
    return this.#paths.identity(path)
  }

  async listeners(port: number): Promise<LegacyProcessSnapshot[]> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Некорректный listener port")
    }
    const output = await this.#read("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ], true)
    const pids = [...new Set(output.split("\n").flatMap(line => {
      return /^p([1-9][0-9]*)$/.exec(line.trim())?.[1] ?? []
    }).map(Number))]
    if (pids.length > 16) throw new Error("Listener inventory превышает limit")
    const processes = await Promise.all(pids.map(pid => this.process(pid)))
    return processes.filter((process): process is LegacyProcessSnapshot => {
      return process !== undefined && process.listenerPorts.includes(port)
    })
  }

  async process(pid: number): Promise<LegacyProcessSnapshot | undefined> {
    if (!Number.isInteger(pid) || pid < 1) throw new Error("Некорректный PID")
    const ps = await this.#read("/bin/ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      "pid=,ppid=,uid=,lstart=,state=,command=",
    ], true)
    const parsed = parsePsLine(ps.trim())
    if (parsed === undefined) return undefined
    if (parsed.pid !== pid) throw new Error("ps вернул другой PID")
    const files = await this.#read("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd,txt",
      "-Ffn",
    ], false)
    const paths = parseLsofProcessPaths(files)
    if (paths.cwd === undefined || paths.executable === undefined) {
      throw new Error(`lsof не вернул cwd/executable для PID ${pid}`)
    }
    const listeners = await this.#read("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fn",
    ], true)
    return {
      pid: parsed.pid,
      parentPid: parsed.parentPid,
      startTimeMicros: parsed.startTimeMicros,
      uid: parsed.uid,
      executable: paths.executable,
      cwd: paths.cwd,
      argv: parsed.argv,
      listenerPorts: parseListenerPorts(listeners),
      state: parsed.stopped ? "stopped" : "running",
      heldInputState: paths.executable.endsWith("/meta-input-helper")
        ? "unknown"
        : undefined,
    }
  }

  async descendants(pid: number): Promise<LegacyProcessSnapshot[]> {
    const output = await this.#read("/bin/ps", [
      "-ww",
      "-axo",
      "pid=,ppid=,uid=,lstart=,state=,command=",
    ], true)
    const rows = output.split("\n").map(line => parsePsLine(line.trim()))
      .filter((row): row is ParsedPsProcess => row !== undefined)
    if (rows.length > 4096) throw new Error("Process inventory превышает limit")
    const selected = new Set<number>([pid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (selected.has(row.parentPid) && !selected.has(row.pid)) {
          selected.add(row.pid)
          changed = true
        }
      }
    }
    selected.delete(pid)
    if (selected.size > 256) throw new Error("Descendant inventory превышает limit")
    const processes = await Promise.all([...selected].map(childPid => {
      return this.process(childPid)
    }))
    return processes.filter((process): process is LegacyProcessSnapshot => {
      return process !== undefined
    })
  }

  async signalProcess(
    expected: LegacyProcessSnapshot,
    signal: ExactSignal,
  ): Promise<"sent" | "stale" | "failed"> {
    const before = await this.process(expected.pid)
    if (before === undefined || !sameProcessIdentity(before, expected)) {
      return "stale"
    }
    const command = await this.#runner.run("/bin/kill", [
      signal === "SIGSTOP" ? "-STOP" : signal === "SIGCONT" ? "-CONT" : "-TERM",
      String(expected.pid),
    ], { timeoutMs: 1_000, maxOutputBytes: 64 * 1024, env: { LC_ALL: "C" } })
    const after = await this.process(expected.pid)
    if (after !== undefined && !sameProcessIncarnation(after, expected)) {
      return "stale"
    }
    if (command.exitCode !== 0) return after === undefined ? "stale" : "failed"
    if (signal === "SIGSTOP" && after?.state !== "stopped") return "failed"
    if (signal === "SIGCONT" && after !== undefined && after.state !== "running") {
      return "failed"
    }
    return "sent"
  }

  async #read(
    file: string,
    args: readonly string[],
    allowNoMatch: boolean,
  ): Promise<string> {
    const result = await this.#runner.run(file, args, {
      timeoutMs: 2_000,
      maxOutputBytes: 4 * 1024 * 1024,
      env: { LC_ALL: "C" },
    })
    if (result.stdout.length > 4 * 1024 * 1024
      || result.stderr.length > 64 * 1024) {
      throw new Error(`${file} output превышает limit`)
    }
    if (result.exitCode !== 0 && !(allowNoMatch && result.exitCode === 1)) {
      throw new Error(`${file} failed (${result.exitCode}): ${result.stderr}`)
    }
    return result.stdout
  }
}

type ParsedPsProcess = {
  pid: number
  parentPid: number
  uid: number
  startTimeMicros: number
  stopped: boolean
  argv: string[]
}

function parsePsLine(line: string): ParsedPsProcess | undefined {
  if (line === "") return undefined
  const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s+([0-9]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+[ 0-9][0-9]\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\s+[0-9]{4})\s+(\S+)\s+(.+)$/.exec(line)
  if (match === null) throw new Error("ps вернул неоднозначный process record")
  const start = Date.parse(match[4]!.replace(/\s+/g, " "))
  const argv = parseCommandLine(match[6]!)
  if (!Number.isFinite(start) || argv.length === 0) {
    throw new Error("ps process start/argv не распознаны")
  }
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    uid: Number(match[3]),
    startTimeMicros: start * 1000,
    stopped: match[5]!.includes("T"),
    argv,
  }
}

function parseCommandLine(value: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += character
  }
  if (escaped || quote !== undefined) throw new Error("ps argv содержит незавершённое quoting")
  if (current !== "") tokens.push(current)
  if (tokens.length > 256 || tokens.some(token => token.length > 4_096)) {
    throw new Error("ps argv превышает limit")
  }
  return tokens
}

function parseLsofProcessPaths(value: string): {
  cwd?: string
  executable?: string
} {
  let descriptor: string | undefined
  const result: { cwd?: string, executable?: string } = {}
  for (const raw of value.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("f")) {
      descriptor = line.slice(1)
      continue
    }
    if (!line.startsWith("n") || descriptor === undefined) continue
    const path = line.slice(1)
    if (descriptor === "cwd") result.cwd = path
    if (descriptor === "txt" && result.executable === undefined) {
      result.executable = path
    }
  }
  return result
}

function parseListenerPorts(value: string): number[] {
  const ports = value.split("\n").flatMap(raw => {
    const match = /:([0-9]{1,5})(?:\s|$)/.exec(raw.trim())
    if (match === null) return []
    const port = Number(match[1])
    return port >= 1 && port <= 65535 ? [port] : []
  })
  return [...new Set(ports)].sort((left, right) => left - right)
}
