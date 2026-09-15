import {
  authorizeObservationPoint,
  evidenceReportMatchesReceipt,
  interactionPointProofSchema,
  nativeEvidenceReportSchema,
  observationSchema,
  observationPublicationSchema,
  proofRefSchema,
  verifiedNativeEvidenceReceiptSchema,
  type AuthorizedObservationPoint,
  type BinaryFramePublisher,
  type BoundNativeEvidencePublisher,
  type EvidenceIssuer,
  type NativeGeneration,
  type NativeEvidenceReport,
  type NativeTargetMapping,
  type ObservationAuthorityContext,
  type Observation,
  type ObservationResolver,
  type ResolveObservationPointRequest,
  type ResolveStoredObservationPointRequest,
  type ObservationPublication,
  type OperationTarget,
  type ProofAuthority,
  type ProofRef,
  type RuntimeGeneration,
  type TargetAuthority,
  type TargetResolution,
  type TargetResolutionRequest,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import { canonicalJson, randomIdSource, sha256, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

type RegisteredTarget = {
  resolution: TargetResolution
  inventoryId: string
  inventoryRevision: number
  expiresAt: number
  scope: string
}

export class TargetRegistry implements TargetAuthority {
  readonly #generation: RuntimeGeneration
  readonly #clock: RuntimeClock
  readonly #maxAgeMs: number
  readonly #targets = new Map<string, RegisteredTarget>()
  readonly #inventoryHighWater = new Map<string, { inventoryId: string, revision: number }>()

  constructor(
    generation: RuntimeGeneration,
    options: { clock?: RuntimeClock, maxAgeMs?: number } = {},
  ) {
    this.#generation = generation
    this.#clock = options.clock ?? systemClock
    this.#maxAgeMs = options.maxAgeMs ?? 5_000
  }

  register(
    target: OperationTarget,
    inventoryId: string,
    inventoryRevision: number,
    resolutionId: string,
    proofRef: string,
    displayLayoutRevision: number,
    nativeMapping?: TargetResolution["nativeMapping"],
    maxAgeMs = this.#maxAgeMs,
  ): void {
    if (
      target.ref.runtimeEpoch !== this.#generation.runtimeEpoch
      || target.ref.loginSessionId !== this.#generation.loginSessionId
    ) {
      throw new Error("Target принадлежит другой runtime generation")
    }
    const scope = targetAuthorityScope(target)
    const highWater = this.#inventoryHighWater.get(scope)
    if (highWater !== undefined && inventoryRevision < highWater.revision) {
      throw new Error("Target registration stale: revision ниже authority high-water")
    }
    if (highWater !== undefined && inventoryRevision === highWater.revision && inventoryId !== highWater.inventoryId) {
      throw new Error("Target registration conflicting: equal revision имеет другой inventoryId")
    }
    if (highWater === undefined || inventoryRevision > highWater.revision) {
      for (const [key, registered] of this.#targets) {
        if (registered.scope === scope) this.#targets.delete(key)
      }
      this.#inventoryHighWater.set(scope, { inventoryId, revision: inventoryRevision })
    }
    const resolution: TargetResolution = {
      target,
      resolutionId,
      proofRef,
      inventoryId,
      inventoryRevision,
      displayLayoutRevision,
      ...("nativeGeneration" in target.ref ? { nativeGeneration: target.ref.nativeGeneration } : {}),
      ...(nativeMapping === undefined ? {} : { nativeMapping }),
    }
    const existing = this.#targets.get(targetKey(target))
    if (existing !== undefined && canonicalJson(existing.resolution) !== canonicalJson(resolution)) {
      throw new Error("Target registration conflicting: same target/snapshot имеет другой resolution")
    }
    this.#targets.set(targetKey(target), {
      inventoryId,
      inventoryRevision,
      expiresAt: this.#clock.now().getTime() + maxAgeMs,
      scope,
      resolution,
    })
  }

  async resolve(request: TargetResolutionRequest): Promise<TargetResolution> {
    const now = this.#clock.now().getTime()
    if (
      request.runtimeEpoch !== this.#generation.runtimeEpoch
      || request.loginSessionId !== this.#generation.loginSessionId
    ) {
      throw new Error("Target request принадлежит другой runtime generation")
    }
    const registered = this.#targets.get(targetKey(request.target))
    if (registered === undefined) throw new Error("Target не зарегистрирован runtime")
    if (
      registered.inventoryId !== request.inventoryId
      || registered.inventoryRevision !== request.inventoryRevision
      || now >= registered.expiresAt
      || now >= Date.parse(request.deadlineAt)
      || canonicalJson(registered.resolution.target) !== canonicalJson(request.target)
    ) {
      throw new Error("Target stale или относится к другой inventory")
    }
    if (request.nativeGeneration !== undefined && "nativeGeneration" in request.target.ref) {
      if (request.target.ref.nativeGeneration !== request.nativeGeneration) throw new Error("Target относится к другой native generation")
    }
    return structuredClone(registered.resolution)
  }

  remove(target: OperationTarget): void {
    this.#targets.delete(targetKey(target))
  }
}

