import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../..")
let checkDirectory = ""
let fixtureBinary = ""

async function run(command: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

beforeAll(async () => {
  checkDirectory = mkdtempSync(join(tmpdir(), "ai-macos-native-sut-"))
  fixtureBinary = join(checkDirectory, "native-sut-fixture")
  const compilation = await run([
    "/usr/bin/clang",
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Inative/include",
    "native/src/executor.c",
    "native/src/registry.c",
    "native/src/ledger.c",
    "tests/computer-use/native/native_sut_fixture.c",
    "-o",
    fixtureBinary
  ])
  expect(compilation.stderr).toBe("")
  expect(compilation.exitCode).toBe(0)
})

afterAll(() => {
  const expectedPrefix = join(tmpdir(), "ai-macos-native-sut-")
  if (checkDirectory.startsWith(expectedPrefix)) {
    rmSync(checkDirectory, { recursive: true, force: true })
  }
})

async function expectScenario(name: string): Promise<void> {
  const result = await run([fixtureBinary, name, checkDirectory])
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
}

describe("real native C SUT with injected backend", () => {
  test("A04: target checkpoint останавливает следующий event", () =>
    expectScenario("a04-target-checkpoint"))

  test("A06: cancel до первого event сохраняет dispatch none", () =>
    expectScenario("a06-cancel-before-event"))

  test("A07: cancel после down отправляет bounded matching up", () =>
    expectScenario("a07-cancel-after-down"))

  test("A08: потерянный ACK после down даёт unknown и quarantine", () =>
    expectScenario("a08-lost-down-ack"))

  test("A08: persist failure второго down сохраняет unknown ledger после physical cleanup", () =>
    expectScenario("a08-persist-existing-hold"))

  test("A08: broken cleanup persistence освобождает все live-owned holds один раз", () =>
    expectScenario("a08-persist-cleanup-unknown"))

  test("A09: watchdog живого helper прекращает будущие events", () =>
    expectScenario("a09-watchdog"))

  test("A09: durable recovery ledger виден после reconnect без blind event", () =>
    expectScenario("a09-recovery-ledger"))

  test("A10: reconnect той же epoch не сбрасывает fence counter", () =>
    expectScenario("a10-same-epoch-fence"))

  test("A10: старые runtime/native generations отклоняются", () =>
    expectScenario("a10-generation-fence"))

  test("A16: две AX кандидатуры для одного CG остаются ambiguous", () =>
    expectScenario("a16-ambiguous-mapping"))
})
