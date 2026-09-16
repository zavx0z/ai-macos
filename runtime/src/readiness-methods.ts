import { operationDeadline } from "./deadline.ts"
import {
  NATIVE_PROTOCOL_VERSION,
  adapterResultSchema,
  displayRefSchema,
  opaqueIdSchema,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  z,
  type AdapterControl,
  type AdapterResult,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type OperationOutcome,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
} from "@meta/shared/contracts"
import {
  nativeInputReadinessRequestSchema,
  nativeInputReadinessResultSchema,
  type NativeInputReadinessRequest,
  type NativeInputReadinessResponse,
  type NativeInputReadinessResult,
} from "@meta/native/protocol"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry } from "./method-registry.ts"

export const INPUT_READINESS_BUDGETS = Object.freeze({
  operationMs: 5_000,
  methodMs: 8_000,
})

export const inputReadinessMethodInputSchema = z.strictObject({
  clientRequestId: opaqueIdSchema,
  precondition: z.strictObject({
    target: z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
    inventoryId: opaqueIdSchema,
    inventoryRevision: z.number().int().safe().min(0),
  }),
})

export type RuntimeInputReadinessNative = Readonly<{
  inputReadiness(
    request: NativeInputReadinessRequest,
    control: AdapterControl,
  ): Promise<NativeInputReadinessResponse>
}>

export function registerReadinessMethods(
  registry: MethodRegistry,
  core: RuntimeCore,
  native: RuntimeInputReadinessNative,
  options: { now?: () => Date, visibility?: "public" | "internal" } = {},
): void {
  const now = options.now ?? (() => new Date())
  registry.register("input_readiness", {
    visibility: options.visibility ?? "public",
    title: "Проверить готовность ввода",
    description: "Выполняет адресованный active-event probe на выбранном display и подтверждает возврат указателя.",
    input: inputReadinessMethodInputSchema,
    output: z.strictObject({
      operation: operationRecordSchema,
      result: adapterResultSchema(nativeInputReadinessResultSchema),
    }),
    readOnly: false,
    destructive: false,
    timeoutMs: INPUT_READINESS_BUDGETS.methodMs,
    requiredCapabilities: ["input.readiness", "runtime.operations", "desktop.displays"],
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
    async execute(context, request) {
      const deadlineAt = operationDeadline(context.signal, INPUT_READINESS_BUDGETS.operationMs, now().getTime())
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: request.clientRequestId,
        precondition: request.precondition,
        deadlineAt,
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return await core.runOperation(
        context.session,
        intent,
        { expectedDisplayRef: request.precondition.target.ref },
        async operationContext => {
          if (operationContext.wire.kind !== "native") {
            throw new Error("Input readiness требует NativeExecutionContext")
          }
          const nativeContext = operationContext as RuntimeOperationContext<NativeExecutionContext>
          const nativeRequest = nativeInputReadinessRequestSchema.parse({
            kind: "request",
            intent: "mutation",
            protocolVersion: NATIVE_PROTOCOL_VERSION,
            requestId: `readiness:${crypto.randomUUID()}`,
            runtimeEpoch: nativeContext.wire.runtimeEpoch,
            loginSessionId: nativeContext.wire.loginSessionId,
            nativeGeneration: nativeContext.wire.nativeGeneration,
            deadlineAt: nativeContext.wire.deadlineAt,
            method: "input.readiness",
            operation: nativeContext.wire,
            payload: { expectedDisplayRef: request.precondition.target.ref },
          })
          const response = await native.inputReadiness(
            nativeRequest,
            nativeContext.control,
          )
          if (!response.ok) {
            return {
              ok: false,
              error: response.error,
              outcome: unknownOutcome(nativeContext.resources),
            } satisfies AdapterResult<NativeInputReadinessResult>
          }
          if (!response.result.value.inputReady) {
            const inputReadiness = diagnostics(response.result.value)
            const failure = readinessFailure(inputReadiness)
            return {
              ok: false,
              error: {
                code: failure.code,
                message: inputReadiness.reason,
                stage: "input-readiness",
                retryable: false,
                replayAllowed: false,
                recoveryAction: failure.recoveryAction,
                context: {
                  operationId: nativeContext.wire.operationId,
                  target: nativeContext.wire.target,
                  inputReadiness,
                },
              },
              outcome: outcomeFromReadiness(
                response.result.value,
                response.result.status,
                nativeContext.resources,
              ),
              nativeStatus: response.result.status,
            } satisfies AdapterResult<NativeInputReadinessResult>
          }
          return {
            ok: true,
            value: response.result.value,
            outcome: outcomeFromReadiness(
              response.result.value,
              response.result.status,
              nativeContext.resources,
            ),
            nativeStatus: response.result.status,
          } satisfies AdapterResult<NativeInputReadinessResult>
        },
        context.signal,
      )
    },
    isError: output => !output.result.ok,
  })
}

function readinessFailure(inputReadiness: ReturnType<typeof diagnostics>) {
  if (inputReadiness.interference === "observed") {
    return {
      code: "user-interference" as const,
      recoveryAction: "request-user-action" as const,
    }
  }
  if (inputReadiness.quarantined || inputReadiness.cleanup !== "complete") {
    return {
      code: "resource-quarantined" as const,
      recoveryAction: "recover-input" as const,
    }
  }
  return {
    code: "capability-unavailable" as const,
    recoveryAction: "inspect-health" as const,
  }
}

function diagnostics(result: NativeInputReadinessResult) {
  if (result.inputReady || result.reason === undefined) {
    throw new Error("Readiness diagnostics требует not-ready result с причиной")
  }
  return {
    probe: result.probe,
    inputReady: false as const,
    quarantined: result.quarantined,
    movePosted: result.movePosted,
    moveObserved: result.moveObserved,
    moveReadbackConfirmed: result.moveReadbackConfirmed,
    restorePosted: result.restorePosted,
    restoreObserved: result.restoreObserved,
    restoreReadbackConfirmed: result.restoreReadbackConfirmed,
    dispatch: result.dispatch,
    cleanup: result.cleanup,
    interference: result.interference,
    restoration: result.restoration,
    reason: result.reason,
  }
}

function outcomeFromReadiness(
  result: NativeInputReadinessResult,
  status: NativeOperationStatus,
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome {
  const restoration = result.restoration === "skipped-user-takeover"
    ? "skipped-external-change"
    : result.restoration === "not-attempted"
      ? "not-applicable"
      : result.restoration
  return {
    dispatch: result.dispatch,
    targetVerified: status.targetVerified,
    userInterference: result.interference,
    observation: result.moveObserved || result.restoreObserved
      ? "available"
      : "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: cleanupOutcome(result.cleanup, resources),
    restoration,
    ...(status.lastCheckpoint === undefined
      ? {}
      : { lastCheckpoint: status.lastCheckpoint }),
    dispatchAttempts: status.dispatchAttempts,
    ledgerRevision: status.ledgerRevision,
  }
}

function unknownOutcome(
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome {
  return {
    dispatch: "unknown",
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: cleanupOutcome("unknown", resources),
    restoration: "unknown",
    dispatchAttempts: 0,
  }
}

function cleanupOutcome(
  state: NativeOperationStatus["cleanup"],
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome["cleanup"] {
  if (state === "complete") {
    return {
      scope: "owned",
      state: "complete",
      resources: resources.map(handle => ({ handle, outcome: "released" as const })),
    }
  }
  return {
    scope: "owned",
    state,
    resources: resources.map(handle => ({ handle, outcome: "quarantined" as const })),
    reason: "Native readiness cleanup не подтверждён",
  }
}
