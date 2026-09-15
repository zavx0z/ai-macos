import { KEY_CODES, modifierFlags, parseShortcut } from "./keys.ts"
import type { Point } from "@meta/shared/contracts"

export const INPUT_BUDGETS = {
  shortSequenceMs: 5_000,
  typingMs: 30_000,
  typingUtf16Units: 10_000,
} as const

export const INPUT_SEQUENCE_LIMITS = {
  textChunkUtf16Units: 20,
  dragPoints: 512,
  shortcutSteps: 64,
} as const

export type InputPlanErrorCode =
  | "invalid-input"
  | "budget-exceeded"
  | "unsupported-key"
  | "unsupported-modifier"

export class InputPlanError extends Error {
  constructor(
    readonly code: InputPlanErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "InputPlanError"
  }
}

export type InputActionKind = "pointer" | "keyboard" | "typing"

export type ActionBudget = Readonly<{
  startedAtMs: number
  deadlineAtMs: number
  limitMs: number
}>

export function planActionBudget(
  kind: InputActionKind,
  operationDeadlineAtMs: number,
  nowMs: number,
): ActionBudget {
  if (!Number.isFinite(nowMs) || !Number.isFinite(operationDeadlineAtMs)) {
    throw new InputPlanError("invalid-input", "deadline и текущее время должны быть конечными числами")
  }
  if (operationDeadlineAtMs <= nowMs) {
    throw new InputPlanError("budget-exceeded", "срок операции уже истёк")
  }

  const limitMs = kind === "typing" ? INPUT_BUDGETS.typingMs : INPUT_BUDGETS.shortSequenceMs
  return {
    startedAtMs: nowMs,
    deadlineAtMs: Math.min(operationDeadlineAtMs, nowMs + limitMs),
    limitMs,
  }
}

export function remainingActionBudget(budget: ActionBudget, nowMs: number): number {
  if (!Number.isFinite(nowMs)) {
    throw new InputPlanError("invalid-input", "текущее время должно быть конечным числом")
  }
  return Math.max(0, budget.deadlineAtMs - nowMs)
}

export type InputPoint = Readonly<Point>

export type MouseButton = "left" | "right" | "middle"
export type ClickCount = 1 | 2 | 3
export type ScrollUnit = "line" | "pixel"

export type HoverPlan = Readonly<{
  kind: "hover"
  point: InputPoint
}>

export type ClickPlan = Readonly<{
  kind: "click"
  point: InputPoint
  button: MouseButton
  count: ClickCount
}>

export type ScrollPlan = Readonly<{
  kind: "scroll"
  anchor: InputPoint
  dx: number
  dy: number
  unit: ScrollUnit
}>

export type TimedDragPoint = Readonly<{
  point: InputPoint
  atMs: number
}>

export type DragPlan = Readonly<{
  kind: "drag"
  button: MouseButton
  durationMs: number
  modifiers: readonly string[]
  trajectory: readonly TimedDragPoint[]
}>

function normalizePoint(value: InputPoint, field: string): InputPoint {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new InputPlanError("invalid-input", `${field} должен содержать конечные x и y`)
  }
  return { x: value.x, y: value.y }
}

function normalizeButton(value: MouseButton | undefined): MouseButton {
  const button = value ?? "left"
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new InputPlanError("invalid-input", `неподдерживаемая кнопка мыши: ${String(button)}`)
  }
  return button
}

export function planHover(point: InputPoint): HoverPlan {
  return { kind: "hover", point: normalizePoint(point, "point") }
}

export function planClick(input: {
  point: InputPoint
  button?: MouseButton
  count?: number
}): ClickPlan {
  const count = input.count ?? 1
  if (count !== 1 && count !== 2 && count !== 3) {
    throw new InputPlanError("invalid-input", "count должен быть равен 1, 2 или 3")
  }
  return {
    kind: "click",
    point: normalizePoint(input.point, "point"),
    button: normalizeButton(input.button),
    count,
  }
}

