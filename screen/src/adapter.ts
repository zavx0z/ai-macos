import {
  authorizeScreenCapture,
  evidenceSchema,
  operationTargetSchema,
  screenCaptureRequestSchema,
  screenCaptureResultSchema,
  verifyAndPublishBinaryFrame,
  type AdapterHostContext,
  type AdapterResult,
  type AdapterServices,
  type AffineTransform,
  type CaptureClip,
  type CleanupOutcome,
  type CleanupAuthorityReceipt,
  type ContractError,
  type DisplayRef,
  type Evidence,
  type NativeCaptureTarget,
  type NativeExecutionContext,
  type OperationOutcome,
  type OperationTarget,
  type ReadinessPolicy,
  type ReadinessResult,
  type ReadinessStep,
  type ReadinessStepName,
  type Rect,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
  type ScreenAdapter,
  type ScreenCaptureRequest,
  type ScreenCaptureResult,
  type TargetResolution,
  type VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"

export type NativeCaptureMapping = NonNullable<TargetResolution["nativeMapping"]>

export type NativeCaptureDriverRequest = {
  request: ScreenCaptureRequest
  nativeMapping: NativeCaptureMapping
  captureTimeoutMs: number
  stopTimeoutMs: number
}

export type NativeCaptureReadinessFact = {
  state: "reached" | "failed" | "timed-out" | "unavailable"
  durationMs: number
  reason?: string
}

export type NativeCaptureRegion = {
  nativeDisplayId: number
  frameOrientation: "display-oriented"
  imageRect: Rect
  destinationRect: Rect
  imageToDestination: AffineTransform
  frameTimestamp: string
  frameStatus: "complete" | "stale" | "unavailable"
}

type NativeCaptureCompletionBase = {
  taskRef: string
  cleanup: "complete" | "unknown"
  drained: boolean
  statusRevision: number
}

export type NativeCaptureSuccess = NativeCaptureCompletionBase & {
  ok: true
  source: ScreenCaptureRequest["source"]
  caption: string
  target: OperationTarget
  nativeMapping: NativeCaptureMapping
  clip: CaptureClip
  cursor: "included" | "excluded"
  scale: number
  widthPx: number
  heightPx: number
  encodedBytes: number
  capturedAt: string
  frameStatus: "complete"
  backend: { name: string, buildId: string }
  evidenceReceipt: VerifiedNativeEvidenceReceipt
  targetEvidence: {
    shareableTargetMatched: boolean
    beforeTargetMatched: boolean
    afterTargetMatched: boolean
    boundsUnchanged: boolean
    auxiliarySurfacesExcluded: boolean
  }
  readinessFacts: Partial<Record<ReadinessStepName, NativeCaptureReadinessFact>>
  occlusion: Evidence
  regions: NativeCaptureRegion[]
  bytes: Uint8Array
}

export type NativeCaptureFailure = NativeCaptureCompletionBase & {
  ok: false
  code:
    | "invalid-request"
    | "permission-denied"
    | "target-unavailable"
    | "target-changed"
    | "frame-unavailable"
    | "frame-stale"
    | "budget-exceeded"
    | "encoding-failed"
    | "stream-failed"
    | "cancelled"
    | "timed-out"
  message: string
}

export type NativeCaptureCompletion = NativeCaptureSuccess | NativeCaptureFailure

export type NativeCaptureTask = {
  taskRef: string
  result: Promise<NativeCaptureCompletion>
}

export type NativeCaptureTaskStatus = {
  taskRef: string
  revision: number
  cleanup: "pending" | "complete" | "unknown"
  drained: boolean
}

export type CaptureReconciliation = {
  taskRef: string
  status: NativeCaptureTaskStatus
  report: {
    operationId: string
    runtimeEpoch: string
    loginSessionId: string
    nativeGeneration: string
    revision: number
    cleanup: CleanupOutcome
  }
}

export interface NativeCaptureDriver {
  start(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: NativeCaptureDriverRequest,
  ): Promise<NativeCaptureTask>
  cancel(taskRef: string, reason: string): Promise<void>
  status(taskRef: string): Promise<NativeCaptureTaskStatus>
  release(
    taskRef: string,
    idempotencyKey: string,
  ): Promise<{ taskRef: string, status: "released" | "already-released" }>
}

export type ScreenAdapterServices = AdapterServices

type AuthorizedCaptureRegion = NativeCaptureRegion & {
  display: DisplayRef
}

type PendingCapture = {
  revision: number
  operationId: string
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration: string
  handles: readonly RuntimeResourceHandle[]
  terminal?: CaptureReconciliation
  releaseStage?: "unknown"
}

type CaptureTombstone = {
  operationId: string
  receiptDigest: string
}

export class RuntimeScreenAdapter implements ScreenAdapter {
  readonly capabilities = ["capture.desktop", "capture.window", "capture.observation"] as const
  readonly #pendingTasks = new Map<string, PendingCapture>()
  readonly #tombstones = new Map<string, CaptureTombstone>()

  constructor(
    readonly host: AdapterHostContext,
    readonly services: ScreenAdapterServices,
    private readonly native: NativeCaptureDriver,
    private readonly now: () => Date = () => new Date(),
    private readonly stopTimeoutMs = 1_000,
  ) {}

  async capture(
    context: RuntimeOperationContext<NativeExecutionContext>,
    input: ScreenCaptureRequest,
  ): Promise<AdapterResult<ScreenCaptureResult>> {
    let targetVerified = false
    let startAttempted = false
    let task: NativeCaptureTask | undefined
    let nativeCleanup: NativeCaptureCompletion["cleanup"] | undefined
    try {
      const request = screenCaptureRequestSchema.parse(input)
      const startedAt = this.now()
      await context.control.checkpoint("screen.authorize-context")
      const resolution = await authorizeScreenCapture(this, context, request, startedAt)

      const captureHandle = exactCaptureHandle(context.resources, request.publication.observationId)
      if (resolution.nativeMapping === undefined) throw new Error("Target authority не вернул native capture mapping")
      const remainingMs = Date.parse(context.wire.deadlineAt) - this.now().getTime()
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("Capture operation deadline истёк до native start")

      startAttempted = true
      task = await within(this.native.start(context, {
        request,
        nativeMapping: resolution.nativeMapping,
        captureTimeoutMs: Math.min(10_000, Math.max(1, Math.floor(remainingMs))),
        stopTimeoutMs: this.stopTimeoutMs,
      }), remainingMs, context.control.signal)
      if (task.taskRef.length === 0) throw new Error("Native capture вернул пустой taskRef")
      this.registerPending(task.taskRef, {
        revision: 0,
        operationId: context.wire.operationId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        handles: [captureHandle],
      })
      await context.control.checkpoint("screen.capture-started")

      const native = await this.awaitNativeResult(task, context)
      if (native.taskRef !== task.taskRef) throw new Error("Native capture result принадлежит другому task")
      if (native.statusRevision < 1) throw new Error("Native capture status revision некорректна")
      if (native.cleanup === "complete" && !native.drained) {
        throw new Error("Native capture объявил complete cleanup до drain")
      }
      if (native.cleanup === "unknown" && native.drained) {
        throw new Error("Native capture объявил unknown cleanup для drained task")
      }
      this.updatePending(task.taskRef, {
        revision: native.statusRevision,
        operationId: context.wire.operationId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        handles: [captureHandle],
      })
      nativeCleanup = native.cleanup
      if (!native.ok) throw new NativeCaptureError(native)
      this.assertNativeResultMatchesRequest(native, request, {
        ...resolution,
        nativeMapping: resolution.nativeMapping,
      })
      assertNativeEvidenceReceipt(native, request)
      targetVerified = true
      const regions = this.authorizeRegions(request, native, resolution)

      const sha256 = new Bun.CryptoHasher("sha256").update(native.bytes).digest("hex")
      const cleanup = captureCleanup(captureHandle, native.cleanup)
      const pendingEvidence: Evidence = {
        state: "unknown",
        claim: "frame-freshness",
        source: "screen-adapter",
        reason: "Binary frame ещё не зарегистрирован runtime publisher",
      }
      const provisional = this.buildResult(
        request,
        native,
        regions,
        cleanup,
        sha256,
        pendingEvidence,
      )
      await context.control.checkpoint("screen.publish-frame")
      await verifyAndPublishBinaryFrame(
        this.services.frames,
        request,
        provisional,
        native.bytes,
        resolution,
      )
      await context.control.checkpoint("screen.frame-published")
      const frameProof = await this.services.evidence.issueFrameFreshness({
        receipt: native.evidenceReceipt,
        observationId: request.publication.observationId,
        frameRef: request.publication.frameRef,
        captureTarget: context.wire.target,
        frameSha256: sha256,
      })
      const captureEvidence: Evidence = {
        state: "confirmed",
        claim: "frame-freshness",
        source: "runtime-native-evidence",
        proof: frameProof,
      }
      const result = this.buildResult(
        request,
        native,
        regions,
        cleanup,
        sha256,
        captureEvidence,
      )
      await context.control.checkpoint("screen.frame-evidence-issued")
      if (native.cleanup === "complete") {
        await this.releaseTask(
          task.taskRef,
          native.drained,
          taskReleaseKey(task.taskRef, context.wire.operationId, native.statusRevision),
          true,
        )
      }
      return {
        ok: true,
        value: result,
        outcome: successOutcome(cleanup),
      }
    } catch (error) {
      let reportedError = error
      let cleanupState: "complete" | "unknown" = error instanceof NativeBufferReleaseError
        ? "unknown"
        : startAttempted ? nativeCleanup ?? "unknown" : "complete"
      if (task !== undefined && cleanupState === "complete" && !(error instanceof NativeBufferReleaseError)) {
        const pending = this.#pendingTasks.get(task.taskRef)
        try {
          await this.releaseTask(
            task.taskRef,
            true,
            taskReleaseKey(task.taskRef, context.wire.operationId, pending?.revision ?? 0),
            true,
          )
        } catch (releaseError) {
          reportedError = releaseError
          cleanupState = "unknown"
        }
      }
      const cleanup = cleanupForHandles(context.resources, cleanupState)
      return {
        ok: false,
        error: contractError(reportedError, context.wire.target, cleanupState),
        outcome: failureOutcome(cleanup, targetVerified, cleanupState === "unknown"),
      }
    }
  }

  async reconcileCapture(taskRef: string): Promise<CaptureReconciliation> {
    const pending = this.#pendingTasks.get(taskRef)
    if (pending === undefined) throw new Error(`Capture task не ожидает reconciliation: ${taskRef}`)
    if (pending.terminal !== undefined) return pending.terminal
    const status = await this.native.status(taskRef)
    if (status.taskRef !== taskRef) throw new Error("Native capture status принадлежит другому task")
    if (status.cleanup === "complete" && !status.drained) {
      throw new Error("Native capture status объявил complete до drain")
    }
    if (status.drained && status.cleanup !== "complete") {
      throw new Error("Native capture status объявил drained без complete cleanup")
    }
    if (status.revision < pending.revision || (status.drained && status.revision <= pending.revision)) {
      throw new Error("Native capture status не продвинул revision при reconciliation")
    }
    const reconciliation: CaptureReconciliation = {
      taskRef,
      status,
      report: {
        operationId: pending.operationId,
        runtimeEpoch: pending.runtimeEpoch,
        loginSessionId: pending.loginSessionId,
        nativeGeneration: pending.nativeGeneration,
        revision: status.revision,
        cleanup: cleanupForHandles(
          pending.handles,
          status.drained && status.cleanup === "complete" ? "complete" : "unknown",
        ),
      },
    }
    this.#pendingTasks.set(taskRef, {
      ...pending,
      revision: status.revision,
      ...(status.drained ? { terminal: reconciliation } : {}),
    })
    return reconciliation
  }

  async acknowledgeCaptureReconciliation(
    taskRef: string,
    receipt: CleanupAuthorityReceipt,
  ): Promise<void> {
    const receiptDigest = cleanupReceiptDigest(receipt)
    const tombstone = this.#tombstones.get(taskRef)
    if (tombstone !== undefined) {
      if (tombstone.receiptDigest !== receiptDigest || tombstone.operationId !== receipt.operationId) {
        throw new Error("Capture reconciliation ACK конфликтует с terminal tombstone")
      }
      return
    }
    const pending = this.#pendingTasks.get(taskRef)
    if (pending?.terminal === undefined || pending.terminal.report.cleanup.state !== "complete") {
      throw new Error("Capture reconciliation ещё не имеет terminal complete cleanup")
    }
    if (
      receipt.operationId !== pending.operationId
      || receipt.runtimeEpoch !== pending.runtimeEpoch
      || receipt.loginSessionId !== pending.loginSessionId
    ) {
      throw new Error("Runtime cleanup receipt принадлежит другой capture operation")
    }
    await this.services.cleanup.verify(receipt, pending.handles)
    await this.releaseTask(taskRef, true, receiptDigest, false)
    this.#tombstones.set(taskRef, { operationId: pending.operationId, receiptDigest })
    this.#pendingTasks.delete(taskRef)
  }

  hasPendingCapture(taskRef: string): boolean {
    return this.#pendingTasks.has(taskRef)
  }

  hasCaptureTombstone(taskRef: string): boolean {
    return this.#tombstones.has(taskRef)
  }

  private authorizeRegions(
    request: ScreenCaptureRequest,
    native: NativeCaptureSuccess,
    resolution: TargetResolution,
  ): AuthorizedCaptureRegion[] {
    const mappings = resolution.nativeMapping?.kind === "display"
      ? [resolution.nativeMapping.display]
      : resolution.nativeMapping?.displays ?? []
    const expectedIds = mappings.map(mapping => mapping.nativeDisplayId)
    const actualIds = native.regions.map(region => region.nativeDisplayId)
    if (
      actualIds.length !== expectedIds.length
      || new Set(actualIds).size !== actualIds.length
      || expectedIds.some(nativeDisplayId => !actualIds.includes(nativeDisplayId))
    ) {
      throw new Error("Native regions не являются exact unique set authority display mapping")
    }
    const byNativeId = new Map(mappings.map(mapping => [mapping.nativeDisplayId, mapping.ref]))
    return native.regions.map(region => {
      const display = byNativeId.get(region.nativeDisplayId)
      if (display === undefined) {
        throw new Error("Native region содержит display ID вне authority resolution")
      }
      assertDisplayGeneration(display, request)
      return { ...region, display }
    })
  }

  private assertNativeResultMatchesRequest(
    native: NativeCaptureSuccess,
    request: ScreenCaptureRequest,
    resolution: TargetResolution & { nativeMapping: NativeCaptureMapping },
  ): void {
    if (
      native.source !== request.source
      || native.caption !== request.caption
      || !sameOperationTarget(native.target, resolution.target)
      || !sameCaptureMapping(native.nativeMapping, resolution.nativeMapping)
      || !sameCaptureClip(native.clip, request.clip)
      || native.cursor !== (request.cursor === "include" ? "included" : "excluded")
      || native.scale !== request.output.scale
    ) {
      throw new Error("Native capture result не совпадает с requested target/source/policy")
    }
    if (native.frameStatus !== "complete" || native.regions.length === 0) {
      throw new Error("Native capture не вернул complete frame regions")
    }
    if (!native.targetEvidence.shareableTargetMatched) {
      throw new Error("Native capture не подтвердил exact shareable target")
    }
    if (request.source === "window-isolated" && !native.targetEvidence.auxiliarySurfacesExcluded) {
      throw new Error("Isolated window capture не подтвердил excluded auxiliary surfaces")
    }
    if (
      native.targetEvidence.beforeTargetMatched
      && (!native.targetEvidence.afterTargetMatched || !native.targetEvidence.boundsUnchanged)
    ) {
      throw new Error("Native capture target изменился между before/after evidence")
    }
    if (
      !Number.isInteger(native.widthPx)
      || !Number.isInteger(native.heightPx)
      || native.widthPx < 1
      || native.heightPx < 1
      || native.widthPx > request.output.maxWidthPx
      || native.heightPx > request.output.maxHeightPx
      || native.widthPx * native.heightPx > request.output.maxPixels
      || native.encodedBytes !== native.bytes.byteLength
      || native.encodedBytes > request.output.maxEncodedBytes
    ) {
      throw new Error("Native capture result нарушает requested dimensions/byte budgets")
    }
    if (native.cleanup === "complete" && !native.drained) {
      throw new Error("Native capture объявил complete cleanup до drain")
    }
    if (native.regions.some(region => region.frameStatus !== "complete")) {
      throw new Error("Native capture не публикует stale/unavailable region как новый frame")
    }
    if (native.regions.some(region => region.frameOrientation !== "display-oriented")) {
      throw new Error("Native capture region не подтверждает display-oriented frame")
    }
    const capturedAt = Date.parse(native.capturedAt)
    const currentTime = this.now().getTime()
    if (!Number.isFinite(capturedAt) || capturedAt > currentTime + 1_000) {
      throw new Error("Native capture timestamp отсутствует или находится в будущем")
    }
    const regionTimes = native.regions.map(region => Date.parse(region.frameTimestamp))
    if (regionTimes.some(timestamp => {
      return !Number.isFinite(timestamp)
        || timestamp > currentTime + 1_000
        || timestamp < currentTime - 2_000
    })) {
      throw new Error("Native capture region timestamp stale или находится в будущем")
    }
    if (Math.abs(Math.max(...regionTimes) - capturedAt) > 1) {
      throw new Error("Native capture capturedAt не совпадает с последним region frame")
    }
    for (let left = 0; left < native.regions.length; left += 1) {
      for (let right = left + 1; right < native.regions.length; right += 1) {
        if (rectanglesOverlap(native.regions[left]!.imageRect, native.regions[right]!.imageRect)) {
          throw new Error("Native capture regions перекрываются в image space")
        }
      }
    }
  }

  private buildResult(
    request: ScreenCaptureRequest,
    native: NativeCaptureSuccess,
    regions: AuthorizedCaptureRegion[],
    cleanup: CleanupOutcome,
    sha256: string,
    captureEvidence: Evidence,
  ): ScreenCaptureResult {
    const captureTarget = captureOperationTarget(request.target)
    const readiness = buildReadiness(request.readinessPolicy, native.readinessFacts)
    const imageRect = { x: 0, y: 0, width: native.widthPx, height: native.heightPx }
    const timestamps = regions.map(region => Date.parse(region.frameTimestamp))
    const maxSkewMs = Math.max(...timestamps) - Math.min(...timestamps)
    const synchronization = native.regions.length === 1 || maxSkewMs === 0
      ? { kind: "single-frame" as const }
      : { kind: "stitched" as const, maxSkewMs }
    const result = {
      publication: request.publication,
      observation: {
        observationId: request.publication.observationId,
        runtimeEpoch: request.publication.runtimeEpoch,
        loginSessionId: request.publication.loginSessionId,
        nativeGeneration: request.publication.nativeGeneration!,
        captureTarget,
        caption: request.caption,
        backend: native.backend,
        capturedAt: native.capturedAt,
        expiresAt: request.publication.expiresAt,
        inventoryRevision: request.publication.inventoryRevision,
        displayLayoutRevision: request.publication.displayLayoutRevision,
        source: request.source,
        image: {
          frameRef: request.publication.frameRef,
          widthPx: native.widthPx,
          heightPx: native.heightPx,
          mime: "image/png" as const,
          byteLength: native.encodedBytes,
          sha256,
        },
        cursor: native.cursor,
        clip: imageRect,
        captureEvidence,
        occlusion: safeOcclusion(request.source, native.occlusion),
        readiness,
        synchronization,
        regions: regions.map(region => ({
          space: { kind: "macos-screen" as const, display: region.display },
          imageRect: region.imageRect,
          destinationRect: region.destinationRect,
          imageToDestination: region.imageToDestination,
          frameTimestamp: region.frameTimestamp,
          frameStatus: region.frameStatus,
        })),
        unavailableReasons: readiness.state === "ready"
          ? []
          : readiness.steps.flatMap(step => "reason" in step ? [step.reason] : []),
      },
      frame: {
        frameRef: request.publication.frameRef,
        observationId: request.publication.observationId,
        runtimeEpoch: request.publication.runtimeEpoch,
        loginSessionId: request.publication.loginSessionId,
        nativeGeneration: request.publication.nativeGeneration!,
        source: request.source,
        target: captureTarget,
        capturedAt: native.capturedAt,
        widthPx: native.widthPx,
        heightPx: native.heightPx,
        byteLength: native.encodedBytes,
        sha256,
        mime: "image/png" as const,
      },
      effective: {
        clip: request.clip,
        fullPage: false,
        cursor: native.cursor,
        scale: native.scale,
        widthPx: native.widthPx,
        heightPx: native.heightPx,
        pixelCount: native.widthPx * native.heightPx,
        encodedBytes: native.encodedBytes,
        readinessPolicy: request.readinessPolicy,
      },
      cleanup,
    }
    return screenCaptureResultSchema.parse(result)
  }

  private async awaitNativeResult(
    task: NativeCaptureTask,
    context: RuntimeOperationContext<NativeExecutionContext>,
  ): Promise<NativeCaptureCompletion> {
    try {
      return await within(
        task.result,
        Date.parse(context.wire.deadlineAt) - this.now().getTime(),
        context.control.signal,
      )
    } catch (error) {
      await this.native.cancel(task.taskRef, error instanceof Error ? error.message : String(error)).catch(() => {})
      try {
        return await within(task.result, this.stopTimeoutMs, undefined)
      } catch {
        throw new UnresolvedCaptureError(task.taskRef, error)
      }
    }
  }

  private registerPending(taskRef: string, pending: PendingCapture): void {
    if (this.#pendingTasks.has(taskRef) || this.#tombstones.has(taskRef)) {
      throw new Error(`Native capture повторно выдал существующий taskRef: ${taskRef}`)
    }
    this.#pendingTasks.set(taskRef, pending)
  }

  private updatePending(taskRef: string, next: PendingCapture): void {
    const current = this.#pendingTasks.get(taskRef)
    if (
      current === undefined
      || current.operationId !== next.operationId
      || current.runtimeEpoch !== next.runtimeEpoch
      || current.loginSessionId !== next.loginSessionId
      || current.nativeGeneration !== next.nativeGeneration
      || !sameResourceHandles(current.handles, next.handles)
    ) {
      throw new Error("Native capture task update не совпадает с registered operation/handles")
    }
    this.#pendingTasks.set(taskRef, { ...next, terminal: current.terminal, releaseStage: current.releaseStage })
  }

  private async releaseTask(
    taskRef: string,
    drained: boolean,
    idempotencyKey: string,
    deleteOnSuccess: boolean,
  ): Promise<void> {
    if (!drained) throw new Error("Capture task нельзя release до drain")
    try {
      const result = await this.native.release(taskRef, idempotencyKey)
      if (result.taskRef !== taskRef || !["released", "already-released"].includes(result.status)) {
        throw new Error("Native release ACK не совпадает с capture task")
      }
      if (deleteOnSuccess) this.#pendingTasks.delete(taskRef)
    } catch (error) {
      const pending = this.#pendingTasks.get(taskRef)
      if (pending !== undefined) this.#pendingTasks.set(taskRef, { ...pending, releaseStage: "unknown" })
      throw new NativeBufferReleaseError(taskRef, error)
    }
  }
}

