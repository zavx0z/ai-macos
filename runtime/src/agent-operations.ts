import { bindDeadline, signalDeadline } from "./deadline.ts"
import {
  TERMINAL_OPERATION_STATES,
  opaqueIdSchema,
  type OperationRecord,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import type {
  AgentTarget,
  AgentTargetActionResolution,
  AgentTargetControlResolution,
  AgentTargetRegistry,
  AgentTargetScope,
} from "./agent-targets.ts"
import type { RuntimeCore } from "./core.ts"
import { canonicalJson, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export type AgentActionTargetBinding = AgentTargetActionResolution
export type AgentControlTargetBinding = AgentTargetControlResolution

export type AgentOperationTargetScope = Pick<
  AgentTargetScope,
  "resolveAction" | "resolveControl" | "retainControl" | "releaseControl"
>

export type AgentOperationTargetRegistry = {
  forLineage(
    lineage: Parameters<AgentTargetRegistry["forLineage"]>[0],
  ): AgentOperationTargetScope
}

export type AgentOperationRuntime = Pick<
  RuntimeCore,
  "getOperationByRequest" | "cancelOperation"
> & {
  clients: Pick<RuntimeCore["clients"], "assertActive" | "lineage">
}

export type AgentMutationContext = {
  clientRequestId: string
  signal: AbortSignal
  binding: AgentActionTargetBinding
}

export type AgentOperationOutcome = {
  state: OperationRecord["state"]
  dispatch: OperationRecord["outcome"]["dispatch"]
  cleanup: OperationRecord["outcome"]["cleanup"]["state"]
  effect: OperationRecord["outcome"]["effect"]["state"]
  updatedAt: string
  error?: {
    code: string
    recoveryAction: string
  }
}

export type AgentOperationView = {
  trackingId: string
  action: string
  targetId: string
  queuedAt: string
  startedAt?: string
  handlerSettledAt?: string
  cancellationRequestedAt?: string
  phase:
    | "queued"
    | "pending-handler"
    | "pending-core"
    | "cancelled-before-admission"
    | "failed-before-admission"
    | "terminal"
  operationId?: string
  outcome?: AgentOperationOutcome
  localFailure?: "cancelled-before-admission" | "handler-error" | "missing-operation-record"
}

export type AgentTargetOperationStatus = {
  targetId: string
  targetState: AgentControlTargetBinding["state"] | "retained-operation"
  targetReason?: string
  active: AgentOperationView[]
  recent: AgentOperationView[]
  retentionMs: number
}

type TrackedRecord = {
  trackingId: string
  ownerKey: string
  clientRequestId: string
  lineage: string
  targetId: string
  targetFingerprint: string
  action: string
  queuedAtMs: number
  startedAtMs?: number
  handlerSettledAtMs?: number
  terminalAtMs?: number
  cancellationRequestedAtMs?: number
  handlerStarted: boolean
  handlerSettled: boolean
  localCancelledBeforeAdmission: boolean
  localFailure?: AgentOperationView["localFailure"]
  controller: AbortController
  authoritative?: OperationRecord
  controlReleased: boolean
}

type TargetBucket = {
  lineage: string
  targetId: string
  target: AgentTarget
  targetFingerprint: string
  records: TrackedRecord[]
  tail: Promise<void>
}

const MAX_TARGETS = 1_024
const MAX_RECORDS = 4_096
const MAX_RECORDS_PER_TARGET = 128
const MAX_STATUS_ACTIVE = 128
const MAX_STATUS_RECENT = 64
export const AGENT_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1_000

export class AgentOperations {
  readonly #runtime: AgentOperationRuntime
  readonly #targets: AgentOperationTargetRegistry
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #buckets = new Map<string, TargetBucket>()

  constructor(options: {
    runtime: AgentOperationRuntime
    targets: AgentOperationTargetRegistry
    clock?: RuntimeClock
    ids?: RuntimeIdSource
  }) {
    this.#runtime = options.runtime
    this.#targets = options.targets
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  async runTrackedMutation<Result>(
    session: RuntimeClientSession,
    targetIdValue: string,
    actionValue: string,
    execute: (context: AgentMutationContext) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    const targetId = opaqueIdSchema.parse(targetIdValue)
    const action = opaqueIdSchema.parse(actionValue)
    await this.#runtime.clients.assertActive(session, this.#clock.now())
    const lineage = this.#runtime.clients.lineage(session)
    const scope = this.#targets.forLineage(lineage)
    let binding = structuredClone(scope.resolveAction(targetId))
    assertActionBinding(binding, targetId, this.#clock.now())
    this.#prune()
    const bucket = this.#bucket(lineage, binding)
    this.#makeAdmissionRoom()
    if (bucket.records.length >= MAX_RECORDS_PER_TARGET
      || this.#recordCount() >= MAX_RECORDS) {
      throw new Error("Agent operation retention capacity исчерпана")
    }
    const trackingId = this.#ids.next("agent-operation")
    const ownerKey = this.#ids.next("agent-target-owner")
    const clientRequestId = this.#ids.next("agent-request")
    scope.retainControl(targetId, ownerKey)
    const controller = new AbortController()
    const deadlineAt = signalDeadline(signal)
    if (deadlineAt !== undefined) bindDeadline(controller.signal, deadlineAt)
    const record: TrackedRecord = {
      trackingId,
      ownerKey,
      clientRequestId,
      lineage,
      targetId,
      targetFingerprint: bucket.targetFingerprint,
      action,
      queuedAtMs: this.#clock.now().getTime(),
      handlerStarted: false,
      handlerSettled: false,
      localCancelledBeforeAdmission: false,
      controller,
      controlReleased: false,
    }
    bucket.records.push(record)
    const previous = bucket.tail
    let releaseSlot!: () => void
    const slot = new Promise<void>(resolve => { releaseSlot = resolve })
    bucket.tail = previous.then(() => slot, () => slot)
    const abortFromCaller = () => controller.abort(signal?.reason ?? new Error("Agent action отменено caller"))
    signal?.addEventListener("abort", abortFromCaller, { once: true })
    if (signal?.aborted) abortFromCaller()
    try {
      await waitForTurn(previous, controller.signal)
      if (controller.signal.aborted) {
        record.localCancelledBeforeAdmission = true
        throw abortError(controller.signal.reason)
      }
      binding = structuredClone(scope.resolveAction(targetId))
      assertActionBinding(binding, targetId, this.#clock.now())
      if (canonicalJson(binding.target) !== record.targetFingerprint) {
        throw new Error("Agent targetId изменил identity до admission")
      }
      record.handlerStarted = true
      record.startedAtMs = this.#clock.now().getTime()
      try {
        return await execute({ clientRequestId, signal: controller.signal, binding })
      } catch (error) {
        record.localFailure = "handler-error"
        throw error
      } finally {
        record.handlerSettled = true
        record.handlerSettledAtMs = this.#clock.now().getTime()
        await this.#refreshRecord(session, scope, record)
        if (record.authoritative === undefined && record.localFailure === undefined) {
          record.localFailure = "missing-operation-record"
          throw new Error("Backend returned without Runtime operation record")
        }
      }
    } catch (error) {
      if (!record.handlerStarted) {
        if (controller.signal.aborted) record.localCancelledBeforeAdmission = true
        record.handlerSettled = true
        record.handlerSettledAtMs = this.#clock.now().getTime()
        record.localFailure = record.localCancelledBeforeAdmission
          ? "cancelled-before-admission"
          : "handler-error"
        await this.#refreshRecord(session, scope, record)
      }
      throw error
    } finally {
      signal?.removeEventListener("abort", abortFromCaller)
      releaseSlot()
    }
  }

  async cancelTarget(
    session: RuntimeClientSession,
    targetIdValue: string,
    reasonValue: string,
  ): Promise<AgentTargetOperationStatus> {
    const targetId = opaqueIdSchema.parse(targetIdValue)
    const reason = reasonValue.trim()
    if (reason.length < 1 || reason.length > 1_024) {
      throw new Error("Agent cancellation reason должен иметь длину 1..1024")
    }
    await this.#runtime.clients.assertActive(session, this.#clock.now())
    const lineage = this.#runtime.clients.lineage(session)
    const scope = this.#targets.forLineage(lineage)
    const bucket = this.#buckets.get(bucketKey(lineage, targetId))
    if (bucket === undefined) scope.resolveControl(targetId)
    const now = this.#clock.now().getTime()
    for (const record of bucket?.records ?? []) {
      if (isLocallyTerminal(record)) continue
      record.cancellationRequestedAtMs ??= now
      record.controller.abort(new Error(reason))
    }
    for (const record of bucket?.records ?? []) {
      const operation = await this.#runtime.getOperationByRequest(
        session,
        record.clientRequestId,
      )
      if (operation === undefined) continue
      record.authoritative = structuredClone(operation)
      if (!isTerminalOperation(operation)) {
        try {
          record.authoritative = structuredClone(
            await this.#runtime.cancelOperation(
              session,
              operation.context.operationId,
              reason,
            ),
          )
        } catch {
          record.localFailure = "handler-error"
        }
      }
      this.#releaseIfTerminal(scope, record)
    }
    return await this.getTargetStatus(session, targetId)
  }

  async getTargetStatus(
    session: RuntimeClientSession,
    targetIdValue: string,
  ): Promise<AgentTargetOperationStatus> {
    const targetId = opaqueIdSchema.parse(targetIdValue)
    await this.#runtime.clients.assertActive(session, this.#clock.now())
    const lineage = this.#runtime.clients.lineage(session)
    const scope = this.#targets.forLineage(lineage)
    this.#prune()
    const bucket = this.#buckets.get(bucketKey(lineage, targetId))
    let control: AgentControlTargetBinding | undefined
    try {
      control = structuredClone(scope.resolveControl(targetId))
      assertControlBinding(control, targetId)
    } catch (error) {
      if (bucket === undefined) throw error
    }
    if (bucket === undefined) {
      return {
        targetId,
        targetState: control!.state,
        ...(control!.reason === undefined ? {} : { targetReason: control!.reason }),
        active: [],
        recent: [],
        retentionMs: AGENT_OPERATION_RETENTION_MS,
      }
    }
    for (const record of bucket.records) {
      await this.#refreshRecord(session, scope, record)
    }
    const views = bucket.records.map(record => view(record))
    const active = views.filter(item => !isViewTerminal(item))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
      .slice(0, MAX_STATUS_ACTIVE)
    const recent = views.filter(isViewTerminal)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .slice(0, MAX_STATUS_RECENT)
    return {
      targetId,
      targetState: control?.state ?? "retained-operation",
      ...(control?.reason === undefined ? {} : { targetReason: control.reason }),
      active,
      recent,
      retentionMs: AGENT_OPERATION_RETENTION_MS,
    }
  }

  #bucket(lineage: string, binding: AgentActionTargetBinding): TargetBucket {
    const key = bucketKey(lineage, binding.targetId)
    const fingerprint = canonicalJson(binding.target)
    const existing = this.#buckets.get(key)
    if (existing !== undefined) {
      if (existing.targetFingerprint !== fingerprint) {
        throw new Error("Agent targetId не может быть перепривязан к другой identity")
      }
      existing.target = structuredClone(binding.target)
      return existing
    }
    if (this.#buckets.size >= MAX_TARGETS) {
      throw new Error("Agent target retention capacity исчерпана")
    }
    const bucket: TargetBucket = {
      lineage,
      targetId: binding.targetId,
      target: structuredClone(binding.target),
      targetFingerprint: fingerprint,
      records: [],
      tail: Promise.resolve(),
    }
    this.#buckets.set(key, bucket)
    return bucket
  }

  async #refreshRecord(
    session: RuntimeClientSession,
    scope: AgentOperationTargetScope,
    record: TrackedRecord,
  ): Promise<void> {
    const operation = await this.#runtime.getOperationByRequest(
      session,
      record.clientRequestId,
    )
    if (operation !== undefined) record.authoritative = structuredClone(operation)
    this.#releaseIfTerminal(scope, record)
  }

  #releaseIfTerminal(scope: AgentOperationTargetScope, record: TrackedRecord): void {
    if (record.controlReleased) return
    const authoritativeTerminal = record.authoritative !== undefined
      && isTerminalOperation(record.authoritative)
      && record.authoritative.outcome.cleanup.state === "complete"
    const localTerminal = record.authoritative === undefined
      && record.handlerSettled
    if (!authoritativeTerminal && !localTerminal) return
    record.terminalAtMs ??= this.#clock.now().getTime()
    scope.releaseControl(record.targetId, record.ownerKey)
    record.controlReleased = true
  }

  #makeAdmissionRoom(): void {
    const evictOne = (bucket: TargetBucket): boolean => {
      const index = bucket.records.findIndex(isEvictableHistory)
      if (index < 0) return false
      bucket.records.splice(index, 1)
      return true
    }
    while (this.#recordCount() >= MAX_RECORDS) {
      let evicted = false
      for (const bucket of this.#buckets.values()) {
        if (!evictOne(bucket)) continue
        // Текущий bucket может уже быть захвачен вызывающим методом.
        // Удаление из map здесь потеряет добавляемую в него новую операцию.
        evicted = true
        break
      }
      if (!evicted) break
    }
  }

  #prune(): void {
    const cutoff = this.#clock.now().getTime() - AGENT_OPERATION_RETENTION_MS
    for (const [key, bucket] of this.#buckets) {
      bucket.records = bucket.records.filter(record => {
        if (record.terminalAtMs === undefined || record.terminalAtMs > cutoff) {
          return true
        }
        if (record.authoritative !== undefined
          && record.authoritative.outcome.cleanup.state !== "complete") {
          return true
        }
        return false
      })

      let overflow = Math.max(0, bucket.records.length - MAX_STATUS_RECENT)
      if (overflow > 0) {
        bucket.records = bucket.records.filter(record => {
          if (overflow === 0 || !isEvictableHistory(record)) return true
          overflow -= 1
          return false
        })
      }

      if (bucket.records.length === 0) this.#buckets.delete(key)
    }
  }

  #recordCount(): number {
    let count = 0
    for (const bucket of this.#buckets.values()) count += bucket.records.length
    return count
  }
}