export class ProofRegistry implements ProofAuthority {
  readonly #runtime: RuntimeGeneration
  readonly #nativeGeneration?: string
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #proofs = new Map<string, ProofRef>()

  constructor(
    generation: RuntimeGeneration,
    options: { nativeGeneration?: string, clock?: RuntimeClock, ids?: RuntimeIdSource } = {},
  ) {
    this.#runtime = generation
    this.#nativeGeneration = options.nativeGeneration
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  issue(input: {
    kind: ProofRef["kind"]
    subject: OperationTarget
    inventoryRevision: number
    displayLayoutRevision: number
    ttlMs: number
  }): ProofRef {
    const issuedAt = this.#clock.now()
    const proof = proofRefSchema.parse({
      proofRef: this.#ids.next("proof"),
      authorityRef: "proof-authority:runtime",
      kind: input.kind,
      subject: input.subject,
      ...this.#runtime,
      ...(this.#nativeGeneration === undefined ? {} : { nativeGeneration: this.#nativeGeneration }),
      inventoryRevision: input.inventoryRevision,
      displayLayoutRevision: input.displayLayoutRevision,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
    })
    this.#proofs.set(proof.proofRef, proof)
    return proof
  }

  async assertValid(proof: ProofRef, context: ObservationAuthorityContext): Promise<void> {
    const stored = this.#proofs.get(proof.proofRef)
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(proof)) throw new Error("Proof не выдан runtime authority")
    if (
      proof.runtimeEpoch !== context.runtimeEpoch
      || proof.loginSessionId !== context.loginSessionId
      || proof.inventoryRevision !== context.inventoryRevision
      || proof.displayLayoutRevision !== context.displayLayoutRevision
      || context.now.getTime() >= Date.parse(proof.expiresAt)
    ) {
      throw new Error("Proof stale или относится к другой authority context")
    }
    const subjectNativeGeneration = "nativeGeneration" in proof.subject.ref
      ? proof.subject.ref.nativeGeneration
      : undefined
    const requiredNativeGeneration = proof.nativeGeneration ?? subjectNativeGeneration
    if (
      requiredNativeGeneration !== undefined
      && (context.nativeGeneration === undefined || context.nativeGeneration !== requiredNativeGeneration)
    ) {
      throw new Error("Native-bound proof требует exact native generation в authority context")
    }
  }
}

export type NativeEvidenceBinding = {
  adapterInstanceRef: string
  backendBuildId: string
  nativeGeneration: string
}

type PublishedEvidence = {
  binding: NativeEvidenceBinding
  report: NativeEvidenceReport
  receipt: VerifiedNativeEvidenceReceipt
}

export type NativeEvidenceSourceExtractor = (bytes: Uint8Array) => readonly NativeEvidenceReport[]

type RegisteredSourceResponse = {
  sha256: string
  facts: readonly NativeEvidenceReport[]
}

export class NativeEvidenceAuthority implements EvidenceIssuer {
  readonly #generation: RuntimeGeneration
  readonly #proofs: ProofRegistry
  readonly #targets: TargetRegistry
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #validateBinding: (binding: NativeEvidenceBinding) => boolean
  readonly #responses = new Map<string, RegisteredSourceResponse>()
  readonly #extractors = new Map<string, {
    binding: NativeEvidenceBinding
    extract: NativeEvidenceSourceExtractor
  }>()
  readonly #published = new Map<string, PublishedEvidence>()
  #observations: ObservationRegistry | undefined
  #frames: FrameStore | undefined

