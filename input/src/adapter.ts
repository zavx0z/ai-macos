import {
  NATIVE_PROTOCOL_VERSION,
  contractErrorSchema,
  nativeResponseMatchesRequest,
  nativeStatusMatchesOperation,
  nativeStatusMatchesRequest,
  nativeStatusRequestSchema,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type ContractError,
  type InputAdapter as SharedInputAdapter,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type OperationOutcome,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  nativeInputExecutionRequestSchema,
  nativeInputExecutionResponseSchema,
} from "@meta/native/protocol"
import { InputPlanError } from "./action-plan.ts"
import {
  inputActionResultSchema,
  type InputAction,
  type InputActionResult,
} from "./actions.ts"
import {
  admitPreparedInputBudget,
  prepareInputAction,
  type PreparedInputAction,
} from "./authorization.ts"
import { compileNativeInputAction } from "./native-action.ts"

export type InputAdapterOptions = Readonly<{
  now?: () => Date
  nextRequestId?: (operationId: string, purpose: "execute" | "status") => string
}>

export class DesktopInputAdapter implements SharedInputAdapter<InputAction, InputActionResult> {
  readonly capabilities = ["input.pointer", "input.drag", "input.keyboard"] as const
  readonly #now: () => Date
  readonly #nextRequestId: (operationId: string, purpose: "execute" | "status") => string

