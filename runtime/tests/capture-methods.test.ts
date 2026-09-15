import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  adapterResultSchema,
  capabilitySetSchema,
  freezeAdapterHostContext,
  operationOutcomeSchema,
  screenCaptureResultSchema,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeStatusRequest,
  type RuntimeOperationContext,
  type ScreenAdapter,
  type ScreenCaptureRequest,
  type z,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import {
  registerCaptureMethods,
} from "../src/capture-methods.ts"

const generation = { runtimeEpoch: "runtime:capture-methods", loginSessionId: "login:capture-methods" }
const nativeGeneration = "native:capture-methods"
const inventoryId = "inventory:capture-methods"
const inventoryRevision = 4
const displayLayoutRevision = 3
const displayRef = {
  ...generation,
  nativeGeneration,
  displayRef: "display:capture-methods",
  displayLayoutRevision,
}
const displayTarget = { kind: "display" as const, ref: displayRef }
const windowTarget = {
  kind: "window" as const,
  ref: {
    ...generation,
    nativeGeneration,
    applicationRef: "application:capture-methods",
    windowRef: "window:capture-methods",
  },
}
const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
))

class FakeNative implements NativeAdapter {
  readonly adapterInstanceRef = "native-adapter:capture-methods"
  readonly loadedBuildId = "native-build:capture-methods"
  readonly generation = { ...generation, nativeGeneration }
  readonly host = freezeAdapterHostContext({
    generation,
    runtimeBuildId: "runtime-build:capture-methods",
    capabilities: {
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "native-adapter:capture-methods",
      capabilities: [],
    },
  })
  readonly ledgerSink = { async persist() { throw new Error("not used") } }
  readonly evidencePublisher = { async publish() { throw new Error("not used") } }
  wire: NativeExecutionContext | undefined

  async handshake(): Promise<never> { throw new Error("not used") }
  async request<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    _requestSchema: RequestSchema,
    _request: z.input<RequestSchema>,
    _responseSchema: ResponseSchema,
  ): Promise<z.output<ResponseSchema>> { throw new Error("not used") }
  async cleanup<RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    _requestSchema: RequestSchema,
    _request: z.input<RequestSchema>,
    _responseSchema: ResponseSchema,
  ): Promise<z.output<ResponseSchema>> { throw new Error("not used") }
  async heartbeat(): Promise<never> { throw new Error("not used") }
  async cancel(): Promise<never> { throw new Error("not used") }
  async drain(): Promise<never> { throw new Error("not used") }
  async *events(): AsyncIterable<never> {}
  async close(): Promise<void> {}

  async status(request: NativeStatusRequest) {
    if (this.wire === undefined) throw new Error("Capture context не сохранён")
    return nativeStatus(this.wire, request.requestId)
  }
}

class FakeScreen implements ScreenAdapter {
  readonly capabilities = ["capture.desktop", "capture.window", "capture.observation"] as const
  calls: ScreenCaptureRequest[] = []

  constructor(
    readonly host: ReturnType<typeof freezeAdapterHostContext>,
    readonly services: RuntimeCore["services"],
    readonly runtime: RuntimeCore,
    readonly native: FakeNative,
  ) {}