  constructor(
    generation: RuntimeGeneration,
    proofs: ProofRegistry,
    targets: TargetRegistry,
    options: {
      clock?: RuntimeClock
      ids?: RuntimeIdSource
      validateBinding?: (binding: NativeEvidenceBinding) => boolean
    } = {},
  ) {
    this.#generation = generation
    this.#proofs = proofs
    this.#targets = targets
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#validateBinding = options.validateBinding ?? (() => false)
  }

  attachObservations(observations: ObservationRegistry): void {
    if (this.#observations !== undefined) throw new Error("Observation registry уже attached")
    this.#observations = observations
  }

  attachFrames(frames: FrameStore): void {
    if (this.#frames !== undefined) throw new Error("Frame store уже attached")
    this.#frames = frames
  }

  registerSourceExtractor(binding: NativeEvidenceBinding, extract: NativeEvidenceSourceExtractor): void {
    if (!this.#validateBinding(binding)) throw new Error("Native evidence binding не соответствует configured/handshaken source")
    const existing = this.#extractors.get(binding.adapterInstanceRef)
    if (existing !== undefined) {
      if (canonicalJson(existing.binding) === canonicalJson(binding) && existing.extract === extract) return
      throw new Error("Native evidence adapter binding/extractor immutable conflict")
    }
    this.#extractors.set(binding.adapterInstanceRef, { binding: structuredClone(binding), extract })
  }

  registerSourceResponse(binding: NativeEvidenceBinding, sourceResponseRef: string, bytes: Uint8Array): void {
    const registered = this.#extractors.get(binding.adapterInstanceRef)
    if (registered === undefined || canonicalJson(registered.binding) !== canonicalJson(binding)) {
      throw new Error("Native source extractor не зарегистрирован для exact adapter binding")
    }
    const extracted = registered.extract(bytes).map(value => nativeEvidenceReportSchema.parse(value))
    const facts = extracted.filter(fact => fact.sourceResponseRef === sourceResponseRef)
    if (facts.length === 0) return
    const key = responseKey(binding.adapterInstanceRef, sourceResponseRef)
    const value = {
      sha256: sha256(bytes),
      facts,
    }
    const existing = this.#responses.get(key)
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(value)) return
      throw new Error("Native source response identity immutable conflict")
    }
    this.#responses.set(key, value)
  }

  bind(binding: NativeEvidenceBinding): BoundNativeEvidencePublisher {
    if (binding.nativeGeneration.length === 0 || binding.backendBuildId.length === 0) {
      throw new Error("Native evidence binding не содержит build/generation")
    }
    const registered = this.#extractors.get(binding.adapterInstanceRef)
    if (registered === undefined || canonicalJson(registered.binding) !== canonicalJson(binding)) {
      throw new Error("Native evidence publisher не имеет registered source extractor")
    }
    return {
      publish: report => this.#publish(binding, report),
    }
  }

  async issueTargetResolution(request: {
    receipt: VerifiedNativeEvidenceReceipt
    target: Parameters<EvidenceIssuer["issueTargetResolution"]>[0]["target"]
    nativeMapping?: NativeTargetMapping
  }): Promise<ProofRef> {
    if (request.nativeMapping?.kind === "window") {
      throw new Error("Window CG/AX mapping требует issueWindowCorrelation")
    }
    const published = this.#assertReceipt(request.receipt,
      request.nativeMapping === undefined ? "native-target-identity" : "target-resolution")
    if (
      (published.report.factKind !== "target-resolution" && published.report.factKind !== "native-target-identity")
      || canonicalJson(published.report.target) !== canonicalJson(request.target)
      || (published.report.factKind === "target-resolution"
        && canonicalJson(published.report.mapping) !== canonicalJson(request.nativeMapping))
    ) {
      throw new Error("Target resolution request не совпадает с verified native facts")
    }
    const proof = this.#proofs.issue({
      kind: "target-resolution",
      subject: request.target,
      inventoryRevision: request.receipt.inventoryRevision,
      displayLayoutRevision: request.receipt.displayLayoutRevision,
      ttlMs: 60_000,
    })
    this.#targets.register(
      request.target,
      request.receipt.inventoryId,
      request.receipt.inventoryRevision,
      request.receipt.evidenceReceiptId,
      proof.proofRef,
      request.receipt.displayLayoutRevision,
      request.nativeMapping,
    )
    return proof
  }

  async issueWindowCorrelation(request: Parameters<EvidenceIssuer["issueWindowCorrelation"]>[0]): Promise<ProofRef> {
    const published = this.#assertReceipt(request.receipt, "window-cg-ax-correlation")
    if (
      published.report.factKind !== "window-cg-ax-correlation"
      || canonicalJson(published.report.target) !== canonicalJson(request.target)
      || canonicalJson(published.report.mapping) !== canonicalJson(request.nativeMapping)
    ) {
      throw new Error("Window correlation request не совпадает с verified AX/CG facts")
    }
    const proof = this.#proofs.issue({
      kind: "cg-ax-correlation",
      subject: request.target,
      inventoryRevision: request.receipt.inventoryRevision,
      displayLayoutRevision: request.receipt.displayLayoutRevision,
      ttlMs: 60_000,
    })
    this.#targets.register(
      request.target,
      request.receipt.inventoryId,
      request.receipt.inventoryRevision,
      request.receipt.evidenceReceiptId,
      proof.proofRef,
      request.receipt.displayLayoutRevision,
      request.nativeMapping,
    )
    return proof
  }

  async issueFrameFreshness(request: Parameters<EvidenceIssuer["issueFrameFreshness"]>[0]): Promise<ProofRef> {
    const published = this.#assertReceipt(request.receipt, "frame")
    if (
      published.report.factKind !== "frame"
      || published.report.observationId !== request.observationId
      || published.report.frameRef !== request.frameRef
      || published.report.frameSha256 !== request.frameSha256
      || canonicalJson(published.report.captureTarget) !== canonicalJson(request.captureTarget)
      || this.#frames?.hasVerified(request.frameRef, request.frameSha256) !== true
    ) {
      throw new Error("Frame freshness request не совпадает с verified frame facts/bytes")
    }
    return this.#proofs.issue({
      kind: "frame-freshness",
      subject: request.captureTarget,
      inventoryRevision: request.receipt.inventoryRevision,
      displayLayoutRevision: request.receipt.displayLayoutRevision,
      ttlMs: 10_000,
    })
  }

  async issueInteractionPoint(request: Parameters<EvidenceIssuer["issueInteractionPoint"]>[0]) {
    const published = this.#assertReceipt(request.receipt, "point-hit")
    if (
      published.report.factKind !== "point-hit"
      || published.report.observationId !== request.observationRef.observationId
      || canonicalJson(published.report.interactionTarget) !== canonicalJson(request.interactionTarget)
      || canonicalJson(published.report.imagePoint) !== canonicalJson(request.imagePoint)
      || published.report.expectedSpace !== request.expectedSpace
      || published.report.inventoryRevision !== request.operation.inventoryRevision
    ) {
      throw new Error("Interaction point request не совпадает с verified native facts")
    }
    const observation = this.#observations?.get(request.observationRef.observationId)
    if (observation === undefined || observation.image.frameRef !== published.report.frameRef) {
      throw new Error("Point evidence не связано со stored observation/frame")
    }
    const region = observation.regions[published.report.regionIndex]
    if (region === undefined || region.space.kind !== request.expectedSpace) throw new Error("Point evidence содержит foreign region/space")
    const proof = this.#proofs.issue({
      kind: "pixel-ownership",
      subject: request.interactionTarget,
      inventoryRevision: request.receipt.inventoryRevision,
      displayLayoutRevision: request.receipt.displayLayoutRevision,
      ttlMs: 5_000,
    })
    return interactionPointProofSchema.parse({
      proof,
      observationId: observation.observationId,
      frameRef: observation.image.frameRef,
      regionIndex: published.report.regionIndex,
      space: region.space,
      coverage: { kind: "point", point: request.imagePoint, tolerancePx: 0 },
    })
  }

  findPointReceipt(request: ResolveStoredObservationPointRequest): VerifiedNativeEvidenceReceipt {
    for (const published of this.#published.values()) {
      const report = published.report
      if (
        report.factKind === "point-hit"
        && report.observationId === request.observationRef.observationId
        && report.frameRef === this.#observations?.get(request.observationRef.observationId)?.image.frameRef
        && canonicalJson(report.interactionTarget) === canonicalJson(request.interactionTarget)
        && canonicalJson(report.imagePoint) === canonicalJson(request.imagePoint)
        && report.expectedSpace === request.expectedSpace
      ) {
        return published.receipt
      }
    }
    throw new Error("Нет verified native point evidence для запроса")
  }

  verifiedReport(
    receipt: VerifiedNativeEvidenceReceipt,
    factKind: VerifiedNativeEvidenceReceipt["factKind"],
  ): NativeEvidenceReport {
    return structuredClone(this.#assertReceipt(receipt, factKind).report)
  }

  async #publish(
    binding: NativeEvidenceBinding,
    value: NativeEvidenceReport,
  ): Promise<VerifiedNativeEvidenceReceipt> {
    const report = nativeEvidenceReportSchema.parse(value)
    const sourceResponse = this.#responses.get(responseKey(binding.adapterInstanceRef, report.sourceResponseRef))
    if (sourceResponse === undefined) throw new Error("Native source response не зарегистрирован runtime")
    if (!sourceResponse.facts.some(fact => canonicalJson(fact) === canonicalJson(report))) {
      throw new Error("Native evidence report не совпадает с normalized facts raw response")
    }
    const issuedAt = this.#clock.now().toISOString()
    const receipt = verifiedNativeEvidenceReceiptSchema.parse({
      evidenceReceiptId: this.#ids.next("native-evidence"),
      adapterInstanceRef: binding.adapterInstanceRef,
      backendBuildId: binding.backendBuildId,
      ...this.#generation,
      nativeGeneration: binding.nativeGeneration,
      sourceResponseRef: report.sourceResponseRef,
      sourceResponseSha256: sourceResponse.sha256,
      inventoryId: report.inventoryId,
      inventoryRevision: report.inventoryRevision,
      displayLayoutRevision: report.displayLayoutRevision,
      observedAt: report.observedAt,
      factKind: report.factKind,
      factSha256: sha256(canonicalJson(report)),
      issuedAt,
    })
    this.#published.set(receipt.evidenceReceiptId, { binding, report, receipt })
    return receipt
  }

  #assertReceipt(receipt: VerifiedNativeEvidenceReceipt, factKind: VerifiedNativeEvidenceReceipt["factKind"]): PublishedEvidence {
    const parsed = verifiedNativeEvidenceReceiptSchema.parse(receipt)
    const published = this.#published.get(parsed.evidenceReceiptId)
    if (
      published === undefined
      || canonicalJson(published.receipt) !== canonicalJson(parsed)
      || parsed.factKind !== factKind
      || !evidenceReportMatchesReceipt(published.report, parsed)
      || parsed.factSha256 !== sha256(canonicalJson(published.report))
    ) {
      throw new Error("Evidence receipt не подтверждён runtime issuer")
    }
    return published
  }
}

