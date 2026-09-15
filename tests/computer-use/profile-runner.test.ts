import { describe, expect, test } from "bun:test"
import {
  acceptanceProfileProbes,
  buildAcceptanceProfile,
  classifyProbeExecution,
  runBoundedCommand,
  type AcceptanceProbeOutcome
} from "./profile-runner"

function outcomes(status: "pass" | "fail"): AcceptanceProbeOutcome[] {
  return acceptanceProfileProbes.map((probe) => ({
    probeId: probe.probeId,
    status,
    durationMs: 1,
    command: `bun test ${probe.path}`,
    tests: { passed: 1, failed: 0, skipped: 0 }
  }))
}

describe("acceptance profile runner", () => {
  test("зелёные safe probes не превращают missing live/transport evidence в pass", () => {
    const profile = buildAcceptanceProfile(outcomes("pass"))
    const passed = profile.scenarios
      .filter((scenario) => scenario.status === "pass")
      .map((scenario) => scenario.id)

    expect(profile.scenarios).toHaveLength(45)
    expect(passed).toEqual(["A03", "A06", "A08", "A09", "A10", "A11", "A38", "A45"])
    expect(profile.scenarios.find((scenario) => scenario.id === "A01")).toMatchObject({
      status: "not-run",
      missingEvidence: ["live"]
    })
    expect(profile.scenarios.find((scenario) => scenario.id === "A05")).toMatchObject({
      status: "not-run",
      missingEvidence: ["integration"]
    })
    expect(profile.scenarios.find((scenario) => scenario.id === "A43")).toMatchObject({
      status: "not-run",
      missingEvidence: ["client-live"]
    })
  })

  test("падение реального probe помечает связанные сценарии fail", () => {
    const probeOutcomes = outcomes("pass").map((outcome) =>
      outcome.probeId === "native" ? { ...outcome, status: "fail" as const } : outcome
    )
    const profile = buildAcceptanceProfile(probeOutcomes)

    expect(profile.scenarios.find((scenario) => scenario.id === "A06")?.status).toBe("fail")
    expect(profile.scenarios.find((scenario) => scenario.id === "A16")?.status).toBe("fail")
    expect(profile.scenarios.find((scenario) => scenario.id === "A03")?.status).toBe("pass")
  })

  test("exit 0 со skipped или zero tests не принимается как evidence", () => {
    expect(classifyProbeExecution({
      exitCode: 0,
      stdout: "1 pass\n1 skip",
      stderr: "",
      timedOut: false,
      outputTruncated: false
    })).toMatchObject({
      status: "fail",
      failureReason: "probe-reported-skips"
    })
    expect(classifyProbeExecution({
      exitCode: 0,
      stdout: "Ran 0 tests across 1 file",
      stderr: "",
      timedOut: false,
      outputTruncated: false
    })).toMatchObject({
      status: "fail",
      failureReason: "probe-reported-zero-tests"
    })
  })

  test("timeout и output cap всегда отвергают probe", () => {
    expect(classifyProbeExecution({
      exitCode: 0,
      stdout: "1 pass",
      stderr: "",
      timedOut: true,
      outputTruncated: false
    }).failureReason).toBe("probe-timeout")
    expect(classifyProbeExecution({
      exitCode: 0,
      stdout: "1 pass",
      stderr: "",
      timedOut: false,
      outputTruncated: true
    }).failureReason).toBe("probe-output-limit")
  })

  test("TERM-ignoring subprocess и унаследованный pipe завершаются по global deadline", async () => {
    const script = [
      "process.on('SIGTERM', () => {})",
      `Bun.spawn([${JSON.stringify(process.execPath)}, '-e', \"setTimeout(() => process.exit(0), 800)\"], { stdout: 'inherit', stderr: 'inherit' })`,
      "process.stdout.write('fixture-ready\\n')",
      "setInterval(() => {}, 1000)"
    ].join("\n")
    const startedAt = performance.now()

    const result = await runBoundedCommand({
      command: [process.execPath, "-e", script],
      cwd: process.cwd(),
      timeoutMs: 50,
      termGraceMs: 50,
      readerGraceMs: 75,
      maxOutputBytes: 4096
    })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain("fixture-ready")
    expect(performance.now() - startedAt).toBeLessThan(500)
  })
})
