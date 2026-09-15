import { describe, expect, test } from "bun:test"
import { NATIVE_EVENT_TEXT_UTF16_LIMIT } from "@meta/native/protocol"
import type { AuthorizedObservationPoint } from "@meta/shared/contracts"
import {
  planClick,
  planDrag,
  planKey,
  planShortcuts,
  planText,
  type TextPlan,
} from "../src/action-plan.ts"
import { compileNativeInputAction } from "../src/native-action.ts"

function authorizedPoint(x: number, y: number): AuthorizedObservationPoint {
  return {
    authorized: true,
    observationId: "observation:1",
    captureTarget: {
      kind: "display",
      ref: {
        runtimeEpoch: "runtime:1",
        loginSessionId: "login:1",
        nativeGeneration: "native:1",
        displayRef: "display:1",
        displayLayoutRevision: 1,
      },
    },
    interactionTarget: {
      kind: "window",
      ref: {
        runtimeEpoch: "runtime:1",
        loginSessionId: "login:1",
        nativeGeneration: "native:1",
        applicationRef: "application:1",
        windowRef: "window:1",
      },
    },
    regionIndex: 0,
    space: {
      kind: "macos-screen",
      display: {
        runtimeEpoch: "runtime:1",
        loginSessionId: "login:1",
        nativeGeneration: "native:1",
        displayRef: "display:1",
        displayLayoutRevision: 1,
      },
    },
    imagePoint: { x, y },
    destinationPoint: { x: x * 2, y: y * 2 },
    frameTimestamp: "2026-09-15T10:00:00.000Z",
    ownershipProofRef: `proof:point:${x}:${y}`,
  }
}

describe("C2 native input action compiler", () => {
  test("использует только авторизованную destination point", () => {
    expect(compileNativeInputAction(
      planClick({ point: { x: 5, y: 6 }, button: "right", count: 2 }),
      [authorizedPoint(5, 6)],
    )).toEqual({
      kind: "click",
      point: { x: 10, y: 12 },
      button: "right",
      count: 2,
      modifiers: { names: [], flags: 0 },
    })
  })

  test("сохраняет drag trajectory и canonical modifier state", () => {
    expect(compileNativeInputAction(
      planDrag({
        points: [{ x: 0, y: 0 }, { x: 4, y: 5 }, { x: 10, y: 10 }],
        durationMs: 401,
        modifiers: ["control", "command"],
      }),
      [authorizedPoint(0, 0), authorizedPoint(4, 5), authorizedPoint(10, 10)],
    )).toEqual({
      kind: "drag",
      button: "left",
      durationMs: 401,
      modifiers: { names: ["cmd", "ctrl"], flags: 0x0014_0000 },
      trajectory: [
        { point: { x: 0, y: 0 }, atMs: 0 },
        { point: { x: 8, y: 10 }, atMs: 201 },
        { point: { x: 20, y: 20 }, atMs: 401 },
      ],
    })
  })

  test("не принимает raw point вместо authorized macOS point", () => {
    expect(() => compileNativeInputAction(
      planClick({ point: { x: 5, y: 6 } }),
      [],
    )).toThrow("authorized macos-screen")
  })

  test("проверяет hard native grapheme limit до dispatch", () => {
    const oversized = "a".repeat(NATIVE_EVENT_TEXT_UTF16_LIMIT + 1)
    const plan = {
      kind: "text",
      utf16Units: oversized.length,
      graphemeCount: 1,
      delayMs: 0,
      estimatedDurationMs: 0,
      softChunkUtf16Units: 20,
      chunks: [{ text: oversized, utf16Units: oversized.length, graphemeCount: 1 }],
      schedule: [{ text: oversized, utf16Units: oversized.length, atMs: 0 }],
    } satisfies TextPlan

    expect(() => compileNativeInputAction(plan, [])).toThrow("hard native limit")
  })

  test("не включает текст в keyboard result metadata и компилирует точные strokes", () => {
    expect(compileNativeInputAction(planText({ text: "Привет 😀" }), [])).toMatchObject({
      kind: "text",
      utf16Units: 9,
      clusters: [
        { text: "П", utf16Units: 1, atMs: 0 },
        { text: "р", utf16Units: 1, atMs: 0 },
        { text: "и", utf16Units: 1, atMs: 0 },
        { text: "в", utf16Units: 1, atMs: 0 },
        { text: "е", utf16Units: 1, atMs: 0 },
        { text: "т", utf16Units: 1, atMs: 0 },
        { text: " ", utf16Units: 1, atMs: 0 },
        { text: "😀", utf16Units: 2, atMs: 0 },
      ],
    })
    expect(compileNativeInputAction(planKey("A"), [])).toEqual({
      kind: "key",
      stroke: { keyCode: 0, flags: 0x0002_0000 },
    })
    expect(compileNativeInputAction(planShortcuts({ shortcuts: ["cmd+l", "enter"], delayMs: 50 }), [])).toEqual({
      kind: "shortcut",
      strokes: [{ keyCode: 37, flags: 0x0010_0000 }, { keyCode: 36, flags: 0 }],
      delayMs: 50,
    })
  })
})
