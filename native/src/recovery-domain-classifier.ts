import {
  RECOVERY_DOMAIN_VERSION,
  nativeRecoveryDescriptorSchema,
  type NativeRecoveryDescriptor,
  type z,
} from "@meta/shared/contracts"
import {
  nativeMethodRequestSchema,
  type NativeInputExecutionPayload,
} from "./protocol.ts"
import type { NativeClipboardRequest } from "./clipboard-protocol.ts"

export type ParsedNativeMethodRequest = z.infer<typeof nativeMethodRequestSchema>
export type ParsedNativeMutationRequest = Extract<
  ParsedNativeMethodRequest,
  { intent: "mutation" }
>
type RecoveryHold = NativeRecoveryDescriptor["possibleHolds"][number]

const BUTTON_CODES = {
  left: 0,
  right: 1,
  middle: 2,
} as const

const NO_HELD_INPUT_METHODS = new Set([
  "application.launch",
  "application.quit",
  "ax.press",
  "capture.cancel",
  "capture.release",
  "capture.start",
  "input.readiness",
  "window.transition",
])

export function classifyNativeRecoveryDescriptor(
  request: ParsedNativeMutationRequest | NativeClipboardRequest,
  nativeBuildId: string,
): NativeRecoveryDescriptor {
  if ("command" in request) {
    if (request.command.method !== "clipboard.write") {
      throw new Error(`Clipboard recovery не авторизует ${request.command.method}`)
    }
    return nativeRecoveryDescriptorSchema.parse({
      policyVersion: RECOVERY_DOMAIN_VERSION,
      nativeBuildId,
      method: request.command.method,
      domain: "no-held-input",
      possibleHolds: [],
    })
  }
  if (request.intent !== "mutation") {
    throw new Error("Recovery classifier принимает только Native mutation")
  }
  let possibleHolds: RecoveryHold[]
  if (request.method === "input.execute") {
    possibleHolds = inputHolds(request.payload.action)
  } else if (NO_HELD_INPUT_METHODS.has(request.method)) {
    possibleHolds = []
  } else {
    throw new Error(`Unknown Native recovery method: ${request.method}`)
  }
  const canonical = uniqueSorted(possibleHolds)
  return nativeRecoveryDescriptorSchema.parse({
    policyVersion: RECOVERY_DOMAIN_VERSION,
    nativeBuildId,
    method: request.method,
    domain: canonical.length === 0
      ? "no-held-input"
      : "possible-held-input",
    possibleHolds: canonical,
  })
}

function inputHolds(
  action: NativeInputExecutionPayload["action"],
): RecoveryHold[] {
  switch (action.kind) {
    case "hover":
    case "scroll":
      return []
    case "click":
    case "drag":
      return [{ kind: "button", code: BUTTON_CODES[action.button] }]
    case "text":
      return [{ kind: "key", code: 0 }]
    case "key":
      return [{ kind: "key", code: action.stroke.keyCode }]
    case "shortcut":
      return action.strokes.map(stroke => ({
        kind: "key" as const,
        code: stroke.keyCode,
      }))
    default:
      throw new Error("Unknown input.execute recovery primitive")
  }
}

function uniqueSorted(holds: readonly RecoveryHold[]): RecoveryHold[] {
  const unique = new Map<string, RecoveryHold>()
  for (const hold of holds) unique.set(`${hold.kind}:${hold.code}`, hold)
  return [...unique.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    return left.code - right.code
  })
}
