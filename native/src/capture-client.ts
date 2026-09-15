import {
  NATIVE_PROTOCOL_VERSION,
  structurallyEqual,
  type AdapterControl,
  type ContractError,
  type NativeAdapter,
  type NativeCancelAck,
  type NativeContinuationIssuer,
  type NativeContinuationRegistrar,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type NativeTargetMapping,
  type RuntimeOperationContext,
  type ScreenCaptureRequest,
  type VerifiedNativeEvidenceReceipt,
  type z,
} from "@meta/shared/contracts"
import {
  nativeCaptureCleanupRequestSchema,
  nativeCaptureCleanupResponseSchema,
  nativeCaptureStartRequestSchema,
  nativeCaptureStartResponseSchema,
  nativeCaptureStatusRequestSchema,
  nativeCaptureStatusResponseSchema,
  type NativeCapturePollResult,
  type NativeCaptureStartResult,
  type NativeCaptureTaskStatus,
} from "./protocol.ts"
import type { NativeBrokerAdapter } from "./adapter.ts"

export type NativeCapturePoll = {
  poll: NativeCapturePollResult
  bytes?: Uint8Array
  evidenceReceipt?: VerifiedNativeEvidenceReceipt
  terminalEvidenceReceipt?: VerifiedNativeEvidenceReceipt
}

export class NativeCaptureStartError extends Error {
  constructor(
    readonly nativeError: ContractError,
    readonly nativeStatus?: NativeOperationStatus,
  ) {
    super(nativeError.message)
  }
}

export class NativeCaptureRejectedBeforeStartError extends NativeCaptureStartError {}

type BinaryNativeAdapter = NativeAdapter & {
  takeBinary(binaryToken: string, expectedLength: number, signal?: AbortSignal): Promise<Uint8Array>
} & Pick<NativeBrokerAdapter, "cleanup">

export class NativeCaptureClient {
  readonly #native: BinaryNativeAdapter
  readonly #continuations: NativeContinuationIssuer & NativeContinuationRegistrar

  constructor(
    native: BinaryNativeAdapter,
    continuations: NativeContinuationIssuer & NativeContinuationRegistrar,
  ) {
    this.#native = native
    this.#continuations = continuations
  }

  async start(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: ScreenCaptureRequest,
    nativeMapping: NativeTargetMapping,
    options: { captureTimeoutMs?: number, stopTimeoutMs?: number } = {},
  ): Promise<NativeCaptureTask> {
    const response = await this.#native.request(
      nativeCaptureStartRequestSchema,
      {
        kind: "request",
        intent: "mutation",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: requestId("capture-start"),
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        deadlineAt: context.wire.deadlineAt,
        method: "capture.start",
        operation: context.wire,
        payload: {
          request,
          nativeMapping,
          captureTimeoutMs: options.captureTimeoutMs ?? 10_000,
          stopTimeoutMs: options.stopTimeoutMs ?? 1_000,
        },
      },
      nativeCaptureStartResponseSchema,
      context.control,
    )
    if (!response.ok) {
      if (response.startDisposition === "rejected-before-start") {
        throw new NativeCaptureRejectedBeforeStartError(response.error)
      }
      throw new NativeCaptureStartError(response.error, response.nativeStatus)
    }
    if (
      response.result.operationId !== context.wire.operationId
      || !structurallyEqual(response.result.acceptedFence, context.wire.fence)
    ) {
      throw new Error("Capture start ACK содержит другую operation/fence")
    }
    const resource = context.resources.filter(handle => {
      return handle.kind === "capture-stream"
        && handle.resourceRef === request.publication.observationId
        && handle.operationId === context.wire.operationId
    })
    if (resource.length !== 1) throw new Error("Capture start требует exact capture-stream lease")
    const acceptedReceipt = await this.#native.evidencePublisher.publish({
      factKind: "capture-task-start",
      sourceResponseRef: response.result.sourceResponseRef,
      inventoryId: response.result.inventoryId,
      inventoryRevision: response.result.inventoryRevision,
      displayLayoutRevision: response.result.displayLayoutRevision,
      observedAt: response.result.observedAt,
      operationId: context.wire.operationId,
      taskRef: response.result.captureTaskRef,
      acceptedFence: context.wire.fence,
      statusRevision: response.result.status.revision,
      statusEvidenceRef: response.result.statusEvidenceRef,
    })
    await this.#continuations.registerAcceptedTask({
      receipt: acceptedReceipt,
      operationId: context.wire.operationId,
      taskRef: response.result.captureTaskRef,
      resourceLeaseId: resource[0]!.leaseId,
      acceptedFence: context.wire.fence,
      statusRevision: response.result.status.revision,
      statusEvidenceRef: response.result.statusEvidenceRef,
    })
    return new NativeCaptureTask(
      this.#native,
      this.#continuations,
      context,
      response.result,
      request,
      nativeMapping,
    )
  }
}

