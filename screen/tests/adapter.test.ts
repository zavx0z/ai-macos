import { describe, expect, test } from "bun:test"
import {
  capturePolicySha256,
  freezeAdapterHostContext,
  screenCaptureRequestSchema,
  type AdapterServices,
  type DisplayRef,
  type Evidence,
  type NativeExecutionContext,
  type OperationTarget,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
  type ScreenCaptureRequest,
  type TargetResolution,
} from "@meta/shared/contracts"
import { ResourceRegistry } from "@meta/runtime"
import {
  RuntimeScreenAdapter,
  type NativeCaptureCompletion,
  type NativeCaptureDriver,
  type NativeCaptureDriverRequest,
  type NativeCaptureSuccess,
  type NativeCaptureTaskStatus,
  type ScreenAdapterServices,
} from "../src/adapter.ts"

const runtimeEpoch = "runtime:1"
const loginSessionId = "login:1"
const nativeGeneration = "native:1"
const nowMs = Date.now()
const now = new Date(nowMs).toISOString()
const deadlineAt = new Date(nowMs + 60_000).toISOString()
const expiresAt = new Date(nowMs + 120_000).toISOString()

const displayRef: DisplayRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  displayRef: "display:1",
  displayLayoutRevision: 3,
}
const captureTarget = { kind: "display", ref: displayRef } as const

function proof(
  kind: "target-resolution" | "frame-freshness" | "cg-ax-correlation",
  subject: OperationTarget,
  proofRef = `proof:${kind}`,
) {
  return {
    proofRef,
    authorityRef: "authority:runtime",
    kind,
    subject,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    issuedAt: new Date(nowMs - 1_000).toISOString(),
    expiresAt,
  }
}

function request(target = captureTarget): ScreenCaptureRequest {
  const value: Omit<ScreenCaptureRequest, "publication"> = {
    source: "display-composite",
    caption: "Ожидаю увидеть выбранный дисплей",
    target: {
      kind: "display",
      target,
      nativeDisplayId: 10,
      mappingEvidence: {
        state: "confirmed",
        claim: "native-display-resolved",
        source: "runtime-target-authority",
        proof: proof("target-resolution", target),
      },
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: {
      policyId: "readiness:native-frame",
      requiredSteps: ["permission", "target", "complete-frame"],
      disabledSteps: [],
    },
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 1_000,
      maxHeightPx: 1_000,
      maxPixels: 1_000_000,
      maxEncodedBytes: 1_000_000,
    },
  }
  return bindRequest(value)
}

function bindRequest(value: Omit<ScreenCaptureRequest, "publication">): ScreenCaptureRequest {
  return screenCaptureRequestSchema.parse({
    ...value,
    publication: {
      observationId: "observation:1",
      frameRef: "frame:runtime:1",
      source: value.source,
      captureTarget: value.target.target,
      capturePolicySha256: capturePolicySha256(value),
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      expiresAt,
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      cacheScopeRef: "client:1",
    },
  })
}

function png(width = 1, height = 1): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)

  const raw = new Uint8Array(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      raw[row * (1 + width * 4) + 1 + column * 4 + 3] = 255
    }
  }
  const length = raw.byteLength
  const deflate = new Uint8Array(2 + 5 + length + 4)
  deflate.set([0x78, 0x01, 0x01, length & 0xff, length >>> 8, (~length) & 0xff, ((~length) >>> 8) & 0xff])
  deflate.set(raw, 7)
  new DataView(deflate.buffer).setUint32(7 + length, adler32(raw))
  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflate),
    pngChunk("IEND", new Uint8Array()),
  )
}

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(name)
  const chunk = new Uint8Array(12 + data.byteLength)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.byteLength)
  chunk.set(type, 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(concat(type, data)))
  return chunk
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(data: Uint8Array): number {
  let first = 1
  let second = 0
  for (const byte of data) {
    first = (first + byte) % 65521
    second = (second + first) % 65521
  }
  return ((second << 16) | first) >>> 0
}

