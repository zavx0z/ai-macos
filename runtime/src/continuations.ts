import {
  nativeCleanupControlSchema,
  structurallyEqual,
  type NativeContinuation,
  type NativeContinuationIssueRequest,
  type NativeContinuationIssuer,
  type NativeContinuationRegistrar,
  type NativeEvidenceReport,
  type NativeExecutionContext,
  type OperationRecord,
  type RuntimeGeneration,
  type RuntimeResourceHandle,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export type NativeTaskBinding = {
  operationId: string
  taskRef: string
  resourceLeaseId: string
  acceptedFence: NativeExecutionContext["fence"]
  statusRevision: number
  statusEvidenceRef: string
  cleanup: "complete" | "incomplete" | "unknown"
  drained: boolean
  drainedEvidenceRef: string
  terminalReceiptRef?: string
}

export class NativeContinuationRegistry implements NativeContinuationIssuer, NativeContinuationRegistrar {
  readonly #generation: RuntimeGeneration
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #lookupOperation: (operationId: string) => OperationRecord | undefined
  readonly #lookupHandle: (leaseId: string) => RuntimeResourceHandle | undefined
  readonly #lookupCleanupReceipt: (leaseId: string) => unknown | undefined
  readonly #highWaterFence: () => NativeExecutionContext["fence"] | undefined
  readonly #verifiedReport: (
    receipt: VerifiedNativeEvidenceReceipt,
    factKind: VerifiedNativeEvidenceReceipt["factKind"],
  ) => NativeEvidenceReport
  readonly #tasks = new Map<string, NativeTaskBinding>()
  readonly #cleanupIds = new Map<string, string>()

  constructor(options: {
    generation: RuntimeGeneration
    lookupOperation: (operationId: string) => OperationRecord | undefined
    lookupHandle: (leaseId: string) => RuntimeResourceHandle | undefined
    lookupCleanupReceipt: (leaseId: string) => unknown | undefined
    highWaterFence: () => NativeExecutionContext["fence"] | undefined
    verifiedReport: (
      receipt: VerifiedNativeEvidenceReceipt,
      factKind: VerifiedNativeEvidenceReceipt["factKind"],
    ) => NativeEvidenceReport
    clock?: RuntimeClock
    ids?: RuntimeIdSource
  }) {
    this.#generation = options.generation
    this.#lookupOperation = options.lookupOperation
    this.#lookupHandle = options.lookupHandle
    this.#lookupCleanupReceipt = options.lookupCleanupReceipt
    this.#highWaterFence = options.highWaterFence
    this.#verifiedReport = options.verifiedReport
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  async registerAcceptedTask(request: Parameters<NativeContinuationRegistrar["registerAcceptedTask"]>[0]): Promise<void> {
    const report = this.#verifiedReport(request.receipt, "capture-task-start")
    if (
      report.factKind !== "capture-task-start"
      || report.operationId !== request.operationId
      || report.taskRef !== request.taskRef
      || !structurallyEqual(report.acceptedFence, request.acceptedFence)
      || report.statusRevision !== request.statusRevision
      || report.statusEvidenceRef !== request.statusEvidenceRef
    ) {
      throw new Error("Accepted capture task registration не совпадает с verified native start facts")
    }
    this.#registerTask({
      operationId: request.operationId,
      taskRef: request.taskRef,
      resourceLeaseId: request.resourceLeaseId,
      acceptedFence: request.acceptedFence,
      statusRevision: request.statusRevision,
      statusEvidenceRef: request.statusEvidenceRef,
      cleanup: "unknown",
      drained: false,
      drainedEvidenceRef: request.statusEvidenceRef,
    })
  }

  async advanceVerifiedStatus(request: Parameters<NativeContinuationRegistrar["advanceVerifiedStatus"]>[0]): Promise<void> {
    const report = this.#verifiedReport(request.receipt, "capture-task-status")
    if (
      report.factKind !== "capture-task-status"
      || report.operationId !== request.operationId
      || report.taskRef !== request.taskRef
      || !structurallyEqual(report.acceptedFence, request.acceptedFence)
      || report.statusRevision !== request.statusRevision
      || report.statusEvidenceRef !== request.statusEvidenceRef
      || report.cleanup !== request.cleanup
      || report.drained !== request.drained
    ) {
      throw new Error("Capture task status advance не совпадает с verified native facts")
    }
    const key = taskKey(request.operationId, request.taskRef)
    const binding = this.#tasks.get(key)
    if (binding === undefined || !structurallyEqual(binding.acceptedFence, request.acceptedFence)) {
      throw new Error("Capture task status относится к другой operation/fence")
    }
    const next = {
      ...binding,
      statusRevision: request.statusRevision,
      statusEvidenceRef: request.statusEvidenceRef,
      cleanup: request.cleanup,
      drained: request.drained,
      drainedEvidenceRef: request.statusEvidenceRef,
    }
    if (request.statusRevision < binding.statusRevision) throw new Error("Capture task status revision stale")
    if (request.statusRevision === binding.statusRevision) {
      if (!structurallyEqual(binding, next)) throw new Error("Capture task equal revision содержит conflicting facts")
      return
    }
    if (binding.terminalReceiptRef !== undefined) throw new Error("Capture task уже terminal")
    this.#tasks.set(key, next)
  }

  async markVerifiedTerminal(request: Parameters<NativeContinuationRegistrar["markVerifiedTerminal"]>[0]): Promise<void> {
    const report = this.#verifiedReport(request.receipt, "capture-task-terminal")
    if (
      report.factKind !== "capture-task-terminal"
      || report.operationId !== request.operationId
      || report.taskRef !== request.taskRef
      || !structurallyEqual(report.acceptedFence, request.acceptedFence)
      || report.statusRevision !== request.statusRevision
      || report.drainedEvidenceRef !== request.drainedEvidenceRef
      || report.terminalReceiptRef !== request.terminalReceiptRef
      || report.cleanup !== "complete"
      || !report.drained
    ) {
      throw new Error("Terminal capture task status не совпадает с verified native facts")
    }
    this.#markTerminal({
      operationId: request.operationId,
      taskRef: request.taskRef,
      acceptedFence: request.acceptedFence,
      statusRevision: request.statusRevision,
      drainedEvidenceRef: request.drainedEvidenceRef,
      terminalReceiptRef: request.terminalReceiptRef,
    })
  }

  #registerTask(binding: NativeTaskBinding): void {
    const operation = this.#nativeOperation(binding.operationId)
    const handle = this.#lookupHandle(binding.resourceLeaseId)
    if (
      handle === undefined
      || handle.operationId !== binding.operationId
      || !structurallyEqual(binding.acceptedFence, operation.context.fence)
    ) {
      throw new Error("Native task binding не совпадает с operation/fence/resource")
    }
    const key = taskKey(binding.operationId, binding.taskRef)
    const existing = this.#tasks.get(key)
    if (existing !== undefined && !structurallyEqual(existing, binding)) throw new Error("Native taskRef уже связан с другими facts")
    this.#tasks.set(key, structuredClone(binding))
  }

  #markTerminal(input: {
    operationId: string
    taskRef: string
    acceptedFence: NativeExecutionContext["fence"]
    statusRevision: number
    drainedEvidenceRef: string
    terminalReceiptRef: string
  }): void {
    const key = taskKey(input.operationId, input.taskRef)
    const binding = this.#tasks.get(key)
    if (
      binding === undefined
      || binding.operationId !== input.operationId
      || !structurallyEqual(binding.acceptedFence, input.acceptedFence)
    ) {
      throw new Error("Native terminal task относится к другой binding")
    }
    const terminalTuple = {
      statusRevision: input.statusRevision,
      drainedEvidenceRef: input.drainedEvidenceRef,
      terminalReceiptRef: input.terminalReceiptRef,
    }
    if (binding.terminalReceiptRef !== undefined) {
      const previousTuple = {
        statusRevision: binding.statusRevision,
        drainedEvidenceRef: binding.drainedEvidenceRef,
        terminalReceiptRef: binding.terminalReceiptRef,
      }
      if (!structurallyEqual(previousTuple, terminalTuple)) throw new Error("Native terminal task содержит conflicting repeated facts")
      return
    }
    if (input.statusRevision <= binding.statusRevision) throw new Error("Первый terminal revision должен быть выше current status")
    this.#tasks.set(key, {
      ...binding,
      statusRevision: input.statusRevision,
      statusEvidenceRef: input.drainedEvidenceRef,
      cleanup: "complete",
      drained: true,
      drainedEvidenceRef: input.drainedEvidenceRef,
      terminalReceiptRef: input.terminalReceiptRef,
    })
  }

  async issue(request: NativeContinuationIssueRequest): Promise<NativeContinuation> {
    const operation = this.#nativeOperation(request.operationId)
    const binding = this.#tasks.get(taskKey(request.operationId, request.taskRef))
    const highWaterFence = this.#highWaterFence()
    if (
      binding === undefined
      || highWaterFence === undefined
      || binding.operationId !== request.operationId
      || request.expectedRevision !== binding.statusRevision
      || !structurallyEqual(binding.acceptedFence, operation.context.fence)
    ) {
      throw new Error("Native continuation task/revision/fence не подтверждены runtime")
    }
    const handle = this.#lookupHandle(binding.resourceLeaseId)
    if (
      handle === undefined
      || handle.operationId !== request.operationId
      || !["active", "quarantined", "revoked"].includes(handle.state)
    ) {
      throw new Error("Native continuation не имеет exact held/quarantined lease")
    }
    if (request.purpose === "release") {
      const normalRelease = handle.state === "active" && binding.terminalReceiptRef !== undefined
      const lateRelease = handle.state === "revoked"
        && binding.terminalReceiptRef !== undefined
        && this.#lookupCleanupReceipt(handle.leaseId) !== undefined
      if (!normalRelease && !lateRelease) {
        throw new Error("Release continuation требует terminal active task или released-resource cleanup receipt")
      }
    } else if (handle.state === "revoked") {
      throw new Error("Только release continuation разрешён после runtime lease receipt")
    }
    const now = this.#clock.now()
    const requestedDeadline = request.requestedDeadlineAt === undefined
      ? now.getTime() + 1_000
      : Date.parse(request.requestedDeadlineAt)
    if (!Number.isFinite(requestedDeadline) || requestedDeadline <= now.getTime()) {
      throw new Error("Continuation requestedDeadlineAt уже истёк")
    }
    const deadlineAt = new Date(Math.min(requestedDeadline, now.getTime() + 1_000)).toISOString()
    const idempotencyKey = continuationIdempotencyKey(request)
    let cleanupRequestId = this.#cleanupIds.get(idempotencyKey)
    if (cleanupRequestId === undefined) {
      cleanupRequestId = this.#ids.next("native-cleanup")
      this.#cleanupIds.set(idempotencyKey, cleanupRequestId)
    }
    const cleanupControl = nativeCleanupControlSchema.parse({
      kind: "cleanup-only",
      purpose: request.purpose,
      requestId: this.#ids.next("native-cleanup-rpc"),
      cleanupRequestId,
      operationId: request.operationId,
      ...this.#generation,
      nativeGeneration: operation.context.nativeGeneration,
      acceptedFence: operation.context.fence,
      currentHighWaterFence: highWaterFence,
      deadlineAt,
      expectedStatusRevision: request.expectedRevision,
      expectedDrainedEvidenceRef: binding.drainedEvidenceRef,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort("native continuation deadline"), Math.max(0, Date.parse(deadlineAt) - now.getTime()))
    timer.unref?.()
    const control = {
      signal: controller.signal,
      checkpoint: () => {
        if (controller.signal.aborted) throw new Error("Native continuation deadline истёк")
      },
    }
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
    return { control, cleanupControl }
  }

  #nativeOperation(operationId: string) {
    const operation = this.#lookupOperation(operationId)
    if (operation === undefined || operation.context.kind !== "native") throw new Error("Native operation не найдена")
    return operation as OperationRecord & { context: NativeExecutionContext }
  }
}

function taskKey(operationId: string, taskRef: string): string {
  return canonicalJson([operationId, taskRef])
}

export function continuationIdempotencyKey(request: Pick<
  NativeContinuationIssueRequest,
  "operationId" | "taskRef" | "purpose" | "expectedRevision"
>): string {
  return canonicalJson([
    request.operationId,
    request.taskRef,
    request.purpose,
    request.expectedRevision,
  ])
}