  constructor(
    readonly host: AdapterHostContext,
    readonly services: AdapterServices,
    readonly native: NativeAdapter,
    options: InputAdapterOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date())
    this.#nextRequestId = options.nextRequestId ?? ((operationId, purpose) => {
      const prefix = operationId.slice(0, 72)
      return `${prefix}:${purpose}:${crypto.randomUUID()}`
    })
  }

  async execute(
    context: RuntimeOperationContext<NativeExecutionContext>,
    action: InputAction,
  ): Promise<AdapterResult<InputActionResult>> {
    let prepared: PreparedInputAction
    let budget
    try {
      prepared = await prepareInputAction(this.host, this.services, context, action, this.#now())
      await context.control.checkpoint("input.compile-native-action")
      budget = admitPreparedInputBudget(prepared, context.wire.deadlineAt, this.#now())
    } catch (error) {
      return preDispatchFailure(context, error)
    }

    let nativeAction
    try {
      nativeAction = compileNativeInputAction(prepared.plan, prepared.authorizedPoints)
    } catch (error) {
      return preDispatchFailure(context, error)
    }

    const request = nativeInputExecutionRequestSchema.parse({
      kind: "request",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: this.#nextRequestId(context.wire.operationId, "execute"),
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: context.wire.nativeGeneration,
      deadlineAt: context.wire.deadlineAt,
      intent: "mutation",
      method: "input.execute",
      operation: context.wire,
      payload: {
        actionDeadlineAt: new Date(budget.deadlineAtMs).toISOString(),
        action: nativeAction,
      },
    })

    try {
      await context.control.checkpoint("input.native-dispatch")
    } catch (error) {
      return preDispatchFailure(context, error)
    }

    try {
      const response = await this.native.request(
        nativeInputExecutionRequestSchema,
        request,
        nativeInputExecutionResponseSchema,
        context.control,
      )
      if (!nativeResponseMatchesRequest(request, response)) {
        return unknownFailure(context, "Native response не совпадает с input request")
      }
      if (!response.ok) {
        const status = await this.#reconcileStatus(context)
        const error = sanitizeTextError(response.error, prepared)
        return status === undefined
          ? unknownFailure(context, error.message)
          : statusFailure(context, error, sanitizeNativeStatus(status, prepared))
      }

      if (!nativeStatusMatchesOperation(context.wire, response.result.status)) {
        return unknownFailure(context, "Inline native status не совпадает с operation/fence")
      }
      const status = sanitizeNativeStatus(response.result.status, prepared)
      const outcome = outcomeFromNative(context, status)
      if (!nativeExecutionSucceeded(response.result.completedSteps, response.result.totalSteps, status)) {
        return statusFailure(context, failureForStatus(status), status, outcome)
      }
      const value = inputActionResultSchema.parse({
        kind: prepared.action.kind,
        dispatchedUnits: response.result.completedSteps,
        destinationPoints: prepared.authorizedPoints.map(point => point.destinationPoint),
        ownershipProofRefs: [...new Set(prepared.authorizedPoints.map(point => point.ownershipProofRef))],
      })
      return { ok: true, value, outcome, nativeStatus: status }
    } catch (error) {
      const status = await this.#reconcileStatus(context)
      const contractError = sanitizeTextError(errorFrom(error, "input-native"), prepared)
      if (status !== undefined) return statusFailure(context, contractError, sanitizeNativeStatus(status, prepared))
      return unknownFailure(context, contractError.message)
    }
  }

  async #reconcileStatus(
    context: RuntimeOperationContext<NativeExecutionContext>,
  ): Promise<NativeOperationStatus | undefined> {
    const statusDeadline = new Date(this.#now().getTime() + 1_000).toISOString()
    const request = nativeStatusRequestSchema.parse({
      requestId: this.#nextRequestId(context.wire.operationId, "status"),
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: context.wire.nativeGeneration,
      deadlineAt: statusDeadline,
      operationId: context.wire.operationId,
    })
    const signal = AbortSignal.timeout(1_000)
    try {
      const status = await this.native.status(request, signal)
      return nativeStatusMatchesRequest(request, status) && nativeStatusMatchesOperation(context.wire, status)
        ? status
        : undefined
    } catch {
      return undefined
    }
  }
}

function nativeExecutionSucceeded(
  completedSteps: number,
  totalSteps: number,
  status: NativeOperationStatus,
): boolean {
  return completedSteps === totalSteps
    && status.execution === "finished"
    && status.dispatch === "finished"
    && status.targetVerified === "verified"
    && status.cleanup === "complete"
    && !status.quarantined
    && status.userInterference !== "observed"
}

function outcomeFromNative(
  context: RuntimeOperationContext<NativeExecutionContext>,
  status: NativeOperationStatus,
): OperationOutcome {
  return {
    dispatch: status.dispatch,
    targetVerified: status.targetVerified,
    userInterference: status.userInterference,
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: runtimeCleanupFromStatus(context, status),
    restoration: "not-applicable",
    ...(status.lastCheckpoint === undefined ? {} : { lastCheckpoint: status.lastCheckpoint }),
    dispatchAttempts: status.dispatchAttempts,
    ledgerRevision: status.ledgerRevision,
  }
}

function statusFailure(
  context: RuntimeOperationContext<NativeExecutionContext>,
  error: ContractError,
  status: NativeOperationStatus,
  knownOutcome?: OperationOutcome,
): AdapterResult<InputActionResult> {
  return {
    ok: false,
    error: failureForStatus(status, error),
    outcome: knownOutcome ?? {
      dispatch: status.dispatch,
      targetVerified: status.targetVerified,
      userInterference: status.userInterference,
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: runtimeCleanupFromStatus(context, status),
      restoration: "not-applicable",
      ...(status.lastCheckpoint === undefined ? {} : { lastCheckpoint: status.lastCheckpoint }),
      dispatchAttempts: status.dispatchAttempts,
      ledgerRevision: status.ledgerRevision,
    },
    nativeStatus: status,
  }
}

function preDispatchFailure(
  context: RuntimeOperationContext<NativeExecutionContext>,
  error: unknown,
): AdapterResult<InputActionResult> {
  return {
    ok: false,
    error: errorFrom(error, "input-pre-dispatch"),
    outcome: {
      dispatch: "none",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: runtimeCleanup(context, "complete"),
      restoration: "not-applicable",
      dispatchAttempts: 0,
    },
  }
}

function unknownFailure(
  context: RuntimeOperationContext<NativeExecutionContext>,
  message: string,
): AdapterResult<InputActionResult> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      code: "operation-outcome-unknown",
      message,
      stage: "input-native-reconciliation",
      retryable: false,
      replayAllowed: false,
      recoveryAction: "get-operation",
      context: { operationId: context.wire.operationId, target: context.wire.target },
    }),
    outcome: {
      dispatch: "unknown",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: runtimeCleanup(context, "unknown"),
      restoration: "unknown",
      dispatchAttempts: 0,
    },
  }
}