class NativeCaptureError extends Error {
  constructor(readonly completion: NativeCaptureFailure) {
    super(completion.message)
  }
}

class UnresolvedCaptureError extends Error {
  constructor(readonly taskRef: string, cause: unknown) {
    super(`Native capture outcome не подтверждён для ${taskRef}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

class NativeBufferReleaseError extends Error {
  constructor(readonly taskRef: string, cause: unknown) {
    super(`Native capture физически drained, но buffer release не подтверждён для ${taskRef}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function exactCaptureHandle(
  handles: readonly RuntimeResourceHandle[],
  observationId: string,
): RuntimeResourceHandle {
  const capture = handles.filter(handle => {
    return handle.kind === "capture-stream" && handle.resourceRef === observationId
  })
  if (capture.length !== 1 || handles.length !== 1) {
    throw new Error("ScreenAdapter требует ровно один принадлежащий capture-stream resource")
  }
  return capture[0]!
}

function captureCleanup(
  handle: RuntimeResourceHandle,
  state: "complete" | "unknown",
): CleanupOutcome {
  return state === "complete"
    ? { scope: "owned", state: "complete", resources: [{ handle, outcome: "released" }] }
    : {
        scope: "owned",
        state: "unknown",
        resources: [{ handle, outcome: "quarantined" }],
        reason: "Native capture task не подтвердил полный drain",
      }
}

function cleanupForHandles(
  handles: readonly RuntimeResourceHandle[],
  state: "complete" | "unknown",
): CleanupOutcome {
  if (handles.length === 0) return { scope: "none", state: "complete", resources: [] }
  return state === "complete"
    ? {
        scope: "owned",
        state: "complete",
        resources: handles.map(handle => ({ handle, outcome: "released" })),
      }
    : {
        scope: "owned",
        state: "unknown",
        resources: handles.map(handle => ({ handle, outcome: "quarantined" })),
        reason: "Native capture outcome или полный drain не подтверждён",
      }
}

function captureOperationTarget(target: NativeCaptureTarget): OperationTarget {
  return target.target
}

function assertDisplayGeneration(
  display: DisplayRef,
  request: ScreenCaptureRequest,
): void {
  if (
    display.runtimeEpoch !== request.publication.runtimeEpoch
    || display.loginSessionId !== request.publication.loginSessionId
    || display.nativeGeneration !== request.publication.nativeGeneration
    || display.displayLayoutRevision !== request.publication.displayLayoutRevision
  ) {
    throw new Error("Native region display принадлежит другой generation/topology")
  }
}

function buildReadiness(
  policy: ReadinessPolicy,
  facts: NativeCaptureSuccess["readinessFacts"],
): ReadinessResult {
  const names = [...new Set([...policy.requiredSteps, ...policy.disabledSteps])]
  const steps: ReadinessStep[] = names.map(name => {
    if (policy.disabledSteps.includes(name)) {
      return { name, state: "skipped", durationMs: 0, reason: "disabled-by-policy" }
    }
    if (name === "ownership") {
      return {
        name,
        state: "unavailable",
        durationMs: 0,
        reason: "Frame-freshness proof не заменяет point-bound interaction ownership proof",
      }
    }
    const fact = facts[name]
    if (fact === undefined) {
      return { name, state: "unavailable", durationMs: 0, reason: `Native capture не подтверждает readiness ${name}` }
    }
    if (fact.state === "reached") return { name, state: "reached", durationMs: fact.durationMs }
    return {
      name,
      state: fact.state,
      durationMs: fact.durationMs,
      reason: fact.reason ?? `Readiness ${name} не достигнута`,
    }
  })
  const timedOut = steps.some(step => step.state === "timed-out")
  const unavailable = steps.some(step => step.state === "unavailable")
  const failed = steps.some(step => step.state === "failed" || step.state === "timed-out")
  return {
    state: unavailable ? "unavailable" : failed ? "partial" : "ready",
    policy,
    steps,
    timedOut,
  }
}

function safeOcclusion(source: ScreenCaptureRequest["source"], evidence: Evidence): Evidence {
  const parsed = evidenceSchema.parse(evidence)
  if (parsed.state === "confirmed") {
    return {
      state: "unknown",
      claim: "pixel-occlusion",
      source: "screen-adapter",
      reason: `${source} capture не принимает producer proof как runtime occlusion authority`,
    }
  }
  return parsed
}

function rectanglesOverlap(left: Rect, right: Rect): boolean {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return width > 0 && height > 0
}

function sameResourceHandles(
  left: readonly RuntimeResourceHandle[],
  right: readonly RuntimeResourceHandle[],
): boolean {
  return left.length === right.length && left.every((handle, index) => {
    const other = right[index]
    return other !== undefined
      && handle.kind === other.kind
      && handle.resourceRef === other.resourceRef
      && handle.leaseId === other.leaseId
      && handle.leaseGeneration === other.leaseGeneration
      && handle.operationId === other.operationId
      && handle.clientSessionId === other.clientSessionId
      && handle.principalId === other.principalId
      && handle.runtimeEpoch === other.runtimeEpoch
      && handle.loginSessionId === other.loginSessionId
      && handle.expiresAt === other.expiresAt
      && handle.state === other.state
  })
}

function taskReleaseKey(taskRef: string, operationId: string, revision: number): string {
  return new Bun.CryptoHasher("sha256")
    .update(`capture-release\n${taskRef}\n${operationId}\n${revision}`)
    .digest("hex")
}

function cleanupReceiptDigest(receipt: CleanupAuthorityReceipt): string {
  const leases = [...receipt.leases]
    .sort((left, right) => left.leaseId.localeCompare(right.leaseId))
    .map(lease => `${lease.leaseId}:${lease.leaseGeneration}`)
    .join("\n")
  return new Bun.CryptoHasher("sha256").update([
    receipt.receiptId,
    receipt.authorityRef,
    receipt.operationId,
    receipt.runtimeEpoch,
    receipt.loginSessionId,
    receipt.issuedAt,
    receipt.state,
    leases,
  ].join("\n")).digest("hex")
}

function assertNativeEvidenceReceipt(
  native: NativeCaptureSuccess,
  request: ScreenCaptureRequest,
): void {
  const receipt = native.evidenceReceipt
  if (
    receipt.factKind !== "frame"
    || receipt.backendBuildId !== native.backend.buildId
    || receipt.runtimeEpoch !== request.publication.runtimeEpoch
    || receipt.loginSessionId !== request.publication.loginSessionId
    || receipt.nativeGeneration !== request.publication.nativeGeneration
    || receipt.inventoryId !== request.publication.inventoryId
    || receipt.inventoryRevision !== request.publication.inventoryRevision
    || receipt.displayLayoutRevision !== request.publication.displayLayoutRevision
    || receipt.observedAt !== native.capturedAt
  ) {
    throw new Error("Native frame evidence receipt не связан с capture result/publication")
  }
}

function sameOperationTarget(left: OperationTarget, right: OperationTarget): boolean {
  return JSON.stringify(operationTargetSchema.parse(left)) === JSON.stringify(operationTargetSchema.parse(right))
}

function sameCaptureClip(left: CaptureClip, right: CaptureClip): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "full-target" || right.kind === "full-target") return true
  return left.rect.x === right.rect.x
    && left.rect.y === right.rect.y
    && left.rect.width === right.rect.width
    && left.rect.height === right.rect.height
}

function sameCaptureMapping(left: NativeCaptureMapping, right: NativeCaptureMapping): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "display" && right.kind === "display") {
    return left.display.nativeDisplayId === right.display.nativeDisplayId
      && sameDisplayRef(left.display.ref, right.display.ref)
  }
  if (left.kind === "window" && right.kind === "window") {
    return left.cgWindowId === right.cgWindowId
      && left.ownerPid === right.ownerPid
      && sameDisplayMappings(left.displays, right.displays)
  }
  if (left.kind === "desktop-layout" && right.kind === "desktop-layout") {
    return sameDisplayMappings(left.displays, right.displays)
  }
  return false
}

