import { describe, expect, test } from "bun:test"
import {
  acceptanceProfileProbes,
  buildAcceptanceProfile,
  type AcceptanceProbeOutcome
} from "./profile-runner"

function outcomes(status: "pass" | "fail"): AcceptanceProbeOutcome[] {
  return acceptanceProfileProbes.map((probe) => ({
    probeId: probe.probeId,
    status,
    durationMs: 1,
    command: `bun test ${probe.path}`
  }))
}

describe("acceptance profile runner", () => {
  test("зелёные safe probes не превращают missing live/transport evidence в pass", () => {
    const profile = buildAcceptanceProfile(outcomes("pass"))
    const passed = profile.scenarios
      .filter((scenario) => scenario.status === "pass")
      .map((scenario) => scenario.id)

    expect(profile.scenarios).toHaveLength(45)
    expect(passed).toEqual(["A03", "A06", "A08", "A09", "A10", "A11", "A38"])
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
})