function rawSuccess(overrides: Partial<NativeCaptureSuccess> = {}): NativeCaptureSuccess {
  const bytes = png()
  return {
    ok: true,
    taskRef: "capture-task:1",
    cleanup: "complete",
    drained: true,
    statusRevision: 2,
    source: "display-composite",
    caption: "Ожидаю увидеть выбранный дисплей",
    target: captureTarget,
    nativeMapping: {
      kind: "display",
      display: { nativeDisplayId: 10, ref: displayRef },
    },
    clip: { kind: "full-target" },
    cursor: "excluded",
    scale: 1,
    widthPx: 1,
    heightPx: 1,
    encodedBytes: bytes.byteLength,
    capturedAt: now,
    frameStatus: "complete",
    backend: { name: "screen-capture-kit", buildId: "native-build:1" },
    evidenceReceipt: {
      evidenceReceiptId: "native-evidence:frame:1",
      adapterInstanceRef: "native-adapter:1",
      backendBuildId: "native-build:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      sourceResponseRef: "native-response:capture:1",
      sourceResponseSha256: "a".repeat(64),
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      observedAt: now,
      factKind: "frame",
      factSha256: "b".repeat(64),
      issuedAt: now,
    },
    targetEvidence: {
      shareableTargetMatched: true,
      beforeTargetMatched: true,
      afterTargetMatched: true,
      boundsUnchanged: true,
      auxiliarySurfacesExcluded: false,
    },
    readinessFacts: {
      permission: { state: "reached", durationMs: 0 },
      target: { state: "reached", durationMs: 1 },
      "complete-frame": { state: "reached", durationMs: 2 },
    },
    occlusion: {
      state: "unknown",
      claim: "pixel-occlusion",
      source: "screen-capture-kit",
      reason: "Composite frame не доказывает ownership отдельных пикселей",
    },
    regions: [{
      nativeDisplayId: 10,
      frameOrientation: "display-oriented",
      imageRect: { x: 0, y: 0, width: 1, height: 1 },
      destinationRect: { x: -100, y: 20, width: 2, height: 2 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -100, ty: 20 },
      frameTimestamp: now,
      frameStatus: "complete",
    }],
    bytes,
    ...overrides,
  }
}

class FakeNativeDriver implements NativeCaptureDriver {
  readonly requests: NativeCaptureDriverRequest[] = []
  readonly cancelled: string[] = []
  readonly released: string[] = []
  readonly releaseKeys: string[] = []
  releaseFailures = 0
  completion: Promise<NativeCaptureCompletion>
  nextStatus: NativeCaptureTaskStatus = {
    taskRef: "capture-task:1",
    revision: 3,
    cleanup: "complete",
    drained: true,
  }

  constructor(result: NativeCaptureCompletion | Promise<NativeCaptureCompletion> = rawSuccess()) {
    this.completion = Promise.resolve(result)
  }

  async start(
    _context: RuntimeOperationContext<NativeExecutionContext>,
    requestValue: NativeCaptureDriverRequest,
  ) {
    this.requests.push(requestValue)
    return { taskRef: "capture-task:1", result: this.completion }
  }

  async cancel(taskRef: string) {
    this.cancelled.push(taskRef)
  }

  async status() {
    return this.nextStatus
  }

  async release(taskRef: string, idempotencyKey: string) {
    this.releaseKeys.push(idempotencyKey)
    if (this.releaseFailures > 0) {
      this.releaseFailures -= 1
      throw new Error("fixture release reply lost")
    }
    if (this.released.includes(taskRef)) return { taskRef, status: "already-released" as const }
    this.released.push(taskRef)
    return { taskRef, status: "released" as const }
  }
}

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:1",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "screen-adapter:fixture",
    capabilities: [
      { id: "capture.desktop", state: "ready" },
      { id: "capture.window", state: "ready" },
      { id: "capture.observation", state: "ready" },
    ],
  },
})

