import { describe, expect, test } from "bun:test"
import {
  authorizeObservationPoint,
  freezeAdapterHostContext,
  observationSchema,
  type AdapterServices,
  type AuthorizedObservationPoint,
  type NativeExecutionContext,
  type OperationTarget,
  type ProofAuthority,
  type RuntimeOperationContext,
  type TargetResolution,
  type TargetResolutionRequest,
} from "@meta/shared/contracts"
import { prepareInputAction } from "../src/authorization.ts"

const runtimeEpoch = "runtime:1"
const loginSessionId = "login:1"
const nativeGeneration = "native:1"
const deadlineAt = "2026-09-15T10:01:00.000Z"
const now = new Date("2026-09-15T10:00:01.000Z")

const displayRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  displayRef: "display:1",
  displayLayoutRevision: 3,
}

const windowRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  applicationRef: "application:1",
  windowRef: "window:1",
}

const captureTarget = { kind: "display", ref: displayRef } as const
const interactionTarget = { kind: "window", ref: windowRef } as const

function proof(
  kind: "frame-freshness" | "pixel-ownership",
  subject: OperationTarget = interactionTarget,
) {
  return {
    proofRef: `proof:${kind}`,
    authorityRef: "proof-authority:1",
    kind,
    subject,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    issuedAt: "2026-09-15T10:00:00.000Z",
    expiresAt: "2026-09-15T10:00:30.000Z",
  }
}

const observation = observationSchema.parse({
  observationId: "observation:1",
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  captureTarget,
  caption: "Ожидаю увидеть окно на основном дисплее",
  backend: { name: "fake-capture", buildId: "capture-build:1" },
  capturedAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T10:00:30.000Z",
  inventoryRevision: 4,
  displayLayoutRevision: 3,
  source: "display-composite",
  image: {
    frameRef: "frame:1",
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
    proof: proof("frame-freshness", captureTarget),
  },
  occlusion: {
    state: "unknown",
    claim: "unknown",
    source: "fake-capture",
    reason: "fixture не моделирует occlusion",
  },
  readiness: {
    state: "ready",
    policy: { policyId: "policy:1", requiredSteps: [], disabledSteps: [] },
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

const interactionProof = {
  proof: proof("pixel-ownership"),
  observationId: observation.observationId,
  frameRef: observation.image.frameRef,
  regionIndex: 0,
  space: observation.regions[0]!.space,
  coverage: { kind: "rect", rect: { x: 0, y: 0, width: 100, height: 100 } },
} as const

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:1",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "input-adapter:1",
    capabilities: [
      { id: "input.pointer", state: "ready" },
      { id: "input.drag", state: "ready" },
      { id: "input.keyboard", state: "ready" },
      { id: "input.readiness", state: "ready" },
    ],
  },
})

const session = {
  clientSessionId: "client:1",
  principalId: "principal:1",
  runtimeEpoch,
  loginSessionId,
  authenticationGeneration: "auth:1",
  authenticatedAt: "2026-09-15T09:59:00.000Z",
  expiresAt: "2026-09-15T10:10:00.000Z",
}

const desktopResource = {
  kind: "desktop-input",
  resourceRef: "desktop",
  leaseId: "lease:1",
  leaseGeneration: "lease-generation:1",
  operationId: "operation:1",
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  expiresAt: deadlineAt,
  state: "active",
} as const

const wire: NativeExecutionContext = {
  kind: "native",
  operationId: "operation:1",
  clientRequestId: "request:1",
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  inventoryId: "inventory:1",
  inventoryRevision: 4,
  observationRef: {
    observationId: observation.observationId,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    proofRef: "proof:frame-freshness",
  },
  deadlineAt,
  target: interactionTarget,
  nativeGeneration,
  fence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
}

const proofAuthority: ProofAuthority = {
  async assertValid(value, context) {
    if (
      value.authorityRef !== "proof-authority:1"
      || value.runtimeEpoch !== context.runtimeEpoch
      || value.loginSessionId !== context.loginSessionId
    ) {
      throw new Error("proof authority rejected")
    }
  },
}

