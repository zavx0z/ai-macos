import { describe, expect, test } from "bun:test"
import {
  acceptanceScenarios,
  acceptanceSutEvidence,
  type AcceptanceScenario
} from "./matrix"

const nativeSutIds: AcceptanceScenario["id"][] = [
  "A04",
  "A06",
  "A07",
  "A08",
  "A09",
  "A10",
  "A16"
]

describe("computer use acceptance matrix", () => {
  test("регистр содержит все 45 последовательных сценариев", () => {
    const expectedIds = Array.from(
      { length: 45 },
      (_, index) =>
        `A${String(index + 1).padStart(2, "0")}` as AcceptanceScenario["id"]
    )

    expect(acceptanceScenarios.map((scenario) => scenario.id)).toEqual(expectedIds)
    expect(new Set(acceptanceScenarios.map((scenario) => scenario.id)).size).toBe(45)
  })

  test("native evidence относится только к сценариям реального C SUT", () => {
    const actual = Object.entries(acceptanceSutEvidence)
      .filter(([, evidence]) => evidence?.includes("native-c"))
      .map(([id]) => id)

    expect(actual).toEqual(nativeSutIds)
  })

  test("A02/A31 не получают evidence от in-process substitutes", () => {
    expect(acceptanceSutEvidence.A02).toBeUndefined()
    expect(acceptanceSutEvidence.A31).toBeUndefined()
  })

  test("live-сценарии сохраняют явную live prerequisite", () => {
    const invalid = acceptanceScenarios.filter(
      (scenario) =>
        scenario.evidence.includes("live") &&
        !["native-live", "C1", "C3", "C4"].includes(scenario.prerequisite)
    )

    expect(invalid).toEqual([])
  })
})