function runtimeCleanupFromStatus(
  context: RuntimeOperationContext<NativeExecutionContext>,
  status: NativeOperationStatus,
): OperationOutcome["cleanup"] {
  if (context.resources.length === 0) return { scope: "none", state: "complete", resources: [] }
  const cleanupConfirmed = status.cleanup === "complete"
    && ["idle", "finished", "cancelled", "failed"].includes(status.execution)
  if (cleanupConfirmed) {
    return {
      scope: "owned",
      state: "complete",
      resources: context.resources.map(handle => ({ handle, outcome: "released" })),
    }
  }
  const state = status.cleanup === "incomplete" ? "incomplete" : "unknown"
  return {
    scope: "owned",
    state,
    reason: `Native input cleanup: ${status.execution}/${status.cleanup}`,
    resources: context.resources.map(handle => ({ handle, outcome: "quarantined" })),
  }
}

function runtimeCleanup(
  context: RuntimeOperationContext<NativeExecutionContext>,
  state: "complete" | "unknown",
): OperationOutcome["cleanup"] {
  if (context.resources.length === 0) return { scope: "none", state: "complete", resources: [] }
  return state === "complete"
    ? {
        scope: "owned",
        state: "complete",
        resources: context.resources.map(handle => ({ handle, outcome: "released" })),
      }
    : {
        scope: "owned",
        state: "unknown",
        reason: "Native input status недоступен",
        resources: context.resources.map(handle => ({ handle, outcome: "quarantined" })),
      }
}

function failureForStatus(status: NativeOperationStatus, fallback?: ContractError): ContractError {
  if (
    !status.quarantined
    && status.cleanup === "complete"
    && status.userInterference !== "observed"
    && status.targetVerified !== "failed"
    && status.execution !== "cancelled"
    && status.execution !== "finished"
    && status.error !== undefined
  ) {
    return status.error
  }
  const code = status.quarantined
    ? "resource-quarantined"
    : status.cleanup !== "complete"
      ? "cleanup-incomplete"
      : status.userInterference === "observed"
        ? "user-interference"
        : status.targetVerified === "failed"
          ? "target-stale"
          : status.execution === "cancelled"
            ? "cancelled"
            : ["dispatching", "cancelling"].includes(status.execution)
              ? "operation-in-progress"
            : status.execution === "finished" && status.dispatch !== "finished"
              ? "operation-outcome-unknown"
              : fallback?.code ?? status.error?.code ?? "operation-outcome-unknown"
  return contractErrorSchema.parse({
    code,
    message: status.error?.message ?? fallback?.message ?? `Native input завершился в состоянии ${status.execution}/${status.dispatch}`,
    stage: "input-native-status",
    retryable: false,
    replayAllowed: false,
    recoveryAction: status.quarantined || status.cleanup !== "complete" ? "recover-input" : "get-operation",
    ...(status.operationId === undefined ? {} : { context: { operationId: status.operationId } }),
  })
}

function errorFrom(error: unknown, stage: string): ContractError {
  if (typeof error === "object" && error !== null && "contract" in error) {
    const parsed = contractErrorSchema.safeParse((error as { contract: unknown }).contract)
    if (parsed.success) return parsed.data
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return contractErrorSchema.parse({
      code: "cancelled",
      message: error.message,
      stage,
      retryable: false,
      replayAllowed: false,
      recoveryAction: "get-operation",
    })
  }
  const payloadTooLarge = error instanceof InputPlanError && error.message.includes("native limit")
  return contractErrorSchema.parse({
    code: payloadTooLarge ? "payload-too-large" : "invalid-request",
    message: messageFrom(error).slice(0, 2_048),
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: "none",
  })
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная input ошибка"
}

function sanitizeTextError(error: ContractError, prepared: PreparedInputAction): ContractError {
  if (prepared.action.kind !== "text") return error
  return {
    ...error,
    message: "Native text input завершился ошибкой; payload исключён из результата",
  }
}

function sanitizeNativeStatus(
  status: NativeOperationStatus,
  prepared: PreparedInputAction,
): NativeOperationStatus {
  if (prepared.action.kind !== "text" || status.error === undefined) return status
  return {
    ...status,
    error: sanitizeTextError(status.error, prepared),
  }
}
