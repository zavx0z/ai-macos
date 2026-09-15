import {
  CLIPBOARD_RESOURCE_REF,
  authorizeAdapterContext,
  clipboardVersionSchema,
  contractErrorSchema,
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
import { MAX_CLIPBOARD_TEXT_BYTES } from "./clipboard.ts"

export const clipboardReadRequestSchema = z.strictObject({
  kind: z.literal("read"),
})

export const clipboardWriteRequestSchema = z.strictObject({
  kind: z.literal("write"),
  text: z.string(),
  expectedVersion: clipboardVersionSchema.optional(),
}).refine(request => new TextEncoder().encode(request.text).byteLength <= MAX_CLIPBOARD_TEXT_BYTES, {
  path: ["text"],
  message: `clipboard text превышает ${MAX_CLIPBOARD_TEXT_BYTES} UTF-8 байт`,
})

export const clipboardRequestSchema = z.discriminatedUnion("kind", [
  clipboardReadRequestSchema,
  clipboardWriteRequestSchema,
])
export type ClipboardRequest = z.infer<typeof clipboardRequestSchema>

const clipboardMetadataShape = {
  version: clipboardVersionSchema,
  length: z.number().int().safe().min(0),
  bytes: z.number().int().safe().min(0).max(MAX_CLIPBOARD_TEXT_BYTES),
}

export const clipboardResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read"), text: z.string(), ...clipboardMetadataShape }),
  z.strictObject({ kind: z.literal("write"), ...clipboardMetadataShape }),
])
export type ClipboardResult = z.infer<typeof clipboardResultSchema>

export interface VersionedClipboardBackend {
  readonly buildId: string
  currentVersion(control: RuntimeOperationContext<ClipboardExecutionContext>["control"]): Promise<number>
  readText(control: RuntimeOperationContext<ClipboardExecutionContext>["control"]): Promise<{
    text: string
    changeCount: number
  }>
  writeText(
    text: string,
    expectedChangeCount: number | undefined,
    control: RuntimeOperationContext<ClipboardExecutionContext>["control"],
  ): Promise<{ changeCount: number }>
}

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
    return clipboardVersionSchema.parse({
      backendBuildId: this.backend.buildId,
      changeCount: await this.backend.currentVersion(context.control),
    })
  }

  async execute(
    context: RuntimeOperationContext<ClipboardExecutionContext>,
    input: ClipboardRequest,
  ): Promise<AdapterResult<ClipboardResult>> {
    let request: ClipboardRequest
    try {
      request = clipboardRequestSchema.parse(input)
      await this.#authorize(context)
    } catch (error) {
      return failure(context, errorFrom(error, "clipboard-precondition"), "none", "complete")
    }

    if (request.kind === "read") {
      try {
        await context.control.checkpoint("clipboard.read")
        const read = await this.backend.readText(context.control)
        const bytes = new TextEncoder().encode(read.text).byteLength
        if (bytes > MAX_CLIPBOARD_TEXT_BYTES) throw new Error("clipboard read превышает byte budget")
        const value = clipboardResultSchema.parse({
          kind: "read",
          text: read.text,
          length: read.text.length,
          bytes,
          version: { backendBuildId: this.backend.buildId, changeCount: read.changeCount },
        })
        return {
          ok: true,
          value,
          outcome: outcome(context, "none", "verified", "complete"),
        }
      } catch (error) {
        return failure(context, errorFrom(error, "clipboard-read"), "none", "complete")
      }
    }

    try {
      if (
        request.expectedVersion !== undefined
        && request.expectedVersion.backendBuildId !== this.backend.buildId
      ) {
        return failure(context, contractErrorSchema.parse({
          code: "backend-version-mismatch",
          message: "Clipboard expectedVersion принадлежит другому backend build",
          stage: "clipboard-write-precondition",
          retryable: false,
          replayAllowed: false,
          recoveryAction: "inspect-health",
        }), "none", "complete")
      }
      await context.control.checkpoint("clipboard.write")
      const written = await this.backend.writeText(
        request.text,
        request.expectedVersion?.changeCount,
        context.control,
      )
      const bytes = new TextEncoder().encode(request.text).byteLength
      const value = clipboardResultSchema.parse({
        kind: "write",
        length: request.text.length,
        bytes,
        version: { backendBuildId: this.backend.buildId, changeCount: written.changeCount },
      })
      return {
        ok: true,
        value,
        outcome: outcome(context, "finished", "verified", "complete"),
      }
    } catch {
      return failure(
        context,
        contractErrorSchema.parse({
          code: "operation-outcome-unknown",
          message: "Clipboard write outcome не подтверждён; payload исключён из результата",
          stage: "clipboard-write",
          retryable: false,
          replayAllowed: false,
          recoveryAction: "get-operation",
        }),
        "unknown",
        "unknown",
      )
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

function errorFrom(
  error: unknown,
  stage: string,
  fallbackCode: ContractError["code"] = "invalid-request",
): ContractError {
  if (typeof error === "object" && error !== null && "contract" in error) {
    const parsed = contractErrorSchema.safeParse((error as { contract: unknown }).contract)
    if (parsed.success) return parsed.data
  }
  return contractErrorSchema.parse({
    code: fallbackCode,
    message: (error instanceof Error ? error.message : "Неизвестная clipboard ошибка").slice(0, 2_048),
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: fallbackCode === "operation-outcome-unknown" ? "get-operation" : "none",
  })
}

function failure(
  context: RuntimeOperationContext<ClipboardExecutionContext>,
  error: ContractError,
  dispatch: OperationOutcome["dispatch"],
  cleanup: "complete" | "unknown",
): AdapterResult<ClipboardResult> {
  return {
    ok: false,
    error,
    outcome: outcome(context, dispatch, "unknown", cleanup),
  }
}

function outcome(
  context: RuntimeOperationContext<ClipboardExecutionContext>,
  dispatch: OperationOutcome["dispatch"],
  targetVerified: OperationOutcome["targetVerified"],
  cleanupState: "complete" | "unknown",
): OperationOutcome {
  const cleanup = context.resources.length === 0
    ? { scope: "none" as const, state: "complete" as const, resources: [] as [] }
    : cleanupState === "complete"
      ? {
          scope: "owned" as const,
          state: "complete" as const,
          resources: context.resources.map(handle => ({ handle, outcome: "released" as const })),
        }
      : {
          scope: "owned" as const,
          state: "unknown" as const,
          reason: "Clipboard write outcome не подтверждён",
          resources: context.resources.map(handle => ({ handle, outcome: "quarantined" as const })),
        }
  return {
    dispatch,
    targetVerified,
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: dispatch === "none" ? 0 : 1,
  }
}
