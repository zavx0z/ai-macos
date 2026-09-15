import {
  CLIPBOARD_RESOURCE_REF,
  authorizeAdapterContext,
  clipboardVersionSchema,
  contractErrorSchema,
  operationOutcomeSchema,
  requireAuthorizedResourceHandles,
  z,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type ClipboardAdapter as SharedClipboardAdapter,
  type ClipboardExecutionContext,
  type ClipboardVersion,
  type ContractError,
  type OperationOutcome,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { NATIVE_CLIPBOARD_MAX_UTF8_BYTES } from "@meta/native/protocol"
import {
  ClipboardBackendError,
  clipboardBackendReportSchema,
  type ClipboardBackendReport,
  type VersionedClipboardBackend,
} from "./native-clipboard-backend.ts"

export const clipboardReadRequestSchema = z.strictObject({
  kind: z.literal("read"),
})

export const clipboardWriteRequestSchema = z.strictObject({
  kind: z.literal("write"),
  text: z.string(),
  expectedVersion: clipboardVersionSchema.optional(),
}).refine(request => new TextEncoder().encode(request.text).byteLength <= NATIVE_CLIPBOARD_MAX_UTF8_BYTES, {
  path: ["text"],
  message: `clipboard text превышает ${NATIVE_CLIPBOARD_MAX_UTF8_BYTES} UTF-8 байт`,
})

export const clipboardRequestSchema = z.discriminatedUnion("kind", [
  clipboardReadRequestSchema,
  clipboardWriteRequestSchema,
])
export type ClipboardRequest = z.infer<typeof clipboardRequestSchema>

const clipboardTextMetadataShape = {
  version: clipboardVersionSchema,
  length: z.number().int().safe().min(0),
  bytes: z.number().int().safe().min(0).max(NATIVE_CLIPBOARD_MAX_UTF8_BYTES),
}

export const clipboardReadResultSchema = z.union([
  z.strictObject({
    kind: z.literal("read"),
    status: z.literal("ok"),
    text: z.string(),
    beforeChangeCount: z.number().int().safe().min(0),
    afterChangeCount: z.number().int().safe().min(0),
    ...clipboardTextMetadataShape,
  }),
  z.strictObject({
    kind: z.literal("read"),
    status: z.literal("text-unavailable"),
    beforeChangeCount: z.number().int().safe().min(0),
    afterChangeCount: z.number().int().safe().min(0),
    version: clipboardVersionSchema,
  }),
])
export const clipboardWriteResultSchema = z.strictObject({
  kind: z.literal("write"),
  status: z.literal("written"),
  beforeChangeCount: z.number().int().safe().min(0),
  declaredChangeCount: z.number().int().safe().min(0),
  afterChangeCount: z.number().int().safe().min(0),
  atomicPrecondition: z.literal(false),
  ...clipboardTextMetadataShape,
})
export const clipboardResultSchema = z.union([
  clipboardReadResultSchema,
  clipboardWriteResultSchema,
])
export type ClipboardResult = z.infer<typeof clipboardResultSchema>

export const clipboardAdapterResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: clipboardResultSchema,
    outcome: operationOutcomeSchema,
    clipboard: clipboardBackendReportSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: contractErrorSchema,
    outcome: operationOutcomeSchema,
    clipboard: clipboardBackendReportSchema,
  }),
])
export type ClipboardAdapterResult = z.infer<typeof clipboardAdapterResultSchema>

export class SystemClipboardAdapter implements SharedClipboardAdapter<ClipboardRequest, ClipboardResult> {
  readonly capabilities = ["input.clipboard"] as const

  constructor(
    readonly host: AdapterHostContext,
    readonly services: AdapterServices,
    readonly backend: VersionedClipboardBackend,
    readonly now: () => Date = () => new Date(),
  ) {}

  async currentVersion(context: RuntimeOperationContext<ClipboardExecutionContext>): Promise<ClipboardVersion> {
    await this.#authorize(context)
    await context.control.checkpoint("clipboard.version")
    const call = await this.backend.currentVersion(context)
    if (call.value.status !== "ok") {
      throw new ClipboardBackendError(
        `Clipboard version недоступна: ${call.value.status}`,
        undefined,
        call.report,
      )
    }
    return clipboardVersionSchema.parse({
      backendBuildId: this.backend.buildId,
      changeCount: call.value.changeCount,
    })
  }

