import { describe, expect, test } from "bun:test"
import {
  nativeTransportResponseFrameSchema,
  nativeHitTestResponseSchema,
  type NativeHitTestRequest,
  type NativeHitTestResult,
} from "@meta/native/protocol"
import { extractNativeEvidenceReports } from "@meta/native/evidence-extractor"
import {
  observationSchema,
  type NativeExecutionContext,
  type NativeOperationTarget,
  type Observation,
  type ResolveStoredObservationPointRequest,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import {
  RuntimeNativePointHitProvider,
  type NativePointHitClient,
} from "../src/input-hit-test.ts"

const generation = {
  runtimeEpoch: "runtime:hit",
  loginSessionId: "login:hit",
}
const nativeGeneration = "native:hit"
const binding = {
  adapterInstanceRef: "adapter:hit",
  backendBuildId: "native-build:hit",
  nativeGeneration,
}
const displayRef = {
  ...generation,
  nativeGeneration,
  displayRef: "display:hit",
  displayLayoutRevision: 3,
}
const displayTarget = { kind: "display", ref: displayRef } as const
const windowTarget = {
  kind: "window",
  ref: {
    ...generation,
    nativeGeneration,
    applicationRef: "application:hit",
    windowRef: "window:hit",
  },
} as const
type HitTarget = NativeHitTestRequest["payload"]["interactionTarget"]

function proof(kind: "frame-freshness" | "pixel-ownership", subject: NativeOperationTarget) {
  return {
    proofRef: `proof:${kind}`,
    authorityRef: "proof-authority:hit",
    kind,
    subject,
    ...generation,
    nativeGeneration,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    issuedAt: "2026-09-15T10:00:00.000Z",
    expiresAt: "2026-09-15T10:01:00.000Z",
  }
}

const observation = observationSchema.parse({
  observationId: "observation:hit",
  ...generation,
  nativeGeneration,
  captureTarget: displayTarget,
  caption: "Ожидаю увидеть окно и Dock на основном дисплее",
  backend: { name: "fake-capture", buildId: "capture-build:hit" },
  capturedAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T10:03:00.000Z",
  inventoryRevision: 4,
  displayLayoutRevision: 3,
  source: "display-composite",
  image: {
    frameRef: "frame:hit",
    widthPx: 100,
    heightPx: 100,
    mime: "image/png",
    byteLength: 68,
    sha256: "a".repeat(64),
  },
  cursor: "excluded",
  clip: { x: 0, y: 0, width: 100, height: 100 },
  captureEvidence: {
    state: "confirmed",
    claim: "frame-fresh",
    source: "fake-capture",
    proof: proof("frame-freshness", displayTarget),
  },
  occlusion: {
    state: "unknown",
    claim: "unknown",
    source: "fake-capture",
    reason: "fixture не моделирует occlusion",
  },
  readiness: {
    state: "ready",
    policy: { policyId: "policy:hit", requiredSteps: [], disabledSteps: [] },
    steps: [],
    timedOut: false,
  },
  synchronization: { kind: "single-frame" },
  regions: [{
    space: { kind: "macos-screen", display: displayRef },
    imageRect: { x: 0, y: 0, width: 100, height: 100 },
    destinationRect: { x: -200, y: 20, width: 200, height: 200 },
    imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -200, ty: 20 },
    frameTimestamp: "2026-09-15T10:00:00.000Z",
    frameStatus: "complete",
  }],
  unavailableReasons: [],
})

function operation(target: HitTarget): NativeExecutionContext {
  return {
    kind: "native",
    operationId: `operation:hit:${target.kind}`,
    clientRequestId: `request:hit:${target.kind}`,
    clientSessionId: "client:hit",
    principalId: "principal:hit",
    ...generation,
    inventoryId: "inventory:hit",
    inventoryRevision: 5,
    observationRef: {
      observationId: observation.observationId,
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      proofRef: "proof:frame-freshness",
    },
    deadlineAt: "2026-09-15T10:00:30.000Z",
    target,
    nativeGeneration,
    fence: { ...generation, nativeGeneration, counter: 1 },
  }
}