  async capture(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: ScreenCaptureRequest,
  ) {
    this.calls.push(request)
    this.native.wire = context.wire
    const sha256 = new Bun.CryptoHasher("sha256").update(png).digest("hex")
    await this.runtime.frames.publish({
      frameRef: request.publication.frameRef,
      observationId: request.publication.observationId,
      ...generation,
      nativeGeneration,
      source: request.source,
      target: request.target.target,
      capturedAt: new Date().toISOString(),
      widthPx: 1,
      heightPx: 1,
      mime: "image/png",
      expectedByteLength: png.byteLength,
      expectedSha256: sha256,
      bytes: png,
    })
    const capturedAt = new Date().toISOString()
    const frameProof = this.runtime.proofs.issue({
      kind: "frame-freshness",
      subject: request.target.target,
      inventoryRevision: request.publication.inventoryRevision,
      displayLayoutRevision: request.publication.displayLayoutRevision,
      ttlMs: 10_000,
    })
    const cleanup = {
      scope: "owned" as const,
      state: "complete" as const,
      resources: context.resources.map(handle => ({ handle, outcome: "released" as const })),
    }
    const readiness = {
      state: "ready" as const,
      policy: request.readinessPolicy,
      steps: request.readinessPolicy.requiredSteps.map(name => ({
        name,
        state: "reached" as const,
        durationMs: 0,
      })),
      timedOut: false,
    }
    const result = screenCaptureResultSchema.parse({
      publication: request.publication,
      observation: {
        observationId: request.publication.observationId,
        ...generation,
        nativeGeneration,
        captureTarget: request.target.target,
        caption: request.caption,
        backend: { name: "fixture", buildId: "native-build:capture-methods" },
        capturedAt,
        expiresAt: request.publication.expiresAt,
        inventoryRevision: request.publication.inventoryRevision,
        displayLayoutRevision: request.publication.displayLayoutRevision,
        source: request.source,
        image: {
          frameRef: request.publication.frameRef,
          widthPx: 1,
          heightPx: 1,
          mime: "image/png",
          byteLength: png.byteLength,
          sha256,
        },
        cursor: request.cursor === "include" ? "included" : "excluded",
        clip: { x: 0, y: 0, width: 1, height: 1 },
        captureEvidence: {
          state: "confirmed",
          claim: "frame-freshness",
          source: "runtime-proof",
          proof: frameProof,
        },
        occlusion: {
          state: "unknown",
          claim: "pixel-occlusion",
          source: "fixture",
          reason: "not observed",
        },
        readiness,
        synchronization: { kind: "single-frame" },
        regions: [{
          space: { kind: "macos-screen", display: displayRef },
          imageRect: { x: 0, y: 0, width: 1, height: 1 },
          destinationRect: { x: 0, y: 0, width: 1, height: 1 },
          imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          frameTimestamp: capturedAt,
          frameStatus: "complete",
        }],
        unavailableReasons: [],
      },
      frame: {
        frameRef: request.publication.frameRef,
        observationId: request.publication.observationId,
        ...generation,
        nativeGeneration,
        source: request.source,
        target: request.target.target,
        capturedAt,
        widthPx: 1,
        heightPx: 1,
        byteLength: png.byteLength,
        sha256,
        mime: "image/png",
      },
      effective: {
        clip: request.clip,
        fullPage: false,
        cursor: request.cursor === "include" ? "included" : "excluded",
        scale: request.output.scale,
        widthPx: 1,
        heightPx: 1,
        pixelCount: 1,
        encodedBytes: png.byteLength,
        readinessPolicy: request.readinessPolicy,
      },
      cleanup,
    })
    return {
      ok: true as const,
      value: result,
      outcome: operationOutcomeSchema.parse({
        dispatch: "none",
        targetVerified: "verified",
        userInterference: "unknown",
        observation: "available",
        effect: { state: "unverified", proofRefs: [] },
        cleanup,
        restoration: "not-applicable",
        dispatchAttempts: 0,
      }),
    }
  }
}

function nativeStatus(wire: NativeExecutionContext, requestId: string) {
  const timestamp = new Date().toISOString()
  return {
    requestId,
    runtimeEpoch: wire.runtimeEpoch,
    loginSessionId: wire.loginSessionId,
    nativeGeneration: wire.nativeGeneration,
    highWaterFence: wire.fence,
    acceptedFence: wire.fence,
    operationId: wire.operationId,
    execution: "finished" as const,
    dispatch: "finished" as const,
    cleanup: "complete" as const,
    targetVerified: "verified" as const,
    cancellationRequested: false,
    userInterference: "unknown" as const,
    restorationAllowed: false,
    quarantined: false,
    heldCount: 0,
    lastCheckpoint: "capture-complete",
    dispatchAttempts: 1,
    ledgerRevision: 0,
    observer: {
      state: "unavailable" as const,
      runtimeEpoch: wire.runtimeEpoch,
      loginSessionId: wire.loginSessionId,
      nativeGeneration: wire.nativeGeneration,
      coverageStartCursor: "observer:start",
      cursor: "observer:current",
      nextSequence: 1,
      startedAt: timestamp,
      coveredFrom: timestamp,
      coveredThrough: timestamp,
      heartbeatAt: timestamp,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: true,
      reason: "fixture observer unavailable",
    },
  }
}

function runtimeFixture() {
  const native = new FakeNative()
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:capture-methods",
    nativeGeneration,
    native,
    secret: new Uint8Array(32).fill(7),
    ids: (() => {
      let index = 0
      return { next: (prefix: string) => `${prefix}:${++index}` }
    })(),
  })
  runtime.updateCapabilities(capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:capture-methods",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })),
  }))
  const targetProof = runtime.proofs.issue({
    kind: "target-resolution",
    subject: displayTarget,
    inventoryRevision,
    displayLayoutRevision,
    ttlMs: 60_000,
  })
  runtime.targets.register(
    displayTarget,
    inventoryId,
    inventoryRevision,
    "resolution:display",
    targetProof.proofRef,
    displayLayoutRevision,
    { kind: "display", display: { nativeDisplayId: 10, ref: displayRef } },
  )
  const windowProof = runtime.proofs.issue({
    kind: "cg-ax-correlation",
    subject: windowTarget,
    inventoryRevision,
    displayLayoutRevision,
    ttlMs: 60_000,
  })
  runtime.targets.register(
    windowTarget,
    inventoryId,
    inventoryRevision,
    "resolution:window",
    windowProof.proofRef,
    displayLayoutRevision,
    {
      kind: "window",
      cgWindowId: 77,
      ownerPid: 1234,
      displays: [{ nativeDisplayId: 10, ref: displayRef }],
    },
  )
  const screen = new FakeScreen(native.host, runtime.services, runtime, native)
  const registry = new MethodRegistry(runtime)
  const methods = registerCaptureMethods(registry, runtime, screen)
  return { methods, native, runtime, screen, registry, targetProof, windowProof }
}