  async execute(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    input: ClipboardRequest,
  ): Promise<ClipboardAdapterResult> {
    let request: ClipboardRequest
    try {
      request = clipboardRequestSchema.parse(input)
      await this.#authorize(context)
    } catch (error) {
      const command = isWriteLike(input) ? "clipboard.write" : "clipboard.read"
      return failed(
        context,
        errorFrom(error, "clipboard-precondition"),
        notDispatchedReport(command),
        "none",
        "unknown",
      )
    }

    if (request.kind === "read") return await this.#read(context)
    return await this.#write(context, request)
  }

  async #read(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
  ): Promise<ClipboardAdapterResult> {
    try {
      await context.control.checkpoint("clipboard.read")
      const call = await this.backend.readText(context, NATIVE_CLIPBOARD_MAX_UTF8_BYTES)
      const value = call.value
      if (value.status === "ok") {
        const bytes = new TextEncoder().encode(value.text).byteLength
        return clipboardAdapterResultSchema.parse({
          ok: true,
          value: {
            kind: "read",
            status: "ok",
            text: value.text,
            length: value.text.length,
            bytes,
            version: { backendBuildId: this.backend.buildId, changeCount: value.afterChangeCount },
            beforeChangeCount: value.beforeChangeCount,
            afterChangeCount: value.afterChangeCount,
          },
          outcome: pendingOutcome(context, "none", "verified"),
          clipboard: call.report,
        })
      }
      if (value.status === "text-unavailable") {
        return clipboardAdapterResultSchema.parse({
          ok: true,
          value: {
            kind: "read",
            status: "text-unavailable",
            version: { backendBuildId: this.backend.buildId, changeCount: value.afterChangeCount },
            beforeChangeCount: value.beforeChangeCount,
            afterChangeCount: value.afterChangeCount,
          },
          outcome: pendingOutcome(context, "none", "verified"),
          clipboard: call.report,
        })
      }
      if (value.status === "changed-during-read") {
        return failed(
          context,
          contractError("target-stale", "Clipboard изменился во время чтения", "clipboard-read", true, true, "retry-read-only"),
          call.report,
          "none",
          "unknown",
        )
      }
      return failed(
        context,
        contractError(
          value.status === "payload-too-large" ? "payload-too-large" : "capability-unavailable",
          `Clipboard read завершился: ${value.status}`,
          "clipboard-read",
          false,
          false,
          "none",
        ),
        call.report,
        "none",
        "unknown",
      )
    } catch (error) {
      return backendFailure(context, error, "clipboard.read")
    }
  }

  async #write(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    request: z.infer<typeof clipboardWriteRequestSchema>,
  ): Promise<ClipboardAdapterResult> {
    if (
      request.expectedVersion !== undefined
      && request.expectedVersion.backendBuildId !== this.backend.buildId
    ) {
      return failed(
        context,
        contractError(
          "backend-version-mismatch",
          "Clipboard expectedVersion принадлежит другому backend build",
          "clipboard-write-precondition",
          false,
          false,
          "inspect-health",
        ),
        notDispatchedReport("clipboard.write"),
        "none",
        "unknown",
      )
    }

    try {
      await context.control.checkpoint("clipboard.write")
      const call = await this.backend.conditionalWrite(
        context,
        request.text,
        request.expectedVersion?.changeCount,
      )
      const value = call.value
      if (value.status === "written") {
        const bytes = new TextEncoder().encode(request.text).byteLength
        return clipboardAdapterResultSchema.parse({
          ok: true,
          value: {
            kind: "write",
            status: "written",
            length: request.text.length,
            bytes,
            version: { backendBuildId: this.backend.buildId, changeCount: value.afterChangeCount },
            beforeChangeCount: value.beforeChangeCount,
            declaredChangeCount: value.declaredChangeCount,
            afterChangeCount: value.afterChangeCount,
            atomicPrecondition: false,
          },
          outcome: pendingOutcome(context, "finished", "verified"),
          clipboard: call.report,
        })
      }
      if (value.status === "precondition-mismatch-no-dispatch") {
        return failed(
          context,
          contractError(
            "target-stale",
            "Clipboard expectedChangeCount больше не актуален",
            "clipboard-write-precondition",
            true,
            false,
            "none",
          ),
          call.report,
          "none",
          "unknown",
        )
      }
      if (value.status === "partial-or-unknown") {
        return failed(
          context,
          contractError(
            "operation-outcome-unknown",
            "Clipboard write начат, но итог ownership не подтверждён",
            "clipboard-write",
            false,
            false,
            "get-operation",
          ),
          call.report,
          "unknown",
          "unknown",
        )
      }
      return failed(
        context,
        contractError(
          value.status === "payload-too-large" ? "payload-too-large" : "capability-unavailable",
          `Clipboard write отклонён: ${value.status}; payload исключён`,
          "clipboard-write",
          false,
          false,
          "none",
        ),
        call.report,
        "none",
        "unknown",
      )
    } catch (error) {
      return backendFailure(context, error, "clipboard.write")
    }
  }

  async #authorize(context: RuntimeOperationContext<ClipboardExecutionContext>): Promise<void> {
    await context.control.checkpoint("clipboard.authorize-context")
    await authorizeAdapterContext(this.host, this.services, context, this.now())
    if (context.wire.target.kind !== "clipboard" || context.wire.target.ref.clipboardRef !== "system") {
      throw new Error("Clipboard adapter требует system clipboard target")
    }
    if (this.host.capabilities.capabilities.find(capability => capability.id === "input.clipboard")?.state !== "ready") {
      throw new Error("Adapter capability input.clipboard не готова")
    }
    await requireAuthorizedResourceHandles(
      this.services.resources,
      context.resources,
      {
        operationId: context.wire.operationId,
        clientSessionId: context.wire.clientSessionId,
        principalId: context.wire.principalId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        now: this.now(),
      },
      [{ kind: "clipboard", resourceRef: CLIPBOARD_RESOURCE_REF }],
    )
  }
}

