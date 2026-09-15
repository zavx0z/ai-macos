import { describe, expect, test } from "bun:test"
import {
  nativeAxPressRequestSchema,
  nativeAxPressResponseSchema,
  nativeAxPressResultMatches,
} from "../src/ax-actions/protocol.ts"

const generation = {
  runtimeEpoch: "runtime:ax-press",
  loginSessionId: "login:ax-press",
  nativeGeneration: "native:ax-press",
}
const fence = { ...generation, counter: 1 }
const element = {
  ...generation,
  applicationRef: "application:ax-press",
  snapshotId: "snapshot:ax-press",
  elementRef: "ax-node:2",
}
const target = {
  kind: "window" as const,
  ref: {
    ...generation,
    applicationRef: "application:ax-press",
    windowRef: "window:ax-press",
  },
}

function request() {
  const deadlineAt = "2030-09-15T10:00:00.000Z"
  return {
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId: "request:ax-press",
    ...generation,
    deadlineAt,
    method: "ax.press",
    operation: {
      kind: "native",
      operationId: "operation:ax-press",
      clientRequestId: "client-request:ax-press",
      clientSessionId: "client:ax-press",
      principalId: "principal:ax-press",
      ...generation,
      deadlineAt,
      inventoryId: "inventory:ax-press",
      inventoryRevision: 7,
      fence,
      target,
    },
    payload: { element },
  } as const
}

function status() {
  const now = "2026-09-15T10:00:00.000Z"
  return {
    requestId: "request:ax-press",
    ...generation,
    highWaterFence: fence,
    acceptedFence: fence,
    operationId: "operation:ax-press",
    execution: "finished",
    dispatch: "finished",
    cleanup: "complete",
    targetVerified: "verified",
    cancellationRequested: false,
    userInterference: "unknown",
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: "ax-press",
    dispatchAttempts: 1,
    ledgerRevision: 0,
    observer: {
      state: "unavailable",
      ...generation,
      coverageStartCursor: "observer:0",
      cursor: "observer:0",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "Fixture observer unavailable",
    },
  } as const
}

describe("Native AXPress protocol", () => {
  test("связывает exact parent, snapshot element, fence и terminal dispatch", () => {
    const parsedRequest = nativeAxPressRequestSchema.parse(request())
    const response = nativeAxPressResponseSchema.parse({
      kind: "response",
      protocolVersion: "1",
      requestId: parsedRequest.requestId,
      ...generation,
      operationId: parsedRequest.operation.operationId,
      ok: true,
      result: {
        value: { element, action: "AXPress", performed: true },
        status: status(),
      },
    })

    expect(response.ok && nativeAxPressResultMatches(
      parsedRequest,
      response.result,
    )).toBe(true)
  })

  test("не принимает element target, foreign application или ложный success", () => {
    expect(nativeAxPressRequestSchema.safeParse({
      ...request(),
      operation: {
        ...request().operation,
        target: { kind: "element", ref: element },
      },
    }).success).toBe(false)
    expect(nativeAxPressRequestSchema.safeParse({
      ...request(),
      payload: {
        element: { ...element, applicationRef: "application:foreign" },
      },
    }).success).toBe(false)
    expect(nativeAxPressResponseSchema.safeParse({
      kind: "response",
      protocolVersion: "1",
      requestId: "request:ax-press",
      ...generation,
      operationId: "operation:ax-press",
      ok: true,
      result: {
        value: { element, action: "AXPress", performed: true },
        status: { ...status(), dispatch: "none", dispatchAttempts: 0 },
      },
    }).success).toBe(false)
  })

  test("failure сохраняет exact native dispatch status", () => {
    const failedStatus = {
      ...status(),
      execution: "failed" as const,
      dispatch: "attempted" as const,
      cleanup: "complete" as const,
    }
    const response = nativeAxPressResponseSchema.parse({
      kind: "response",
      protocolVersion: "1",
      requestId: "request:ax-press",
      ...generation,
      operationId: "operation:ax-press",
      ok: false,
      error: {
        code: "capability-unavailable",
        message: "AXPress action failed",
        stage: "native-ax-press",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "inspect-health",
      },
      nativeStatus: failedStatus,
    })

    expect(!response.ok && response.nativeStatus).toMatchObject({
      execution: "failed",
      dispatch: "attempted",
      operationId: "operation:ax-press",
    })
  })
})
