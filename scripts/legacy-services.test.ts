import { expect, test } from "bun:test"
import {
  CheckedPidLegacyBackend,
  LegacyServiceRetirementCoordinator,
  type ExactSignal,
  type LegacyCommandRunner,
  type LegacyPathReader,
  type LegacyProcessSnapshot,
  type LegacyServiceBackend,
  type PathIdentity,
} from "./legacy-services.ts"

const uid = 501
const root = "/tmp/repozitarium/ai-macos"
const bun = "/tmp/bin/bun"
const helper = `${root}/input/bin/meta-input-helper`

function pathIdentity(path: string, kind: PathIdentity["kind"]): PathIdentity {
  return {
    path,
    realPath: path,
    kind,
    symbolicLink: false,
    uid,
    device: 1,
    inode: hash(path),
  }
}

function service(
  packageName: "window" | "screen" | "chrome" | "android" | "input",
  port: number,
  pid: number,
): LegacyProcessSnapshot {
  return {
    pid,
    parentPid: 1,
    startTimeMicros: pid * 1000,
    uid,
    executable: bun,
    cwd: `${root}/${packageName}`,
    argv: [bun, "src/index.ts"],
    listenerPorts: [port],
    state: "running",
  }
}

function child(pid: number, parentPid: number): LegacyProcessSnapshot {
  return {
    pid,
    parentPid,
    startTimeMicros: pid * 1000,
    uid,
    executable: helper,
    cwd: `${root}/input`,
    argv: [helper],
    listenerPorts: [],
    state: "running",
    heldInputState: "unknown",
  }
}

class FakeBackend implements LegacyServiceBackend {
  signalSafety: LegacyServiceBackend["signalSafety"] = "atomic-incarnation"
  limitations: readonly string[] = []
  now = 0
  readonly paths = new Map<string, PathIdentity>()
  readonly processes = new Map<number, LegacyProcessSnapshot>()
  readonly signals: Array<{ pid: number, signal: ExactSignal }> = []
  helperExitAt: number | undefined
  exitOnContinue = new Set<number>()
  replaceBeforeNextSignal = false
  failDescendantsWhileStopped = false

  constructor() {
    this.paths.set(root, pathIdentity(root, "directory"))
    this.paths.set(bun, pathIdentity(bun, "file"))
    this.paths.set(helper, pathIdentity(helper, "file"))
    for (const packageName of ["window", "screen", "chrome", "android", "input"]) {
      const cwd = `${root}/${packageName}`
      this.paths.set(cwd, pathIdentity(cwd, "directory"))
      const entrypoint = `${cwd}/src/index.ts`
      this.paths.set(entrypoint, pathIdentity(entrypoint, "file"))
    }
  }

  nowMillis() { return this.now }
  async waitMillis(millis: number) {
    this.now += millis
    if (this.helperExitAt !== undefined && this.now >= this.helperExitAt) {
      for (const [pid, process] of this.processes) {
        if (process.executable === helper) this.processes.delete(pid)
      }
    }
  }
  async pathIdentity(path: string) { return this.paths.get(path) }
  async listeners(port: number) {
    return [...this.processes.values()].filter(process => {
      return process.listenerPorts.includes(port)
    }).map(process => structuredClone(process))
  }
  async process(pid: number) {
    const process = this.processes.get(pid)
    return process === undefined ? undefined : structuredClone(process)
  }
  async descendants(pid: number) {
    if (this.failDescendantsWhileStopped
      && this.processes.get(pid)?.state === "stopped") {
      throw new Error("injected descendants failure")
    }
    return [...this.processes.values()].filter(process => process.parentPid === pid)
      .map(process => structuredClone(process))
  }
  async signalProcess(expected: LegacyProcessSnapshot, signal: ExactSignal) {
    let current = this.processes.get(expected.pid)
    if (current !== undefined && this.replaceBeforeNextSignal) {
      current = { ...current, startTimeMicros: current.startTimeMicros + 1 }
      this.processes.set(current.pid, current)
      this.replaceBeforeNextSignal = false
    }
    if (current === undefined || current.startTimeMicros !== expected.startTimeMicros) {
      return "stale" as const
    }
    this.signals.push({ pid: expected.pid, signal })
    if (signal === "SIGSTOP") current.state = "stopped"
    if (signal === "SIGCONT") {
      current.state = "running"
      if (this.exitOnContinue.has(current.pid)) this.processes.delete(current.pid)
    }
    if (signal === "SIGTERM") this.exitOnContinue.add(current.pid)
    return "sent" as const
  }
}

