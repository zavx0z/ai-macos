import { describe, expect, test } from "bun:test"
import {
  NATIVE_FRAME_HEADER_BYTES,
  NativeFrameDecoder,
  NativeTransportStreamDecoder,
  encodeNativeFrame,
  nativeCaptureTaskStatusSchema,
  nativeCaptureStartResultSchema,
  nativeInputExecutionRequestSchema,
  nativeTransportRequestFrameSchema,
  nativeWindowRecordSchema,
  parseNativeRequestFrame,
} from "../src/protocol.ts"

const now = "2026-09-15T12:00:00.000Z"
const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}

function inputRequest() {
  const target = {
    kind: "window" as const,
    ref: {
      ...generation,
      applicationRef: "application-1",
      windowRef: "window-1",
    },
  }
  return {
    kind: "request" as const,
    protocolVersion: "1" as const,
    requestId: "request-1",
    ...generation,
    deadlineAt: "2026-09-15T12:00:05.000Z",
    intent: "mutation" as const,
    method: "input.execute" as const,
    operation: {
      kind: "native" as const,
      operationId: "operation-1",
      clientRequestId: "client-request-1",
      clientSessionId: "client-session-1",
      principalId: "principal-1",
      ...generation,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      target,
      fence: { ...generation, counter: 1 },
      deadlineAt: "2026-09-15T12:00:05.000Z",
    },
    payload: {
      actionDeadlineAt: "2026-09-15T12:00:04.000Z",
      action: {
        kind: "key" as const,
        stroke: { keyCode: 55, flags: 1 },
      },
    },
  }
}

