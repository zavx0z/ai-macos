import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  type AdapterControl,
  type CapabilityId,
  type NativeExecutionContext,
} from "@meta/shared/contracts"
import type {
  NativeInputReadinessRequest,
  NativeInputReadinessResponse,
} from "@meta/native/protocol"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import {
  INPUT_READINESS_BUDGETS,
  inputReadinessMethodInputSchema,
  registerReadinessMethods,
} from "../src/readiness-methods.ts"

const generation = {
  runtimeEpoch: "runtime:readiness-methods",
  loginSessionId: "login:readiness-methods",
}
const nativeGeneration = "native:readiness-methods"

function capabilities(ready: boolean) {
  const ids = new Set<CapabilityId>([
    "runtime.identity",
    "runtime.transport",
    "runtime.arbitration",
    "runtime.operations",
    "desktop.applications",
    "desktop.windows.all",
    "desktop.window.identity",
    "desktop.displays",
    ...(ready ? ["input.readiness" as const] : []),
  ])
  return capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:readiness-methods",
    capabilities: CAPABILITY_IDS.map(id => ids.has(id)
      ? { id, state: "ready" }
      : { id, state: "unavailable", reason: "fixture capability unavailable" }),
  })
}

type ReadinessScenario = "ready" | "unavailable" | "takeover" | "quarantined"

function fixture(options: { scenario?: ReadinessScenario } = {}) {
  const scenario = options.scenario ?? "ready"
  const ready = scenario === "ready"
  const now = new Date(Date.now() + 1_000)
  let calls = 0
  let lastRequest: NativeInputReadinessRequest | undefined
  let lastOperation: NativeExecutionContext | undefined
  const native = {
    async status(request: { requestId: string }) {
      if (lastOperation === undefined) throw new Error("Readiness не выполнялась")
      return status(lastOperation, request.requestId, scenario)
    },
  }
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:readiness-methods",
    native: native as never,
    nativeGeneration,
  })
  const target = {
    kind: "display",
    ref: {
      ...generation,
      nativeGeneration,
      displayRef: "display:main",
      displayLayoutRevision: 4,
    },
  } as const
  core.targets.register(
    target,
    "inventory:readiness-methods",
    7,
    "resolution:readiness-methods",
    "proof:readiness-methods",
    1,
  )
  const binding = {
    async inputReadiness(
      request: NativeInputReadinessRequest,
      _control: AdapterControl,
    ): Promise<NativeInputReadinessResponse> {
      calls += 1
      lastRequest = request
      lastOperation = request.operation
      return {
        kind: "response",
        protocolVersion: "1",
        requestId: request.requestId,
        runtimeEpoch: request.runtimeEpoch,
        loginSessionId: request.loginSessionId,
        nativeGeneration: request.nativeGeneration,
        operationId: request.operation.operationId,
        ok: true,
        result: {
          value: {
            probe: "active-event",
            operationId: request.operation.operationId,
            expectedDisplayRef: request.payload.expectedDisplayRef,
            inputReady: ready,
            quarantined: scenario === "quarantined",
            movePosted: ready || scenario === "takeover" || scenario === "quarantined",
            moveObserved: ready,
            moveReadbackConfirmed: ready,
            restorePosted: ready,
            restoreObserved: ready,
            restoreReadbackConfirmed: ready,
            dispatch: ready ? "finished"
              : scenario === "unavailable" ? "none" : "attempted",
            cleanup: scenario === "quarantined" ? "unknown" : "complete",
            interference: scenario === "takeover" ? "observed" : "none-observed",
            restoration: ready ? "restored"
              : scenario === "takeover" ? "skipped-user-takeover"
                : scenario === "quarantined" ? "unknown" : "not-attempted",
            ...(scenario !== "unavailable" ? {
              originalCursor: { x: 10, y: 20 },
              probeCursor: { x: 11, y: 20 },
              resolvedDisplayRef: request.payload.expectedDisplayRef,
            } : {}),
            ...(ready ? {} : { reason: `Fixture ${scenario}` }),
          },
          status: status(request.operation, request.requestId, scenario),
        },
      }
    },
  }
  const registry = new MethodRegistry(core)
  registerReadinessMethods(registry, core, binding, {
    now: () => new Date(now),
  })
  return {
    binding,
    calls: () => calls,
    core,
    lastRequest: () => lastRequest,
    now,
    registry,
    target,
  }
}

