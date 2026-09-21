import { expect, test } from "bun:test"
import { matchPipelineCondition, pipelineConditionSchema, relativeRegion,
  type PipelineObservation, type PipelineCondition } from "../src/pipeline-conditions.ts"

export function dialogObservation(options: { dx?: number, dy?: number, scale?: number, web?: boolean, image?: boolean } = {}): PipelineObservation {
  const { dx = 0, dy = 0, scale = 1 } = options
  const frame = (x: number, y: number, width: number, height: number) => ({ x: dx + x * scale, y: dy + y * scale, width: width * scale, height: height * scale })
  const nodes: PipelineObservation["elements"] = [
    { elementId: "window:1", role: "AXWindow", subrole: "AXStandardWindow", title: "Chrome", frame: frame(0, 0, 1000, 800), actions: [] },
    ...(options.web ? [{ elementId: "web:1", parentElementId: "window:1", role: "AXWebArea", subrole: "", title: "ChatGPT", frame: frame(0, 40, 1000, 760), actions: [] }] : []),
    { elementId: "dialog:1", parentElementId: options.web ? "web:1" : "window:1", role: options.image ? "AXImage" : "AXGroup",
      subrole: options.image ? "" : "AXApplicationAlertDialog", title: "Разрешить удалённую отладку?", frame: frame(300, 250, 400, 240), actions: [] },
    { elementId: "cancel:1", parentElementId: "dialog:1", role: "AXButton", subrole: "", title: "Отмена", frame: frame(460, 420, 90, 30), actions: ["AXPress"] },
    { elementId: "allow:1", parentElementId: "dialog:1", role: "AXButton", subrole: "", title: "Разрешить", frame: frame(570, 420, 100, 30), actions: ["AXPress"] },
  ]
  return { targetId: "target:test", state: "", complete: true, errors: [], elements: nodes }
}
export const dialogCondition: PipelineCondition = pipelineConditionSchema.parse({
  origin: "native-dialog", select: "allow", anchors: [
    { name: "dialog", selector: { subrole: "AXApplicationAlertDialog", text: "Разрешить удалённую отладку?" },
      region: { x: 0.25, y: 0.2, width: 0.5, height: 0.5, tolerance: 0.05 } },
    { name: "cancel", within: "dialog", selector: { role: "AXButton", text: "Отмена" } },
    { name: "allow", within: "dialog", rightOf: "cancel", selector: { role: "AXButton", text: "Разрешить" },
      region: { x: 0.5, y: 0.6, width: 0.5, height: 0.4 } },
  ],
})

for (const [dx, dy, scale] of [[0, 0, 1], [-1900, 100, 1], [900, -200, 2], [15, 50, 0.75]]) {
  test(`anchors follow window move/resize (${dx},${dy},${scale})`, () => {
    const result = matchPipelineCondition(dialogObservation({ dx, dy, scale }), "target:test", dialogCondition)
    expect(result.state).toBe("matched")
    if (result.state === "matched") {
      expect(result.selected.elementId).toBe("allow:1")
      expect(result.selected.frame!.x).toBe(dx! + 570 * scale!)
      expect(result.source).toBe("ax")
    }
  })
}
test("region tolerance expands search inside anchor only", () => {
  const r = relativeRegion({ x: 100, y: -40, width: 1000, height: 500 },
    { x: 0.05, y: 0.1, width: 0.3, height: 0.4, tolerance: 0.1 })
  expect(r.x).toBe(100); expect(r.y).toBe(-40)
  expect(r.width).toBeCloseTo(450, 9); expect(r.height).toBeCloseTo(300, 9)
})

test("unknown geometry of a second possible candidate is not silently ignored", () => {
  const snapshot = dialogObservation()
  snapshot.elements.push({ ...snapshot.elements.at(-1)!, elementId: "allow:unknown", frame: undefined })
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("unavailable")
})
test("nearby different text is not exact text", () => {
  const snapshot = dialogObservation()
  snapshot.elements.at(-1)!.title = "Разрешить всегда"
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("not-found")
})
test("duplicate candidate is ambiguous, never choose nearest", () => {
  const snapshot = dialogObservation()
  snapshot.elements.push({ ...snapshot.elements.at(-1)!, elementId: "allow:2" })
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("ambiguous")
})
test("fake dialog inside web accessibility tree cannot grant consent", () => {
  const snapshot = dialogObservation({ web: true })
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("unavailable")
})
test("screenshot of permission dialog is not a native dialog", () => {
  const snapshot = dialogObservation({ image: true })
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("not-found")
  expect(matchPipelineCondition({ ...snapshot, elements: [], imageId: "image:1", width: 960, height: 600 }, snapshot.targetId, dialogCondition).state).toBe("unavailable")
})
test("incomplete, foreign or cyclic snapshots fail closed", () => {
  const snapshot = dialogObservation()
  expect(matchPipelineCondition({ ...snapshot, complete: false }, snapshot.targetId, dialogCondition).state).toBe("unavailable")
  expect(matchPipelineCondition(snapshot, "target:foreign", dialogCondition).state).toBe("unavailable")
  snapshot.elements[1]!.parentElementId = "allow:1"
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("unavailable")
})
test("parent links and regions cannot come from a prior snapshot", () => {
  const snapshot = dialogObservation()
  snapshot.elements.at(-1)!.parentElementId = "dialog:old"
  expect(matchPipelineCondition(snapshot, snapshot.targetId, dialogCondition).state).toBe("unavailable")
  expect(() => pipelineConditionSchema.parse({ ...dialogCondition, anchors: [
    { name: "allow", within: "dialog:old", selector: { text: "Разрешить" } },
  ] })).toThrow()
})