function sameDisplayMappings(
  left: Array<{ nativeDisplayId: number, ref: DisplayRef }>,
  right: Array<{ nativeDisplayId: number, ref: DisplayRef }>,
): boolean {
  return left.length === right.length && left.every((mapping, index) => {
    const other = right[index]
    return other !== undefined
      && mapping.nativeDisplayId === other.nativeDisplayId
      && sameDisplayRef(mapping.ref, other.ref)
  })
}

function sameDisplayRef(left: DisplayRef, right: DisplayRef): boolean {
  return left.runtimeEpoch === right.runtimeEpoch
    && left.loginSessionId === right.loginSessionId
    && left.nativeGeneration === right.nativeGeneration
    && left.displayRef === right.displayRef
    && left.displayLayoutRevision === right.displayLayoutRevision
}

function successOutcome(cleanup: CleanupOutcome): OperationOutcome {
  return {
    dispatch: "none",
    targetVerified: "verified",
    userInterference: "unknown",
    observation: "available",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: 0,
  }
}

function failureOutcome(
  cleanup: CleanupOutcome,
  authorized: boolean,
  unknown: boolean,
): OperationOutcome {
  return {
    dispatch: "none",
    targetVerified: authorized ? "verified" : "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: 0,
    ...(unknown ? { lastCheckpoint: "screen.capture-drain-unknown" } : {}),
  }
}

