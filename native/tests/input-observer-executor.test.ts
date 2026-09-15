import { beforeAll, afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeOperationStatusSchema } from "@meta/shared/contracts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-input-observer."))
  binary = join(directory, "fixture")
  const root = join(import.meta.dir, "..")
  const compile = Bun.spawn([
    "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    `-I${join(root, "include")}`,
    ...["input_job.m", "input_executor.m", "input_bridge.c", "executor.c", "ledger.c"].map(file => join(root, "src", file)),
    join(root, "tests/input_observer_executor_fixture.m"), "-framework", "Foundation", "-o", binary,
  ], { stderr: "pipe" })
  const [exit, error] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (exit !== 0) throw new Error(error)
}, 20_000)
afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true }) })

test.each([
  { mode: "own", execution: "finished", posts: 2, cleanups: 0, interference: "none-observed" },
  { mode: "foreign", execution: "cancelled", posts: 2, cleanups: 1, interference: "observed" },
  { mode: "foreign-cancel", execution: "cancelled", posts: 2, cleanups: 1, interference: "observed" },
  { mode: "gap", execution: "cancelled", posts: 2, cleanups: 1, interference: "unknown" },
  { mode: "missing", execution: "failed", posts: 0, cleanups: 0, interference: "unknown" },
  { mode: "slow-point-foreign", execution: "cancelled", posts: 3, cleanups: 1, interference: "observed" },
  { mode: "up-ack-foreign", execution: "cancelled", posts: 2, cleanups: 1, interference: "observed" },
])("input observer lifecycle: $mode", async scenario => {
  const process = Bun.spawn([binary, scenario.mode], { stdout: "pipe", stderr: "pipe" })
  const [exit, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
  if (exit !== 0) throw new Error(await new Response(process.stderr).text())
  const result = JSON.parse(output)
  const status = nativeOperationStatusSchema.parse(result.report.status)
  expect([status.execution, status.userInterference, status.cleanup, status.quarantined, result.posts, result.cleanups]).toEqual([
    scenario.execution, scenario.interference, "complete", false, scenario.posts, scenario.cleanups,
  ])
  if (scenario.mode === "slow-point-foreign") expect(result.pointerPosts).toBe(1)
})
