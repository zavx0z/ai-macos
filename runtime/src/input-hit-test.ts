import {
  NATIVE_PROTOCOL_VERSION,
  mapObservationPointGeometry,
  nativeEvidenceReportSchema,
  structurallyEqual,
  type NativeEvidenceReport,
  type Observation,
  type ResolveStoredObservationPointRequest,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import type { NativeBrokerAdapter } from "@meta/native"
import {
  nativeHitTestRequestSchema,
  nativeHitTestResultMatches,
  type NativeHitTestResult,
} from "@meta/native/protocol"
import { randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"
import type { NativePointEvidenceProvider } from "./authorities.ts"
import { RuntimeContractError } from "./errors.ts"

export type NativePointHitClient = Pick<
  NativeBrokerAdapter,
  "generation" | "hitTest" | "evidencePublisher"
>

export class RuntimeNativePointHitProvider {
  readonly #native: NativePointHitClient
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource

  constructor(options: {
    native: NativePointHitClient
    now?: RuntimeClock
    ids?: RuntimeIdSource
  }) {
    this.#native = options.native
    this.#clock = options.now ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  readonly provide: NativePointEvidenceProvider = async (
    request,
    observation,
    control,
  ) => {
    await control.checkpoint("point-hit-prepare")
    const mapped = this.#authorizeStoredGeometry(request, observation)
    const generation = this.#native.generation
    if (generation === undefined) throw new Error("Native hit-test generation недоступна")
    const nativeRequest = nativeHitTestRequestSchema.parse({
      kind: "request",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: this.#ids.next("input-hit-test"),
      ...generation,
      deadlineAt: request.operation.deadlineAt,
      intent: "read",
      method: "input.hit-test",
      operation: request.operation,
      payload: {
        observationRef: request.observationRef,
        frameRef: observation.image.frameRef,
        imagePoint: request.imagePoint,
        interactionTarget: request.interactionTarget,
        expectedRegionIndex: mapped.regionIndex,
        expectedDestinationPoint: mapped.destinationPoint,
      },
    })
    const response = await this.#native.hitTest(nativeRequest, control)
    await control.checkpoint("point-hit-response")
    if (!response.ok) {
      throw new RuntimeContractError(
        response.error.code,
        response.error.message,
        response.error.stage,
        {
          retryable: response.error.retryable,
          replayAllowed: response.error.replayAllowed,
          recoveryAction: response.error.recoveryAction,
          ...(response.error.context === undefined ? {} : { context: response.error.context }),
        },
      )
    }
    if (!nativeHitTestResultMatches(nativeRequest, response.result)) {
      throw new Error("Native hit-test result не совпадает с request")
    }
    if (response.result.status !== "confirmed") {
      throw hitTestFailure(response.result.status, response.result.reason)
    }
    this.#assertConfirmedResult(request, observation, mapped, response.result)
    const report = nativeEvidenceReportSchema.parse({
      factKind: "point-hit",
      sourceResponseRef: response.result.sourceResponseRef,
      inventoryId: response.result.inventoryId,
      inventoryRevision: response.result.inventoryRevision,
      displayLayoutRevision: response.result.displayLayoutRevision,
      observedAt: response.result.observedAt,
      observationId: response.result.observationId,
      frameRef: response.result.frameRef,
      regionIndex: response.result.regionIndex,
      imagePoint: response.result.imagePoint,
      interactionTarget: response.result.interactionTarget,
      expectedSpace: "macos-screen",
    } satisfies NativeEvidenceReport)
    const receipt = await this.#native.evidencePublisher.publish(report)
    await control.checkpoint("point-hit-evidence-published")
    this.#assertReceipt(receipt, response.result)
    return receipt
  }

  #authorizeStoredGeometry(
    request: ResolveStoredObservationPointRequest,
    observation: Observation,
  ) {
    if (
      request.expectedSpace !== "macos-screen"
      || request.operation.observationRef === undefined
      || !structurallyEqual(request.operation.observationRef, request.observationRef)
      || !structurallyEqual(request.operation.target, request.interactionTarget)
      || request.observationRef.observationId !== observation.observationId
      || observation.captureEvidence.state !== "confirmed"
      || request.observationRef.proofRef !== observation.captureEvidence.proof.proofRef
      || request.observationRef.inventoryRevision !== observation.inventoryRevision
      || request.observationRef.displayLayoutRevision !== observation.displayLayoutRevision
      || observation.runtimeEpoch !== request.operation.runtimeEpoch
      || observation.loginSessionId !== request.operation.loginSessionId
      || observation.nativeGeneration !== request.operation.nativeGeneration
      || observation.readiness.state !== "ready"
      || observation.image.frameRef.length === 0
      || this.#clock.now().getTime() >= Date.parse(observation.expiresAt)
      || this.#clock.now().getTime() >= Date.parse(request.operation.deadlineAt)
    ) {
      throw new Error("Stored observation/operation authority не совпадает для point-hit")
    }
    if (![
      "window",
      "surface",
      "display",
      "desktop-layout",
    ].includes(request.interactionTarget.kind)) {
      throw new Error(`Point-hit target ${request.interactionTarget.kind} не поддерживается`)
    }
    const mapped = mapObservationPointGeometry(observation, request.imagePoint)
    if (mapped.space.kind !== "macos-screen") {
      throw new Error("Stored point не принадлежит macos-screen region")
    }
    return mapped
  }

  #assertConfirmedResult(
    request: ResolveStoredObservationPointRequest,
    observation: Observation,
    mapped: ReturnType<typeof mapObservationPointGeometry>,
    result: Extract<NativeHitTestResult, { status: "confirmed" }>,
  ): void {
    if (
      result.operationId !== request.operation.operationId
      || result.inventoryId !== request.operation.inventoryId
      || result.inventoryRevision !== request.operation.inventoryRevision
      || result.displayLayoutRevision !== request.observationRef.displayLayoutRevision
      || result.observationId !== observation.observationId
      || result.frameRef !== observation.image.frameRef
      || result.regionIndex !== mapped.regionIndex
      || !structurallyEqual(result.imagePoint, request.imagePoint)
      || !structurallyEqual(result.destinationPoint, mapped.destinationPoint)
      || !structurallyEqual(result.space, mapped.space)
      || result.frameTimestamp !== mapped.frameTimestamp
      || !structurallyEqual(result.interactionTarget, request.interactionTarget)
      || !structurallyEqual(result.hitOwnerTarget, request.interactionTarget)
      || !result.topologyUnchanged
      || Date.parse(result.observedAt) < Date.parse(mapped.frameTimestamp)
      || Date.parse(result.observedAt) > Date.parse(request.operation.deadlineAt)
      || Date.parse(result.observedAt) > this.#clock.now().getTime() + 1_000
    ) {
      throw new Error("Confirmed point-hit не связан с authoritative stored geometry/operation")
    }
    if (result.scope === "window") {
      if (
        !["window", "surface"].includes(request.interactionTarget.kind)
        || !structurallyEqual(result.focusedTarget, request.interactionTarget)
        || result.focusRelation !== "target"
        || !result.frameUnchanged
      ) {
        throw new Error("Window point-hit не подтвердил exact hit/focus/frame")
      }
    } else if (
      !["display", "desktop-layout"].includes(request.interactionTarget.kind)
      || result.hitRelation !== "display-contained"
      || result.focusRelation !== "not-required-display-focus"
    ) {
      throw new Error("Display point-hit не подтвердил explicit display-contained scope")
    }
  }

  #assertReceipt(
    receipt: VerifiedNativeEvidenceReceipt,
    result: Extract<NativeHitTestResult, { status: "confirmed" }>,
  ): void {
    if (
      receipt.factKind !== "point-hit"
      || receipt.sourceResponseRef !== result.sourceResponseRef
      || receipt.inventoryId !== result.inventoryId
      || receipt.inventoryRevision !== result.inventoryRevision
      || receipt.displayLayoutRevision !== result.displayLayoutRevision
      || receipt.runtimeEpoch !== result.interactionTarget.ref.runtimeEpoch
      || receipt.loginSessionId !== result.interactionTarget.ref.loginSessionId
      || receipt.nativeGeneration !== result.interactionTarget.ref.nativeGeneration
      || receipt.observedAt !== result.observedAt
    ) {
      throw new Error("Point-hit evidence receipt не совпадает с confirmed native result")
    }
  }
}

function hitTestFailure(
  status: Exclude<NativeHitTestResult["status"], "confirmed">,
  reason: string,
): RuntimeContractError {
  switch (status) {
    case "observation-stale":
      return new RuntimeContractError(status, reason, "point-hit-native", {
        retryable: true,
        recoveryAction: "capture-new-observation",
      })
    case "inventory-stale":
    case "target-mismatch":
      return new RuntimeContractError("target-stale", reason, "point-hit-native", {
        retryable: true,
        recoveryAction: "refresh-inventory",
      })
    case "focus-mismatch":
      return new RuntimeContractError("user-interference", reason, "point-hit-native", {
        recoveryAction: "request-user-action",
      })
    case "ax-unavailable":
      return new RuntimeContractError("capability-unavailable", reason, "point-hit-native", {
        recoveryAction: "inspect-health",
      })
    case "cancelled":
      return new RuntimeContractError("cancelled", reason, "point-hit-native", {
        recoveryAction: "get-operation",
      })
  }
}

export function createNativePointEvidenceProvider(options: {
  native: NativePointHitClient
  now?: RuntimeClock
  ids?: RuntimeIdSource
}): NativePointEvidenceProvider {
  return new RuntimeNativePointHitProvider(options).provide
}
