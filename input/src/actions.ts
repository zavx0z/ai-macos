import {
  pointSchema,
  z,
  type Point,
} from "@meta/shared/contracts"
import {
  INPUT_BUDGETS,
  INPUT_SEQUENCE_LIMITS,
  type ClickPlan,
  type DragPlan,
  type HoverPlan,
  type KeyPlan,
  type ScrollPlan,
  type ShortcutPlan,
  type TextPlan,
} from "./action-plan.ts"

export const mouseButtonSchema = z.enum(["left", "right", "middle"])
export const scrollUnitSchema = z.enum(["line", "pixel"])

export const hoverActionSchema = z.strictObject({
  kind: z.literal("hover"),
  point: pointSchema,
})

export const clickActionSchema = z.strictObject({
  kind: z.literal("click"),
  point: pointSchema,
  button: mouseButtonSchema.default("left"),
  count: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
})

export const scrollActionSchema = z.strictObject({
  kind: z.literal("scroll"),
  anchor: pointSchema,
  dx: z.number().finite().default(0),
  dy: z.number().finite().default(0),
  unit: scrollUnitSchema.default("line"),
}).refine(action => action.dx !== 0 || action.dy !== 0, {
  path: ["dy"],
  message: "scroll требует ненулевой dx или dy",
})

export const dragActionSchema = z.strictObject({
  kind: z.literal("drag"),
  points: z.array(pointSchema).min(2).max(INPUT_SEQUENCE_LIMITS.dragPoints),
  durationMs: z.number().int().min(1).max(INPUT_BUDGETS.shortSequenceMs),
  button: mouseButtonSchema.default("left"),
  modifiers: z.array(z.string().min(1).max(32)).max(16).default([]),
})

export const textActionSchema = z.strictObject({
  kind: z.literal("text"),
  text: z.string().min(1).max(INPUT_BUDGETS.typingUtf16Units),
  delayMs: z.number().int().min(0).max(INPUT_BUDGETS.shortSequenceMs).default(0),
})

export const keyActionSchema = z.strictObject({
  kind: z.literal("key"),
  key: z.string().min(1).max(64),
  modifiers: z.array(z.string().min(1).max(32)).max(16).default([]),
})

export const shortcutActionSchema = z.strictObject({
  kind: z.literal("shortcut"),
  shortcuts: z.array(z.string().min(1).max(256)).min(1).max(INPUT_SEQUENCE_LIMITS.shortcutSteps),
  delayMs: z.number().int().min(0).max(INPUT_BUDGETS.shortSequenceMs).default(0),
})

export const inputActionSchema = z.discriminatedUnion("kind", [
  hoverActionSchema,
  clickActionSchema,
  scrollActionSchema,
  dragActionSchema,
  textActionSchema,
  keyActionSchema,
  shortcutActionSchema,
])

export type HoverAction = z.infer<typeof hoverActionSchema>
export type ClickAction = z.infer<typeof clickActionSchema>
export type ScrollAction = z.infer<typeof scrollActionSchema>
export type DragAction = z.infer<typeof dragActionSchema>
export type TextAction = z.infer<typeof textActionSchema>
export type KeyAction = z.infer<typeof keyActionSchema>
export type ShortcutAction = z.infer<typeof shortcutActionSchema>
export type InputAction = z.infer<typeof inputActionSchema>
export type PointerInputAction = HoverAction | ClickAction | ScrollAction | DragAction
export type KeyboardInputAction = TextAction | KeyAction | ShortcutAction

export type InputActionPlan =
  | HoverPlan
  | ClickPlan
  | ScrollPlan
  | DragPlan
  | TextPlan
  | KeyPlan
  | ShortcutPlan

export type InputActionResult = Readonly<{
  kind: InputAction["kind"]
  dispatchedUnits: number
  destinationPoints: readonly Point[]
  ownershipProofRefs: readonly string[]
}>

export const inputActionResultSchema = z.strictObject({
  kind: z.enum(["hover", "click", "scroll", "drag", "text", "key", "shortcut"]),
  dispatchedUnits: z.number().int().min(0).max(10_000),
  destinationPoints: z.array(pointSchema).max(INPUT_SEQUENCE_LIMITS.dragPoints),
  ownershipProofRefs: z.array(z.string().min(1).max(127)).max(INPUT_SEQUENCE_LIMITS.dragPoints),
})

export function pointerActionPoints(action: PointerInputAction): readonly Point[] {
  switch (action.kind) {
    case "hover":
    case "click":
      return [action.point]
    case "scroll":
      return [action.anchor]
    case "drag":
      return action.points
  }
}
