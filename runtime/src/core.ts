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
  observationPublicationSchema,
  observationSchema,
  type Observation,
  type ObservationPublication,
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
import type { PersistentOperationJournal, StoredOperationEvidence } from "./storage/index.ts"
import type { StoredClientSession } from "./client-sessions.ts"

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
  durableRevision: number
  durableTail: Promise<void>
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
  operationJournal?: PersistentOperationJournal
  durableTimeoutMs?: number
  hmacKeyGeneration?: string
  clientPersistence?: { sessions: readonly StoredClientSession[], persist(sessions: readonly StoredClientSession[]): Promise<void> }
}

export type ReserveCapturePublicationRequest = Pick<ObservationPublication,
  "source" | "captureTarget" | "capturePolicySha256" | "inventoryId" | "inventoryRevision" | "displayLayoutRevision"
> & { clientRequestId: string, nativeGeneration?: string, ttlMs?: number }

export class RuntimeCore implements RuntimeAdapter {
  readonly generation: RuntimeGeneration
  #capabilities: CapabilitySet
  readonly #capabilityListeners = new Set<() => void>()
  readonly #admissionListeners = new Set<() => void>()
  #admissionSealed = false
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
  readonly #captureReservations = new Map<string, { digest: string, publication: ObservationPublication }>()
  readonly #observationOwners = new Map<string, string>()
  readonly #latestObservations = new Map<string, string>()
  readonly #cancelGraceMs: number
  readonly #completionVerifier?: BackendCompletionVerifier
  readonly #operationJournal?: PersistentOperationJournal
  readonly #durableTimeoutMs: number
  readonly #clientPersistence?: RuntimeCoreOptions["clientPersistence"]
  #credentialTail: Promise<void> = Promise.resolve()
  readonly #persistedSessions = new Set<string>()
  #storagePoisoned = false
  #storageInitialized: boolean
  #recoveryEvidence: StoredOperationEvidence[] = []
  readonly #startupRecoveryReasons: string[] = []
  #fenceCounter = 0