describe("Runtime input readiness method", () => {
  test("публикуется только при полном capability graph", () => {
    const value = fixture()
    value.core.updateCapabilities(capabilities(false))
    expect(value.registry.descriptors().tools).toEqual([])
    value.core.updateCapabilities(capabilities(true))
    expect(value.registry.descriptors().tools.map(tool => tool.name)).toEqual([
      "input_readiness",
    ])
    expect(value.registry.descriptors().tools[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
  })

  test("исполняет один exact-display probe через Runtime operation", async () => {
    const value = fixture()
    value.core.updateCapabilities(capabilities(true))
    const client = value.core.openClient("principal:readiness-methods")
    const request = {
      clientRequestId: "request:input-readiness",
      precondition: {
        target: value.target,
        inventoryId: "inventory:readiness-methods",
        inventoryRevision: 7,
      },
    }
    const first = await value.registry.dispatch(
      client.session,
      "input_readiness",
      request,
      new AbortController().signal,
    )
    const repeated = await value.registry.dispatch(
      client.session,
      "input_readiness",
      request,
      new AbortController().signal,
    )

    expect(first.data).toMatchObject({
      operation: { state: "completed", context: { target: value.target } },
      result: { ok: true, value: { inputReady: true, restoration: "restored" } },
    })
    expect(first.isError).toBe(false)
    expect(repeated.data.operation).toEqual(first.data.operation)
    expect(value.calls()).toBe(1)
    expect(value.lastRequest()).toMatchObject({
      intent: "mutation",
      method: "input.readiness",
      operation: {
        target: value.target,
        inventoryId: "inventory:readiness-methods",
        inventoryRevision: 7,
        deadlineAt: new Date(
          value.now.getTime()
          + INPUT_READINESS_BUDGETS.operationMs,
        ).toISOString(),
      },
      payload: { expectedDisplayRef: value.target.ref },
    })
  })

  test("schema отклоняет не-display target", () => {
    expect(inputReadinessMethodInputSchema.safeParse({
      clientRequestId: "request:wrong-target",
      precondition: {
        target: {
          kind: "desktop-layout",
          ref: {
            ...generation,
            nativeGeneration,
            layoutRef: "layout:1",
            displayLayoutRevision: 4,
          },
        },
        inventoryId: "inventory:readiness-methods",
        inventoryRevision: 7,
      },
    }).success).toBe(false)
  })

  test("not-ready остаётся завершённым probe с точным false result", async () => {
    const value = fixture({ scenario: "unavailable" })
    value.core.updateCapabilities(capabilities(true))
    const client = value.core.openClient("principal:readiness-not-ready")
    const response = await value.registry.dispatch(
      client.session,
      "input_readiness",
      {
        clientRequestId: "request:readiness-not-ready",
        precondition: {
          target: value.target,
          inventoryId: "inventory:readiness-methods",
          inventoryRevision: 7,
        },
      },
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      isError: true,
      data: {
        operation: { state: "failed", outcome: { dispatch: "none" } },
        result: {
          ok: false,
          error: {
            code: "capability-unavailable",
            context: {
              inputReadiness: {
                inputReady: false,
                restoration: "not-attempted",
                reason: "Fixture unavailable",
              },
            },
          },
          outcome: { dispatch: "none", restoration: "not-applicable" },
        },
      },
    })
  })

  test("сохраняет terminal takeover и quarantine без подмены failed", async () => {
    const expectations = [
      {
        scenario: "takeover" as const,
        code: "user-interference",
        execution: "cancelled",
        dispatch: "attempted",
        cleanup: "complete",
      },
      {
        scenario: "quarantined" as const,
        code: "resource-quarantined",
        execution: "quarantined",
        dispatch: "attempted",
        cleanup: "unknown",
      },
    ]
    for (const expected of expectations) {
      const value = fixture({ scenario: expected.scenario })
      value.core.updateCapabilities(capabilities(true))
      const client = value.core.openClient(`principal:${expected.scenario}`)
      const response = await value.registry.dispatch(
        client.session,
        "input_readiness",
        {
          clientRequestId: `request:${expected.scenario}`,
          precondition: {
            target: value.target,
            inventoryId: "inventory:readiness-methods",
            inventoryRevision: 7,
          },
        },
        new AbortController().signal,
      )
      expect(response.data.result).toMatchObject({
        ok: false,
        error: { code: expected.code },
        outcome: {
          dispatch: expected.dispatch,
          cleanup: { state: expected.cleanup },
        },
        nativeStatus: { execution: expected.execution },
      })
    }
  })
})

function status(
  operation: NativeExecutionContext,
  requestId: string,
  scenario: ReadinessScenario,
) {
  const ready = scenario === "ready"
  const timestamp = "2026-09-15T10:00:01.000Z"
  return {
    requestId,
    ...generation,
    nativeGeneration,
    highWaterFence: operation.fence,
    acceptedFence: operation.fence,
    operationId: operation.operationId,
    execution: ready ? "finished" as const
      : scenario === "unavailable" ? "failed" as const
        : scenario === "takeover" ? "cancelled" as const : "quarantined" as const,
    dispatch: ready ? "finished" as const
      : scenario === "unavailable" ? "none" as const : "attempted" as const,
    cleanup: scenario === "quarantined" ? "unknown" as const : "complete" as const,
    targetVerified: "verified" as const,
    cancellationRequested: false,
    userInterference: scenario === "takeover" ? "observed" as const : "none-observed" as const,
    restorationAllowed: false,
    quarantined: scenario === "quarantined",
    heldCount: 0,
    lastCheckpoint: "readiness-restored",
    dispatchAttempts: ready ? 2 : scenario === "unavailable" ? 0 : 1,
    ledgerRevision: 0,
    observer: {
      state: "ready" as const,
      ...generation,
      nativeGeneration,
      coverageStartCursor: "cursor:start",
      cursor: "cursor:restored",
      nextSequence: 3,
      startedAt: timestamp,
      coveredFrom: timestamp,
      coveredThrough: timestamp,
      heartbeatAt: timestamp,
      coveredKinds: ["input" as const, "focus" as const],
      droppedEvents: 0,
      gapDetected: false,
    },
  }
}