function backendFailure(
  context: RuntimeOperationContext<ClipboardExecutionContext>,
  error: unknown,
  command: ClipboardBackendReport["command"],
): ClipboardAdapterResult {
  if (error instanceof ClipboardBackendError) {
    const unknownWrite = command === "clipboard.write"
      && error.report.mutationAttempted === "unknown"
    return failed(
      context,
      unknownWrite
        ? contractError(
            "operation-outcome-unknown",
            "Native clipboard write response недоступен; payload исключён",
            "clipboard-write",
            false,
            false,
            "get-operation",
          )
        : errorFrom(error, command),
      error.report,
      unknownWrite ? "unknown" : "none",
      "unknown",
    )
  }
  return failed(
    context,
    errorFrom(error, command),
    notDispatchedReport(command),
    "none",
    "unknown",
  )
}

function failed(
  context: RuntimeOperationContext<ClipboardExecutionContext>,
  error: ContractError,
  clipboard: ClipboardBackendReport,
  dispatch: OperationOutcome["dispatch"],
  targetVerified: OperationOutcome["targetVerified"],
): ClipboardAdapterResult {
  return clipboardAdapterResultSchema.parse({
    ok: false,
    error,
    outcome: pendingOutcome(context, dispatch, targetVerified),
    clipboard,
  })
}

function pendingOutcome(
  context: RuntimeOperationContext<ClipboardExecutionContext>,
  dispatch: OperationOutcome["dispatch"],
  targetVerified: OperationOutcome["targetVerified"],
): OperationOutcome {
  return operationOutcomeSchema.parse({
    dispatch,
    targetVerified,
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: context.resources.length === 0
      ? { scope: "none", state: "complete", resources: [] }
      : {
          scope: "owned",
          state: "pending",
          resources: context.resources.map(handle => ({ handle, outcome: "held" })),
        },
    restoration: "not-applicable",
    dispatchAttempts: dispatch === "none" ? 0 : 1,
  })
}

function notDispatchedReport(command: ClipboardBackendReport["command"]): ClipboardBackendReport {
  return clipboardBackendReportSchema.parse({
    authority: "adapter-precondition",
    command,
    status: "not-dispatched",
    mutationAttempted: "false",
    atomicPrecondition: false,
  })
}

function errorFrom(error: unknown, stage: string): ContractError {
  if (error instanceof ClipboardBackendError && error.contract !== undefined) {
    const parsed = contractErrorSchema.safeParse(error.contract)
    if (parsed.success) {
      return {
        ...parsed.data,
        message: stage === "clipboard.write"
          ? "Native clipboard write завершился ошибкой; payload исключён"
          : parsed.data.message,
      }
    }
  }
  if (typeof error === "object" && error !== null && "contract" in error) {
    const parsed = contractErrorSchema.safeParse((error as { contract: unknown }).contract)
    if (parsed.success) return parsed.data
  }
  return contractError(
    "invalid-request",
    (error instanceof Error ? error.message : "Неизвестная clipboard ошибка").slice(0, 2_048),
    stage,
    false,
    false,
    "none",
  )
}

function contractError(
  code: ContractError["code"],
  message: string,
  stage: string,
  retryable: boolean,
  replayAllowed: boolean,
  recoveryAction: ContractError["recoveryAction"],
): ContractError {
  return contractErrorSchema.parse({
    code,
    message,
    stage,
    retryable,
    replayAllowed,
    recoveryAction,
  })
}

function isWriteLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "write"
}

export type GenericClipboardAdapterResult = AdapterResult<ClipboardResult>
