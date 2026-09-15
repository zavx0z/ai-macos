import {
  NATIVE_PROTOCOL_VERSION,
  structurallyEqual,
  z,
  type ClipboardExecutionContext,
  type ContractError,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import type { NativeBrokerAdapter } from "@meta/native"
import {
  NATIVE_CLIPBOARD_MAX_UTF8_BYTES,
  clipboardResponseMatches,
  nativeClipboardReadResultSchema,
  nativeClipboardRequestSchema,
  nativeClipboardVersionResultSchema,
  nativeClipboardWriteResultSchema,
} from "@meta/native/protocol"

const countSchema = z.number().int().safe().min(0)

export const clipboardBackendReceiptSchema = z.strictObject({
  receiptId: z.string().min(1).max(127),
  adapterInstanceRef: z.string().min(1).max(127),
  backendBuildId: z.string().min(1).max(127),
  requestId: z.string().min(1).max(127),
  operationId: z.string().min(1).max(127),
  runtimeEpoch: z.string().min(1).max(64),
  loginSessionId: z.string().min(1).max(64),
  nativeGeneration: z.string().min(1).max(64),
})
export type ClipboardBackendReceipt = z.infer<typeof clipboardBackendReceiptSchema>

export const clipboardBackendReportSchema = z.strictObject({
  authority: z.enum(["verified-response", "unverified-request", "adapter-precondition"]),
  command: z.enum(["clipboard.version", "clipboard.read", "clipboard.write"]),
  status: z.enum([
    "ok",
    "changed-during-read",
    "text-unavailable",
    "written",
    "precondition-mismatch-no-dispatch",
    "partial-or-unknown",
    "backend-unavailable",
    "invalid-argument",
    "payload-too-large",
    "invalid-utf8",
    "native-error",
    "response-unavailable",
    "not-dispatched",
  ]),
  receipt: clipboardBackendReceiptSchema.optional(),
  requestId: z.string().min(1).max(127).optional(),
  changeCount: countSchema.optional(),
  beforeChangeCount: countSchema.optional(),
  declaredChangeCount: countSchema.optional(),
  afterChangeCount: countSchema.optional(),
  mutationAttempted: z.enum(["true", "false", "unknown"]),
  setStringSucceeded: z.boolean().optional(),
  ownershipStableAfterWrite: z.boolean().optional(),
  atomicPrecondition: z.literal(false),
  utf8Bytes: z.number().int().min(0).max(NATIVE_CLIPBOARD_MAX_UTF8_BYTES).optional(),
}).superRefine((report, context) => {
  if ((report.authority === "verified-response") !== (report.receipt !== undefined)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Verified clipboard report требует единственный receipt" })
  }
  if (report.authority === "unverified-request" && report.requestId === undefined) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "Unverified request report требует requestId" })
  }
  if (report.status === "written" && (
    report.mutationAttempted !== "true"
    || report.setStringSucceeded !== true
    || report.ownershipStableAfterWrite !== true
    || report.declaredChangeCount === undefined
    || report.afterChangeCount !== report.declaredChangeCount
  )) {
    context.addIssue({ code: "custom", message: "Written report требует подтверждённую стабильную ownership" })
  }
  if (report.status === "precondition-mismatch-no-dispatch" && report.mutationAttempted !== "false") {
    context.addIssue({ code: "custom", path: ["mutationAttempted"], message: "Precondition mismatch не отправляет mutation" })
  }
  if (report.status === "partial-or-unknown" && report.mutationAttempted !== "true") {
    context.addIssue({ code: "custom", path: ["mutationAttempted"], message: "Partial clipboard result следует за mutation attempt" })
  }
})
export type ClipboardBackendReport = z.infer<typeof clipboardBackendReportSchema>

export type ClipboardBackendCall<T> = Readonly<{
  value: T
  report: ClipboardBackendReport
}>

