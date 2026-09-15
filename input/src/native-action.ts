import {
  NATIVE_EVENT_TEXT_UTF16_LIMIT,
  nativeInputActionSchema,
} from "@meta/native/protocol"
import { modifierFlags } from "./keys.ts"
import { InputPlanError } from "./action-plan.ts"
import type { InputActionPlan } from "./actions.ts"
import type { AuthorizedObservationPoint, z } from "@meta/shared/contracts"

export type NativeInputAction = z.infer<typeof nativeInputActionSchema>

export function compileNativeInputAction(
  plan: InputActionPlan,
  authorizedPoints: readonly AuthorizedObservationPoint[],
): NativeInputAction {
  switch (plan.kind) {
    case "hover":
      return nativeInputActionSchema.parse({
        kind: "hover",
        point: requireAuthorizedPoint(authorizedPoints, 0),
        modifiers: nativeModifiers([]),
      })
    case "click":
      return nativeInputActionSchema.parse({
        kind: "click",
        point: requireAuthorizedPoint(authorizedPoints, 0),
        button: plan.button,
        count: plan.count,
        modifiers: nativeModifiers([]),
      })
    case "scroll":
      return nativeInputActionSchema.parse({
        kind: "scroll",
        anchor: requireAuthorizedPoint(authorizedPoints, 0),
        dx: plan.dx,
        dy: plan.dy,
        unit: plan.unit,
        modifiers: nativeModifiers([]),
      })
    case "drag":
      if (authorizedPoints.length !== plan.trajectory.length) {
        throw new InputPlanError("invalid-input", "drag plan и authorized points имеют разную длину")
      }
      return nativeInputActionSchema.parse({
        kind: "drag",
        button: plan.button,
        modifiers: nativeModifiers(plan.modifiers),
        durationMs: plan.durationMs,
        trajectory: plan.trajectory.map((step, index) => ({
          point: requireAuthorizedPoint(authorizedPoints, index),
          atMs: step.atMs,
        })),
      })
    case "text": {
      if (plan.schedule.some(step => step.utf16Units > NATIVE_EVENT_TEXT_UTF16_LIMIT)) {
        throw new InputPlanError(
          "budget-exceeded",
          `grapheme превышает hard native limit ${NATIVE_EVENT_TEXT_UTF16_LIMIT} UTF-16 units`,
        )
      }
      if (plan.utf16Units > NATIVE_EVENT_TEXT_UTF16_LIMIT) {
        throw new InputPlanError(
          "budget-exceeded",
          `text action превышает hard native limit ${NATIVE_EVENT_TEXT_UTF16_LIMIT} UTF-16 units`,
        )
      }
      return nativeInputActionSchema.parse({
        kind: "text",
        utf16Units: plan.utf16Units,
        clusters: plan.schedule.map(cluster => ({
          text: cluster.text,
          utf16Units: cluster.utf16Units,
          atMs: cluster.atMs,
        })),
      })
    }
    case "key":
      return nativeInputActionSchema.parse({
        kind: "key",
        stroke: { keyCode: plan.keyCode, flags: plan.modifierFlags },
      })
    case "shortcut":
      return nativeInputActionSchema.parse({
        kind: "shortcut",
        strokes: plan.steps.map(step => ({ keyCode: step.keyCode, flags: step.modifierFlags })),
        delayMs: plan.delayMs,
      })
  }
}

function requireAuthorizedPoint(
  points: readonly AuthorizedObservationPoint[],
  index: number,
): AuthorizedObservationPoint["destinationPoint"] {
  const point = points[index]
  if (point === undefined || !point.authorized || point.space.kind !== "macos-screen") {
    throw new InputPlanError("invalid-input", `отсутствует authorized macos-screen point ${index}`)
  }
  return point.destinationPoint
}

function nativeModifiers(names: readonly string[]) {
  return {
    names,
    flags: modifierFlags([...names]),
  }
}
