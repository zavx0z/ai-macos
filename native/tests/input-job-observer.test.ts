import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeOperationStatusSchema } from "@meta/shared/contracts"

test("Native job публикует текущую coverage без чужого generation и фиктивного restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-job-observer."))
  try {
    const binary = join(directory, "fixture")
    const root = join(import.meta.dir, "..")
    const compile = Bun.spawn([
      "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
      `-I${join(root, "include")}`, join(root, "src/input_job.m"),
      join(root, "tests/input_job_observer_fixture.m"), "-framework", "Foundation", "-o", binary,
    ], { stderr: "pipe" })
    const [code, errors] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
    if (code !== 0) throw new Error(errors)
    const process = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
    const [exit, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
    if (exit !== 0) throw new Error(await new Response(process.stderr).text())
    const reports = nativeOperationStatusSchema.array().parse(JSON.parse(output))
    expect(reports.map(report => [report.observer.state, report.userInterference, report.restorationAllowed])).toEqual([
      ["unavailable", "unknown", false],
      ["ready", "none-observed", true],
      ["unavailable", "unknown", false],
      ["revoked", "unknown", false],
    ])
  } finally {
    await rm(directory, { recursive: true })
  }
}, 20_000)