function request(target: HitTarget): ResolveStoredObservationPointRequest {
  const operationValue = operation(target)
  return {
    operation: operationValue,
    observationRef: operationValue.observationRef!,
    interactionTarget: target,
    imagePoint: { x: 25, y: 40 },
    expectedSpace: "macos-screen",
  }
}

function confirmed(
  nativeRequest: NativeHitTestRequest,
  target: HitTarget,
): Extract<NativeHitTestResult, { status: "confirmed" }> {
  const common = {
    status: "confirmed" as const,
    sourceResponseRef: `source-response:${target.kind}`,
    operationId: nativeRequest.operation.operationId,
    inventoryId: nativeRequest.operation.inventoryId,
    inventoryRevision: nativeRequest.operation.inventoryRevision,
    displayLayoutRevision: nativeRequest.payload.observationRef.displayLayoutRevision,
    observedAt: "2026-09-15T10:00:20.000Z",
    observationId: nativeRequest.payload.observationRef.observationId,
    frameRef: nativeRequest.payload.frameRef,
    regionIndex: nativeRequest.payload.expectedRegionIndex,
    imagePoint: nativeRequest.payload.imagePoint,
    destinationPoint: nativeRequest.payload.expectedDestinationPoint,
    space: { kind: "macos-screen" as const, display: displayRef },
    frameTimestamp: "2026-09-15T10:00:00.000Z",
    interactionTarget: target,
    hitOwnerTarget: target,
    topologyUnchanged: true as const,
  }
  if (target.kind === "display" || target.kind === "desktop-layout") {
    const display = target as Extract<HitTarget, { kind: "display" | "desktop-layout" }>
    return {
        ...common,
        interactionTarget: display,
        hitOwnerTarget: display,
        scope: "display",
        hitRelation: "display-contained",
        focusRelation: "not-required-display-focus",
      }
  }
  const window = target as Extract<HitTarget, { kind: "window" | "surface" }>
  return {
        ...common,
        interactionTarget: window,
        hitOwnerTarget: window,
        scope: "window",
        focusedTarget: window,
        hitRelation: "exact",
        focusRelation: "target",
        frameUnchanged: true,
  }
}

function fixture(options: {
  result?: (request: NativeHitTestRequest) => NativeHitTestResult
  now?: string
} = {}) {
  const clock = { now: () => new Date(options.now ?? "2026-09-15T10:00:20.000Z") }
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:hit",
    nativeGeneration,
    nativeSourceIdentity: binding,
    clock,
  })
  core.evidence.registerSourceExtractor(binding, extractNativeEvidenceReports)
  core.observations.register(observation)
  let calls = 0
  const native: NativePointHitClient = {
    generation: { ...generation, nativeGeneration },
    evidencePublisher: core.evidence.bind(binding),
    async hitTest(nativeRequest) {
      calls++
      const result = options.result?.(nativeRequest) ?? confirmed(nativeRequest, nativeRequest.payload.interactionTarget)
      const response = nativeHitTestResponseSchema.parse({
        kind: "response",
        protocolVersion: "1",
        requestId: nativeRequest.requestId,
        ...generation,
        nativeGeneration,
        operationId: nativeRequest.operation.operationId,
        ok: true,
        result,
      })
      const frame = nativeTransportResponseFrameSchema.parse({ channel: "response", payload: response })
      if (response.ok && response.result.status === "confirmed") {
        core.evidence.registerSourceResponse(
          binding,
          response.result.sourceResponseRef,
          new TextEncoder().encode(JSON.stringify(frame)),
        )
      }
      return response
    },
  }
  let id = 0
  const provider = new RuntimeNativePointHitProvider({
    native,
    now: clock,
    ids: { next: prefix => `${prefix}:${++id}` },
  })
  const checkpoints: string[] = []
  return {
    calls: () => calls,
    checkpoints,
    core,
    provider,
    control: {
      signal: new AbortController().signal,
      checkpoint(stage: string) { checkpoints.push(stage) },
    },
  }
}

