import {
  CAPABILITY_IDS,
  adapterResultSchema,
  browserExecutionContextSchema,
  capabilitySetSchema,
  cleanupOutcomeSchema,
  clipboardExecutionContextSchema,
  deviceExecutionContextSchema,
  nativeExecutionContextSchema,
  nativeCancelRequestSchema,
  nativeCancelAckMatches,
  nativeStatusMatchesOperation,
  nativeStatusMatchesRequest,
  nativeStatusRequestSchema,
  parseWireValue,
  operationOutcomeSchema,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  type AdapterResult,
  type AdapterServices,
  type BrowserExecutionContext,
  type CapabilitySet,
  type CleanupAuthorityReceipt,
  type CleanupOutcome,
  type ClipboardExecutionContext,
  type DeviceExecutionContext,
  type NativeAdapter,
  type NativeOperationStatus,
  type NativeExecutionContext,
  type OperationOutcome,
  type OperationRecord,
  type RuntimeAdapter,
  type RuntimeClientSession,
  type RuntimeExecution,
  type RuntimeGeneration,
  type RuntimeOperationContext,
  type RuntimeOperationIntent,
  type SerializableOperationContext,
  type RuntimeResourceHandle,
  z,
} from "@meta/shared/contracts"
import { ClientSessionRegistry, type RuntimeClientCredential } from "./client-sessions.ts"
import { RuntimeContractError, contractErrorFrom } from "./errors.ts"
import { FrameStore, NativeEvidenceAuthority, ObservationRegistry, ProofRegistry, TargetRegistry } from "./authorities.ts"
import type { NativeEvidenceBinding } from "./authorities.ts"
import { canonicalJson, hmacSha256, randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"
import { ResourceRegistry } from "./resources.ts"
import { NativeContinuationRegistry } from "./continuations.ts"
import { BrowserLifetimeCoordinator, type CoordinatedLifecycle } from "./reservations.ts"

type JournalEntry = {
  digest: string
  lineageId: string
  record: OperationRecord
  controller: AbortController
  promise?: Promise<RuntimeExecution<unknown>>
  result?: RuntimeExecution<unknown>
  deadlineTimer?: ReturnType<typeof setTimeout>
  adapterStarted: boolean
  settled: boolean
  lastNativeStatus?: NativeOperationStatus
}

export interface BackendCompletionVerifier {
  verify(context: RuntimeOperationContext, result: AdapterResult<unknown>): Promise<void>
  verifyReconciliation?(record: OperationRecord, report: LateCleanupReport): Promise<void>
}

export type LateCleanupReport = {
  operationId: string
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration?: string
  revision: number
  cleanup: CleanupOutcome
  nativeStatus?: NativeOperationStatus
}

export type RuntimeCoreOptions = {
  generation: RuntimeGeneration
  runtimeBuildId: string
  nativeGeneration?: string
  native?: NativeAdapter
  clock?: RuntimeClock
  ids?: RuntimeIdSource
  secret?: Uint8Array
  cancelGraceMs?: number
  completionVerifier?: BackendCompletionVerifier
  nativeSourceIdentity?: NativeEvidenceBinding
  reservationTtlMs?: number
}

export class RuntimeCore implements RuntimeAdapter {
  readonly generation: RuntimeGeneration
  readonly capabilities: CapabilitySet
  readonly native?: NativeAdapter
  readonly clients: ClientSessionRegistry
  readonly resources: ResourceRegistry
  readonly targets: TargetRegistry
  readonly proofs: ProofRegistry
  readonly evidence: NativeEvidenceAuthority
  readonly frames: FrameStore
  readonly observations: ObservationRegistry
  readonly continuations: NativeContinuationRegistry
  readonly browserLifetime: BrowserLifetimeCoordinator
  readonly reservations: BrowserLifetimeCoordinator["authority"]
  readonly services: AdapterServices
  readonly #runtimeBuildId: string
  readonly #nativeGeneration?: string
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #secret: Uint8Array
  readonly #journal = new Map<string, JournalEntry>()
  readonly #dedup = new Map<string, string>()
  readonly #reconciliationRevisions = new Map<string, number>()
  readonly #reconciliationReceipts = new Map<string, {
    revision: number
    digest: string
    receipt: CleanupAuthorityReceipt
  }>()
  readonly #hmacKeyGeneration: string
  readonly #cancelGraceMs: number
  readonly #completionVerifier?: BackendCompletionVerifier
  #fenceCounter = 0

  constructor(options: RuntimeCoreOptions) {
    this.generation = options.generation
    this.#runtimeBuildId = options.runtimeBuildId
    this.#nativeGeneration = options.nativeGeneration
    this.native = options.native
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#secret = options.secret ?? crypto.getRandomValues(new Uint8Array(32))
    this.#hmacKeyGeneration = this.#ids.next("hmac-key")
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000
    this.#completionVerifier = options.completionVerifier
    this.capabilities = unavailableRuntimeCapabilities(this.#ids.next("runtime-capabilities"))
    this.clients = new ClientSessionRegistry(this.generation, { clock: this.#clock, ids: this.#ids })
    this.resources = new ResourceRegistry(this.generation, this.#secret, { clock: this.#clock, ids: this.#ids })
    this.browserLifetime = new BrowserLifetimeCoordinator({
      generation: this.generation,
      clients: this.clients,
      clock: this.#clock,
      ids: this.#ids,
      ttlMs: options.reservationTtlMs,
      lookup: id => this.#journal.get(id)?.record,
      run: (session, intent, request, execute, lifecycle) => this.#runOperation(session, intent, request, execute, lifecycle),
    })
    this.reservations = this.browserLifetime.authority
    this.targets = new TargetRegistry(this.generation, { clock: this.#clock })
    this.proofs = new ProofRegistry(this.generation, {
      ...(this.#nativeGeneration === undefined ? {} : { nativeGeneration: this.#nativeGeneration }),
      clock: this.#clock,
      ids: this.#ids,
    })
    this.frames = new FrameStore(this.generation, { clock: this.#clock })
    const configuredNativeSource = options.nativeSourceIdentity
    this.evidence = new NativeEvidenceAuthority(this.generation, this.proofs, this.targets, {
      clock: this.#clock,
      ids: this.#ids,
      validateBinding: binding => configuredNativeSource !== undefined
        && canonicalJson(binding) === canonicalJson(configuredNativeSource),
    })
    this.observations = new ObservationRegistry(this.proofs, this.evidence, { clock: this.#clock })
    this.evidence.attachObservations(this.observations)
    this.evidence.attachFrames(this.frames)
    this.continuations = new NativeContinuationRegistry({
      generation: this.generation,
      lookupOperation: operationId => this.#journal.get(operationId)?.record,
      lookupHandle: leaseId => this.resources.handleByLeaseId(leaseId),
      lookupCleanupReceipt: leaseId => this.resources.cleanupReceiptByLeaseId(leaseId),
      highWaterFence: () => this.#nativeGeneration === undefined || this.#fenceCounter < 1
        ? undefined
        : {
            ...this.generation,
            nativeGeneration: this.#nativeGeneration,
            counter: this.#fenceCounter,
          },
      verifiedReport: (receipt, factKind) => this.evidence.verifiedReport(receipt, factKind),
      clock: this.#clock,
      ids: this.#ids,
    })
    this.services = Object.freeze({
      clientSessions: this.clients,
      resources: this.resources,
      cleanup: this.resources,
      targets: this.targets,
      proofs: this.proofs,
      evidence: this.evidence,
      frames: this.frames,
      observations: this.observations,
      continuations: this.continuations,
      reservations: this.reservations,
    })
  }

  openClient(principalId: string, ttlMs?: number): RuntimeClientCredential {
    return this.clients.open(principalId, ttlMs)
  }

  async runOperation<TRequest, TResult>(
    session: RuntimeClientSession,
    intentValue: RuntimeOperationIntent,
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
  ): Promise<RuntimeExecution<TResult>> {
    return this.#runOperation(session, intentValue, request, execute)
  }

  async #runOperation<TRequest, TResult>(
    session: RuntimeClientSession,
    intentValue: RuntimeOperationIntent,
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
    lifecycle?: CoordinatedLifecycle,
  ): Promise<RuntimeExecution<TResult>> {
    const now = this.#clock.now()
    await this.clients.assertActive(session, now)
    const intent = runtimeOperationIntentSchema.parse(intentValue)
    const domain = intent.precondition.target.kind
    if (lifecycle === undefined && [
      "browser-instance", "browser-target", "device", "device-browser-instance", "device-browser-target",
    ].includes(domain)) {
      throw new RuntimeContractError(
        "unauthorized",
        "Browser/device operation требует зарегистрированный lifetime coordinator",
        "runtime-admission",
      )
    }
    const digest = hmacSha256(this.#secret, canonicalJson({
      intent: intent.intent,
      precondition: intent.precondition,
      requestedResources: intent.requestedResources,
      request,
    }))
    const lineageId = this.clients.lineage(session)
    const dedupKey = canonicalJson([
      this.generation.runtimeEpoch,
      lineageId,
      intent.clientRequestId,
    ])
    const previousOperationId = this.#dedup.get(dedupKey)
    if (previousOperationId !== undefined) {
      const previous = this.#journal.get(previousOperationId)
      if (previous === undefined) throw new Error("Dedup index ссылается на отсутствующую operation")
      this.#assertJournalAuthority(session, previous.record)
      if (previous.digest !== digest) {
        throw new RuntimeContractError(
          "request-payload-mismatch",
          "Повторный clientRequestId содержит другой payload",
          "runtime-dedup",
          { recoveryAction: "get-operation", context: { operationId: previousOperationId } },
        )
      }
      if (previous.result !== undefined) return previous.result as RuntimeExecution<TResult>
      if (previous.promise !== undefined) return previous.promise as Promise<RuntimeExecution<TResult>>
      throw new Error("Operation зарегистрирована без execution promise")
    }

    this.#assertIntentAuthority(session, intent, now)
    await this.targets.resolve({
      target: intent.precondition.target,
      inventoryId: intent.precondition.inventoryId,
      inventoryRevision: intent.precondition.inventoryRevision,
      runtimeEpoch: session.runtimeEpoch,
      loginSessionId: session.loginSessionId,
      ...(this.#nativeGeneration === undefined ? {} : { nativeGeneration: this.#nativeGeneration }),
      deadlineAt: intent.deadlineAt,
    })

    const operationId = this.#ids.next("operation")
    const wire = this.#createWireContext(operationId, session, intent)
    const resourceExpiry = new Date(Math.min(Date.parse(intent.deadlineAt), now.getTime() + 30_000)).toISOString()
    const handles = this.resources.acquire(session, operationId, intent.requestedResources, resourceExpiry)
    const controller = new AbortController()
    const record = operationRecordSchema.parse({
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      intent: intent.intent,
      context: wire,
      state: "registered",
      outcome: pendingOutcome(handles),
      resources: handles,
      payloadReceipt: {
        keyGeneration: this.#hmacKeyGeneration,
        hmacSha256: digest,
      },
      registeredAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    const entry: JournalEntry = {
      digest,
      lineageId,
      record,
      controller,
      adapterStarted: false,
      settled: false,
    }
    this.#journal.set(operationId, entry)
    this.#dedup.set(dedupKey, operationId)
    const deadlineDelay = Math.max(0, Date.parse(intent.deadlineAt) - this.#clock.now().getTime())
    entry.deadlineTimer = setTimeout(() => controller.abort("operation deadline exceeded"), deadlineDelay)
    const promise = this.#execute(entry, session, handles, request, execute, lifecycle)
    entry.promise = promise as Promise<RuntimeExecution<unknown>>
    return promise
  }

  async getOperation(session: RuntimeClientSession, operationId: string): Promise<OperationRecord | undefined> {
    await this.clients.assertActive(session, this.#clock.now())
    const entry = this.#journal.get(operationId)
    if (entry === undefined) return undefined
    this.#assertJournalAuthority(session, entry.record)
    return entry.record
  }

  async getOperationByRequest(session: RuntimeClientSession, clientRequestId: string): Promise<OperationRecord | undefined> {
    await this.clients.assertActive(session, this.#clock.now())
    const operationId = this.#dedup.get(canonicalJson([
      this.generation.runtimeEpoch,
      this.clients.lineage(session),
      clientRequestId,
    ]))
    return operationId === undefined ? undefined : this.getOperation(session, operationId)
  }

  async cancelOperation(session: RuntimeClientSession, operationId: string, reason: string): Promise<OperationRecord> {
    await this.clients.assertActive(session, this.#clock.now())
    const entry = this.#journal.get(operationId)
    if (entry === undefined) throw new Error("Operation не найдена")
    this.#assertJournalAuthority(session, entry.record)
    if (isTerminal(entry.record)) return entry.record
    entry.record = operationRecordSchema.parse({
      ...entry.record,
      state: "cancelling",
      updatedAt: this.#clock.now().toISOString(),
    })
    entry.controller.abort(reason)
    if (entry.promise !== undefined) await entry.promise.catch(() => undefined)
    return entry.record
  }

  disconnectClient(clientSessionId: string): void {
    this.clients.disconnect(clientSessionId)
    for (const entry of this.#journal.values()) {
      if (entry.record.clientSessionId === clientSessionId && !isTerminal(entry.record)) {
        entry.controller.abort("client disconnected")
      }
    }
  }

  async reconcileCleanup(report: LateCleanupReport): Promise<CleanupAuthorityReceipt> {
    const { nativeStatus: _reportedStatus, ...reconciliationFacts } = report
    const reportDigest = hmacSha256(this.#secret, canonicalJson(reconciliationFacts))
    const previousReconciliation = this.#reconciliationReceipts.get(report.operationId)
    if (previousReconciliation !== undefined && report.revision === previousReconciliation.revision) {
      if (previousReconciliation.digest !== reportDigest) throw new Error("Duplicate reconciliation revision содержит другие facts")
      return previousReconciliation.receipt
    }
    const entry = this.#journal.get(report.operationId)
    if (entry === undefined) throw new Error("Reconciliation operation не найдена")
    if (
      !entry.settled
      || !["failed", "interrupted-unknown"].includes(entry.record.state)
      || entry.record.outcome.cleanup.state === "complete"
      || report.runtimeEpoch !== entry.record.context.runtimeEpoch
      || report.loginSessionId !== entry.record.context.loginSessionId
      || report.revision <= (this.#reconciliationRevisions.get(report.operationId) ?? 0)
    ) {
      throw new Error("Reconciliation stale или не относится к unresolved operation")
    }
    let verifiedNativeStatus: NativeOperationStatus | undefined
    if (entry.record.context.kind === "native") {
      if (report.nativeGeneration !== entry.record.context.nativeGeneration) {
        throw new Error("Reconciliation относится к другой native generation")
      }
      if (report.nativeStatus !== undefined && !nativeStatusMatchesOperation(entry.record.context, report.nativeStatus)) {
        throw new Error("Caller report содержит foreign native status")
      }
      try {
        verifiedNativeStatus = await this.#queryNativeStatus(entry.record.context, "native-status-reconcile")
      } catch {
        if (this.#completionVerifier?.verifyReconciliation === undefined) {
          throw new Error("Native reconciliation не подтверждён runtime status query")
        }
        await this.#completionVerifier.verifyReconciliation(entry.record, report)
      }
      if (verifiedNativeStatus !== undefined && (
        verifiedNativeStatus.cleanup !== "complete"
        || verifiedNativeStatus.heldCount !== 0
        || verifiedNativeStatus.ledgerRevision < report.revision
        || !["finished", "cancelled", "failed"].includes(verifiedNativeStatus.execution)
      )) {
        throw new Error("Runtime-query native status не подтверждает terminal cleanup/revision")
      }
    } else {
      if (this.#completionVerifier?.verifyReconciliation === undefined) {
        throw new Error("Для adapter reconciliation не зарегистрирован verifier")
      }
      await this.#completionVerifier.verifyReconciliation(entry.record, report)
    }
    const stagedOutcome = operationOutcomeSchema.parse({
      ...entry.record.outcome,
      cleanup: report.cleanup,
    })
    const stagedRecord = operationRecordSchema.parse({
      ...entry.record,
      outcome: stagedOutcome,
      updatedAt: this.#clock.now().toISOString(),
    })
    const receipt = this.resources.reconcileCleanup(
      report.operationId,
      entry.record.resources,
      report.cleanup,
    )
    this.#reconciliationRevisions.set(report.operationId, report.revision)
    this.#reconciliationReceipts.set(report.operationId, {
      revision: report.revision,
      digest: reportDigest,
      receipt,
    })
    entry.record = stagedRecord
    if (entry.result !== undefined) {
      entry.result = {
        operation: stagedRecord,
        result: {
          ...entry.result.result,
          outcome: stagedOutcome,
          ...(verifiedNativeStatus === undefined ? {} : { nativeStatus: verifiedNativeStatus }),
        },
      }
    }
    return receipt
  }

  operationCount(): number {
    return this.#journal.size
  }

  activeOperationCount(): number {
    return [...this.#journal.values()].filter(entry => !isTerminal(entry.record)).length
  }

  async #execute<TRequest, TResult>(
    entry: JournalEntry,
    session: RuntimeClientSession,
    handles: RuntimeResourceHandle[],
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
    lifecycle?: CoordinatedLifecycle,
  ): Promise<RuntimeExecution<TResult>> {
    const context: RuntimeOperationContext = {
      wire: entry.record.context,
      session,
      resources: handles,
      control: {
        signal: entry.controller.signal,
        checkpoint: async stage => {
          if (entry.controller.signal.aborted) throw new RuntimeContractError("cancelled", "Operation отменена", stage)
          const now = this.#clock.now()
          if (now.getTime() >= Date.parse(entry.record.context.deadlineAt)) {
            throw new RuntimeContractError("deadline-exceeded", "Operation deadline истёк", stage)
          }
          for (const handle of handles) {
            await this.resources.assertActive({
              handle,
              operationId: entry.record.context.operationId,
              clientSessionId: session.clientSessionId,
              principalId: session.principalId,
              ...this.generation,
              now,
            })
          }
          entry.record = operationRecordSchema.parse({
            ...entry.record,
            outcome: { ...entry.record.outcome, lastCheckpoint: stage },
            updatedAt: now.toISOString(),
          })
        },
      },
    }
    let abortGuard: { promise: Promise<never>, dispose(): void } | undefined
    try {
      await context.control.checkpoint("before-adapter-dispatch")
      await lifecycle?.before(context)
      if (entry.controller.signal.aborted) throw new RuntimeContractError("cancelled", "Operation отменена", "before-adapter-dispatch")
      entry.record = operationRecordSchema.parse({
        ...entry.record,
        state: "dispatching",
        updatedAt: this.#clock.now().toISOString(),
      })
      entry.adapterStarted = true
      abortGuard = this.#createAbortGuard(entry, context)
      const adapterPromise = Promise.resolve().then(() => execute(context, request))
      const rawResult = await Promise.race([adapterPromise, abortGuard.promise])
      const parsedResult = parseWireValue(adapterResultSchema(z.unknown()), rawResult) as AdapterResult<TResult>
      const verifiedNativeStatus = lifecycle === undefined
        ? await Promise.race([this.#verifyBackendCompletion(context, parsedResult), abortGuard.promise])
        : undefined
      const result: AdapterResult<TResult> = verifiedNativeStatus === undefined
        ? parsedResult
        : { ...parsedResult, nativeStatus: verifiedNativeStatus }
      const outcome = operationOutcomeSchema.parse(result.outcome)
      const state = result.ok
        ? "completed"
        : result.error.code === "cancelled" && outcome.cleanup.state === "complete"
          ? "cancelled"
          : "failed"
      const stagedRecord = operationRecordSchema.parse({
        ...entry.record,
        state,
        outcome,
        updatedAt: this.#clock.now().toISOString(),
        ...(!result.ok ? { error: result.error } : {}),
      })
      const commitLifecycle = lifecycle === undefined ? undefined
        : await Promise.race([lifecycle.stage(stagedRecord, result), abortGuard.promise])
      const confirmedCancellation = !result.ok
        && result.error.code === "cancelled"
        && outcome.cleanup.state === "complete"
      if (entry.settled || entry.controller.signal.aborted && !confirmedCancellation) {
        throw new RuntimeContractError(
          "operation-outcome-unknown",
          "Operation была отозвана до atomic cleanup commit",
          "runtime-finalize",
          { recoveryAction: "get-operation" },
        )
      }
      this.resources.applyCleanup(entry.record.context.operationId, handles, outcome.cleanup)
      commitLifecycle?.()
      const execution = { operation: stagedRecord, result }
      this.#settle(entry, execution)
      return execution
    } catch (error) {
      if (entry.result !== undefined) return entry.result as RuntimeExecution<TResult>
      lifecycle?.failed(entry.adapterStarted)
      const contractError = contractErrorFrom(error, "runtime-execute")
      if (!entry.adapterStarted) {
        const cleanup = releasedCleanup(handles)
        const outcome = operationOutcomeSchema.parse({
          ...entry.record.outcome,
          dispatch: "none",
          cleanup,
          restoration: "not-applicable",
        })
        const stagedRecord = operationRecordSchema.parse({
          ...entry.record,
          state: "rejected",
          outcome,
          error: contractError,
          updatedAt: this.#clock.now().toISOString(),
        })
        this.resources.applyCleanup(entry.record.context.operationId, handles, cleanup)
        const result: AdapterResult<TResult> = { ok: false, error: contractError, outcome }
        const execution = { operation: stagedRecord, result }
        this.#settle(entry, execution)
        return execution
      }
      const cleanup = this.resources.quarantine(entry.record.context.operationId)
      const outcome = operationOutcomeSchema.parse({
        ...entry.record.outcome,
        dispatch: entry.record.outcome.dispatch === "none" ? "unknown" : entry.record.outcome.dispatch,
        cleanup,
        restoration: "unknown",
      })
      const stagedRecord = operationRecordSchema.parse({
        ...entry.record,
        state: "interrupted-unknown",
        outcome,
        error: contractError,
        updatedAt: this.#clock.now().toISOString(),
      })
      const result: AdapterResult<TResult> = {
        ok: false,
        error: contractError,
        outcome,
        ...(entry.lastNativeStatus === undefined ? {} : { nativeStatus: entry.lastNativeStatus }),
      }
      const execution = { operation: stagedRecord, result }
      this.#settle(entry, execution)
      return execution
    } finally {
      abortGuard?.dispose()
    }
  }

  async #verifyBackendCompletion(
    context: RuntimeOperationContext,
    result: AdapterResult<unknown>,
  ): Promise<NativeOperationStatus | undefined> {
    if (context.resources.length === 0) return undefined
    if (context.wire.kind === "native") {
      if (result.nativeStatus !== undefined && !nativeStatusMatchesOperation(context.wire, result.nativeStatus)) {
        throw new Error("Adapter вернул foreign native status")
      }
      if (this.native === undefined) throw new Error("Native adapter отсутствует при native completion")
      let status: NativeOperationStatus
      try {
        status = await this.#queryNativeStatus(context.wire, "native-status-finalize")
      } catch {
        if (result.outcome.cleanup.state === "complete") throw new Error("Native complete cleanup не подтверждён runtime status query")
        return undefined
      }
      if (!nativeStatusMatchesOperation(context.wire, status)) throw new Error("Native status относится к другой operation/fence")
      if (result.outcome.cleanup.state === "complete" && (
        status.cleanup !== "complete"
        || status.heldCount !== 0
        || !["finished", "cancelled", "failed"].includes(status.execution)
      )) {
        throw new Error("Native status не подтверждает terminal cleanup")
      }
      if (result.outcome.cleanup.state !== "complete" && status.cleanup === "complete") {
        throw new Error("Adapter outcome теряет подтверждённый native cleanup")
      }
      return status
    }
    if (this.#completionVerifier === undefined) {
      throw new Error("Для non-native resource cleanup не зарегистрирован backend completion verifier")
    }
    await this.#completionVerifier.verify(context, result)
    return undefined
  }

  #createAbortGuard(
    entry: JournalEntry,
    context: RuntimeOperationContext,
  ): { promise: Promise<never>, dispose(): void } {
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let rejectPromise: ((error: Error) => void) | undefined
    const onAbort = () => {
      void this.#requestNativeStop(entry, context)
      graceTimer = setTimeout(() => {
        rejectPromise?.(new RuntimeContractError(
          "operation-outcome-unknown",
          "Adapter не подтвердил остановку за cancel grace period",
          "runtime-cancel-grace",
          { recoveryAction: "get-operation" },
        ))
      }, this.#cancelGraceMs)
    }
    const promise = new Promise<never>((_, reject) => {
      rejectPromise = reject
      if (entry.controller.signal.aborted) onAbort()
      else entry.controller.signal.addEventListener("abort", onAbort, { once: true })
    })
    return {
      promise,
      dispose: () => {
        entry.controller.signal.removeEventListener("abort", onAbort)
        if (graceTimer !== undefined) clearTimeout(graceTimer)
      },
    }
  }

  async #queryNativeStatus(
    operation: NativeExecutionContext,
    requestPrefix: string,
  ): Promise<NativeOperationStatus> {
    if (this.native === undefined) throw new Error("Native adapter отсутствует")
    const deadlineAt = new Date(this.#clock.now().getTime() + this.#cancelGraceMs).toISOString()
    const request = nativeStatusRequestSchema.parse({
      requestId: this.#ids.next(requestPrefix),
      operationId: operation.operationId,
      ...this.generation,
      nativeGeneration: operation.nativeGeneration,
      deadlineAt,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Native status query превысил bounded deadline")), this.#cancelGraceMs)
    })
    try {
      const status = await Promise.race([
        this.native.status(request, AbortSignal.timeout(this.#cancelGraceMs)),
        timeout,
      ])
      if (!nativeStatusMatchesRequest(request, status) || !nativeStatusMatchesOperation(operation, status)) {
        throw new Error("Native status response не коррелирует с runtime query/operation")
      }
      return status
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async #requestNativeStop(entry: JournalEntry, context: RuntimeOperationContext): Promise<void> {
    if (context.wire.kind !== "native" || this.native === undefined) return
    const deadlineAt = new Date(this.#clock.now().getTime() + this.#cancelGraceMs).toISOString()
    const request = nativeCancelRequestSchema.parse({
      requestId: this.#ids.next("native-cancel"),
      operationId: context.wire.operationId,
      ...this.generation,
      nativeGeneration: context.wire.nativeGeneration,
      deadlineAt,
      fence: context.wire.fence,
      reason: String(entry.controller.signal.reason ?? "runtime cancellation"),
    })
    const control = {
      signal: AbortSignal.timeout(this.#cancelGraceMs),
      checkpoint: () => undefined,
    }
    try {
      const ack = await this.native.cancel(request, control)
      if (!nativeCancelAckMatches(request, ack)) return
      const statusRequest = nativeStatusRequestSchema.parse({
        requestId: this.#ids.next("native-status"),
        operationId: context.wire.operationId,
        ...this.generation,
        nativeGeneration: context.wire.nativeGeneration,
        deadlineAt,
      })
      const status = await this.native.status(statusRequest, control.signal)
      if (nativeStatusMatchesRequest(statusRequest, status) && nativeStatusMatchesOperation(context.wire, status)) {
        entry.lastNativeStatus = status
      }
    } catch {
      return
    }
  }

  #settle<TResult>(entry: JournalEntry, execution: RuntimeExecution<TResult>): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.deadlineTimer !== undefined) clearTimeout(entry.deadlineTimer)
    entry.record = execution.operation
    entry.result = execution as RuntimeExecution<unknown>
  }

  #createWireContext(
    operationId: string,
    session: RuntimeClientSession,
    intent: RuntimeOperationIntent,
  ): SerializableOperationContext {
    const common = {
      operationId,
      clientRequestId: intent.clientRequestId,
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      ...this.generation,
      inventoryId: intent.precondition.inventoryId,
      inventoryRevision: intent.precondition.inventoryRevision,
      ...(intent.precondition.observationRef === undefined ? {} : { observationRef: intent.precondition.observationRef }),
      deadlineAt: intent.deadlineAt,
      target: intent.precondition.target,
    }
    switch (intent.precondition.target.kind) {
      case "application":
      case "window":
      case "surface":
      case "element":
      case "display":
      case "desktop-layout": {
        if (this.#nativeGeneration === undefined || this.native === undefined) {
          throw new RuntimeContractError("capability-unavailable", "Native adapter не подключён", "runtime-context")
        }
        return nativeExecutionContextSchema.parse({
          kind: "native",
          ...common,
          nativeGeneration: this.#nativeGeneration,
          fence: {
            ...this.generation,
            nativeGeneration: this.#nativeGeneration,
            counter: ++this.#fenceCounter,
          },
        })
      }
      case "browser-instance":
      case "browser-target":
        return browserExecutionContextSchema.parse({ kind: "browser", ...common })
      case "device":
      case "device-browser-instance":
      case "device-browser-target":
        return deviceExecutionContextSchema.parse({ kind: "device", ...common })
      case "clipboard":
        return clipboardExecutionContextSchema.parse({ kind: "clipboard", ...common })
    }
  }

  #assertIntentAuthority(session: RuntimeClientSession, intent: RuntimeOperationIntent, now: Date): void {
    const target = intent.precondition.target.ref
    if (
      target.runtimeEpoch !== session.runtimeEpoch
      || target.loginSessionId !== session.loginSessionId
    ) {
      throw new RuntimeContractError("target-stale", "Target принадлежит другой runtime/login generation", "runtime-admission")
    }
    if (now.getTime() >= Date.parse(intent.deadlineAt)) {
      throw new RuntimeContractError("deadline-exceeded", "Operation deadline уже истёк", "runtime-admission")
    }
  }

  #assertJournalAuthority(session: RuntimeClientSession, record: OperationRecord): void {
    const entry = this.#journal.get(record.context.operationId)
    if (
      entry === undefined
      || entry.lineageId !== this.clients.lineage(session)
      || record.principalId !== session.principalId
    ) {
      throw new RuntimeContractError("unauthorized", "Operation принадлежит другой client lineage", "runtime-journal")
    }
  }
}

function pendingOutcome(handles: RuntimeResourceHandle[]): OperationOutcome {
  return operationOutcomeSchema.parse({
    dispatch: "none",
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: handles.length === 0
      ? { scope: "none", state: "complete", resources: [] }
      : { scope: "owned", state: "pending", resources: handles.map(handle => ({ handle, outcome: "held" })) },
    restoration: "not-applicable",
    dispatchAttempts: 0,
  })
}

function releasedCleanup(handles: RuntimeResourceHandle[]) {
  return cleanupOutcomeSchema.parse(handles.length === 0
    ? { scope: "none", state: "complete", resources: [] }
    : {
        scope: "owned",
        state: "complete",
        resources: handles.map(handle => ({ handle, outcome: "released" })),
      })
}

function isTerminal(record: OperationRecord): boolean {
  return ["rejected", "completed", "cancelled", "failed", "interrupted-unknown"].includes(record.state)
}

function unavailableRuntimeCapabilities(producerRef: string): CapabilitySet {
  return capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef,
    capabilities: CAPABILITY_IDS.map(id => ({
      id,
      state: id === "runtime.identity" || id === "runtime.health" ? "ready" : "unavailable",
      ...(id === "runtime.identity" || id === "runtime.health" ? {} : { reason: "adapter/protocol не подтверждён" }),
    })),
  })
}
