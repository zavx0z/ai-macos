import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS, desktopInventorySnapshotSchema, operationRecordSchema, z,
  type NativeAdapter,
  type NativeExecutionContext,
  type OperationTarget,
} from "@meta/shared/contracts"
import { nativeCursorDisplayResponseSchema, type NativeCursorDisplayResult } from "@meta/native/protocol"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerCheckInputMethod } from "../src/check-input.ts"
import { inputReadinessMethodInputSchema, registerReadinessMethods } from "../src/readiness-methods.ts"

function fixture() {
  const generation = { runtimeEpoch: "runtime:check", loginSessionId: "login:check", nativeGeneration: "native:check" }
  const core = new RuntimeCore({ generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId }, runtimeBuildId: "build:check" })
  core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "check:fixture",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
  const registry = new MethodRegistry(core)
  const session = core.openClient("principal:check").session
  const displays = [0, 1].map(index => ({ ref: { ...generation, displayRef: `display:${index}`, displayLayoutRevision: 2 },
      nativeDisplayId: index + 1, bounds: { x: index === 0 ? 0 : -100, y: 0, width: 100, height: 100 },
      usableBounds: { x: index === 0 ? 0 : -100, y: 0, width: 100, height: 100 }, scale: 1, rotationDegrees: 0, main: index === 0 }))
  const evidence = (target: OperationTarget, id: string) => ({ state: "confirmed", claim: "target-resolution", source: "fixture",
    proof: { proofRef: id, authorityRef: "authority:check", kind: "target-resolution", subject: target, ...generation,
      inventoryRevision: 1, displayLayoutRevision: 2, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5000).toISOString() } })
  const layoutTarget = { kind: "desktop-layout" as const, ref: { ...generation, layoutRef: "layout:check", displayLayoutRevision: 2 } }
  const snapshot = desktopInventorySnapshotSchema.parse({ ...generation, inventoryId: "inventory:check", revision: 1,
    displayLayoutRevision: 2, capturedAt: new Date().toISOString(), complete: true, errors: [], applications: [], windows: [], displays,
    desktopLayout: { kind: "desktop-layout", target: layoutTarget, mappingEvidence: evidence(layoutTarget, "proof:layout"),
      displays: displays.map((display, index) => ({ kind: "display", target: { kind: "display", ref: display.ref },
        nativeDisplayId: display.nativeDisplayId, mappingEvidence: evidence({ kind: "display", ref: display.ref }, `proof:display:${index}`) })) },
  })
  let selected: NativeCursorDisplayResult = { status: "resolved", ...generation, inventoryId: snapshot.inventoryId, inventoryRevision: 1,
    displayLayoutRevision: 2, observedAt: new Date().toISOString(), sourceResponseRef: "source:cursor",
    cursor: { x: -50, y: 50 }, displayRef: snapshot.displays[1]!.ref }
  let probes = 0
  let reads = 0
  let ready = true
  let probeTarget: unknown
  registry.register("input_readiness", { title: "Fixture", description: "Проверенный internal handler fixture", readOnly: false,
    input: inputReadinessMethodInputSchema, output: z.object({ operation: operationRecordSchema, result: z.any() }),
    async execute(context, input) {
      probes++
      probeTarget = input.precondition.target.ref
      const checks = { probe: "active-event" as const, quarantined: false,
        movePosted: ready, moveObserved: ready, moveReadbackConfirmed: ready,
        restorePosted: ready, restoreObserved: ready, restoreReadbackConfirmed: ready,
        dispatch: ready ? "finished" as const : "none" as const, cleanup: "complete" as const,
        interference: "none-observed" as const, restoration: ready ? "restored" as const : "not-attempted" as const }
      const outcome = { dispatch: checks.dispatch, dispatchAttempts: ready ? 2 : 0, targetVerified: "verified", userInterference: "none-observed",
        observation: "unavailable", effect: { state: "unverified", proofRefs: [] }, cleanup: { scope: "none", state: "complete", resources: [] },
        restoration: ready ? "restored" : "not-applicable" }
      const now = new Date().toISOString()
      const operation = operationRecordSchema.parse({ clientSessionId: context.session.clientSessionId, principalId: context.session.principalId,
        intent: "mutation", context: { kind: "native", ...generation, operationId: "operation:check", clientRequestId: input.clientRequestId,
          clientSessionId: context.session.clientSessionId, principalId: context.session.principalId, ...input.precondition,
          deadlineAt: new Date(Date.now() + 5000).toISOString(), fence: { ...generation, counter: 1 } },
        resources: [], state: ready ? "completed" : "failed", outcome,
        payloadReceipt: { keyGeneration: "key:check", hmacSha256: "a".repeat(64) }, registeredAt: now, updatedAt: now })
      const result = ready ? { ok: true, outcome, value: { ...checks, inputReady: true, operationId: "operation:check",
        expectedDisplayRef: input.precondition.target.ref, resolvedDisplayRef: input.precondition.target.ref,
        originalCursor: { x: -50, y: 50 }, probeCursor: { x: -49, y: 50 } } }
        : { ok: false, outcome, error: { code: "capability-unavailable", message: "cursor moved", stage: "readiness",
          retryable: false, replayAllowed: false, recoveryAction: "inspect-health", context: { inputReadiness: { ...checks, inputReady: false, reason: "cursor moved" } } } }
      return { operation, result }
    },
  })
  const native = { generation, async request(_requestSchema: unknown, request: { requestId: string }) {
    reads++
    return nativeCursorDisplayResponseSchema.parse({ kind: "response", protocolVersion: "1", requestId: request.requestId, ...generation, ok: true, result: selected })
  } } as unknown as Pick<NativeAdapter, "request" | "generation">
  registerCheckInputMethod(registry, { native, windows: { async inventory() { return snapshot } } })
  return { core, registry, session, snapshot, get probes() { return probes }, get reads() { return reads }, get probeTarget() { return probeTarget },
    setSelected(value: NativeCursorDisplayResult) { selected = value }, setReady(value: boolean) { ready = value } }
}