type StoredFrame = {
  publication: ObservationPublication
  bytes: Uint8Array
  sha256: string
  createdAt: number
}

export class FrameStore implements BinaryFramePublisher {
  readonly #generation: RuntimeGeneration
  readonly #clock: RuntimeClock
  readonly #publications = new Map<string, ObservationPublication>()
  readonly #publicationsByFrame = new Map<string, ObservationPublication>()
  readonly #frames = new Map<string, StoredFrame>()
  readonly #maxFramesPerScope: number
  readonly #ttlMs: number

  constructor(
    generation: RuntimeGeneration,
    options: { clock?: RuntimeClock, maxFramesPerScope?: number, ttlMs?: number } = {},
  ) {
    this.#generation = generation
    this.#clock = options.clock ?? systemClock
    this.#maxFramesPerScope = options.maxFramesPerScope ?? 4
    this.#ttlMs = options.ttlMs ?? 120_000
  }

  registerPublication(value: unknown): ObservationPublication {
    const publication = observationPublicationSchema.parse(value)
    if (
      publication.runtimeEpoch !== this.#generation.runtimeEpoch
      || publication.loginSessionId !== this.#generation.loginSessionId
    ) {
      throw new Error("Observation publication принадлежит другой runtime generation")
    }
    if (this.#publications.has(publication.observationId) || this.#publicationsByFrame.has(publication.frameRef)) {
      throw new Error("Observation/frame reservation уже существует")
    }
    this.#publications.set(publication.observationId, publication)
    this.#publicationsByFrame.set(publication.frameRef, publication)
    return publication
  }