function assertActionBinding(
  binding: AgentActionTargetBinding,
  targetId: string,
  now: Date,
): void {
  if (binding.targetId !== targetId || !Number.isSafeInteger(binding.inventoryRevision)
    || binding.inventoryRevision < 0 || binding.inventoryId.length < 1
    || binding.actionExpiresAt !== undefined && (!Number.isFinite(Date.parse(binding.actionExpiresAt))
      || Date.parse(binding.actionExpiresAt) <= now.getTime())) {
    throw new Error("Agent action target binding invalid или expired")
  }
}

function assertControlBinding(
  binding: AgentControlTargetBinding,
  targetId: string,
): void {
  if (binding.targetId !== targetId || !Number.isFinite(Date.parse(binding.controlExpiresAt))) {
    throw new Error("Agent control target binding invalid")
  }
}

function isTerminalOperation(operation: OperationRecord): boolean {
  return TERMINAL_OPERATION_STATES.includes(operation.state)
}

function isEvictableHistory(record: TrackedRecord): boolean {
  if (record.terminalAtMs === undefined || !record.controlReleased) return false
  if (record.authoritative !== undefined) {
    return isTerminalOperation(record.authoritative)
      && record.authoritative.outcome.cleanup.state === "complete"
  }
  return record.handlerSettled
}