function contractError(
  error: unknown,
  target: OperationTarget,
  cleanup: "complete" | "unknown",
): ContractError {
  const native = error instanceof NativeCaptureError ? error.completion : undefined
  const unresolved = error instanceof UnresolvedCaptureError
  const releaseUnknown = error instanceof NativeBufferReleaseError
  const code: ContractError["code"] = releaseUnknown
    ? "cleanup-incomplete"
    : unresolved || (cleanup === "unknown" && native === undefined)
    ? "operation-outcome-unknown"
    : native === undefined ? inferErrorCode(error) : nativeErrorCode(native.code)
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    stage: "screen-adapter",
    retryable: cleanup === "complete" && !releaseUnknown && !["permission-denied", "cancelled"].includes(code),
    replayAllowed: false,
    recoveryAction: cleanup === "unknown" || releaseUnknown
      ? "get-operation"
      : code === "target-stale" || code === "target-ambiguous"
        ? "refresh-inventory"
        : code === "permission-denied" ? "request-user-action" : "retry-read-only",
    context: { target },
  }
}

function inferErrorCode(error: unknown): ContractError["code"] {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (normalized.includes("deadline") || normalized.includes("timeout")) return "deadline-exceeded"
  if (normalized.includes("authority") || normalized.includes("mapping") || normalized.includes("generation")) return "target-stale"
  if (["png", "frame", "bytes", "binary", "crc"].some(token => normalized.includes(token))) {
    return "binary-frame-mismatch"
  }
  return "internal-error"
}

function nativeErrorCode(code: NativeCaptureFailure["code"]): ContractError["code"] {
  switch (code) {
    case "invalid-request":
    case "permission-denied":
    case "cancelled":
      return code
    case "target-unavailable":
    case "target-changed":
      return "target-stale"
    case "frame-unavailable":
    case "frame-stale":
      return "observation-stale"
    case "budget-exceeded":
      return "payload-too-large"
    case "encoding-failed":
      return "binary-frame-mismatch"
    case "stream-failed":
      return "operation-outcome-unknown"
    case "timed-out":
      return "deadline-exceeded"
  }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Capture deadline истёк")
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("Capture deadline истёк"))), timeoutMs)
    const abort = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Capture отменён")))
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      callback()
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}