function coordinator(backend: FakeBackend) {
  return new LegacyServiceRetirementCoordinator(backend, {
    repositoryRoot: root,
    expectedBunExecutable: bun,
    uid,
    helperWaitMs: 30,
    exitWaitMs: 30,
    pollMs: 10,
    testOnlyAllowNonCanonicalRoot: true,
    now: () => new Date("2026-09-15T12:00:00.000Z"),
  })
}

test("foreign listener блокирует plan без signals", async () => {
  const backend = new FakeBackend()
  const foreign = service("window", 7878, 10)
  foreign.executable = "/tmp/foreign/bun"
  backend.processes.set(foreign.pid, foreign)
  const plan = await coordinator(backend).plan()
  expect(plan.state).toBe("blocked")
  expect(plan.reasons.join(" ")).toContain("другой executable")
  expect(backend.signals).toEqual([])
})

test("bare bun argv принимается только при подтверждённом executable", async () => {
  const backend = new FakeBackend()
  const owned = service("window", 7878, 10)
  owned.argv[0] = "bun"
  backend.processes.set(owned.pid, owned)
  const plan = await coordinator(backend).plan()
  expect(plan.state).toBe("ready")
  expect(backend.signals).toEqual([])
})

test("archived production root отклоняется до process inspection", async () => {
  const backend = new FakeBackend()
  const owner = new LegacyServiceRetirementCoordinator(backend, {
    repositoryRoot: "/Users/zavx0z/production/ai-macos",
    expectedBunExecutable: bun,
    uid,
    testOnlyAllowNonCanonicalRoot: true,
  })
  await expect(owner.plan()).rejects.toThrow("Archived production root")
  expect(backend.signals).toEqual([])
})

test("stale process incarnation не получает signal", async () => {
  const backend = new FakeBackend()
  const owned = service("window", 7878, 10)
  backend.processes.set(owned.pid, owned)
  const owner = coordinator(backend)
  const plan = await owner.plan()
  backend.processes.set(owned.pid, {
    ...owned,
    startTimeMicros: owned.startTimeMicros + 1,
  })
  const result = await owner.execute(plan)
  expect(result.state).toBe("stale")
  expect(backend.signals).toEqual([])
})

test("listener, появившийся после plan, блокирует execution без signals", async () => {
  const backend = new FakeBackend()
  const owner = coordinator(backend)
  const plan = await owner.plan()
  const late = service("screen", 7879, 13)
  backend.processes.set(late.pid, late)
  const result = await owner.execute(plan)
  expect(result.state).toBe("stale")
  expect(backend.signals).toEqual([])
})

test("PID reuse в signal boundary не затрагивает replacement", async () => {
  const backend = new FakeBackend()
  const owned = service("window", 7878, 11)
  backend.processes.set(owned.pid, owned)
  const owner = coordinator(backend)
  const plan = await owner.plan()
  backend.replaceBeforeNextSignal = true
  const result = await owner.execute(plan)
  expect(result.state).toBe("stale")
  expect(backend.signals).toEqual([])
})

test("checked-pid backend выполняет retirement и публикует остаточную race", async () => {
  const backend = new FakeBackend()
  backend.signalSafety = "checked-pid"
  const owned = service("window", 7878, 12)
  backend.processes.set(owned.pid, owned)
  const owner = coordinator(backend)
  const result = await owner.execute(await owner.plan())
  expect(result.state).toBe("retired")
  expect(result.signalSafety).toBe("checked-pid")
  expect(result.limitations.join(" ")).toContain("PID race")
})

test("pending helper timeout возобновляет parent без TERM или child signal", async () => {
  const backend = new FakeBackend()
  const owned = service("input", 7882, 20)
  const activeHelper = child(21, owned.pid)
  backend.processes.set(owned.pid, owned)
  backend.processes.set(activeHelper.pid, activeHelper)
  const owner = coordinator(backend)
  const plan = await owner.plan()
  const result = await owner.execute(plan)
  expect(result.state).toBe("blocked")
  expect(backend.signals).toEqual([
    { pid: owned.pid, signal: "SIGSTOP" },
    { pid: owned.pid, signal: "SIGCONT" },
  ])
  expect((await backend.process(owned.pid))?.state).toBe("running")
})