function isLocallyTerminal(record: TrackedRecord): boolean {
  return record.authoritative !== undefined
    ? isTerminalOperation(record.authoritative)
    : record.handlerSettled
}

function view(record: TrackedRecord): AgentOperationView {
  const authoritative = record.authoritative === undefined
    ? undefined
    : structuredClone(record.authoritative)
  const phase: AgentOperationView["phase"] = authoritative !== undefined
    ? isTerminalOperation(authoritative) ? "terminal" : "pending-core"
    : !record.handlerStarted
      ? record.localCancelledBeforeAdmission ? "cancelled-before-admission" : "queued"
      : !record.handlerSettled ? "pending-handler"
        : record.controller.signal.aborted ? "cancelled-before-admission"
          : "failed-before-admission"
  return {
    trackingId: record.trackingId,
    action: record.action,
    targetId: record.targetId,
    queuedAt: new Date(record.queuedAtMs).toISOString(),
    ...(record.startedAtMs === undefined ? {} : { startedAt: new Date(record.startedAtMs).toISOString() }),
    ...(record.handlerSettledAtMs === undefined ? {} : { handlerSettledAt: new Date(record.handlerSettledAtMs).toISOString() }),
    ...(record.cancellationRequestedAtMs === undefined ? {} : {
      cancellationRequestedAt: new Date(record.cancellationRequestedAtMs).toISOString(),
    }),
    phase,
    ...(authoritative === undefined ? {} : {
      operationId: authoritative.context.operationId,
      outcome: projectOutcome(authoritative),
    }),
    ...(record.localFailure === undefined ? {} : { localFailure: record.localFailure }),
  }
}

function projectOutcome(operation: OperationRecord): AgentOperationOutcome {
  return {
    state: operation.state,
    dispatch: operation.outcome.dispatch,
    cleanup: operation.outcome.cleanup.state,
    effect: operation.outcome.effect.state,
    updatedAt: operation.updatedAt,
    ...(operation.error === undefined ? {} : {
      error: {
        code: operation.error.code,
        recoveryAction: operation.error.recoveryAction,
      },
    }),
  }
}

function isViewTerminal(view: AgentOperationView): boolean {
  return ["cancelled-before-admission", "failed-before-admission", "terminal"].includes(view.phase)
}

function bucketKey(lineage: string, targetId: string): string {
  return canonicalJson([lineage, targetId])
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Agent action отменено до admission")
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal.reason)
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(abortError(signal.reason))
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    await Promise.race([previous, cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