function fixture(options: {
  wire?: NativeExecutionContext
  resources?: readonly typeof desktopResource[]
  stopAtCheckpoint?: string
  targetResolution?: (request: TargetResolutionRequest, value: TargetResolution) => TargetResolution
  pointTransform?: (value: AuthorizedObservationPoint) => AuthorizedObservationPoint
} = {}) {
  const checkpoints: string[] = []
  let resolvedPoints = 0
  const controller = new AbortController()
  const context: RuntimeOperationContext<NativeExecutionContext> = {
    wire: options.wire ?? wire,
    session,
    resources: options.resources ?? [desktopResource],
    control: {
      signal: controller.signal,
      checkpoint(stage) {
        checkpoints.push(stage)
        if (stage === options.stopAtCheckpoint) {
          controller.abort()
          throw new DOMException("Операция отменена", "AbortError")
        }
      },
    },
  }
  const services: AdapterServices = {
    clientSessions: { async assertActive() {} },
    resources: {
      async assertActive() {},
      async assertOwnedSet() {},
    },
    cleanup: { async verify() {} },
    targets: {
      async resolve(request) {
        const value: TargetResolution = {
          target: request.target,
          resolutionId: "resolution:1",
          proofRef: "proof:target-resolution",
          inventoryId: request.inventoryId,
          inventoryRevision: request.inventoryRevision,
          displayLayoutRevision: 3,
          nativeGeneration,
          nativeMapping: {
            kind: "window",
            cgWindowId: 42,
            ownerPid: 100,
            displays: [{ nativeDisplayId: 1, ref: displayRef }],
          },
        }
        return options.targetResolution?.(request, value) ?? value
      },
    },
    proofs: proofAuthority,
    evidence: {
      async issueTargetResolution() { throw new Error("не используется") },
      async issueFrameFreshness() { throw new Error("не используется") },
      async issueWindowCorrelation() { throw new Error("не используется") },
      async issueInteractionPoint() { throw new Error("не используется") },
    },
    frames: { async publish() {} },
    observations: {
      async resolvePoint(request) {
        resolvedPoints++
        if (request.observationRef.observationId !== observation.observationId) {
          throw new Error("Observation не зарегистрирован runtime")
        }
        const value = await authorizeObservationPoint(proofAuthority, {
          observation,
          imagePoint: request.imagePoint,
          expectedCaptureTarget: captureTarget,
          interactionTarget: request.interactionTarget,
          interactionProof,
          expectedSpace: request.expectedSpace,
          runtimeEpoch: request.operation.runtimeEpoch,
          loginSessionId: request.operation.loginSessionId,
          nativeGeneration: request.operation.nativeGeneration,
          inventoryRevision: request.operation.inventoryRevision,
          displayLayoutRevision: request.observationRef.displayLayoutRevision,
          deadlineAt: request.operation.deadlineAt,
          maxFrameAgeMs: 5_000,
          now,
        })
        return options.pointTransform?.(value) ?? value
      },
    },
    continuations: {
      async issue() { throw new Error("не используется") },
      async registerAcceptedTask() { throw new Error("не используется") },
      async advanceVerifiedStatus() { throw new Error("не используется") },
      async markVerifiedTerminal() { throw new Error("не используется") },
    },
    reservations: { async assertChild() { throw new Error("не используется") } },
  }
  return { checkpoints, context, services, resolvedPoints: () => resolvedPoints }
}

