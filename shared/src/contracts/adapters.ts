import { z } from "zod"
import { capabilitySetSchema, type CapabilityId, type CapabilitySet } from "./capabilities.ts"
import { contractErrorSchema, type ContractError } from "./errors.ts"
import type { BoundNativeEvidencePublisher, EvidenceIssuer, NativeContinuationRegistrar } from "./evidence.ts"
import {
  generationIdSchema,
  opaqueIdSchema,
  operationTargetSchema,
  runtimeGenerationSchema,
  type NativeGeneration,
  type DisplayRef,
  type OperationTarget,
  type RuntimeGeneration,
} from "./identities.ts"
import type {
  NativeCancelAck,
  NativeCancelRequest,
  NativeDrainAck,
  NativeDrainRequest,
  NativeHeartbeatAck,
  NativeHeartbeatRequest,
  HeldInputLedgerSink,
  NativeStatusRequest,
  NativeContinuationIssuer,
} from "./native-lifecycle.ts"
import { nativeOperationStatusSchema, type NativeOperationStatus } from "./native-lifecycle.ts"
import type { NativeHandshakeRequest, NativeHandshakeResponse } from "./native.ts"
import type { ObservedEvent } from "./observer.ts"
import {
  operationOutcomeSchema,
  runtimeClientSessionSchema,
  targetPreconditionSchema,
  type AdapterControl,
  type BrowserExecutionContext,
  type ClipboardExecutionContext,
  type DeviceExecutionContext,
  type NativeExecutionContext,
  type OperationOutcome,
  type OperationRecord,
  type RuntimeClientSession,
  type RuntimeOperationContext,
  type SerializableOperationContext,
} from "./operations.ts"
import type { ObservationResolver, ProofAuthority } from "./observations.ts"
import type { LifetimeReservationAuthority } from "./reservations.ts"
import {
  runtimeResourceRefSchema,
  sortRuntimeResources,
  type ResourceAuthority,
  type CleanupAuthority,
  type RuntimeResourceRef,
} from "./resources.ts"
import { isoTimestampSchema } from "./schema.ts"

export const adapterHostContextSchema = z.strictObject({
  generation: runtimeGenerationSchema,
  runtimeBuildId: opaqueIdSchema,
  capabilities: capabilitySetSchema.refine(set => set.scope === "adapter", "Adapter host требует adapter capability set"),
})
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T
export type AdapterHostContext = DeepReadonly<z.infer<typeof adapterHostContextSchema>>

export const adapterResultSchema = <Result extends z.ZodType>(result: Result) => z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: result, outcome: operationOutcomeSchema, nativeStatus: nativeOperationStatusSchema.optional() }),
  z.strictObject({ ok: z.literal(false), error: contractErrorSchema, outcome: operationOutcomeSchema, nativeStatus: nativeOperationStatusSchema.optional() }),
])
export type AdapterResult<TResult> = {
  outcome: OperationOutcome
  nativeStatus?: NativeOperationStatus
} & ({ ok: true, value: TResult } | { ok: false, error: ContractError })

export const runtimeOperationIntentSchema = z.strictObject({
  intent: z.enum(["read", "mutation", "admin"]),
  clientRequestId: opaqueIdSchema,
  precondition: targetPreconditionSchema,
  deadlineAt: isoTimestampSchema,
  requestedResources: z.array(runtimeResourceRefSchema).max(16),
}).superRefine((intent, context) => {
  const canonical = sortRuntimeResources(intent.requestedResources)
  if (canonical.some((resource, index) => {
    const actual = intent.requestedResources[index]
    return actual === undefined || resource.kind !== actual.kind || resource.resourceRef !== actual.resourceRef
  })) {
    context.addIssue({ code: "custom", path: ["requestedResources"], message: "resources должны быть в canonical order" })
  }
  const ids = intent.requestedResources.map(resource => `${resource.kind}:${resource.resourceRef}`)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["requestedResources"], message: "resource не должен повторяться" })
  }
})
export type RuntimeOperationIntent = z.infer<typeof runtimeOperationIntentSchema>

export type RuntimeExecution<TResult> = {
  operation: OperationRecord
  result: AdapterResult<TResult>
}

export interface RuntimeAdapter {
  readonly generation: RuntimeGeneration
  readonly capabilities: CapabilitySet
  runOperation<TRequest, TResult>(
    session: RuntimeClientSession,
    intent: RuntimeOperationIntent,
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
  ): Promise<RuntimeExecution<TResult>>
  getOperation(session: RuntimeClientSession, operationId: string): Promise<OperationRecord | undefined>
  cancelOperation(session: RuntimeClientSession, operationId: string, reason: string): Promise<OperationRecord>
}

export interface NativeAdapter {
  readonly host: AdapterHostContext
  readonly adapterInstanceRef: string
  readonly loadedBuildId: string
  readonly generation?: NativeGeneration
  readonly ledgerSink: HeldInputLedgerSink
  readonly evidencePublisher: BoundNativeEvidencePublisher
  handshake(request: NativeHandshakeRequest, signal?: AbortSignal): Promise<NativeHandshakeResponse>
  request<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    requestSchema: RequestSchema,
    request: z.input<RequestSchema>,
    responseSchema: ResponseSchema,
    control: AdapterControl,
  ): Promise<z.output<ResponseSchema>>
  heartbeat(request: NativeHeartbeatRequest, control: AdapterControl): Promise<NativeHeartbeatAck>
  status(request: NativeStatusRequest, signal?: AbortSignal): Promise<NativeOperationStatus>
  cancel(request: NativeCancelRequest, control: AdapterControl): Promise<NativeCancelAck>
  drain(request: NativeDrainRequest, control: AdapterControl): Promise<NativeDrainAck>
  events(signal: AbortSignal): AsyncIterable<ObservedEvent>
  close(): Promise<void>
}

