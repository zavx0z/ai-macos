import { describe, expect, test } from "bun:test"
import {
  contractErrorSchema,
  inputReadinessDiagnosticsSchema,
} from "./errors.ts"

const diagnostics = {
  probe: "active-event",
  inputReady: false,
  quarantined: false,
  movePosted: false,
  moveObserved: false,
  moveReadbackConfirmed: false,
  restorePosted: false,
  restoreObserved: false,
  restoreReadbackConfirmed: false,
  dispatch: "none",
  cleanup: "complete",
  interference: "none-observed",
  restoration: "not-attempted",
  reason: "Accessibility permission unavailable",
} as const

describe("bounded input readiness diagnostics", () => {
  test("сохраняется только в typed error context", () => {
    expect(contractErrorSchema.parse({
      code: "capability-unavailable",
      message: "Input readiness не подтверждена",
      stage: "input-readiness",
      retryable: false,
      replayAllowed: false,
      recoveryAction: "inspect-health",
      context: {
        operationId: "operation:readiness",
        inputReadiness: diagnostics,
      },
    }).context?.inputReadiness).toEqual(diagnostics)
  })

  test("не принимает ready, лишние поля и невозможный порядок", () => {
    expect(inputReadinessDiagnosticsSchema.safeParse({
      ...diagnostics,
      inputReady: true,
    }).success).toBe(false)
    expect(inputReadinessDiagnosticsSchema.safeParse({
      ...diagnostics,
      originalCursor: { x: 10, y: 20 },
    }).success).toBe(false)
    expect(inputReadinessDiagnosticsSchema.safeParse({
      ...diagnostics,
      moveObserved: true,
    }).success).toBe(false)
  })
})
