import {
  NATIVE_PROTOCOL_VERSION,
  applicationBundleResolutionSchema,
  applicationLaunchResultSchema,
  applicationQuitResultSchema,
  authorizeAdapterContext,
  nativeStatusMatchesOperation,
  sameNativeGeneration,
  structurallyEqual,
  type AdapterControl,
  type AdapterResult,
  type AdapterServices,
  type ApplicationBundleResolution,
  type ApplicationLaunchRequest,
  type ApplicationLaunchResult,
  type ApplicationQuitRequest,
  type ApplicationQuitResult,
  type ApplicationResolveRequest,
  type ApplicationAdapter,
  type ContractError,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type OperationOutcome,
  type OperationTarget,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import {
  nativeApplicationLaunchRequestSchema,
  nativeApplicationLaunchResponseSchema,
  nativeApplicationQuitRequestSchema,
  nativeApplicationQuitResponseSchema,
  nativeApplicationResolveRequestSchema,
  nativeApplicationResolveResponseSchema,
} from "./applications-protocol.ts"

const APPLICATION_CAPABILITIES = ["desktop.applications", "desktop.application.lifecycle"] as const

export type { ApplicationAdapter } from "@meta/shared/contracts"

export class NativeApplicationAdapter implements ApplicationAdapter {
  readonly host
  readonly services: AdapterServices
  readonly capabilities = APPLICATION_CAPABILITIES

  readonly #native: NativeAdapter

  constructor(options: { native: NativeAdapter, services: AdapterServices }) {
    this.#native = options.native
    this.host = options.native.host
    this.services = options.services
  }

  async resolve(request: ApplicationResolveRequest, control: AdapterControl): Promise<ApplicationBundleResolution> {
    const generation = this.#generation()
    const response = await this.#native.request(
      nativeApplicationResolveRequestSchema,
      {
        kind: "request",
        intent: "read",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: requestId("application-resolve"),
        ...generation,
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        method: "application.resolve",
        payload: request,
      },
      nativeApplicationResolveResponseSchema,
      control,
    )
    if (!response.ok) throw new Error(response.error.message)
    const resolution = applicationBundleResolutionSchema.parse(response.result)
    if (
      !sameNativeGeneration(resolution.target.ref, generation)
      || resolution.requestedPath !== request.path
      || resolution.target.ref.bundleId !== request.bundleId
    ) {
      throw new Error("Application resolution вернул другой requested path, identifier или generation")
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "application-bundle-identity",
      sourceResponseRef: resolution.sourceResponseRef,
      inventoryId: resolution.inventoryId,
      inventoryRevision: resolution.inventoryRevision,
      displayLayoutRevision: 0,
      observedAt: resolution.observedAt,
      target: resolution.target,
    })
    await this.services.evidence.issueTargetResolution({ receipt, target: resolution.target })
    return resolution
  }

  async launch(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: ApplicationLaunchRequest,
  ): Promise<AdapterResult<ApplicationLaunchResult>> {
    await authorizeAdapterContext(this.host, this.services, context, new Date())
    const target = { kind: "application-bundle", ref: request.bundle } as const
    if (!structurallyEqual(context.wire.target, target)) {
      throw new Error("Application launch context содержит другой exact bundle")
    }
    const nativeRequestId = requestId("application-launch")
    const response = await this.#native.request(
      nativeApplicationLaunchRequestSchema,
      {
        kind: "request",
        intent: "mutation",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: nativeRequestId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        deadlineAt: context.wire.deadlineAt,
        method: "application.launch",
        operation: context.wire,
        payload: request,
      },
      nativeApplicationLaunchResponseSchema,
      context.control,
    )
    if (!response.ok) return nativeFailure(response.error, context, target)
    const value = applicationLaunchResultSchema.parse(response.result.value)
    assertStatus(nativeRequestId, context, response.result.status)
    if (value.state === "running") {
      assertProcessGeneration(value.application, context)
      assertFinishedStatus(response.result.status, "Application launch")
      return {
        ok: true,
        value,
        outcome: outcomeFromStatus(response.result.status, context.resources),
        nativeStatus: response.result.status,
      }
    }
    if (value.candidate !== undefined) assertProcessGeneration(value.candidate, context)
    return {
      ok: false,
      error: unknownApplicationError(
        "application-launch",
        value.reason,
        context,
        value.candidate === undefined ? target : { kind: "application", ref: value.candidate },
      ),
      outcome: outcomeFromStatus(response.result.status, context.resources),
      nativeStatus: response.result.status,
    }
  }

  async quit(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: ApplicationQuitRequest,
  ): Promise<AdapterResult<ApplicationQuitResult>> {
    await authorizeAdapterContext(this.host, this.services, context, new Date())
    const target = { kind: "application", ref: request.application } as const
    if (!structurallyEqual(context.wire.target, target)) {
      throw new Error("Application quit context содержит другой exact process")
    }
    const nativeRequestId = requestId("application-quit")
    const response = await this.#native.request(
      nativeApplicationQuitRequestSchema,
      {
        kind: "request",
        intent: "mutation",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: nativeRequestId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        deadlineAt: context.wire.deadlineAt,
        method: "application.quit",
        operation: context.wire,
        payload: request,
      },
      nativeApplicationQuitResponseSchema,
      context.control,
    )
    if (!response.ok) return nativeFailure(response.error, context, target)
    const value = applicationQuitResultSchema.parse(response.result.value)
    if (!structurallyEqual(value.application, request.application)) {
      throw new Error("Application quit вернул другой exact process")
    }
    assertStatus(nativeRequestId, context, response.result.status)
    if (value.state !== "unknown") {
      assertFinishedStatus(response.result.status, "Application quit")
      return {
        ok: true,
        value,
        outcome: outcomeFromStatus(response.result.status, context.resources),
        nativeStatus: response.result.status,
      }
    }
    return {
      ok: false,
      error: unknownApplicationError("application-quit", value.reason, context, target),
      outcome: outcomeFromStatus(response.result.status, context.resources),
      nativeStatus: response.result.status,
    }
  }

  #generation() {
    const generation = this.#native.generation
    if (generation === undefined) throw new Error("Native handshake ещё не завершён")
    if (
      generation.runtimeEpoch !== this.host.generation.runtimeEpoch
      || generation.loginSessionId !== this.host.generation.loginSessionId
    ) {
      throw new Error("Native generation не совпадает с ApplicationAdapter host")
    }
    return generation
  }
}

