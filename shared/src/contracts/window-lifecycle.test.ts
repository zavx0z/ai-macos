import { expect, test } from "bun:test"
import { windowTransitionResultSchema } from "./window.ts"

const ref = { runtimeEpoch: "runtime:test", loginSessionId: "login:test", nativeGeneration: "native:test",
  applicationRef: "app:test", windowRef: "window:test" }
const closed = { target: ref, requested: { kind: "close", target: ref },
  actual: { kind: "closed", ref, absence: "confirmed" }, changed: true, partial: false, errors: [] }
const error = { code: "inventory-incomplete", message: "AX readback недоступен", stage: "window-close",
  retryable: false, replayAllowed: false, recoveryAction: "refresh-inventory" }

test("close различает подтверждённое отсутствие и неизвестный readback", () => {
  expect(windowTransitionResultSchema.parse(closed).actual.kind).toBe("closed")
  const unknown = { ...closed, actual: { kind: "unknown", ref, reason: "AX readback недоступен" },
    partial: true, errors: [error] }
  expect(windowTransitionResultSchema.parse(unknown).actual.kind).toBe("unknown")
  expect(windowTransitionResultSchema.safeParse({ ...unknown, partial: false }).success).toBe(false)
  expect(windowTransitionResultSchema.safeParse({ ...unknown, errors: [] }).success).toBe(false)
})

test("закрытие нельзя подтвердить для другого окна или незавершённого перехода", () => {
  expect(windowTransitionResultSchema.safeParse({ ...closed, actual: { ...closed.actual,
    ref: { ...ref, windowRef: "window:foreign" } } }).success).toBe(false)
  expect(windowTransitionResultSchema.safeParse({ ...closed, requested: { kind: "show", target: ref } }).success).toBe(false)
  expect(windowTransitionResultSchema.safeParse({ ...closed, partial: true, errors: [error] }).success).toBe(false)
  expect(windowTransitionResultSchema.safeParse({ ...closed, newSurface: {
    ...ref, surfaceRef: "surface:save", ownerWindowRef: ref.windowRef } }).success).toBe(false)
})