function handle(observationId = "observation:1", operationId = "operation:1"): RuntimeResourceHandle {
  return {
    kind: "capture-stream",
    resourceRef: observationId,
    leaseId: `lease:${observationId}`,
    leaseGeneration: "lease-generation:1",
    operationId,
    clientSessionId: "client:1",
    principalId: "principal:1",
    runtimeEpoch,
    loginSessionId,
    expiresAt,
    state: "active",
  }
}

function cleanupReceipt(resource: RuntimeResourceHandle) {
  return {
    receiptId: "cleanup-receipt:1",
    authorityRef: "cleanup-authority:1",
    operationId: resource.operationId,
    runtimeEpoch,
    loginSessionId,
    issuedAt: now,
    state: "complete" as const,
    leases: [{ leaseId: resource.leaseId, leaseGeneration: resource.leaseGeneration }],
  }
}

function context(
  target: NativeExecutionContext["target"] = captureTarget,
  deadline = deadlineAt,
): RuntimeOperationContext<NativeExecutionContext> {
  return {
    wire: {
      kind: "native",
      operationId: "operation:1",
      clientRequestId: "request:1",
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      target,
      nativeGeneration,
      fence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      deadlineAt: deadline,
    },
    session: {
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch,
      loginSessionId,
      authenticationGeneration: "auth:1",
      authenticatedAt: new Date(nowMs - 1_000).toISOString(),
      expiresAt,
    },
    resources: [handle()],
    control: { signal: new AbortController().signal, checkpoint() {} },
  }
}

function services(
  resolution: (target: OperationTarget) => TargetResolution = target => ({
    target,
    resolutionId: "resolution:1",
    proofRef: "proof:target-resolution",
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    nativeGeneration,
    nativeMapping: {
      kind: "display",
      display: { nativeDisplayId: 10, ref: displayRef },
    },
  }),
) {
  const published: unknown[] = []
  const value: ScreenAdapterServices & { published: unknown[] } = {
    clientSessions: { async assertActive() {} },
    resources: { async assertActive() {}, async assertOwnedSet() {} },
    cleanup: { async verify() {} },
    targets: { async resolve(input) { return resolution(input.target) } },
    proofs: { async assertValid() {} },
    evidence: {
      async issueTargetResolution() { throw new Error("not used") },
      async issueWindowCorrelation() { throw new Error("not used") },
      async issueFrameFreshness(input) {
        if (published.length === 0) throw new Error("Frame bytes должны быть published до freshness proof")
        return proof("frame-freshness", input.captureTarget)
      },
      async issueInteractionPoint() { throw new Error("not used") },
    },
    frames: {
      async publish(input) {
        published.push(input)
      },
    },
    observations: { async resolvePoint() { throw new Error("not used") } },
    continuations: {
      async issue() { throw new Error("not used") },
      async registerAcceptedTask() { throw new Error("not used") },
      async advanceVerifiedStatus() { throw new Error("not used") },
      async markVerifiedTerminal() { throw new Error("not used") },
    },
    reservations: { async assertChild() { throw new Error("not used") } },
    published,
  }
  return value
}