function assertProcessGeneration(
  process: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
  context: RuntimeOperationContext<NativeExecutionContext>,
) {
  if (!sameNativeGeneration(process, context.wire)) {
    throw new Error("Application result содержит process из другой native generation")
  }
}

function assertStatus(
  nativeRequestId: string,
  context: RuntimeOperationContext<NativeExecutionContext>,
  status: NativeOperationStatus,
) {
  if (status.requestId !== nativeRequestId || !nativeStatusMatchesOperation(context.wire, status)) {
    throw new Error("Application native status не коррелирует с request, operation или process generation")
  }
}

function assertFinishedStatus(status: NativeOperationStatus, stage: string) {
  if (status.execution !== "finished" || status.dispatch !== "finished") {
    throw new Error(`${stage} вернул terminal value без finished native status`)
  }
}

function nativeFailure(
  error: ContractError,
  context: RuntimeOperationContext<NativeExecutionContext>,
  target: OperationTarget,
): AdapterResult<never> {
  return {
    ok: false,
    error: {
      ...error,
      replayAllowed: false,
      context: {
        operationId: context.wire.operationId,
        target,
        ...(error.context?.resourceRef === undefined ? {} : { resourceRef: error.context.resourceRef }),
        ...(error.context?.checkpoint === undefined ? {} : { checkpoint: error.context.checkpoint }),
        ...(error.context?.capabilityId === undefined ? {} : { capabilityId: error.context.capabilityId }),
      },
    },
    outcome: unknownOutcome(context.resources),
  }
}

function unknownApplicationError(
  stage: string,
  reason: string,
  context: RuntimeOperationContext<NativeExecutionContext>,
  target: OperationTarget,
): ContractError {
  return {
    code: "operation-outcome-unknown",
    message: reason,
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
    context: { operationId: context.wire.operationId, target },
  }
}

function outcomeFromStatus(
  status: NativeOperationStatus,
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome {
  const cleanup = status.cleanup === "complete" && ["finished", "failed", "cancelled"].includes(status.execution)
    ? completeCleanup(resources)
    : unknownCleanup(resources)
  return {
    dispatch: status.dispatch,
    targetVerified: status.targetVerified,
    userInterference: status.userInterference,
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: status.restorationAllowed ? "kept-target" : "not-applicable",
    ...(status.lastCheckpoint === undefined ? {} : { lastCheckpoint: status.lastCheckpoint }),
    dispatchAttempts: status.dispatchAttempts,
    ledgerRevision: status.ledgerRevision,
  }
}

function unknownOutcome(resources: readonly RuntimeResourceHandle[]): OperationOutcome {
  return {
    dispatch: "unknown",
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: unknownCleanup(resources),
    restoration: "unknown",
    dispatchAttempts: 0,
  }
}

function completeCleanup(resources: readonly RuntimeResourceHandle[]): OperationOutcome["cleanup"] {
  if (resources.length === 0) return { scope: "none", state: "complete", resources: [] }
  return {
    scope: "owned",
    state: "complete",
    resources: resources.map(handle => ({ handle, outcome: "released" })),
  }
}

function unknownCleanup(resources: readonly RuntimeResourceHandle[]): OperationOutcome["cleanup"] {
  if (resources.length === 0) return { scope: "none", state: "complete", resources: [] }
  return {
    scope: "owned",
    state: "unknown",
    resources: resources.map(handle => ({ handle, outcome: "quarantined" })),
    reason: "Native application cleanup не подтверждён",
  }
}

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`
}
