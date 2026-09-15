import { describe, expect, test } from "bun:test"
import {
  axPressRequestSchema,
  axPressResultMatches,
  axPressResultSchema,
} from "./ax-actions.ts"

const element = {
  runtimeEpoch: "runtime:ax-press",
  loginSessionId: "login:ax-press",
  nativeGeneration: "native:ax-press",
  applicationRef: "application:ax-press",
  snapshotId: "snapshot:ax-press",
  elementRef: "ax-node:2",
}

describe("AXPress contract", () => {
  test("сохраняет exact snapshot element и единственный native action", () => {
    const request = axPressRequestSchema.parse({ element })
    const result = axPressResultSchema.parse({
      element,
      action: "AXPress",
      performed: true,
    })

    expect(axPressResultMatches(request, result)).toBe(true)
    expect(axPressResultMatches(request, {
      ...result,
      element: { ...element, snapshotId: "snapshot:stale" },
    })).toBe(false)
  })

  test("не допускает caller action, fallback point или false success", () => {
    expect(axPressRequestSchema.safeParse({
      element,
      action: "AXShowMenu",
    }).success).toBe(false)
    expect(axPressRequestSchema.safeParse({
      element,
      point: { x: 10, y: 20 },
    }).success).toBe(false)
    expect(axPressResultSchema.safeParse({
      element,
      action: "AXPress",
      performed: false,
    }).success).toBe(false)
  })
})