export interface VersionedClipboardBackend {
  readonly buildId: string
  currentVersion(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardVersionResultSchema>>>
  readText(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    maxBytes: number,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardReadResultSchema>>>
  conditionalWrite(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    text: string,
    expectedChangeCount: number | undefined,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardWriteResultSchema>>>
  verifyReport(report: ClipboardBackendReport): Promise<void>
}

export type NativeClipboardClient = Pick<
  NativeBrokerAdapter,
  "adapterInstanceRef" | "loadedBuildId" | "generation" | "clipboard"
>

export class NativeVersionedClipboardBackend implements VersionedClipboardBackend {
  readonly #reports = new Map<string, ClipboardBackendReport>()

  constructor(
    readonly native: NativeClipboardClient,
    readonly nextId: (purpose: "request" | "receipt") => string = purpose => `${purpose}:${crypto.randomUUID()}`,
  ) {}

  get buildId(): string {
    return this.native.loadedBuildId
  }

  async currentVersion(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardVersionResultSchema>>> {
    return await this.#call(context, { method: "clipboard.version", payload: {} }, nativeClipboardVersionResultSchema)
  }

  async readText(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    maxBytes: number,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardReadResultSchema>>> {
    return await this.#call(
      context,
      { method: "clipboard.read", payload: { maxBytes } },
      nativeClipboardReadResultSchema,
    )
  }

  async conditionalWrite(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    text: string,
    expectedChangeCount: number | undefined,
  ): Promise<ClipboardBackendCall<z.infer<typeof nativeClipboardWriteResultSchema>>> {
    return await this.#call(
      context,
      {
        method: "clipboard.write",
        payload: {
          text,
          ...(expectedChangeCount === undefined ? {} : { expectedChangeCount }),
        },
      },
      nativeClipboardWriteResultSchema,
    )
  }

  async verifyReport(report: ClipboardBackendReport): Promise<void> {
    const parsed = clipboardBackendReportSchema.parse(report)
    const receiptId = parsed.receipt?.receiptId
    const stored = receiptId === undefined ? undefined : this.#reports.get(receiptId)
    if (stored === undefined || !structurallyEqual(stored, parsed)) {
      throw new Error("Clipboard report не зарегистрирован verified native backend")
    }
  }

  async #call<Schema extends z.ZodType>(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    command: { method: "clipboard.version" | "clipboard.read" | "clipboard.write", payload: Record<string, unknown> },
    resultSchema: Schema,
  ): Promise<ClipboardBackendCall<z.infer<Schema>>> {
    const generation = this.native.generation
    if (generation === undefined) throw new Error("Native clipboard handshake не завершён")
    const requestId = this.nextId("request")
    const request = nativeClipboardRequestSchema.parse({
      kind: "request",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId,
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: generation.nativeGeneration,
      deadlineAt: context.wire.deadlineAt,
      operation: context.wire,
      command,
    })
    try {
      const response = await this.native.clipboard(request, context.control)
      if (!clipboardResponseMatches(request, response)) {
        throw new Error("Clipboard response не совпадает с request identity")
      }
      if (!response.ok) {
        const report = this.#verifiedErrorReport(context, requestId, command.method)
        throw new ClipboardBackendError(
          "Native clipboard вернул structured error; payload исключён",
          sanitizeContractError(response.error, command.method),
          report,
        )
      }
      const value = resultSchema.parse(response.result.value)
      const report = this.#verifiedReport(context, requestId, command.method, value as Record<string, unknown>)
      return { value, report }
    } catch (error) {
      if (error instanceof ClipboardBackendError) throw error
      throw new ClipboardBackendError(
        "Native clipboard response недоступен; payload исключён",
        undefined,
        this.#unverifiedReport(command.method, requestId, "response-unavailable"),
      )
    }
  }

  #verifiedReport(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    requestId: string,
    command: ClipboardBackendReport["command"],
    value: Record<string, unknown>,
  ): ClipboardBackendReport {
    const mutation = value.mutationAttempted
    const report = clipboardBackendReportSchema.parse({
      authority: "verified-response",
      command,
      status: value.status,
      receipt: this.#receipt(context, requestId),
      mutationAttempted: mutation === true ? "true" : mutation === false ? "false" : "false",
      atomicPrecondition: false,
      ...copyMetadata(value),
    })
    this.#store(report)
    return report
  }

  #verifiedErrorReport(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    requestId: string,
    command: ClipboardBackendReport["command"],
  ): ClipboardBackendReport {
    const report = clipboardBackendReportSchema.parse({
      authority: "verified-response",
      command,
      status: "native-error",
      receipt: this.#receipt(context, requestId),
      mutationAttempted: command === "clipboard.write" ? "unknown" : "false",
      atomicPrecondition: false,
    })
    this.#store(report)
    return report
  }

  #receipt(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    requestId: string,
  ): ClipboardBackendReceipt {
    const generation = this.native.generation
    if (generation === undefined) throw new Error("Native clipboard generation потерян")
    return {
      receiptId: this.nextId("receipt"),
      adapterInstanceRef: this.native.adapterInstanceRef,
      backendBuildId: this.native.loadedBuildId,
      requestId,
      operationId: context.wire.operationId,
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: generation.nativeGeneration,
    }
  }

  #store(report: ClipboardBackendReport): void {
    const receiptId = report.receipt?.receiptId
    if (receiptId === undefined) throw new Error("Verified clipboard report потерял receipt")
    this.#reports.set(receiptId, report)
    while (this.#reports.size > 1_024) {
      const oldest = this.#reports.keys().next().value
      if (oldest === undefined) break
      this.#reports.delete(oldest)
    }
  }

  #unverifiedReport(
    command: ClipboardBackendReport["command"],
    requestId: string,
    status: "native-error" | "response-unavailable",
  ): ClipboardBackendReport {
    return clipboardBackendReportSchema.parse({
      authority: "unverified-request",
      command,
      status,
      requestId,
      mutationAttempted: command === "clipboard.write" ? "unknown" : "false",
      atomicPrecondition: false,
    })
  }
}

export class ClipboardBackendError extends Error {
  constructor(
    message: string,
    readonly contract: ContractError | undefined,
    readonly report: ClipboardBackendReport,
  ) {
    super(message)
    this.name = "ClipboardBackendError"
  }
}

function copyMetadata(value: Record<string, unknown>) {
  return Object.fromEntries([
    "changeCount",
    "beforeChangeCount",
    "declaredChangeCount",
    "afterChangeCount",
    "setStringSucceeded",
    "ownershipStableAfterWrite",
    "utf8Bytes",
  ].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]))
}

function sanitizeContractError(
  error: ContractError,
  command: ClipboardBackendReport["command"],
): ContractError {
  if (command !== "clipboard.write") return error
  return {
    ...error,
    message: "Native clipboard write завершился ошибкой; payload исключён",
  }
}