test("check_input выбирает фактический не-primary display и скрывает service params", async () => {
  const value = fixture()
  expect(value.probes).toBe(0)
  const result = await value.registry.dispatch(value.session, "check_input", {}, new AbortController().signal)
  expect(value.probeTarget).toEqual(value.snapshot.displays[1]!.ref)
  expect(value.reads).toBe(1)
  expect(value.probes).toBe(1)
  expect(result.data).toMatchObject({ inputReady: true, probe: "active-event" })
  expect(JSON.stringify(result.data)).not.toContain("inventory:check")
  expect(JSON.stringify(result.data)).not.toContain("native:check")
})

test("ambiguous cursor не вызывает active probe или перебор displays", async () => {
  const value = fixture()
  value.setSelected({ status: "ambiguous", sourceResponseRef: "trace:cursor", reason: "two displays" })
  const result = await value.registry.dispatch(value.session, "check_input", {}, new AbortController().signal)
  expect(result.data).toEqual({ inputReady: false, probe: "not-run", reason: "two displays" })
  expect(value.probes).toBe(0)
  expect(value.reads).toBe(1)
})

test("not-ready active probe не повторяется; caller не передаёт refs", async () => {
  const value = fixture()
  value.setReady(false)
  const result = await value.registry.dispatch(value.session, "check_input", {}, new AbortController().signal)
  expect(result.isError).toBe(true)
  expect(result.data).toMatchObject({ inputReady: false, reason: "cursor moved", probe: "active-event" })
  expect(value.probes).toBe(1)
  await expect(value.registry.dispatch(value.session, "check_input", { clientRequestId: "forged" }, new AbortController().signal)).rejects.toThrow()
  expect(value.probes).toBe(1)
})

test("чужая геометрия или stale snapshot не заменяется primary display", async () => {
  const value = fixture()
  const generation = value.snapshot
  value.setSelected({ status: "resolved", runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId,
    nativeGeneration: generation.nativeGeneration, inventoryId: generation.inventoryId, inventoryRevision: generation.revision,
    displayLayoutRevision: generation.displayLayoutRevision, observedAt: new Date().toISOString(), sourceResponseRef: "source:bad-geometry",
    cursor: { x: 50, y: 50 }, displayRef: generation.displays[1]!.ref })
  const result = await value.registry.dispatch(value.session, "check_input", {}, new AbortController().signal)
  expect(result.data).toMatchObject({ inputReady: false, probe: "not-run" })
  expect(value.probes).toBe(0)
  expect(value.reads).toBe(1)
})