describe("C2 input authorization", () => {
  test("разделяет capture target и interaction target и разрешает macOS point", async () => {
    const value = fixture()
    const prepared = await prepareInputAction(host, value.services, value.context, {
      kind: "click",
      point: { x: 25, y: 40 },
      button: "right",
      count: 2,
    }, now)

    expect(prepared.target.target).toEqual(interactionTarget)
    expect(prepared.authorizedPoints[0]?.captureTarget).toEqual(captureTarget)
    expect(prepared.authorizedPoints[0]?.interactionTarget).toEqual(interactionTarget)
    expect(prepared.authorizedPoints[0]?.destinationPoint).toEqual({ x: -150, y: 100 })
    expect(value.checkpoints).toEqual([
      "input.authorize-context",
      "input.resolve-target",
      "input.authorize-point.0",
      "input.ready-dispatch",
    ])
  })

  test("не разрешает observation ref, отсутствующий в runtime registry", async () => {
    const value = fixture({
      wire: {
        ...wire,
        observationRef: { ...wire.observationRef!, observationId: "observation:other" },
      },
    })
    await expect(prepareInputAction(host, value.services, value.context, {
      kind: "hover",
      point: { x: 20, y: 20 },
    }, now)).rejects.toMatchObject({
      contract: { code: "proof-invalid", stage: "input-point-proof.0" },
    })
    expect(value.resolvedPoints()).toBe(1)
  })

  test("отмена между drag points прекращает дальнейшую авторизацию", async () => {
    const value = fixture({ stopAtCheckpoint: "input.authorize-point.1" })
    await expect(prepareInputAction(host, value.services, value.context, {
      kind: "drag",
      points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }],
      durationMs: 300,
      button: "left",
      modifiers: [],
    }, now)).rejects.toMatchObject({ contract: { code: "cancelled" } })
    expect(value.resolvedPoints()).toBe(1)
  })

  test("keyboard action требует desktop lease и адресуемый target", async () => {
    const missingLease = fixture({ resources: [] })
    await expect(prepareInputAction(host, missingLease.services, missingLease.context, {
      kind: "key",
      key: "enter",
      modifiers: [],
    }, now)).rejects.toMatchObject({ contract: { code: "lease-revoked" } })

    const displayContext = fixture({ wire: { ...wire, target: captureTarget } })
    await expect(prepareInputAction(host, displayContext.services, displayContext.context, {
      kind: "text",
      text: "текст",
      delayMs: 0,
    }, now)).rejects.toMatchObject({ contract: { code: "invalid-request" } })
  })

  test("не принимает substituted target resolution", async () => {
    const value = fixture({
      targetResolution(_request, result) {
        return { ...result, inventoryId: "inventory:foreign" }
      },
    })
    await expect(prepareInputAction(host, value.services, value.context, {
      kind: "key",
      key: "enter",
      modifiers: [],
    }, now)).rejects.toMatchObject({ contract: { code: "target-stale", stage: "input-target-binding" } })
  })

  test("не принимает substituted authorized point fields", async () => {
    const transforms: Array<(value: AuthorizedObservationPoint) => AuthorizedObservationPoint> = [
      value => ({ ...value, observationId: "observation:foreign" }),
      value => ({ ...value, imagePoint: { x: value.imagePoint.x + 1, y: value.imagePoint.y } }),
      value => ({ ...value, interactionTarget: captureTarget }),
      value => ({
        ...value,
        space: {
          ...value.space,
          kind: "macos-screen",
          display: { ...displayRef, nativeGeneration: "native:foreign" },
        },
      }),
    ]
    for (const pointTransform of transforms) {
      const value = fixture({ pointTransform })
      await expect(prepareInputAction(host, value.services, value.context, {
        kind: "click",
        point: { x: 25, y: 40 },
        button: "left",
        count: 1,
      }, now)).rejects.toMatchObject({ contract: { code: "proof-invalid", stage: "input-point-binding.0" } })
    }
  })

  test("не авторизует drag, известная длительность которого больше остатка budget", async () => {
    const value = fixture({
      wire: { ...wire, deadlineAt: "2026-09-15T10:00:01.100Z" },
    })
    await expect(prepareInputAction(host, value.services, value.context, {
      kind: "drag",
      points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
      durationMs: 5_000,
      button: "left",
      modifiers: [],
    }, now)).rejects.toMatchObject({ contract: { code: "deadline-exceeded", stage: "input-budget-admission" } })
    expect(value.resolvedPoints()).toBe(0)
  })
})