export function planScroll(input: {
  anchor: InputPoint
  dx?: number
  dy?: number
  unit?: ScrollUnit
}): ScrollPlan {
  const dx = input.dx ?? 0
  const dy = input.dy ?? 0
  const unit = input.unit ?? "line"
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new InputPlanError("invalid-input", "scroll delta должен быть конечным числом")
  }
  if (dx === 0 && dy === 0) {
    throw new InputPlanError("invalid-input", "scroll требует ненулевой dx или dy")
  }
  if (unit !== "line" && unit !== "pixel") {
    throw new InputPlanError("invalid-input", `неподдерживаемая единица scroll: ${String(unit)}`)
  }
  return {
    kind: "scroll",
    anchor: normalizePoint(input.anchor, "anchor"),
    dx,
    dy,
    unit,
  }
}

function normalizeModifiers(modifiers: readonly string[]): readonly string[] {
  const normalized: string[] = []
  const seen = new Set<number>()
  const canonicalByFlag = new Map<number, string>([
    [0x0010_0000, "cmd"],
    [0x0002_0000, "shift"],
    [0x0008_0000, "alt"],
    [0x0004_0000, "ctrl"],
    [0x0080_0000, "fn"],
  ])
  for (const modifier of modifiers) {
    let flag: number
    try {
      flag = modifierFlags([modifier])
    } catch {
      throw new InputPlanError("unsupported-modifier", `неподдерживаемый modifier: ${modifier}`)
    }
    if (seen.has(flag)) continue
    seen.add(flag)
    const canonical = canonicalByFlag.get(flag)
    if (canonical === undefined) {
      throw new InputPlanError("unsupported-modifier", `нет canonical modifier для ${modifier}`)
    }
    normalized.push(canonical)
  }
  const order = ["cmd", "shift", "alt", "ctrl", "fn"]
  return normalized.sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

export function planDrag(input: {
  points: readonly InputPoint[]
  durationMs: number
  button?: MouseButton
  modifiers?: readonly string[]
}): DragPlan {
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0 || input.durationMs > INPUT_BUDGETS.shortSequenceMs) {
    throw new InputPlanError(
      "budget-exceeded",
      `durationMs должен быть в пределах 1..${INPUT_BUDGETS.shortSequenceMs}`,
    )
  }
  if (input.points.length < 2) {
    throw new InputPlanError("invalid-input", "drag требует как минимум начальную и конечную точки")
  }
  if (input.points.length > INPUT_SEQUENCE_LIMITS.dragPoints) {
    throw new InputPlanError(
      "budget-exceeded",
      `drag содержит больше ${INPUT_SEQUENCE_LIMITS.dragPoints} точек`,
    )
  }

  const denominator = input.points.length - 1
  const trajectory = input.points.map((point, index) => ({
    point: normalizePoint(point, `points[${index}]`),
    atMs: Math.round(input.durationMs * index / denominator),
  }))

  return {
    kind: "drag",
    button: normalizeButton(input.button),
    durationMs: input.durationMs,
    modifiers: normalizeModifiers(input.modifiers ?? []),
    trajectory,
  }
}

export type TextChunk = Readonly<{
  text: string
  utf16Units: number
  graphemeCount: number
}>

export type TextPlan = Readonly<{
  kind: "text"
  utf16Units: number
  graphemeCount: number
  delayMs: number
  estimatedDurationMs: number
  softChunkUtf16Units: number
  chunks: readonly TextChunk[]
  schedule: readonly TextScheduleStep[]
}>

export type TextScheduleStep = Readonly<{
  text: string
  utf16Units: number
  atMs: number
}>

function segmentGraphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return Array.from(segmenter.segment(text), ({ segment }) => segment)
}