test("check_input проходит настоящий readiness registrar/Core и освобождает exact display lease", async () => {
  const snapshot = fixture().snapshot
  const generation = { runtimeEpoch: snapshot.runtimeEpoch, loginSessionId: snapshot.loginSessionId }
  let operation: NativeExecutionContext | undefined
  let probes = 0
  let statusQueries = 0
  const status = (requestId: string) => {
    if (operation === undefined) throw new Error("Native operation отсутствует")
    const timestamp = new Date().toISOString()
    return { requestId, ...generation, nativeGeneration: snapshot.nativeGeneration,
      operationId: operation.operationId, acceptedFence: operation.fence, highWaterFence: operation.fence,
      execution: "finished" as const, dispatch: "finished" as const, cleanup: "complete" as const,
      targetVerified: "verified" as const, cancellationRequested: false, userInterference: "none-observed" as const,
      restorationAllowed: false, quarantined: false, heldCount: 0, dispatchAttempts: 2, ledgerRevision: 0,
      observer: { state: "ready" as const, ...generation, nativeGeneration: snapshot.nativeGeneration,
        coverageStartCursor: "cursor:start", cursor: "cursor:end", nextSequence: 3, startedAt: timestamp,
        coveredFrom: timestamp, coveredThrough: timestamp, heartbeatAt: timestamp,
        coveredKinds: ["input" as const, "focus" as const], droppedEvents: 0, gapDetected: false } }
  }
  const native = {
    generation: { ...generation, nativeGeneration: snapshot.nativeGeneration },
    async status(request: { requestId: string }) { statusQueries++; return status(request.requestId) },
    async request(_schema: unknown, request: { requestId: string }) {
      return nativeCursorDisplayResponseSchema.parse({ kind: "response", protocolVersion: "1", requestId: request.requestId,
        ...generation, nativeGeneration: snapshot.nativeGeneration, ok: true, result: { status: "resolved", ...generation, nativeGeneration: snapshot.nativeGeneration, inventoryId: snapshot.inventoryId,
          inventoryRevision: snapshot.revision, displayLayoutRevision: snapshot.displayLayoutRevision, observedAt: new Date().toISOString(),
          sourceResponseRef: "source:core-check", cursor: { x: -50, y: 50 }, displayRef: snapshot.displays[1]!.ref } })
    },
  } as unknown as NativeAdapter
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:check-core", native, nativeGeneration: snapshot.nativeGeneration })
  core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "check:core", capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
  const registry = new MethodRegistry(core)
  registerReadinessMethods(registry, core, { async inputReadiness(request) {
    probes++
    operation = request.operation
    expect(core.resources.handlesForOperation(operation.operationId)).toHaveLength(1)
    return { kind: "response", protocolVersion: "1", requestId: request.requestId, ...generation,
      nativeGeneration: snapshot.nativeGeneration, operationId: operation.operationId, ok: true,
      result: { status: status(request.requestId), value: { probe: "active-event", operationId: operation.operationId,
        expectedDisplayRef: request.payload.expectedDisplayRef, resolvedDisplayRef: request.payload.expectedDisplayRef,
        inputReady: true, quarantined: false, movePosted: true, moveObserved: true, moveReadbackConfirmed: true,
        restorePosted: true, restoreObserved: true, restoreReadbackConfirmed: true, dispatch: "finished", cleanup: "complete",
        interference: "none-observed", restoration: "restored", originalCursor: { x: -50, y: 50 }, probeCursor: { x: -49, y: 50 } } } }
  } })
  registerCheckInputMethod(registry, { native, windows: { async inventory() {
    for (const display of snapshot.displays) core.targets.register({ kind: "display", ref: display.ref }, snapshot.inventoryId,
      snapshot.revision, `resolution:${display.ref.displayRef}`, `proof:${display.ref.displayRef}`, snapshot.displayLayoutRevision)
    return snapshot
  } } })
  const session = core.openClient("principal:actual-check").session
  try {
    const result = await registry.dispatch(session, "check_input", {}, new AbortController().signal)
    expect(result.data.inputReady).toBe(true)
    expect(probes).toBe(1)
    expect(statusQueries).toBe(1)
    expect(operation?.inventoryId).toBe(snapshot.inventoryId)
    expect(operation?.inventoryRevision).toBe(snapshot.revision)
    expect(core.resources.handlesForOperation(operation!.operationId)).toHaveLength(0)
    expect((await core.getOperation(session, operation!.operationId))?.state).toBe("completed")
  } finally { await core.closeClientLifecycle() }
})
