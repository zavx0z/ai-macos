import { describe, expect, test } from "bun:test"
import { axInspectionResultSchema } from "./ax.ts"
import { rectSchema } from "./observations.ts"

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

  test("AX сохраняет zero bounds и семантические value, не ослабляя capture rect", () => {
    const result = axInspectionResultSchema.parse({
      snapshotId,
      target,
      complete: true,
      nodeCount: 5,
      encodedBytes: 512,
      nodes: [
        { elementRef: elementRef("element:root"), role: "AXWindow", subrole: "AXStandardWindow", title: "Документ",
          identifier: "document-window", description: "Главное окно", frame: { x: 10, y: 20, width: 800, height: 600 }, actions: [] },
        { elementRef: elementRef("element:static"), parentElementRef: elementRef("element:root"), role: "AXStaticText", subrole: "",
          title: "", value: "Состояние готово", frame: { x: 20, y: 40, width: 0, height: 0 }, actions: [] },
        { elementRef: elementRef("element:progress"), parentElementRef: elementRef("element:root"), role: "AXProgressIndicator", subrole: "",
          title: "", value: 0.5, actions: [] },
        { elementRef: elementRef("element:checkbox"), parentElementRef: elementRef("element:root"), role: "AXCheckBox", subrole: "",
          title: "Включено", value: true, actions: [] },
        { elementRef: elementRef("element:secure"), parentElementRef: elementRef("element:root"), role: "AXTextField", subrole: "AXSecureTextField",
          title: "Пароль", valueRedacted: true, actions: [] },
      ],
      errors: [],
    })
    expect(result.nodes).toMatchObject([
      { identifier: "document-window", description: "Главное окно" },
      { title: "", value: "Состояние готово", frame: { width: 0, height: 0 } },
      { value: 0.5 },
      { value: true },
      { valueRedacted: true },
    ])
    expect(rectSchema.safeParse({ x: 20, y: 40, width: 0, height: 0 }).success).toBe(false)
    expect(axInspectionResultSchema.safeParse({
      ...result,
      nodes: result.nodes.map((node, index) => index === 4 ? { ...node, value: "secret" } : node),
    }).success).toBe(false)
  })
})