export function planText(input: {
  text: string
  delayMs?: number
  chunkUtf16Units?: number
}): TextPlan {
  const utf16Units = input.text.length
  const delayMs = input.delayMs ?? 0
  const chunkLimit = input.chunkUtf16Units ?? INPUT_SEQUENCE_LIMITS.textChunkUtf16Units
  if (utf16Units > INPUT_BUDGETS.typingUtf16Units) {
    throw new InputPlanError(
      "budget-exceeded",
      `текст содержит больше ${INPUT_BUDGETS.typingUtf16Units} UTF-16 units`,
    )
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > INPUT_BUDGETS.shortSequenceMs) {
    throw new InputPlanError("invalid-input", `delayMs должен быть целым числом от 0 до ${INPUT_BUDGETS.shortSequenceMs}`)
  }
  if (!Number.isInteger(chunkLimit) || chunkLimit <= 0) {
    throw new InputPlanError("invalid-input", "chunkUtf16Units должен быть положительным целым числом")
  }

  const graphemes = segmentGraphemes(input.text)
  const estimatedDurationMs = delayMs * Math.max(0, graphemes.length - 1)
  if (estimatedDurationMs > INPUT_BUDGETS.typingMs) {
    throw new InputPlanError(
      "budget-exceeded",
      `известные задержки typing превышают ${INPUT_BUDGETS.typingMs} мс`,
    )
  }
  const chunks: TextChunk[] = []
  let current = ""
  let currentCount = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({ text: current, utf16Units: current.length, graphemeCount: currentCount })
    current = ""
    currentCount = 0
  }

  for (const grapheme of graphemes) {
    if (current.length > 0 && current.length + grapheme.length > chunkLimit) flush()
    current += grapheme
    currentCount++
  }
  flush()

  const schedule = graphemes.map((text, index) => ({
    text,
    utf16Units: text.length,
    atMs: index * delayMs,
  }))

  return {
    kind: "text",
    utf16Units,
    graphemeCount: graphemes.length,
    delayMs,
    estimatedDurationMs,
    softChunkUtf16Units: chunkLimit,
    chunks,
    schedule,
  }
}

export type KeyPlan = Readonly<{
  kind: "key"
  key: string
  keyCode: number
  modifiers: readonly string[]
  modifierFlags: number
}>

export function planKey(key: string, modifiers: readonly string[] = []): KeyPlan {
  const lower = key.toLowerCase()
  const keyCode = KEY_CODES[lower]
  if (keyCode === undefined) {
    throw new InputPlanError("unsupported-key", `неподдерживаемая клавиша: ${key}`)
  }
  const normalizedModifiers = [...normalizeModifiers(modifiers)]
  if (key.length === 1 && key !== lower && !normalizedModifiers.includes("shift")) {
    normalizedModifiers.push("shift")
  }
  return {
    kind: "key",
    key,
    keyCode,
    modifiers: normalizedModifiers,
    modifierFlags: modifierFlags(normalizedModifiers),
  }
}

export type ShortcutPlan = Readonly<{
  kind: "shortcut"
  steps: readonly KeyPlan[]
  delayMs: number
}>

export function planShortcuts(input: {
  shortcuts: readonly string[]
  delayMs?: number
}): ShortcutPlan {
  if (input.shortcuts.length === 0) {
    throw new InputPlanError("invalid-input", "shortcut sequence не может быть пустой")
  }
  if (input.shortcuts.length > INPUT_SEQUENCE_LIMITS.shortcutSteps) {
    throw new InputPlanError(
      "budget-exceeded",
      `shortcut sequence содержит больше ${INPUT_SEQUENCE_LIMITS.shortcutSteps} шагов`,
    )
  }
  const delayMs = input.delayMs ?? 0
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > INPUT_BUDGETS.shortSequenceMs) {
    throw new InputPlanError("invalid-input", `delayMs должен быть целым числом от 0 до ${INPUT_BUDGETS.shortSequenceMs}`)
  }
  const steps = input.shortcuts.map((shortcut) => {
    const parsed = parseShortcut(shortcut)
    return planKey(parsed.key, parsed.modifiers)
  })
  const estimatedDelayMs = delayMs * Math.max(0, steps.length - 1)
  if (estimatedDelayMs > INPUT_BUDGETS.shortSequenceMs) {
    throw new InputPlanError(
      "budget-exceeded",
      `задержки shortcut sequence превышают ${INPUT_BUDGETS.shortSequenceMs} мс`,
    )
  }
  return { kind: "shortcut", steps, delayMs }
}