describe("C3 runtime native point-hit provider", () => {
  test("20-second capture provenance получает fresh point proof на новой inventory", async () => {
    const value = fixture()
    const requestValue = request(windowTarget)
    const receipt = await value.provider.provide(requestValue, observation, value.control)
    const interactionProof = await value.core.evidence.issueInteractionPoint({
      operation: requestValue.operation,
      receipt,
      observationRef: requestValue.observationRef,
      interactionTarget: requestValue.interactionTarget,
      imagePoint: requestValue.imagePoint,
      expectedSpace: "macos-screen",
    })

    expect(receipt).toMatchObject({
      factKind: "point-hit",
      sourceResponseRef: "source-response:window",
      inventoryId: "inventory:hit",
      inventoryRevision: 5,
      nativeGeneration,
    })
    expect(value.core.proofs.hasIssued(interactionProof.proof)).toBe(true)
    expect(Date.parse(interactionProof.proof.expiresAt) - Date.parse(interactionProof.proof.issuedAt))
      .toBe(5_000)
    expect(value.checkpoints).toEqual([
      "point-hit-prepare",
      "point-hit-response",
      "point-hit-evidence-published",
    ])
    expect(value.calls()).toBe(1)
  })

  test("explicit display scope подтверждается без AX focus claim", async () => {
    const value = fixture()
    const receipt = await value.provider.provide(request(displayTarget), observation, value.control)

    expect(receipt).toMatchObject({ factKind: "point-hit", sourceResponseRef: "source-response:display" })
    expect(value.calls()).toBe(1)
  })

  test("capture provenance старше 120 секунд не доходит до native", async () => {
    const value = fixture({ now: "2026-09-15T10:02:00.001Z" })
    const requestValue = request(windowTarget)
    requestValue.operation = {
      ...requestValue.operation,
      deadlineAt: "2026-09-15T10:02:30.000Z",
    }

    await expect(value.provider.provide(requestValue, observation, value.control))
      .rejects.toThrow("capture provenance age")
    expect(value.calls()).toBe(0)
  })

  test("failure не публикует point proof", async () => {
    const value = fixture({
      result: () => ({ status: "observation-stale", reason: "native frame geometry changed" }),
    })

    await expect(value.provider.provide(request(windowTarget), observation, value.control)).rejects.toMatchObject({
      contract: { code: "observation-stale", recoveryAction: "capture-new-observation" },
    })
    expect(value.checkpoints).toEqual(["point-hit-prepare", "point-hit-response"])
  })

  test("native cancellation сохраняет typed operation semantics", async () => {
    const value = fixture({
      result: () => ({ status: "cancelled", reason: "operation signal aborted" }),
    })

    await expect(value.provider.provide(request(windowTarget), observation, value.control)).rejects.toMatchObject({
      contract: { code: "cancelled", recoveryAction: "get-operation" },
    })
  })

  test("substituted native destination не получает evidence receipt", async () => {
    const value = fixture({
      result: nativeRequest => ({
        ...confirmed(nativeRequest, nativeRequest.payload.interactionTarget),
        destinationPoint: { x: -149, y: 100 },
      }),
    })

    await expect(value.provider.provide(request(windowTarget), observation, value.control)).rejects.toThrow("не совпадает")
  })

  test("late confirmed fact не авторизует operation после deadline", async () => {
    const value = fixture({
      result: nativeRequest => ({
        ...confirmed(nativeRequest, nativeRequest.payload.interactionTarget),
        observedAt: "2026-09-15T10:00:31.000Z",
      }),
    })

    await expect(value.provider.provide(request(windowTarget), observation, value.control)).rejects.toThrow("authoritative")
  })

  test("capture proof ref и stored observation authority обязательны до native call", async () => {
    const value = fixture()
    const requestValue = request(windowTarget)
    requestValue.observationRef = { ...requestValue.observationRef, proofRef: "proof:foreign" }

    await expect(value.provider.provide(requestValue, observation, value.control)).rejects.toThrow("authority")
    expect(value.calls()).toBe(0)
  })
})
