import { describe, expect, test } from "bun:test"
import {
  INPUT_BUDGETS,
  INPUT_SEQUENCE_LIMITS,
  InputPlanError,
  planActionBudget,
  planClick,
  planDrag,
  planHover,
  planKey,
  planScroll,
  planShortcuts,
  planText,
  remainingActionBudget,
} from "../src/action-plan.ts"

describe("input budgets", () => {
  test("ограничивает локальный budget сроком типа действия", () => {
    expect(planActionBudget("pointer", 20_000, 1_000)).toEqual({
      startedAtMs: 1_000,
      deadlineAtMs: 6_000,
      limitMs: INPUT_BUDGETS.shortSequenceMs,
    })
    expect(planActionBudget("typing", 20_000, 1_000).deadlineAtMs).toBe(20_000)
  })

  test("отклоняет истёкший срок и не возвращает отрицательный остаток", () => {
    expect(() => planActionBudget("pointer", 1_000, 1_000)).toThrow("уже истёк")
    expect(remainingActionBudget({ startedAtMs: 0, deadlineAtMs: 5, limitMs: 5 }, 10)).toBe(0)
  })
})

describe("pointer plans", () => {
  test("hover и click сохраняют точную точку", () => {
    expect(planHover({ x: -120.5, y: 42 })).toEqual({
      kind: "hover",
      point: { x: -120.5, y: 42 },
    })
    expect(planClick({ point: { x: 10, y: 20 }, button: "right", count: 2 })).toEqual({
      kind: "click",
      point: { x: 10, y: 20 },
      button: "right",
      count: 2,
    })
  })

  test("scroll требует явный anchor и ненулевое направление", () => {
    expect(planScroll({ anchor: { x: 50, y: 60 }, dy: 3 })).toEqual({
      kind: "scroll",
      anchor: { x: 50, y: 60 },
      dx: 0,
      dy: 3,
      unit: "line",
    })
    expect(() => planScroll({ anchor: { x: 50, y: 60 } })).toThrow("ненулевой")
  })

  test("drag сохраняет промежуточную траекторию и время", () => {
    expect(planDrag({
      points: [{ x: 0, y: 0 }, { x: 5, y: 7 }, { x: 10, y: 10 }],
      durationMs: 400,
      modifiers: ["cmd", "command", "shift"],
    })).toEqual({
      kind: "drag",
      button: "left",
      durationMs: 400,
      modifiers: ["cmd", "shift"],
      trajectory: [
        { point: { x: 0, y: 0 }, atMs: 0 },
        { point: { x: 5, y: 7 }, atMs: 200 },
        { point: { x: 10, y: 10 }, atMs: 400 },
      ],
    })
  })

  test("приводит modifier aliases к native canonical order", () => {
    expect(planDrag({
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      durationMs: 10,
      modifiers: ["control", "option", "command", "shift", "cmd"],
    }).modifiers).toEqual(["cmd", "shift", "alt", "ctrl"])
  })

  test("drag ограничен числом точек и общим временем", () => {
    const tooMany = Array.from({ length: INPUT_SEQUENCE_LIMITS.dragPoints + 1 }, (_, x) => ({ x, y: 0 }))
    expect(() => planDrag({ points: tooMany, durationMs: 100 })).toThrow("точек")
    expect(() => planDrag({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], durationMs: 5_001 })).toThrow("durationMs")
    expect(() => planDrag({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], durationMs: 0.2 })).toThrow("durationMs")
  })

  test("последняя точка drag получает точный duration timestamp", () => {
    const plan = planDrag({
      points: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 10, y: 10 }, { x: 20, y: 30 }],
      durationMs: 401,
    })

    expect(plan.trajectory.at(-1)?.atMs).toBe(401)
  })

  test("не принимает NaN как координату", () => {
    expect(() => planClick({ point: { x: Number.NaN, y: 1 } })).toThrow(InputPlanError)
  })
})

describe("keyboard plans", () => {
  test("не разрывает emoji и составные grapheme clusters", () => {
    const text = "A👨‍👩‍👧‍👦е́Б"
    const plan = planText({ text, chunkUtf16Units: 2 })

    expect(plan.chunks.map((chunk) => chunk.text)).toEqual(["A", "👨‍👩‍👧‍👦", "е́", "Б"])
    expect(plan.chunks.map((chunk) => chunk.graphemeCount)).toEqual([1, 1, 1, 1])
    expect(plan.chunks.map((chunk) => chunk.text).join("")).toBe(text)
  })

  test("считает chunk target мягким и сохраняет большой grapheme целиком", () => {
    const grapheme = `a${"\u0301".repeat(50)}`
    const plan = planText({ text: grapheme, chunkUtf16Units: 20 })

    expect(plan.softChunkUtf16Units).toBe(20)
    expect(plan.chunks).toEqual([{ text: grapheme, utf16Units: 51, graphemeCount: 1 }])
    expect(plan.schedule).toEqual([{ text: grapheme, utf16Units: 51, atMs: 0 }])
  })

  test("задаёт delay между grapheme clusters и строит точный schedule", () => {
    const plan = planText({ text: "A😀Б", delayMs: 25 })

    expect(plan.estimatedDurationMs).toBe(50)
    expect(plan.schedule).toEqual([
      { text: "A", utf16Units: 1, atMs: 0 },
      { text: "😀", utf16Units: 2, atMs: 25 },
      { text: "Б", utf16Units: 1, atMs: 50 },
    ])
  })

  test("отклоняет известные typing delays сверх общего budget", () => {
    expect(() => planText({ text: "x".repeat(100), delayMs: 5_000 })).toThrow("задержки typing")
  })

  test("считает лимит текста в UTF-16 units", () => {
    expect(planText({ text: "😀" }).utf16Units).toBe(2)
    expect(() => planText({ text: "x".repeat(INPUT_BUDGETS.typingUtf16Units + 1) })).toThrow("UTF-16")
  })

  test("добавляет shift для заглавной латинской клавиши", () => {
    expect(planKey("A")).toMatchObject({
      keyCode: 0,
      modifiers: ["shift"],
      modifierFlags: 0x0002_0000,
    })
  })

  test("валидирует все шаги shortcut до исполнения", () => {
    expect(planShortcuts({ shortcuts: ["cmd+l", "enter"], delayMs: 50 }).steps).toHaveLength(2)
    expect(() => planShortcuts({ shortcuts: ["cmd+l", "hyper+x"] })).toThrow("modifier")
  })

  test("не допускает sequence, чьи задержки превышают short budget", () => {
    expect(() => planShortcuts({ shortcuts: ["cmd+a", "cmd+c", "cmd+v"], delayMs: 3_000 })).toThrow("превышают")
  })
})