test("helper завершается сам, coordinator останавливает только exact parent", async () => {
  const backend = new FakeBackend()
  const owned = service("input", 7882, 30)
  const activeHelper = child(31, owned.pid)
  backend.processes.set(owned.pid, owned)
  backend.processes.set(activeHelper.pid, activeHelper)
  backend.helperExitAt = 10
  const owner = coordinator(backend)
  const result = await owner.execute(await owner.plan())
  expect(result.state).toBe("retired")
  expect(result.retired.map(spec => spec.port)).toEqual([7882])
  expect(backend.signals).toEqual([
    { pid: owned.pid, signal: "SIGSTOP" },
    { pid: owned.pid, signal: "SIGTERM" },
    { pid: owned.pid, signal: "SIGCONT" },
  ])
})

test("unknown child после pause возобновляет service без TERM", async () => {
  const backend = new FakeBackend()
  const owned = service("window", 7878, 40)
  backend.processes.set(owned.pid, owned)
  const owner = coordinator(backend)
  const plan = await owner.plan()
  const foreignChild = child(41, owned.pid)
  foreignChild.executable = "/tmp/foreign/helper"
  backend.processes.set(foreignChild.pid, foreignChild)
  const result = await owner.execute(plan)
  expect(result.state).toBe("blocked")
  expect(backend.signals).toEqual([
    { pid: owned.pid, signal: "SIGSTOP" },
    { pid: owned.pid, signal: "SIGCONT" },
  ])
})

test("backend failure после pause возобновляет exact parent", async () => {
  const backend = new FakeBackend()
  const owned = service("window", 7878, 42)
  backend.processes.set(owned.pid, owned)
  const owner = coordinator(backend)
  const plan = await owner.plan()
  backend.failDescendantsWhileStopped = true
  const result = await owner.execute(plan)
  expect(result.state).toBe("partial")
  expect(backend.signals).toEqual([
    { pid: owned.pid, signal: "SIGSTOP" },
    { pid: owned.pid, signal: "SIGCONT" },
  ])
  expect((await backend.process(owned.pid))?.state).toBe("running")
})

test("checked-pid scanner читает exact listener/cwd/executable и проверяет STOP", async () => {
  class ScannerRunner implements LegacyCommandRunner {
    stopped = false
    killCalls = 0

    async run(file: string, args: readonly string[]) {
      if (file === "/bin/kill") {
        this.killCalls += 1
        this.stopped = args[0] === "-STOP"
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      if (file === "/bin/ps" && args.includes("-p")) {
        const requestedPid = args[args.indexOf("-p") + 1]
        if (requestedPid === "56") {
          return {
            stdout: `56 55 501 Mon Sep 15 12:00:01 2026 S ${helper}\n`,
            stderr: "",
            exitCode: 0,
          }
        }
        return {
          stdout: `55 1 501 Mon Sep 15 12:00:00 2026 ${this.stopped ? "T" : "S"} ${bun} --hot src/index.ts\n`,
          stderr: "",
          exitCode: 0,
        }
      }
      if (file === "/usr/sbin/lsof" && args.includes("-Fp")) {
        return { stdout: "p55\n", stderr: "", exitCode: 0 }
      }
      if (file === "/usr/sbin/lsof" && args.includes("cwd,txt")) {
        if (args.includes("56")) {
          return { stdout: `fcwd\nn${root}/input\nftxt\nn${helper}\n`, stderr: "", exitCode: 0 }
        }
        return { stdout: `fcwd\nn${root}/window\nftxt\nn${bun}\n`, stderr: "", exitCode: 0 }
      }
      if (file === "/usr/sbin/lsof" && args.includes("-Fn")) {
        if (args.includes("56")) return { stdout: "", stderr: "", exitCode: 1 }
        return { stdout: "n*:7878\n", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "not found", exitCode: 1 }
    }
  }
  const runner = new ScannerRunner()
  const paths: LegacyPathReader = {
    async identity(path) {
      if (path === bun) return pathIdentity(bun, "file")
      if (path === `${root}/window`) return pathIdentity(path, "directory")
      if (path === helper) return pathIdentity(helper, "file")
      if (path === `${root}/input`) return pathIdentity(path, "directory")
      return undefined
    },
  }
  const scanner = new CheckedPidLegacyBackend({ runner, paths })
  const [snapshot] = await scanner.listeners(7878)
  expect(snapshot).toMatchObject({
    pid: 55,
    uid: 501,
    executable: bun,
    cwd: `${root}/window`,
    argv: [bun, "--hot", "src/index.ts"],
    listenerPorts: [7878],
    state: "running",
  })
  expect(await scanner.signalProcess(snapshot!, "SIGSTOP")).toBe("sent")
  expect(runner.killCalls).toBe(1)
  expect(await scanner.process(56)).toMatchObject({
    pid: 56,
    executable: helper,
    listenerPorts: [],
    heldInputState: "unknown",
  })
})

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0
  return result + 1
}