describe("native protocol", () => {
  test("использует C1 native execution context без локальной копии fence", () => {
    const request = inputRequest()
    expect(nativeInputExecutionRequestSchema.parse(request)).toEqual(request)
    expect(nativeTransportRequestFrameSchema.parse({ channel: "request", payload: request })).toEqual({
      channel: "request",
      payload: request,
    })
  })

  test("отклоняет несовпавший loginSessionId в operation fence", () => {
    const request = inputRequest()
    request.operation.fence.loginSessionId = "foreign-login"
    expect(() => nativeInputExecutionRequestSchema.parse(request)).toThrow()
  })

  test("отклоняет oversized ID и неизвестные transport fields", () => {
    const request = inputRequest()
    request.requestId = "x".repeat(128)
    expect(() => nativeInputExecutionRequestSchema.parse(request)).toThrow()
    expect(() => nativeTransportRequestFrameSchema.parse({
      channel: "request",
      payload: inputRequest(),
      fallback: true,
    })).toThrow()
  })

  test("декодирует разрезанный и объединённый length-prefixed stream", () => {
    const response = {
      channel: "heartbeat" as const,
      payload: {
        requestId: "heartbeat-1",
        ...generation,
        accepted: true,
        acknowledgedAt: now,
        quarantined: false,
      },
    }
    const first = encodeNativeFrame(response)
    const second = encodeNativeFrame({
      ...response,
      payload: { ...response.payload, requestId: "heartbeat-2" },
    })
    const decoder = new NativeFrameDecoder()
    expect(decoder.push(first.subarray(0, 3))).toEqual([])
    const combined = new Uint8Array(first.byteLength - 3 + second.byteLength)
    combined.set(first.subarray(3))
    combined.set(second, first.byteLength - 3)
    expect(decoder.push(combined).map((frame) => {
      if (frame.channel !== "heartbeat") throw new Error("ожидался heartbeat frame")
      return frame.payload.requestId
    })).toEqual([
      "heartbeat-1",
      "heartbeat-2",
    ])
    expect(() => decoder.finish()).not.toThrow()
  })

  test("не принимает frame больше native envelope budget", () => {
    const decoder = new NativeFrameDecoder()
    const header = new Uint8Array(NATIVE_FRAME_HEADER_BYTES)
    new DataView(header.buffer).setUint32(0, 1024 * 1024 + 1, false)
    expect(() => decoder.push(header)).toThrow("превышает предел")
  })

  test("проверяет oversized header до копирования большого chunk", () => {
    const decoder = new NativeTransportStreamDecoder()
    const chunk = new Uint8Array(2 * 1024 * 1024)
    new DataView(chunk.buffer).setUint32(0, 1024 * 1024 + 1, false)
    expect(() => decoder.push(chunk)).toThrow("превышает предел")
  })

  test("request parser применяет строгую wire validation", () => {
    const frame = { channel: "request" as const, payload: inputRequest() }
    expect(parseNativeRequestFrame(JSON.stringify(frame))).toEqual(frame)
    expect(() => parseNativeRequestFrame('{"channel":"request","__proto__":{},"payload":{}}')).toThrow()
  })

  test("pointer action требует observation и согласованные canonical modifiers", () => {
    const base = inputRequest()
    const request = {
      ...base,
      payload: {
        ...base.payload,
        action: {
          kind: "click" as const,
          point: { x: 10, y: 20 },
          button: "left" as const,
          count: 1,
          modifiers: { names: ["cmd", "shift"] as const, flags: 0x0012_0000 },
        },
      },
    }
    expect(() => nativeInputExecutionRequestSchema.parse(request)).toThrow("observation")
    const withObservation = {
      ...request,
      operation: {
        ...request.operation,
        observationRef: {
          observationId: "observation-1",
          inventoryRevision: 1,
          displayLayoutRevision: 1,
          proofRef: "point-proof-1",
        },
      },
    }
    expect(nativeInputExecutionRequestSchema.parse(withObservation).payload.action.kind).toBe("click")
    expect(() => nativeInputExecutionRequestSchema.parse({
      ...withObservation,
      payload: {
        ...withObservation.payload,
        action: {
          ...withObservation.payload.action,
          modifiers: { ...withObservation.payload.action.modifiers, flags: 0 },
        },
      },
    })).toThrow("modifier flags")
  })

  test("action deadline не расширяет outer operation deadline", () => {
    const request = inputRequest()
    request.payload.actionDeadlineAt = "2026-09-15T12:00:06.000Z"
    expect(() => nativeInputExecutionRequestSchema.parse(request)).toThrow("action deadline")
  })

  test("сохраняет CG-only inventory record без выдуманного AX ref", () => {
    const record = nativeWindowRecordSchema.parse({
      kind: "cg-only",
      ownerPid: 42,
      cgWindowId: 900,
      title: "Несопоставленное окно",
      frame: { x: -100, y: 0, width: 500, height: 300 },
      onScreen: "false",
      spaceVisibility: "unknown",
      unavailableReason: "AX correlation отсутствует",
    })
    expect(record.kind).toBe("cg-only")
    expect("windowRef" in record).toBe(false)
  })

  test("capture status не объявляет unknown cleanup drained", () => {
    expect(() => nativeCaptureTaskStatusSchema.parse({
      captureTaskRef: "capture-1",
      revision: 2,
      completionDelivered: true,
      stopRequested: true,
      stopCallInFlight: false,
      stopAttemptCount: 1,
      startPending: false,
      streamStarted: true,
      streamStopped: false,
      encodingInFlight: false,
      cleanup: "unknown",
      drained: true,
    })).toThrow("drained capture")
  })

  test("capture start возвращает task identity до completion", () => {
    const result = nativeCaptureStartResultSchema.parse({
      captureTaskRef: "capture-1",
      operationId: "operation-1",
      acceptedFence: { ...generation, counter: 1 },
      sourceResponseRef: "capture-start-response-1",
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      observedAt: now,
      statusEvidenceRef: "status-start-1",
      acceptedAt: now,
      status: {
        captureTaskRef: "capture-1",
        revision: 1,
        completionDelivered: false,
        stopRequested: false,
        stopCallInFlight: false,
        stopAttemptCount: 0,
        startPending: true,
        streamStarted: false,
        streamStopped: false,
        encodingInFlight: false,
        cleanup: "pending",
        drained: false,
      },
    })
    expect(result.status.startPending).toBe(true)
    expect(result.status.completionDelivered).toBe(false)
  })

  test("stream decoder передаёт PNG bytes отдельным binary packet", () => {
    const header = encodeNativeFrame({
      channel: "binary",
      payload: { binaryToken: "binary-1", byteLength: 4 },
    })
    const combined = new Uint8Array(header.byteLength + 4)
    combined.set(header)
    combined.set([1, 2, 3, 4], header.byteLength)
    const decoder = new NativeTransportStreamDecoder()
    expect(decoder.push(combined.subarray(0, header.byteLength + 2))).toEqual([])
    const packets = decoder.push(combined.subarray(header.byteLength + 2))
    expect(packets).toEqual([{ kind: "binary", binaryToken: "binary-1", bytes: new Uint8Array([1, 2, 3, 4]) }])
    expect(() => decoder.finish()).not.toThrow()
  })

  test("failed capture не может пронести frame evidence", async () => {
    const { nativeCaptureExecutionResultSchema } = await import("../src/protocol.ts")
    expect(nativeCaptureExecutionResultSchema.safeParse({
      captureTaskRef: "capture-1",
      operationId: "operation-1",
      acceptedFence: { ...generation, counter: 1 },
      sourceResponseRef: "response-1",
      observationId: "observation-1",
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      observedAt: now,
      drainedEvidenceRef: "drained-1",
      terminalReceiptRef: "terminal-1",
      outcome: "failed",
      cleanup: "complete",
      errorCode: "frame-unavailable",
      errorMessage: "frame отсутствует",
      source: "display-composite",
      caption: "fixture",
      target: {
        kind: "display",
        ref: { ...generation, displayRef: "display-1", displayLayoutRevision: 1 },
      },
      nativeMapping: {
        kind: "display",
        display: {
          nativeDisplayId: 1,
          ref: { ...generation, displayRef: "display-1", displayLayoutRevision: 1 },
        },
      },
      clip: { kind: "full-target" },
      cursor: "excluded",
      scale: 1,
      backend: { name: "fixture", buildId: "build-1" },
      targetEvidence: {
        shareableTargetMatched: true,
        beforeTargetMatched: true,
        afterTargetMatched: true,
        boundsUnchanged: true,
        auxiliarySurfacesExcluded: false,
      },
      readinessFacts: [],
      frame: {
        binaryToken: "binary-1",
        frameRef: "frame-1",
        sha256: "a".repeat(64),
        widthPx: 1,
        heightPx: 1,
        encodedBytes: 1,
        capturedAt: now,
        frameStatus: "complete",
        regions: [{
          nativeDisplayId: 1,
          displayBounds: { x: 0, y: 0, width: 1, height: 1 },
          imageRect: { x: 0, y: 0, width: 1, height: 1 },
          destinationRect: { x: 0, y: 0, width: 1, height: 1 },
          imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          rotationDegrees: 0,
          frameOrientation: "display-oriented",
          backingScaleX: 1,
          backingScaleY: 1,
          frameTimestamp: now,
        }],
      },
      statusRevision: 1,
    }).success).toBe(false)
  })
})