  async publish(request: Parameters<BinaryFramePublisher["publish"]>[0]): Promise<void> {
    const publication = this.#publications.get(request.observationId)
    if (publication === undefined) throw new Error("Observation publication не зарегистрирована")
    if (
      request.runtimeEpoch !== publication.runtimeEpoch
      || request.loginSessionId !== publication.loginSessionId
      || request.frameRef !== publication.frameRef
      || request.source !== publication.source
      || canonicalJson(request.target) !== canonicalJson(publication.captureTarget)
      || request.expectedByteLength !== request.bytes.byteLength
      || this.#clock.now().getTime() >= Date.parse(publication.expiresAt)
    ) {
      throw new Error("Binary frame не совпадает с publication или publication stale")
    }
    if (this.#publicationsByFrame.get(request.frameRef)?.observationId !== request.observationId) {
      throw new Error("FrameRef не зарезервирован для observation")
    }
    if (this.#frames.has(request.frameRef)) throw new Error("FrameRef уже опубликован и не может быть перезаписан")
    const digest = new Bun.CryptoHasher("sha256").update(request.bytes).digest("hex")
    if (digest !== request.expectedSha256) throw new Error("Binary frame digest не совпадает")
    this.#evict(publication.cacheScopeRef)
    this.#frames.set(request.frameRef, {
      publication,
      bytes: request.bytes.slice(),
      sha256: digest,
      createdAt: this.#clock.now().getTime(),
    })
  }

  get(frameRef: string, cacheScopeRef: string): Uint8Array | undefined {
    const stored = this.#frames.get(frameRef)
    if (
      stored === undefined
      || stored.publication.cacheScopeRef !== cacheScopeRef
      || this.#clock.now().getTime() - stored.createdAt >= this.#ttlMs
    ) {
      return undefined
    }
    return stored.bytes.slice()
  }

  hasVerified(frameRef: string, sha256Value: string): boolean {
    const frame = this.#frames.get(frameRef)
    return frame !== undefined
      && frame.sha256 === sha256Value
      && this.#clock.now().getTime() - frame.createdAt < this.#ttlMs
  }

  #evict(cacheScopeRef: string): void {
    const now = this.#clock.now().getTime()
    const scoped = [...this.#frames.entries()]
      .filter(([, frame]) => frame.publication.cacheScopeRef === cacheScopeRef)
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
    for (const [frameRef, frame] of scoped) {
      if (now - frame.createdAt >= this.#ttlMs) this.#frames.delete(frameRef)
    }
    const remaining = scoped.filter(([frameRef]) => this.#frames.has(frameRef))
    while (remaining.length >= this.#maxFramesPerScope) {
      const oldest = remaining.shift()
      if (oldest !== undefined) this.#frames.delete(oldest[0])
    }
  }
}

export class ObservationRegistry implements ObservationResolver {
  readonly #proofs: ProofAuthority
  readonly #evidence: NativeEvidenceAuthority
  readonly #clock: RuntimeClock
  readonly #observations = new Map<string, Observation>()

  constructor(
    proofs: ProofAuthority,
    evidence: NativeEvidenceAuthority,
    options: { clock?: RuntimeClock } = {},
  ) {
    this.#proofs = proofs
    this.#evidence = evidence
    this.#clock = options.clock ?? systemClock
  }

  register(value: unknown): Observation {
    const observation = observationSchema.parse(value)
    this.#observations.set(observation.observationId, observation)
    return observation
  }

  get(observationId: string): Observation | undefined {
    return this.#observations.get(observationId)
  }

  async resolvePoint(request: ResolveStoredObservationPointRequest): Promise<AuthorizedObservationPoint> {
    const stored = this.#observations.get(request.observationRef.observationId)
    if (
      stored === undefined
      || stored.inventoryRevision !== request.observationRef.inventoryRevision
      || stored.displayLayoutRevision !== request.observationRef.displayLayoutRevision
      || request.operation.observationRef?.observationId !== stored.observationId
      || canonicalJson(request.operation.target) !== canonicalJson(request.interactionTarget)
    ) {
      throw new Error("Stored observation ref/operation/interaction target не совпадают")
    }
    const receipt = this.#evidence.findPointReceipt(request)
    const interactionProof = await this.#evidence.issueInteractionPoint({
      operation: request.operation,
      receipt,
      observationRef: request.observationRef,
      interactionTarget: request.interactionTarget,
      imagePoint: request.imagePoint,
      expectedSpace: request.expectedSpace,
    })
    return authorizeObservationPoint(this.#proofs, {
      observation: stored,
      imagePoint: request.imagePoint,
      expectedCaptureTarget: stored.captureTarget,
      interactionTarget: request.interactionTarget,
      interactionProof,
      expectedSpace: request.expectedSpace,
      runtimeEpoch: request.operation.runtimeEpoch,
      loginSessionId: request.operation.loginSessionId,
      nativeGeneration: request.operation.nativeGeneration,
      inventoryRevision: request.operation.inventoryRevision,
      displayLayoutRevision: request.observationRef.displayLayoutRevision,
      deadlineAt: request.operation.deadlineAt,
      maxFrameAgeMs: 5_000,
      now: this.#clock.now(),
    })
  }
}

function targetKey(target: OperationTarget): string {
  return canonicalJson(target)
}

function targetAuthorityScope(target: OperationTarget): string {
  switch (target.kind) {
    case "application":
    case "window":
    case "surface":
    case "element":
    case "display":
    case "desktop-layout":
      return `native:${target.ref.runtimeEpoch}:${target.ref.loginSessionId}:${target.ref.nativeGeneration}`
    case "browser-instance":
    case "browser-target":
      return `browser:${target.ref.browserInstanceRef}:${target.ref.transportGeneration}`
    case "device":
      return `device:${target.ref.deviceRef}:${target.ref.transportGeneration}`
    case "device-browser-instance":
    case "device-browser-target":
      return `device-browser:${target.ref.deviceRef}:${target.ref.transportGeneration}:${target.ref.browserInstanceRef}:${target.ref.browserTransportGeneration}`
    case "clipboard":
      return `clipboard:${target.ref.runtimeEpoch}:${target.ref.loginSessionId}`
  }
}

function responseKey(adapterInstanceRef: string, sourceResponseRef: string): string {
  return canonicalJson([adapterInstanceRef, sourceResponseRef])
}
