import { expect, test } from "bun:test"
import {
  nativePermissionRequestStatusSchema,
  nativeStartupPermissionsRequestSchema,
  nativeStartupPermissionsResponseMatches,
  nativeStartupPermissionsResponseSchema,
} from "../src/permissions-request-protocol.ts"
import { nativePermissionsResponseSchema } from "../src/permissions-protocol.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const capabilities = { schemaVersion: "1" as const, scope: "adapter" as const, producerRef: "native", capabilities: [] }
const notRequested = {
  beforeGranted: false,
  currentGranted: false,
  requestState: "not-requested" as const,
  promptRequested: false,
  requestFinished: false,
  restartNeeded: false,
  restartState: "not-required" as const,
}
const granted = {
  beforeGranted: true,
  currentGranted: true,
  requestState: "not-needed" as const,
  promptRequested: false,
  requestFinished: false,
  restartNeeded: false,
  restartState: "not-required" as const,
}

test("startup permission DTO различает initial, finished и неизвестный restart", () => {
  const request = nativeStartupPermissionsRequestSchema.parse({
    kind: "permissions-request", command: "request-missing", protocolVersion: "1", requestId: "request",
    ...generation, deadlineAt: new Date(Date.now() + 1000).toISOString(),
  })
  const response = nativeStartupPermissionsResponseSchema.parse({
    kind: "permissions-request-response", command: request.command, protocolVersion: "1", requestId: request.requestId,
    ...generation, nativeBuildId: "build", observedAt: new Date().toISOString(), requestsFinished: false,
    allGranted: false, restartNeeded: false, restartState: "unknown", capabilities,
    permissions: {
      accessibility: granted,
      screenRecording: { ...notRequested, requestState: "finished", promptRequested: true, requestFinished: true,
        requestReturnedGranted: true, restartState: "unknown", restartReason: "Current helper ещё не видит grant" },
      postEvents: notRequested,
      inputMonitoring: notRequested,
    },
  })
  expect(nativeStartupPermissionsResponseMatches(request, response, "build")).toBe(true)
})

test("отзыв initial grant остаётся честным not-needed без повторного prompt", () => {
  expect(nativePermissionRequestStatusSchema.parse({ ...granted, currentGranted: false })).toEqual({
    ...granted,
    currentGranted: false,
  })
})

test("top-level aggregates и restart proof проверяются строго", () => {
  const base = {
    kind: "permissions-request-response", command: "status", protocolVersion: "1", requestId: "request",
    ...generation, nativeBuildId: "build", observedAt: new Date().toISOString(), requestsFinished: true,
    allGranted: true, restartNeeded: false, restartState: "not-required", capabilities,
    permissions: { accessibility: granted, screenRecording: granted, postEvents: granted, inputMonitoring: granted },
  }
  expect(nativeStartupPermissionsResponseSchema.safeParse({ ...base, allGranted: false }).success).toBe(false)
  expect(nativePermissionRequestStatusSchema.safeParse({ ...notRequested, restartNeeded: true }).success).toBe(false)
  expect(nativePermissionRequestStatusSchema.safeParse({ ...notRequested, restartState: "unknown" }).success).toBe(false)
})

test("passive response требует Input Monitoring и fresh capability catalog", () => {
  const base = {
    kind: "permissions-response", protocolVersion: "1", requestId: "request", ...generation, nativeBuildId: "build",
    accessibility: true, screenRecording: true, postEvents: true, inputMonitoring: false, capabilities,
  }
  expect(nativePermissionsResponseSchema.safeParse(base).success).toBe(true)
  const { inputMonitoring: _, ...missing } = base
  expect(nativePermissionsResponseSchema.safeParse(missing).success).toBe(false)
  expect(nativePermissionsResponseSchema.safeParse({ ...base, capabilities: { ...capabilities, producerRef: "foreign" } }).success).toBe(false)
})
