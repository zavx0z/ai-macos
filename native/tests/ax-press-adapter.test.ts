import { expect, test } from "bun:test"
import { capabilitySetSchema, nativeOperationStatusSchema, type NativeAdapter, type NativeExecutionContext, type RuntimeOperationContext } from "@meta/shared/contracts"
import { RuntimeCore } from "../../runtime/src/core.ts"
import { NativeWindowAdapter } from "../src/window-adapter.ts"
import { nativeAxPressResponseSchema, type NativeAxPressRequest } from "../src/ax-actions/protocol.ts"

const generation = { runtimeEpoch: "runtime", loginSessionId: "login", nativeGeneration: "native" }
const element = { ...generation, applicationRef: "application", snapshotId: "snapshot", elementRef: "element" }

function fixture(foreignResult = false, failed = false) {
  const core = new RuntimeCore({ generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId }, nativeGeneration: "native", runtimeBuildId: "build" })
  const session = core.openClient("principal").session
  const deadlineAt = new Date(Date.now() + 5000).toISOString()
  const wire: NativeExecutionContext = {
    kind: "native", ...generation, operationId: "operation", clientRequestId: "client-request",
    clientSessionId: session.clientSessionId, principalId: session.principalId,
    deadlineAt, inventoryId: "inventory", inventoryRevision: 1,
    fence: { ...generation, counter: 1 },
    target: { kind: "window", ref: { ...generation, applicationRef: "application", windowRef: "window" } },
  }
  const context: RuntimeOperationContext<NativeExecutionContext> = {
    wire, session, resources: [], control: { signal: new AbortController().signal, checkpoint() {} },
  }
  let calls = 0
  const native = {
    host: { generation: core.generation, runtimeBuildId: "build", capabilities: capabilitySetSchema.parse({
      schemaVersion: "1", scope: "adapter", producerRef: "fixture", capabilities: [],
    }) },
    generation,
    async request(_schema: unknown, request: NativeAxPressRequest) {
      calls += 1
      const now = new Date().toISOString()
      const status = nativeOperationStatusSchema.parse({
        ...generation, requestId: request.requestId, operationId: wire.operationId,
        acceptedFence: wire.fence, highWaterFence: wire.fence,
        execution: failed ? "failed" : "finished", dispatch: failed ? "none" : "finished", cleanup: "complete", targetVerified: failed ? "failed" : "verified",
        cancellationRequested: false, userInterference: "unknown", restorationAllowed: false,
        quarantined: false, heldCount: 0, dispatchAttempts: failed ? 0 : 1, ledgerRevision: 0,
        observer: { ...generation, state: "unavailable", coverageStartCursor: "start", cursor: "cursor", nextSequence: 1,
          startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
          coveredKinds: [], droppedEvents: 0, gapDetected: false, reason: "Injected fixture" },
      })
      if (failed) return nativeAxPressResponseSchema.parse({
        ...generation, kind: "response", protocolVersion: "1", requestId: request.requestId, operationId: wire.operationId,
        ok: false, error: { code: "target-stale", message: "Retained parent устарел", stage: "ax-press", retryable: false, replayAllowed: false, recoveryAction: "refresh-inventory" },
        nativeStatus: status,
      })
      return nativeAxPressResponseSchema.parse({
        ...generation, kind: "response", protocolVersion: "1", requestId: request.requestId, operationId: wire.operationId,
        ok: true, result: { value: { element: foreignResult ? { ...element, snapshotId: "foreign" } : element, action: "AXPress", performed: true }, status },
      })
    },
  } as unknown as NativeAdapter
  return { adapter: new NativeWindowAdapter({ native, services: core.services }), context, calls: () => calls }
}

test("AXPress сохраняет exact status и не объявляет semantic effect подтверждённым", async () => {
  const { adapter, context } = fixture()
  const result = await adapter.press(context, { element })
  expect(result.ok).toBe(true)
  expect(result.outcome.effect).toEqual({ state: "unverified", proofRefs: [] })
  expect(result.nativeStatus?.dispatchAttempts).toBe(1)
})

test("AXPress отвергает чужой parent до dispatch и чужой snapshot в результате", async () => {
  const local = fixture()
  await expect(local.adapter.press(local.context, { element: { ...element, applicationRef: "foreign" } })).rejects.toThrow()
  expect(local.calls()).toBe(0)
  const foreign = fixture(true)
  await expect(foreign.adapter.press(foreign.context, { element })).rejects.toThrow("retained element")
})

test("AXPress failure сохраняет no-dispatch status без фиктивного unknown cleanup", async () => {
  const { adapter, context } = fixture(false, true)
  const result = await adapter.press(context, { element })
  expect([result.ok, result.nativeStatus?.execution, result.outcome.dispatch, result.outcome.cleanup.state]).toEqual([
    false, "failed", "none", "complete",
  ])
})