describe("RuntimeScreenAdapter", () => {
  test("публикует complete frame только после authority, policy и binary checks", async () => {
    const native = new FakeNativeDriver()
    const runtime = services()
    const adapter = new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
    const result = await adapter.capture(context(), request())

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(native.requests[0]?.nativeMapping).toEqual({
      kind: "display",
      display: { nativeDisplayId: 10, ref: displayRef },
    })
    expect(native.released).toEqual(["capture-task:1"])
    expect(runtime.published).toHaveLength(1)
    expect(result.value.observation.image.frameRef).toBe("frame:runtime:1")
    expect(result.value.observation.captureEvidence.state).toBe("confirmed")
    expect(result.value.observation.readiness.state).toBe("ready")
    expect("pointerActionable" in result.value.observation).toBe(false)
    expect(result.value.observation.captureTarget).toEqual(captureTarget)
  })

  test("не запускает native при несовпавшей authoritative mapping", async () => {
    const native = new FakeNativeDriver()
    const runtime = services(target => ({
      target,
      resolutionId: "resolution:wrong",
      proofRef: "proof:target-resolution",
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      nativeGeneration,
      nativeMapping: {
        kind: "display",
        display: { nativeDisplayId: 99, ref: displayRef },
      },
    }))
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(false)
    expect(result.outcome.targetVerified).toBe("unknown")
    expect(native.requests).toEqual([])
  })

  test("отклоняет producer policy mismatch до binary publication", async () => {
    const native = new FakeNativeDriver(rawSuccess({ scale: 0.5 }))
    const runtime = services()
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(false)
    expect(runtime.published).toEqual([])
    expect(native.released).toEqual(["capture-task:1"])
  })

  test("policy mismatch и потерянный release reply возвращают quarantined cleanup", async () => {
    const native = new FakeNativeDriver(rawSuccess({ scale: 0.5 }))
    native.releaseFailures = 1
    const adapter = new RuntimeScreenAdapter(host, services(), native, () => new Date(nowMs))
    const result = await adapter.capture(context(), request())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.code).toBe("cleanup-incomplete")
    expect(result.outcome.cleanup.state).toBe("unknown")
    expect(result.outcome.cleanup.scope).toBe("owned")
    expect(native.releaseKeys).toHaveLength(1)
    expect(native.released).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)
  })

  test("unknown cleanup остаётся quarantined до status reconciliation", async () => {
    const native = new FakeNativeDriver(rawSuccess({ cleanup: "unknown", drained: false }))
    const runtime = services()
    const adapter = new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
    const result = await adapter.capture(context(), request())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.cleanup.state).toBe("unknown")
    expect(native.released).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)

    const status = await adapter.reconcileCapture("capture-task:1")
    expect(status.report.cleanup.state).toBe("complete")
    expect(status.report.operationId).toBe("operation:1")
    expect(status.report.cleanup.scope).toBe("owned")
    expect(native.released).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)
    expect(await adapter.reconcileCapture("capture-task:1")).toEqual(status)

    const receipt = cleanupReceipt(handle())
    await adapter.acknowledgeCaptureReconciliation("capture-task:1", receipt)
    expect(native.released).toEqual(["capture-task:1"])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(false)
    expect(adapter.hasCaptureTombstone("capture-task:1")).toBe(true)
    await expect(adapter.acknowledgeCaptureReconciliation("capture-task:1", receipt)).resolves.toBeUndefined()
    expect(native.releaseKeys).toHaveLength(1)
    await expect(adapter.acknowledgeCaptureReconciliation("capture-task:1", {
      ...receipt,
      receiptId: "cleanup-receipt:conflict",
    })).rejects.toThrow("конфликтует")
    expect(runtime.published).toHaveLength(1)
  })

  test("late cleanup проходит ResourceRegistry до native release", async () => {
    let id = 0
    const clock = { now: () => new Date(nowMs) }
    const ids = { next: (prefix: string) => `${prefix}:${++id}` }
    const registry = new ResourceRegistry(
      { runtimeEpoch, loginSessionId },
      new Uint8Array(32).fill(7),
      { clock, ids },
    )
    const baseContext = context()
    const resource = registry.acquire(
      baseContext.session,
      baseContext.wire.operationId,
      [{ kind: "capture-stream", resourceRef: request().publication.observationId }],
      expiresAt,
    )[0]!
    const runtime = {
      ...services(),
      resources: registry,
      cleanup: registry,
    }
    const native = new FakeNativeDriver(rawSuccess({ cleanup: "unknown", drained: false }))
    const adapter = new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
    const result = await adapter.capture({ ...baseContext, resources: [resource] }, request())
    expect(result.ok).toBe(true)
    registry.applyCleanup(baseContext.wire.operationId, [resource], result.outcome.cleanup)
    expect(registry.handlesForOperation(baseContext.wire.operationId)[0]?.state).toBe("quarantined")

    const reconciliation = await adapter.reconcileCapture("capture-task:1")
    expect(native.released).toEqual([])
    const receipt = registry.reconcileCleanup(
      reconciliation.report.operationId,
      [resource],
      reconciliation.report.cleanup,
    )
    expect(registry.handlesForOperation(baseContext.wire.operationId)).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)

    await adapter.acknowledgeCaptureReconciliation("capture-task:1", receipt)
    expect(native.released).toEqual(["capture-task:1"])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(false)
  })

  test("reconciliation не release task при unknown cleanup и drained=true", async () => {
    const native = new FakeNativeDriver(rawSuccess({ cleanup: "unknown", drained: false }))
    native.nextStatus = {
      taskRef: "capture-task:1",
      revision: 3,
      cleanup: "unknown",
      drained: true,
    }
    const adapter = new RuntimeScreenAdapter(host, services(), native, () => new Date(nowMs))
    const result = await adapter.capture(context(), request())
    expect(result.ok).toBe(true)
    await expect(adapter.reconcileCapture("capture-task:1")).rejects.toThrow("drained")
    expect(native.released).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)
  })

  test("потерянный release reply не вызывает blind retry и сохраняет pending stage", async () => {
    const native = new FakeNativeDriver()
    native.releaseFailures = 1
    const adapter = new RuntimeScreenAdapter(host, services(), native, () => new Date(nowMs))
    const result = await adapter.capture(context(), request())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected release failure")
    expect(result.error.code).toBe("cleanup-incomplete")
    expect(result.outcome.cleanup.state).toBe("unknown")
    expect(native.releaseKeys).toHaveLength(1)
    expect(native.released).toEqual([])
    expect(adapter.hasPendingCapture("capture-task:1")).toBe(true)
  })

  test("повторный taskRef не перезаписывает pending operation authority", async () => {
    const native = new FakeNativeDriver(rawSuccess({ cleanup: "unknown", drained: false }))
    const adapter = new RuntimeScreenAdapter(host, services(), native, () => new Date(nowMs))
    const first = await adapter.capture(context(), request())
    expect(first.ok).toBe(true)

    const secondContext = context()
    secondContext.wire.operationId = "operation:2"
    secondContext.resources = [handle("observation:1", "operation:2")]
    const second = await adapter.capture(secondContext, request())
    expect(second.ok).toBe(false)
    const reconciliation = await adapter.reconcileCapture("capture-task:1")
    expect(reconciliation.report.operationId).toBe("operation:1")
    expect(reconciliation.report.cleanup.scope).toBe("owned")
    if (reconciliation.report.cleanup.scope !== "owned") throw new Error("expected owned cleanup")
    expect(reconciliation.report.cleanup.resources[0]?.handle.operationId).toBe("operation:1")
  })

  test("bounded wait вызывает cancel и сохраняет unresolved task", async () => {
    const native = new FakeNativeDriver(new Promise<NativeCaptureCompletion>(() => {}))
    const runtime = services()
    const deadline = new Date(Date.now() + 15).toISOString()
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(), 10)
      .capture(context(captureTarget, deadline), request())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.code).toBe("operation-outcome-unknown")
    expect(result.outcome.cleanup.state).toBe("unknown")
    expect(native.cancelled).toEqual(["capture-task:1"])
    expect(native.released).toEqual([])
    expect(runtime.published).toEqual([])
  })

  test("composite не принимает producer confirmed occlusion как ownership", async () => {
    const producerEvidence: Evidence = {
      state: "confirmed",
      claim: "pixel-occlusion-clear",
      source: "producer-geometry",
      proof: {
        ...proof("frame-freshness", captureTarget, "proof:producer-occlusion"),
        kind: "frame-freshness",
      },
    }
    const native = new FakeNativeDriver(rawSuccess({ occlusion: producerEvidence }))
    const result = await new RuntimeScreenAdapter(host, services(), native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.observation.occlusion.state).toBe("unknown")
  })

  test("frame proof не превращается в interaction ownership readiness", async () => {
    const { publication: _, ...baseRequest } = request()
    const ownershipRequest = bindRequest({
      ...baseRequest,
      readinessPolicy: {
        policyId: "readiness:ownership",
        requiredSteps: ["complete-frame", "ownership"],
        disabledSteps: [],
      },
    })
    const result = await new RuntimeScreenAdapter(host, services(), new FakeNativeDriver(), () => new Date(nowMs))
      .capture(context(), ownershipRequest)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.observation.readiness.state).toBe("unavailable")
    expect(result.value.observation.readiness.steps.find(step => step.name === "ownership")?.state)
      .toBe("unavailable")
  })

  test("isolated window использует CG/PID и displays только из window resolution", async () => {
    const windowTarget = {
      kind: "window" as const,
      ref: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        applicationRef: "application:1",
        windowRef: "window:1",
      },
    }
    const { publication: _, ...baseRequest } = request()
    const windowRequest = bindRequest({
      ...baseRequest,
      source: "window-isolated",
      target: {
        kind: "window",
        target: windowTarget,
        cgWindowId: 77,
        ownerPid: 1234,
        mappingEvidence: {
          state: "confirmed",
          claim: "cg-ax-correlated",
          source: "runtime-target-authority",
          proof: proof("cg-ax-correlation", windowTarget),
        },
      },
    })
    const mapping = {
      kind: "window" as const,
      cgWindowId: 77,
      ownerPid: 1234,
      displays: [{ nativeDisplayId: 10, ref: displayRef }],
    }
    const native = new FakeNativeDriver(rawSuccess({
      source: "window-isolated",
      target: windowTarget,
      nativeMapping: mapping,
      targetEvidence: {
        shareableTargetMatched: true,
        beforeTargetMatched: false,
        afterTargetMatched: false,
        boundsUnchanged: false,
        auxiliarySurfacesExcluded: true,
      },
    }))
    const runtime = services(target => ({
      target,
      resolutionId: "resolution:window",
      proofRef: "proof:cg-ax-correlation",
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      nativeGeneration,
      nativeMapping: mapping,
    }))
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(windowTarget), windowRequest)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(native.requests[0]?.nativeMapping).toEqual(mapping)
    expect(result.value.observation.captureTarget).toEqual(windowTarget)
    expect(result.value.observation.source).toBe("window-isolated")
  })

  test("region display ID вне единственного authority resolution не публикуется", async () => {
    const native = new FakeNativeDriver(rawSuccess({
      regions: [{ ...rawSuccess().regions[0]!, nativeDisplayId: 999 }],
    }))
    const runtime = services()
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(false)
    expect(runtime.published).toEqual([])
  })

  test("PNG с повреждённым chunk CRC не достигает runtime frame store", async () => {
    const bytes = png()
    bytes[45] = (bytes[45] ?? 0) ^ 0xff
    const native = new FakeNativeDriver(rawSuccess({ bytes, encodedBytes: bytes.byteLength }))
    const runtime = services()
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected binary failure")
    expect(result.error.code).toBe("binary-frame-mismatch")
    expect(runtime.published).toEqual([])
  })

  test("foreign native frame receipt отклоняется до publication", async () => {
    const native = new FakeNativeDriver(rawSuccess({
      evidenceReceipt: {
        ...rawSuccess().evidenceReceipt,
        inventoryRevision: 99,
      },
    }))
    const runtime = services()
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs))
      .capture(context(), request())
    expect(result.ok).toBe(false)
    expect(runtime.published).toEqual([])
  })

  test("layout сохраняет отдельные display timestamps и exact skew", async () => {
    const secondDisplay: DisplayRef = {
      ...displayRef,
      displayRef: "display:2",
    }
    const layoutTarget = {
      kind: "desktop-layout" as const,
      ref: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        layoutRef: "layout:1",
        displayLayoutRevision: 3,
      },
    }
    const { publication: _, ...baseRequest } = request()
    if (baseRequest.target.kind !== "display") throw new Error("fixture должен быть display capture")
    const layoutRequest = bindRequest({
      ...baseRequest,
      target: {
        kind: "desktop-layout",
        target: layoutTarget,
        mappingEvidence: {
          state: "confirmed",
          claim: "layout-resolved",
          source: "runtime-target-authority",
          proof: proof("target-resolution", layoutTarget),
        },
        displays: [
          baseRequest.target,
          {
            kind: "display",
            target: { kind: "display", ref: secondDisplay },
            nativeDisplayId: 11,
            mappingEvidence: {
              state: "confirmed",
              claim: "native-display-resolved",
              source: "runtime-target-authority",
              proof: proof("target-resolution", { kind: "display", ref: secondDisplay }, "proof:display:2"),
            },
          },
        ],
      },
    })
    const bytes = png(2, 1)
    const layoutNative = rawSuccess({
      target: layoutTarget,
      nativeMapping: {
        kind: "desktop-layout",
        displays: [
          { ref: displayRef, nativeDisplayId: 10 },
          { ref: secondDisplay, nativeDisplayId: 11 },
        ],
      },
      widthPx: 2,
      encodedBytes: bytes.byteLength,
      bytes,
      capturedAt: new Date(nowMs + 10).toISOString(),
      evidenceReceipt: {
        ...rawSuccess().evidenceReceipt,
        observedAt: new Date(nowMs + 10).toISOString(),
      },
      regions: [
        rawSuccess().regions[0]!,
        {
          nativeDisplayId: 11,
          frameOrientation: "display-oriented",
          imageRect: { x: 1, y: 0, width: 1, height: 1 },
          destinationRect: { x: 0, y: 20, width: 1, height: 1 },
          imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: -1, ty: 20 },
          frameTimestamp: new Date(nowMs + 10).toISOString(),
          frameStatus: "complete",
        },
      ],
    })
    const layoutResolution = (target: OperationTarget): TargetResolution => ({
      target,
      resolutionId: "resolution:layout",
      proofRef: "proof:target-resolution",
      inventoryId: "inventory:1",
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      nativeGeneration,
      nativeMapping: {
        kind: "desktop-layout",
        displays: [
          { ref: displayRef, nativeDisplayId: 10 },
          { ref: secondDisplay, nativeDisplayId: 11 },
        ],
      },
    })
    const native = new FakeNativeDriver(layoutNative)
    const runtime = services(layoutResolution)
    const result = await new RuntimeScreenAdapter(host, runtime, native, () => new Date(nowMs + 10))
      .capture(context(layoutTarget), layoutRequest)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.ok).toBe(true)
    expect(result.value.observation.synchronization).toEqual({ kind: "stitched", maxSkewMs: 10 })
    expect(result.value.observation.regions.map(region => region.space.kind)).toEqual([
      "macos-screen",
      "macos-screen",
    ])

    const missingRuntime = services(layoutResolution)
    const missing = await new RuntimeScreenAdapter(
      host,
      missingRuntime,
      new FakeNativeDriver({ ...layoutNative, regions: [layoutNative.regions[0]!] }),
      () => new Date(nowMs + 10),
    ).capture(context(layoutTarget), layoutRequest)
    expect(missing.ok).toBe(false)
    expect(missingRuntime.published).toEqual([])

    const duplicateRuntime = services(layoutResolution)
    const duplicate = await new RuntimeScreenAdapter(
      host,
      duplicateRuntime,
      new FakeNativeDriver({
        ...layoutNative,
        regions: [
          layoutNative.regions[0]!,
          { ...layoutNative.regions[1]!, nativeDisplayId: 10 },
        ],
      }),
      () => new Date(nowMs + 10),
    ).capture(context(layoutTarget), layoutRequest)
    expect(duplicate.ok).toBe(false)
    expect(duplicateRuntime.published).toEqual([])
  })
})