function windowCaptureInput(
  proof: ReturnType<RuntimeCore["proofs"]["issue"]>,
  clientRequestId = "capture-window-request:1",
) {
  const base = captureInput(proof, clientRequestId)
  return {
    ...base,
    caption: "Ожидаю runtime-owned isolated window frame",
    target: {
      kind: "window" as const,
      target: windowTarget,
      cgWindowId: 77,
      ownerPid: 1234,
      mappingEvidence: {
        state: "confirmed" as const,
        claim: "window-correlated",
        source: "runtime-target-authority",
        proof,
      },
    },
  }
}

function captureInput(
  targetProof: ReturnType<RuntimeCore["proofs"]["issue"]>,
  clientRequestId = "capture-request:1",
) {
  return {
    clientRequestId,
    inventoryId,
    caption: "Ожидаю runtime-owned desktop frame",
    target: {
      kind: "display" as const,
      target: displayTarget,
      nativeDisplayId: 10,
      mappingEvidence: {
        state: "confirmed" as const,
        claim: "display-resolved",
        source: "runtime-target-authority",
        proof: targetProof,
      },
    },
    clip: { kind: "full-target" as const },
    cursor: "exclude" as const,
    readinessPolicy: {
      policyId: "readiness:capture-methods",
      requiredSteps: ["permission", "target", "complete-frame"] as const,
      disabledSteps: [],
    },
    output: {
      format: "image/png" as const,
      scale: 1,
      maxWidthPx: 100,
      maxHeightPx: 100,
      maxPixels: 10_000,
      maxEncodedBytes: 1_000_000,
    },
  }
}

test("capture catalogue reserves IDs, commits observation and emits lineage frame refs", async () => {
  const fixture = runtimeFixture()
  const session = fixture.runtime.openClient("principal:capture").session
  const input = captureInput(fixture.targetProof)
  expect(fixture.registry.descriptors().tools.map(tool => tool.name)).toEqual([
    "capture_desktop",
    "capture_window",
    "get_observation",
    "latest_capture",
  ])
  const captured = await fixture.registry.dispatch(session, "capture_desktop", input, new AbortController().signal)
  expect(captured.frameRefs).toHaveLength(1)
  expect(captured.data.frameAvailable).toBe(true)
  expect(fixture.screen.calls).toHaveLength(1)
  expect(fixture.screen.calls[0]?.publication.cacheScopeRef).toBe(fixture.runtime.clients.lineage(session))
  expect("publication" in input).toBe(false)

  const observationId = fixture.screen.calls[0]!.publication.observationId
  const observation = await fixture.registry.dispatch(session, "get_observation", { observationId }, new AbortController().signal)
  expect(observation.frameRefs).toEqual(captured.frameRefs)
  expect(observation.data.frameAvailable).toBe(true)
  const latest = await fixture.registry.dispatch(session, "latest_capture", {}, new AbortController().signal)
  expect(latest.frameRefs).toEqual(captured.frameRefs)
  expect(latest.data).toMatchObject({ changed: true, version: 1 })
  const unchanged = await fixture.registry.dispatch(session, "latest_capture", { after: 1 }, new AbortController().signal)
  expect(unchanged).toEqual({
    data: { changed: false, version: 1, frameAvailable: true },
    frameRefs: [],
  })

  await fixture.registry.dispatch(session, "capture_desktop", input, new AbortController().signal)
  expect(fixture.screen.calls).toHaveLength(1)
})

test("observation and latest remain scoped to authenticated lineage", async () => {
  const fixture = runtimeFixture()
  const first = fixture.runtime.openClient("principal:first").session
  const second = fixture.runtime.openClient("principal:second").session
  const input = captureInput(fixture.targetProof)
  await fixture.registry.dispatch(first, "capture_desktop", input, new AbortController().signal)
  const observationId = fixture.screen.calls[0]!.publication.observationId
  await expect(fixture.registry.dispatch(
    second,
    "get_observation",
    { observationId },
    new AbortController().signal,
  )).rejects.toThrow("lineage")
  expect(await fixture.registry.dispatch(second, "latest_capture", {}, new AbortController().signal)).toEqual({
    data: { changed: false, version: 0, frameAvailable: false },
    frameRefs: [],
  })
})

test("capture_window builds isolated request from runtime-owned publication", async () => {
  const fixture = runtimeFixture()
  const session = fixture.runtime.openClient("principal:window-capture").session
  const result = await fixture.registry.dispatch(
    session,
    "capture_window",
    windowCaptureInput(fixture.windowProof),
    new AbortController().signal,
  )
  expect(result.frameRefs).toHaveLength(1)
  expect(fixture.screen.calls).toHaveLength(1)
  expect(fixture.screen.calls[0]).toMatchObject({
    source: "window-isolated",
    target: { kind: "window", cgWindowId: 77, ownerPid: 1234 },
    publication: { captureTarget: windowTarget },
  })
})
