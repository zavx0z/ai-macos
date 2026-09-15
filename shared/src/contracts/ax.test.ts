import { describe, expect, test } from "bun:test"
import { axInspectionResultSchema } from "./ax.ts"

const generation = {
  runtimeEpoch: "runtime:1",
  loginSessionId: "login:1",
  nativeGeneration: "native:1",
}
const applicationRef = "application:1"
const snapshotId = "ax-snapshot:1"
const target = {
  kind: "window" as const,
  ref: { ...generation, applicationRef, windowRef: "window:1" },
}

function elementRef(elementRef: string) {
  return { ...generation, applicationRef, snapshotId, elementRef }
}

describe("AX inspection contract", () => {
  test("сохраняет readable nodes с exact snapshot identity", () => {
    const result = axInspectionResultSchema.parse({
      snapshotId,
      target,
      complete: true,
      nodeCount: 2,
      encodedBytes: 512,
      nodes: [
        {
          elementRef: elementRef("element:1"),
          role: "AXWindow",
          subrole: "AXStandardWindow",
          title: "Документ",
          frame: { x: 10, y: 20, width: 800, height: 600 },
          actions: ["AXRaise"],
        },
        {
          elementRef: elementRef("element:2"),
          parentElementRef: elementRef("element:1"),
          role: "AXButton",
          subrole: "",
          title: "Сохранить",
          actions: ["AXPress"],
        },
      ],
      errors: [],
    })
    expect(result.nodes[1]?.parentElementRef?.snapshotId).toBe(snapshotId)
  })

  test("отклоняет foreign generation, duplicate node и false complete", () => {
    const base = {
      snapshotId,
      target,
      complete: true,
      nodeCount: 2,
      encodedBytes: 512,
      nodes: [
        { elementRef: elementRef("element:1"), role: "AXWindow", subrole: "", title: "", actions: [] },
        { elementRef: { ...elementRef("element:1"), nativeGeneration: "native:other" }, role: "AXButton", subrole: "", title: "", actions: [] },
      ],
      errors: [],
    }
    expect(axInspectionResultSchema.safeParse(base).success).toBe(false)
    expect(axInspectionResultSchema.safeParse({
      ...base,
      nodeCount: 0,
      nodes: [],
      errors: [{
        code: "inventory-incomplete",
        message: "AX deadline exceeded",
        stage: "ax-inspect",
        retryable: true,
        replayAllowed: false,
        recoveryAction: "retry-observation",
      }],
    }).success).toBe(false)
  })

  test("incomplete snapshot требует cursor или typed error", () => {
    expect(axInspectionResultSchema.safeParse({
      snapshotId,
      target,
      complete: false,
      nodeCount: 0,
      encodedBytes: 128,
      nodes: [],
      errors: [],
    }).success).toBe(false)
  })
})