export class NativeCaptureTask {
  readonly taskRef: string
  readonly accepted: NativeCaptureStartResult

  readonly #native: BinaryNativeAdapter
  readonly #continuations: NativeContinuationIssuer & NativeContinuationRegistrar
  readonly #context: RuntimeOperationContext<NativeExecutionContext>
  readonly #request: ScreenCaptureRequest
  readonly #nativeMapping: NativeTargetMapping
  #released = false
  #statusRevision: number
  #terminalRegistered = false

  constructor(
    native: BinaryNativeAdapter,
    continuations: NativeContinuationIssuer & NativeContinuationRegistrar,
    context: RuntimeOperationContext<NativeExecutionContext>,
    accepted: NativeCaptureStartResult,
    request: ScreenCaptureRequest,
    nativeMapping: NativeTargetMapping,
  ) {
    this.#native = native
    this.#continuations = continuations
    this.#context = context
    this.accepted = accepted
    this.taskRef = accepted.captureTaskRef
    this.#request = request
    this.#nativeMapping = nativeMapping
    this.#statusRevision = accepted.status.revision
  }

  async status(): Promise<NativeCaptureTaskStatus> {
    this.#assertOpen()
    const continuation = await this.#continuation("status")
    const response = await this.#native.cleanup(
      nativeCaptureCleanupRequestSchema,
      { control: continuation.cleanupControl, payload: { captureTaskRef: this.taskRef } },
      nativeCaptureCleanupResponseSchema,
      continuation.control,
    )
    if (response.purpose !== "status") throw new Error("Native cleanup response содержит другой purpose")
    if (response.terminal !== undefined && response.status.cleanup === "complete" && response.status.drained) {
      await this.#markTerminal(response.terminal, response.status)
    } else {
      await this.#advanceStatus(response.statusEvidence, response.status)
    }
    this.#acceptRevision(response.status.revision)
    return response.status
  }

  async result(): Promise<NativeCapturePoll> {
    this.#assertOpen()
    const continuation = await this.#continuation("result")
    const response = await this.#native.cleanup(
      nativeCaptureCleanupRequestSchema,
      { control: continuation.cleanupControl, payload: { captureTaskRef: this.taskRef } },
      nativeCaptureCleanupResponseSchema,
      continuation.control,
    )
    if (response.purpose !== "result") throw new Error("Native cleanup response содержит другой purpose")
    if (response.poll.state !== "completed") {
      await this.#advanceStatus(response.statusEvidence, response.poll.status)
      this.#acceptRevision(response.poll.status.revision)
      return { poll: response.poll }
    }
    const completion = response.poll.result
    const terminalEvidenceReceipt = response.poll.status.cleanup === "complete" && response.poll.status.drained
      ? await this.#markTerminal(completion, response.poll.status)
      : undefined
    if (terminalEvidenceReceipt === undefined && !this.#terminalRegistered) {
      await this.#advanceStatus(response.statusEvidence, response.poll.status)
    }
    this.#acceptRevision(response.poll.status.revision)
    if (completion.frame === undefined) {
      return {
        poll: response.poll,
        ...(terminalEvidenceReceipt === undefined ? {} : { terminalEvidenceReceipt }),
      }
    }
    const frame = completion.frame
    const bytes = await this.#native.takeBinary(
      frame.binaryToken,
      frame.encodedBytes,
      continuation.control.signal,
    )
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const expectedTarget = this.#request.target.target
    const expectedCursor = this.#request.cursor === "include" ? "included" : "excluded"
    if (
      completion.source !== this.#request.source
      || completion.caption !== this.#request.caption
      || !structurallyEqual(completion.target, expectedTarget)
      || !structurallyEqual(completion.nativeMapping, this.#nativeMapping)
      || !structurallyEqual(completion.clip, this.#request.clip)
      || completion.cursor !== expectedCursor
      || completion.scale !== this.#request.output.scale
      || frame.frameRef !== this.#request.publication.frameRef
      || frame.sha256 !== digest
      || frame.widthPx > this.#request.output.maxWidthPx
      || frame.heightPx > this.#request.output.maxHeightPx
      || frame.widthPx * frame.heightPx > this.#request.output.maxPixels
      || frame.encodedBytes > this.#request.output.maxEncodedBytes
    ) {
      throw new Error("Native capture completion не совпадает с accepted request/policy/binary")
    }
    const evidenceReceipt = await this.#native.evidencePublisher.publish({
      factKind: "frame",
      sourceResponseRef: completion.sourceResponseRef,
      inventoryId: completion.inventoryId,
      inventoryRevision: completion.inventoryRevision,
      displayLayoutRevision: completion.displayLayoutRevision,
      observedAt: completion.observedAt,
      observationId: this.#request.publication.observationId,
      frameRef: frame.frameRef,
      captureTarget: expectedTarget,
      frameSha256: frame.sha256,
    })
    return {
      poll: response.poll,
      bytes,
      evidenceReceipt,
      ...(terminalEvidenceReceipt === undefined ? {} : { terminalEvidenceReceipt }),
    }
  }

  async cancel(
    reason: string,
  ): Promise<NativeCancelAck> {
    this.#assertOpen()
    const continuation = await this.#continuation("cancel")
    return await this.#native.cancel({
      requestId: continuation.cleanupControl.requestId,
      runtimeEpoch: this.#context.wire.runtimeEpoch,
      loginSessionId: this.#context.wire.loginSessionId,
      nativeGeneration: this.#context.wire.nativeGeneration,
      deadlineAt: continuation.cleanupControl.deadlineAt,
      operationId: this.#context.wire.operationId,
      fence: continuation.cleanupControl.acceptedFence,
      reason,
    }, continuation.control)
  }

  async release(): Promise<void> {
    this.#assertOpen()
    const continuation = await this.#continuation("release")
    const response = await this.#native.cleanup(
      nativeCaptureCleanupRequestSchema,
      { control: continuation.cleanupControl, payload: { captureTaskRef: this.taskRef } },
      nativeCaptureCleanupResponseSchema,
      continuation.control,
    )
    if (response.purpose !== "release") throw new Error("Native cleanup response содержит другой purpose")
    if (response.ack.cleanup !== "complete" || !response.ack.drained || response.ack.terminalReceiptRef === undefined) {
      throw new Error("Native broker не подтвердил authoritative release capture task")
    }
    this.#acceptRevision(response.ack.statusRevision)
    this.#released = true
  }

  async #continuation(purpose: "result" | "status" | "cancel" | "release") {
    return await this.#continuations.issue({
      operationId: this.#context.wire.operationId,
      taskRef: this.taskRef,
      purpose,
      expectedRevision: this.#statusRevision,
    })
  }

  #acceptRevision(revision: number): void {
    if (revision < this.#statusRevision) throw new Error("Native capture status revision уменьшилась")
    this.#statusRevision = revision
  }

  async #markTerminal(
    terminal: {
      sourceResponseRef: string
      operationId: string
      acceptedFence: NativeExecutionContext["fence"]
      inventoryId: string
      inventoryRevision: number
      displayLayoutRevision: number
      observedAt: string
      drainedEvidenceRef?: string
      terminalReceiptRef?: string
    },
    status: NativeCaptureTaskStatus,
  ): Promise<VerifiedNativeEvidenceReceipt | undefined> {
    if (this.#terminalRegistered || status.cleanup !== "complete" || !status.drained) return undefined
    if (terminal.drainedEvidenceRef === undefined || terminal.terminalReceiptRef === undefined) {
      throw new Error("Drained capture status не содержит terminal evidence refs")
    }
    if (
      terminal.operationId !== this.#context.wire.operationId
      || !structurallyEqual(terminal.acceptedFence, this.#context.wire.fence)
    ) {
      throw new Error("Terminal capture evidence содержит другую operation/fence")
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "capture-task-terminal",
      sourceResponseRef: terminal.sourceResponseRef,
      inventoryId: terminal.inventoryId,
      inventoryRevision: terminal.inventoryRevision,
      displayLayoutRevision: terminal.displayLayoutRevision,
      observedAt: terminal.observedAt,
      operationId: terminal.operationId,
      taskRef: this.taskRef,
      acceptedFence: terminal.acceptedFence,
      statusRevision: status.revision,
      drainedEvidenceRef: terminal.drainedEvidenceRef,
      terminalReceiptRef: terminal.terminalReceiptRef,
      cleanup: "complete",
      drained: true,
    })
    await this.#continuations.markVerifiedTerminal({
      receipt,
      operationId: this.#context.wire.operationId,
      taskRef: this.taskRef,
      acceptedFence: this.#context.wire.fence,
      statusRevision: status.revision,
      drainedEvidenceRef: terminal.drainedEvidenceRef,
      terminalReceiptRef: terminal.terminalReceiptRef,
    })
    this.#terminalRegistered = true
    return receipt
  }

  async #advanceStatus(
    evidence: {
      operationId: string
      acceptedFence: NativeExecutionContext["fence"]
      sourceResponseRef: string
      inventoryId: string
      inventoryRevision: number
      displayLayoutRevision: number
      observedAt: string
      statusEvidenceRef: string
    },
    status: NativeCaptureTaskStatus,
  ): Promise<void> {
    if (
      evidence.operationId !== this.#context.wire.operationId
      || !structurallyEqual(evidence.acceptedFence, this.#context.wire.fence)
      || status.captureTaskRef !== this.taskRef
    ) {
      throw new Error("Capture status evidence содержит другую task/operation/fence")
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "capture-task-status",
      sourceResponseRef: evidence.sourceResponseRef,
      inventoryId: evidence.inventoryId,
      inventoryRevision: evidence.inventoryRevision,
      displayLayoutRevision: evidence.displayLayoutRevision,
      observedAt: evidence.observedAt,
      operationId: evidence.operationId,
      taskRef: this.taskRef,
      acceptedFence: evidence.acceptedFence,
      statusRevision: status.revision,
      statusEvidenceRef: evidence.statusEvidenceRef,
      cleanup: status.cleanup === "pending" ? "unknown" : status.cleanup,
      drained: status.drained,
    })
    await this.#continuations.advanceVerifiedStatus({
      receipt,
      operationId: evidence.operationId,
      taskRef: this.taskRef,
      acceptedFence: evidence.acceptedFence,
      statusRevision: status.revision,
      statusEvidenceRef: evidence.statusEvidenceRef,
      cleanup: status.cleanup === "pending" ? "unknown" : status.cleanup,
      drained: status.drained,
    })
  }

  #assertOpen(): void {
    if (this.#released) throw new Error("Capture task уже released")
  }
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`
}