  constructor(options: RuntimeCoreOptions) {
    this.generation = options.generation
    this.#runtimeBuildId = options.runtimeBuildId
    this.#nativeGeneration = options.nativeGeneration
    this.native = options.native
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#secret = options.secret ?? crypto.getRandomValues(new Uint8Array(32))
    this.#hmacKeyGeneration = options.hmacKeyGeneration ?? this.#ids.next("hmac-key")
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000
    this.#completionVerifier = options.completionVerifier
    this.#operationJournal = options.operationJournal
    this.#clientPersistence = options.clientPersistence
    this.#durableTimeoutMs = options.durableTimeoutMs ?? 1000
    if (!Number.isSafeInteger(this.#durableTimeoutMs) || this.#durableTimeoutMs < 1 || this.#durableTimeoutMs > 10_000) throw new Error("Durable timeout вне bounds")
    this.#storageInitialized = options.operationJournal === undefined
    this.#capabilities = unavailableRuntimeCapabilities(this.#ids.next("runtime-capabilities"))
    this.clients = new ClientSessionRegistry(this.generation, { clock: this.#clock, ids: this.#ids })
    if (options.clientPersistence !== undefined) {
      this.clients.restore(options.clientPersistence.sessions)
      for (const stored of options.clientPersistence.sessions) this.#persistedSessions.add(stored.session.clientSessionId)
    }
    this.resources = new ResourceRegistry(this.generation, this.#secret, { clock: this.#clock, ids: this.#ids })
    this.browserLifetime = new BrowserLifetimeCoordinator({
      generation: this.generation,
      clients: this.clients,
      clock: this.#clock,
      ids: this.#ids,
      ttlMs: options.reservationTtlMs,
      lookup: id => this.#journal.get(id)?.record,
      stageRecovered: ids => this.#stageLifetimeRecovery(ids),
      run: (session, intent, request, execute, lifecycle, signal) => this.#runOperation(session, intent, request, execute, lifecycle, signal),
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
    if (this.#clientPersistence !== undefined) throw new Error("Durable host требует openClientDurable")
    return this.clients.open(principalId, ttlMs)
  }

  async openClientDurable(principalId: string, ttlMs?: number): Promise<RuntimeClientCredential> {
    return this.#persistCredential(() => this.clients.open(principalId, ttlMs))
  }

  async resumeClientDurable(resumptionToken: string, ttlMs?: number): Promise<RuntimeClientCredential> {
    return this.#persistCredential(() => {
      const lineage = this.clients.resumptionLineage(resumptionToken)
      if ([...this.#journal.values()].some(entry => !entry.settled && entry.lineageId === lineage)) throw new RuntimeContractError("operation-in-progress", "Client renewal ждёт завершения active operations", "runtime-client")
      return this.clients.resume(resumptionToken, ttlMs)
    })
  }

  async closeClientDurable(session: RuntimeClientSession): Promise<void> {
    await this.clients.assertActive(session, this.#clock.now())
    this.disconnectClient(session.clientSessionId)
    const pending = [...this.#journal.values()].filter(entry => entry.record.clientSessionId === session.clientSessionId && !entry.settled)
    await Promise.all(pending.map(entry => entry.promise?.catch(() => undefined)))
    if (this.#clientPersistence !== undefined) await this.#awaitDurable(this.#clientPersistence.persist(this.clients.snapshot()))
  }

  async #persistCredential(create: () => RuntimeClientCredential): Promise<RuntimeClientCredential> {
    if (this.#clientPersistence === undefined) return create()
    const persist = async () => {
      if (this.#storagePoisoned) throw new Error("Durable storage poisoned")
      const credential = create()
      try { await this.#awaitDurable(this.#clientPersistence!.persist(this.clients.snapshot())) }
      catch (error) { this.#storagePoisoned = true; this.quarantineStartup("Client credential persistence не подтверждена"); throw error }
      this.#persistedSessions.add(credential.session.clientSessionId)
      return credential
    }
    const pending = this.#credentialTail.then(persist, persist)
    this.#credentialTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  async reserveCapturePublication(session: RuntimeClientSession, request: ReserveCapturePublicationRequest): Promise<ObservationPublication> {
    await this.clients.assertActive(session, this.#clock.now())
    const lineage = this.clients.lineage(session)
    const key = canonicalJson([lineage, request.clientRequestId])
    const digest = hmacSha256(this.#secret, canonicalJson(request))
    const existing = this.#captureReservations.get(key)
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error("Capture clientRequestId содержит другую reservation")
      if (this.#clock.now().getTime() >= Date.parse(existing.publication.expiresAt)
        && await this.getOperationByRequest(session, request.clientRequestId) === undefined) throw new Error("Capture reservation receipt-expired")
      return structuredClone(existing.publication)
    }
    const ttlMs = request.ttlMs ?? 120_000
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) throw new Error("Capture TTL вне bounds")
    if (request.nativeGeneration !== undefined && request.nativeGeneration !== this.#nativeGeneration) throw new Error("Capture native generation stale")
    await this.targets.resolve({ target: request.captureTarget, inventoryId: request.inventoryId,
      inventoryRevision: request.inventoryRevision, ...this.generation,
      ...(request.nativeGeneration === undefined ? {} : { nativeGeneration: request.nativeGeneration }),
      deadlineAt: new Date(this.#clock.now().getTime() + 5000).toISOString() })
    const concurrent = this.#captureReservations.get(key)
    if (concurrent !== undefined) {
      if (concurrent.digest !== digest) throw new Error("Capture clientRequestId содержит другую reservation")
      return structuredClone(concurrent.publication)
    }
    const publication = observationPublicationSchema.parse({
      source: request.source, captureTarget: request.captureTarget, capturePolicySha256: request.capturePolicySha256,
      inventoryId: request.inventoryId, inventoryRevision: request.inventoryRevision, displayLayoutRevision: request.displayLayoutRevision,
      ...this.generation, ...(request.nativeGeneration === undefined ? {} : { nativeGeneration: request.nativeGeneration }),
      observationId: this.#ids.next("observation"), frameRef: this.#ids.next("frame"), cacheScopeRef: lineage,
      expiresAt: new Date(this.#clock.now().getTime() + ttlMs).toISOString(),
    })
    this.frames.registerPublication(publication)
    this.#captureReservations.set(key, { digest, publication })
    return structuredClone(publication)
  }

  async commitCaptureObservation(session: RuntimeClientSession, publication: ObservationPublication, value: Observation): Promise<Observation> {
    await this.clients.assertActive(session, this.#clock.now())
    const lineage = this.clients.lineage(session)
    const reserved = [...this.#captureReservations.values()].some(item => canonicalJson(item.publication) === canonicalJson(publication))
    const observation = observationSchema.parse(value)
    const operation = [...this.#journal.values()].find(entry => entry.lineageId === lineage
      && entry.record.state === "completed" && entry.record.resources.some(handle => handle.kind === "capture-stream" && handle.resourceRef === publication.observationId))
    if (!reserved || operation === undefined || publication.cacheScopeRef !== lineage
      || observation.observationId !== publication.observationId || observation.image.frameRef !== publication.frameRef
      || observation.runtimeEpoch !== publication.runtimeEpoch || observation.loginSessionId !== publication.loginSessionId
      || observation.nativeGeneration !== publication.nativeGeneration || observation.source !== publication.source
      || Date.parse(observation.expiresAt) > Date.parse(publication.expiresAt)
      || this.#clock.now().getTime() >= Date.parse(publication.expiresAt)
      || observation.inventoryRevision !== publication.inventoryRevision || observation.displayLayoutRevision !== publication.displayLayoutRevision
      || canonicalJson(observation.captureTarget) !== canonicalJson(publication.captureTarget)
      || !this.frames.hasVerified(publication.frameRef, observation.image.sha256)
      || observation.captureEvidence.state !== "confirmed" || !this.proofs.hasIssued(observation.captureEvidence.proof)) {
      throw new Error("Capture commit не подтверждён operation/reservation/bytes/proof authority")
    }
    const committed = this.observations.register(observation)
    this.#observationOwners.set(committed.observationId, lineage)
    this.#latestObservations.set(lineage, committed.observationId)
    return committed
  }

  async getObservation(session: RuntimeClientSession, observationId?: string): Promise<Observation | undefined> {
    await this.clients.assertActive(session, this.#clock.now())
    const lineage = this.clients.lineage(session)
    const id = observationId ?? this.#latestObservations.get(lineage)
    if (id === undefined) return undefined
    if (this.#observationOwners.get(id) !== lineage) throw new Error("Observation принадлежит другой client lineage")
    return this.observations.get(id)
  }

  get capabilities(): CapabilitySet { return structuredClone(this.#capabilities) }

  updateCapabilities(value: CapabilitySet): void {
    this.#capabilities = capabilitySetSchema.parse(value)
    for (const listener of this.#capabilityListeners) listener()
  }

  subscribeCapabilities(listener: () => void): () => void {
    this.#capabilityListeners.add(listener)
    return () => { this.#capabilityListeners.delete(listener) }
  }

  get admissionSealed(): boolean { return this.#admissionSealed }

  async initializeRecovery(): Promise<readonly StoredOperationEvidence[]> {
    if (this.#operationJournal === undefined) return []
    if (this.#storageInitialized) return structuredClone(this.#recoveryEvidence)
    this.sealAdmission()
    this.#recoveryEvidence = await this.#operationJournal.loadRecoveryEvidence()
    if (this.#clientPersistence !== undefined && this.#operationJournal.loadAll !== undefined) {
      for (const { record, revision } of await this.#operationJournal.loadAll()) {
        const lineageId = this.clients.historicalLineage(record.clientSessionId, record.principalId)
        if (lineageId === undefined || record.context.loginSessionId !== this.generation.loginSessionId) continue
        const dedupKey = canonicalJson([this.generation.runtimeEpoch, lineageId, record.context.clientRequestId])
        const previous = this.#dedup.get(dedupKey)
        if (previous !== undefined && previous !== record.context.operationId) throw new Error("Historical journal содержит duplicate lineage/request")
        this.#journal.set(record.context.operationId, {
          record, digest: record.payloadReceipt.hmacSha256, lineageId, durableRevision: revision,
          durableTail: Promise.resolve(), controller: new AbortController(), settled: true, adapterStarted: record.outcome.dispatch !== "none",
        })
        this.#dedup.set(dedupKey, record.context.operationId)
      }
    }
    this.#storageInitialized = true
    if (this.#recoveryEvidence.length === 0) this.unsealAdmission()
    return structuredClone(this.#recoveryEvidence)
  }

  recoveryEvidence(): readonly StoredOperationEvidence[] { return structuredClone(this.#recoveryEvidence) }

  quarantineStartup(reason: string): void {
    this.#startupRecoveryReasons.push(reason)
    this.sealAdmission()
  }

  startupRecoveryReasons(): readonly string[] { return [...this.#startupRecoveryReasons] }

  sealAdmission(): void {
    if (this.#admissionSealed) return
    this.#admissionSealed = true
    for (const listener of this.#admissionListeners) listener()
  }

  unsealAdmission(): void {
    if (!this.#admissionSealed) return
    if (this.#storagePoisoned || !this.#storageInitialized || this.#recoveryEvidence.length > 0 || this.#startupRecoveryReasons.length > 0 || this.activeOperationCount() !== 0 || this.resources.quarantinedCount() !== 0) throw new Error("Runtime admission нельзя открыть при active/unknown operations")
    this.#admissionSealed = false
    for (const listener of this.#admissionListeners) listener()
  }

  subscribeAdmission(listener: () => void): () => void {
    this.#admissionListeners.add(listener)
    return () => { this.#admissionListeners.delete(listener) }
  }

  async drainOperations(): Promise<void> {
    this.sealAdmission()
    const active = [...this.#journal.values()].filter(entry => !entry.settled)
    for (const entry of active) entry.controller.abort("runtime drain")
    await Promise.all(active.map(entry => entry.promise?.catch(() => undefined)))
    if (this.resources.quarantinedCount() > 0 || this.activeOperationCount() > 0) throw new Error("Runtime drain оставил unknown/active operations")
  }

  async runOperation<TRequest, TResult>(
    session: RuntimeClientSession,
    intentValue: RuntimeOperationIntent,
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
    signal?: AbortSignal,
  ): Promise<RuntimeExecution<TResult>> {
    return this.#runOperation(session, intentValue, request, execute, undefined, signal)
  }

  async #runOperation<TRequest, TResult>(
    session: RuntimeClientSession,
    intentValue: RuntimeOperationIntent,
    request: TRequest,
    execute: (context: RuntimeOperationContext, request: TRequest) => Promise<AdapterResult<TResult>>,
    lifecycle?: CoordinatedLifecycle,
    signal?: AbortSignal,
  ): Promise<RuntimeExecution<TResult>> {
    const now = this.#clock.now()
    await this.clients.assertActive(session, now)
    if (this.#clientPersistence !== undefined && !this.#persistedSessions.has(session.clientSessionId)) throw new Error("Client session не подтверждена durable storage")
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
      throw new RuntimeContractError("receipt-expired", "Сохранён только operation receipt; действие не повторяется", "runtime-dedup", {
        recoveryAction: "get-operation", context: { operationId: previousOperationId },
      })
    }

    this.#assertIntentAuthority(session, intent, now)
    if (!this.#storageInitialized) throw new RuntimeContractError("capability-unavailable", "Runtime durable recovery не инициализирована", "runtime-admission")
    if (this.#admissionSealed) throw new RuntimeContractError("capability-unavailable", "Runtime admission sealed", "runtime-admission")
    if (signal?.aborted) throw new RuntimeContractError("cancelled", "Operation отменена до admission", "runtime-admission")
    if (lifecycle?.admission !== "stored-cleanup") {
      await this.targets.resolve({
        target: intent.precondition.target,
        inventoryId: intent.precondition.inventoryId,
        inventoryRevision: intent.precondition.inventoryRevision,
        runtimeEpoch: session.runtimeEpoch,
        loginSessionId: session.loginSessionId,
        ...(this.#nativeGeneration === undefined ? {} : { nativeGeneration: this.#nativeGeneration }),
        deadlineAt: intent.deadlineAt,
      })
    }

    const operationId = this.#ids.next("operation")
    const wire = this.#createWireContext(operationId, session, intent)
    const resourceExpiry = new Date(Math.min(Date.parse(intent.deadlineAt), now.getTime() + 120_000)).toISOString()
    const handles = this.resources.acquire(session, operationId, intent.requestedResources, resourceExpiry)
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(signal?.reason ?? "caller cancellation")
    signal?.addEventListener("abort", abortFromCaller, { once: true })
    if (signal?.aborted) abortFromCaller()
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
      durableRevision: 0,
      durableTail: Promise.resolve(),
    }
    this.#journal.set(operationId, entry)
    this.#dedup.set(dedupKey, operationId)
    const deadlineDelay = Math.max(0, Date.parse(intent.deadlineAt) - this.#clock.now().getTime())
    entry.deadlineTimer = setTimeout(() => controller.abort("operation deadline exceeded"), deadlineDelay)
    const promise = this.#execute(entry, session, handles, request, execute, lifecycle)
    entry.promise = promise as Promise<RuntimeExecution<unknown>>
    try { return await promise }
    finally { signal?.removeEventListener("abort", abortFromCaller) }
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
    if (entry.record.context.runtimeEpoch !== this.generation.runtimeEpoch) return entry.record
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
    const cleanupStage = this.resources.prepareCleanup(report.operationId, entry.record.resources, report.cleanup, "quarantined")
    if (cleanupStage.receipt === undefined) throw new Error("Reconciliation requires complete cleanup receipt")
    await this.#persist(entry, stagedRecord, cleanupStage.receipt)
    cleanupStage.commit()
    const receipt = cleanupStage.receipt
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
    return [...this.#journal.values()].filter(entry => !entry.settled).length
  }

  async #stageLifetimeRecovery(operationIds: readonly string[]): Promise<() => void> {
    const staged = operationIds.flatMap(id => {
      const entry = this.#journal.get(id)
      if (entry === undefined || !entry.settled) throw new Error("Recovery journal entry отсутствует или active")
      if (entry.record.outcome.cleanup.state === "complete") return []
      const handles = entry.record.resources
      for (const handle of handles) {
        const current = this.resources.handleByLeaseId(handle.leaseId)
        if (current === undefined || current.operationId !== id || current.leaseGeneration !== handle.leaseGeneration
          || current.state !== "quarantined") throw new Error("Recovery resource generation не совпадает")
      }
      const cleanup = releasedCleanup(handles)
      const record = operationRecordSchema.parse({
        ...entry.record,
        outcome: { ...entry.record.outcome, cleanup },
        updatedAt: this.#clock.now().toISOString(),
      })
      const prepared = this.resources.prepareCleanup(id, handles, cleanup, "quarantined")
      return [{ entry, record, prepared }]
    })
    for (const { entry, record, prepared } of staged) await this.#persist(entry, record, prepared.receipt)
    return () => {
      for (const { entry, record, prepared } of staged) {
        prepared.commit()
        entry.record = record
        if (entry.result !== undefined) entry.result = {
          operation: record,
          result: { ...entry.result.result, outcome: record.outcome },
        }
      }
    }
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
      await this.#persist(entry, entry.record)
      await context.control.checkpoint("before-adapter-dispatch")
      if (this.#admissionSealed) throw new RuntimeContractError("capability-unavailable", "Runtime admission sealed", "runtime-admission")
      await lifecycle?.before(context)
      if (entry.controller.signal.aborted) throw new RuntimeContractError("cancelled", "Operation отменена", "before-adapter-dispatch")
      entry.record = operationRecordSchema.parse({
        ...entry.record,
        state: "dispatching",
        updatedAt: this.#clock.now().toISOString(),
      })
      await this.#persist(entry, entry.record)
      if (this.#admissionSealed || entry.controller.signal.aborted) throw new RuntimeContractError("cancelled", "Admission отменена до durable dispatch", "runtime-dispatch")
      entry.adapterStarted = true
      abortGuard = this.#createAbortGuard(entry, context)
      const adapterPromise = Promise.resolve().then(() => execute(context, request))
      const rawResult = await Promise.race([adapterPromise, abortGuard.promise])
      const parsedResult = parseWireValue(adapterResultSchema(z.unknown()), rawResult, {
        maxDepth: 32, maxBytes: context.wire.kind === "clipboard" ? 8 * 1024 * 1024 : 1024 * 1024,
      }) as AdapterResult<TResult>
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
      const stagedCleanup = this.resources.prepareCleanup(entry.record.context.operationId, handles, outcome.cleanup)
      await Promise.race([this.#persist(entry, stagedRecord, stagedCleanup.receipt), abortGuard.promise])
      if (entry.settled || entry.controller.signal.aborted && !confirmedCancellation) throw new Error("Runtime finalize cancelled during durable write")
      stagedCleanup.commit()
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
          state: entry.record.state === "registered" ? "rejected" : "failed",
          outcome,
          error: contractError,
          updatedAt: this.#clock.now().toISOString(),
        })
        const stagedCleanup = this.resources.prepareCleanup(entry.record.context.operationId, handles, cleanup)
        try { await this.#persist(entry, stagedRecord, stagedCleanup.receipt) }
        catch { this.sealAdmission() }
        stagedCleanup.commit()
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
      try { await this.#persist(entry, stagedRecord) }
      catch { this.sealAdmission() }
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

  async #persist(entry: JournalEntry, record: OperationRecord, cleanupReceipt?: CleanupAuthorityReceipt): Promise<void> {
    if (this.#operationJournal === undefined) return
    if (this.#storagePoisoned) throw new Error("Durable storage poisoned после unresolved write")
    const snapshot = structuredClone(record)
    const revision = ++entry.durableRevision
    const store = this.#operationJournal
    const write = async () => {
      if (this.#storagePoisoned) throw new Error("Durable storage poisoned до queued write")
      try { await store.persist(snapshot, revision, cleanupReceipt === undefined ? {} : { cleanupReceipt }) }
      catch (error) {
        if (this.#storagePoisoned) throw error
        await store.persist(snapshot, revision, cleanupReceipt === undefined ? {} : { cleanupReceipt })
      }
    }
    const pending = entry.durableTail.then(write, write)
    entry.durableTail = pending.catch(() => undefined)
    await this.#awaitDurable(pending)
  }

  async #awaitDurable(pending: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.#storagePoisoned = true
          this.quarantineStartup("Durable write deadline: позднее подтверждение не открывает admission")
          reject(new Error("Durable write deadline"))
        }, this.#durableTimeoutMs)
      })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
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
      case "application-bundle":
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