export type TargetResolutionRequest = {
  target: OperationTarget
  inventoryId: string
  inventoryRevision: number
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration?: string
  deadlineAt: string
}

export type TargetResolution = {
  target: OperationTarget
  resolutionId: string
  proofRef: string
  inventoryId: string
  inventoryRevision: number
  displayLayoutRevision: number
  nativeGeneration?: string
  nativeMapping?:
    | { kind: "display", display: { nativeDisplayId: number, ref: DisplayRef } }
    | { kind: "window", cgWindowId: number, ownerPid: number, displays: Array<{ nativeDisplayId: number, ref: DisplayRef }> }
    | { kind: "desktop-layout", displays: Array<{ nativeDisplayId: number, ref: DisplayRef }> }
}

export interface TargetAuthority {
  resolve(request: TargetResolutionRequest): Promise<TargetResolution>
}

export interface ClientSessionAuthority {
  assertActive(session: RuntimeClientSession, now: Date): Promise<void>
}

export interface BinaryFramePublisher {
  publish(request: {
    frameRef: string
    observationId: string
    runtimeEpoch: string
    loginSessionId: string
    nativeGeneration?: string
    source: "display-composite" | "window-isolated" | "browser-viewport" | "device-browser-viewport"
    target: OperationTarget
    capturedAt: string
    widthPx: number
    heightPx: number
    mime: "image/png"
    expectedByteLength: number
    expectedSha256: string
    bytes: Uint8Array
  }): Promise<void>
}

export type AdapterServices = Readonly<{
  clientSessions: ClientSessionAuthority
  resources: ResourceAuthority
  cleanup: CleanupAuthority
  targets: TargetAuthority
  proofs: ProofAuthority
  evidence: EvidenceIssuer
  frames: BinaryFramePublisher
  observations: ObservationResolver
  continuations: NativeContinuationIssuer & NativeContinuationRegistrar
  reservations: LifetimeReservationAuthority
}>

export interface OperationAdapter<Context extends SerializableOperationContext, Request, Result> {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly CapabilityId[]
  execute(context: RuntimeOperationContext<Context>, request: Request): Promise<AdapterResult<Result>>
}

export interface InputAdapter<TAction, TResult> {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly ("input.pointer" | "input.drag" | "input.keyboard" | "input.readiness")[]
  execute(context: RuntimeOperationContext<NativeExecutionContext>, action: TAction): Promise<AdapterResult<TResult>>
}

export const nativeTextChunkSchema = z.strictObject({
  text: z.string().max(10_000),
  utf16Units: z.number().int().min(0).max(10_000),
}).refine(chunk => chunk.text.length === chunk.utf16Units, {
  message: "utf16Units не совпадает с длиной text",
})
export const MAX_NATIVE_TEXT_CHUNK_UTF16_UNITS = 10_000
export type NativeTextChunk = z.infer<typeof nativeTextChunkSchema>

export const clipboardVersionSchema = z.strictObject({
  backendBuildId: opaqueIdSchema,
  changeCount: z.number().int().safe().min(0),
})
export type ClipboardVersion = z.infer<typeof clipboardVersionSchema>

export interface ClipboardAdapter<TRequest, TResult> {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly ["input.clipboard"]
  currentVersion(context: RuntimeOperationContext<ClipboardExecutionContext>): Promise<ClipboardVersion>
  execute(context: RuntimeOperationContext<ClipboardExecutionContext>, request: TRequest): Promise<AdapterResult<TResult>>
}

export function freezeAdapterHostContext(value: z.input<typeof adapterHostContextSchema>): AdapterHostContext {
  const parsed = adapterHostContextSchema.parse(value)
  return Object.freeze({
    generation: Object.freeze(parsed.generation),
    runtimeBuildId: parsed.runtimeBuildId,
    capabilities: Object.freeze({
      ...parsed.capabilities,
      capabilities: Object.freeze(parsed.capabilities.capabilities.map(capability => Object.freeze(capability))),
    }),
  })
}

export function assertOperationGenerationMatchesHost(
  context: RuntimeOperationContext<NativeExecutionContext | BrowserExecutionContext | DeviceExecutionContext | ClipboardExecutionContext>,
  host: AdapterHostContext,
): void {
  if (
    context.wire.runtimeEpoch !== host.generation.runtimeEpoch
    || context.wire.loginSessionId !== host.generation.loginSessionId
  ) {
    throw new Error("Operation context принадлежит другой runtime/login generation")
  }
}

export async function authorizeAdapterContext(
  host: AdapterHostContext,
  services: AdapterServices,
  context: RuntimeOperationContext,
  now: Date,
): Promise<void> {
  assertOperationGenerationMatchesHost(context, host)
  if (
    context.session.clientSessionId !== context.wire.clientSessionId
    || context.session.principalId !== context.wire.principalId
    || context.session.runtimeEpoch !== context.wire.runtimeEpoch
    || context.session.loginSessionId !== context.wire.loginSessionId
  ) {
    throw new Error("Runtime client session не совпадает с operation authority")
  }
  await services.clientSessions.assertActive(context.session, now)
}
