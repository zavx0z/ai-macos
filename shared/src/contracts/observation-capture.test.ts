import { describe, expect, test } from "bun:test"
import {
  assertBinaryFrameBytes,
  assertCaptureResultMatchesRequest,
  authorizeObservationPoint,
  authorizeScreenCapture,
  browserCaptureRequestSchema,
  capturePolicySha256,
  evidenceSchema,
  mapObservationPointGeometry,
  nativeBinaryFrameHeaderSchema,
  observationSchema,
  readinessResultSchema,
  screenCaptureRequestSchema,
  screenCaptureResultSchema,
  nativeExecutionContextSchema,
  runtimeResourceHandleSchema,
  verifyAndPublishBinaryFrame,
  validatePng,
  type BinaryFramePublisher,
  type Observation,
  type ProofAuthority,
  type ScreenAdapter,
} from "./index.ts"
import {
  deadlineAt,
  deviceBrowserTargetRef,
  displayRef,
  loginSessionId,
  nativeGeneration,
  host,
  nativeContext,
  proof,
  readyPolicy,
  readyResult,
  runtimeEpoch,
  resourceHandle,
  session,
  windowRef,
} from "./test-fixtures.ts"

const displayTarget = { kind: "display", ref: displayRef } as const
const windowTarget = { kind: "window", ref: windowRef } as const

function observation(overrides: Record<string, unknown> = {}): Observation {
  return observationSchema.parse({
    observationId: "observation:1",
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    captureTarget: displayTarget,
    caption: "Ожидаю увидеть основной дисплей",
    backend: { name: "screen-capture-kit", buildId: "native-build:1" },
    capturedAt: "2026-09-15T10:00:00.000Z",
    expiresAt: "2026-09-15T10:01:00.000Z",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    source: "display-composite",
    image: {
      frameRef: "frame:1",
      widthPx: 100,
      heightPx: 100,
      mime: "image/png",
      byteLength: 68,
      sha256: "a".repeat(64),
    },
    cursor: "excluded",
    clip: { x: 0, y: 0, width: 100, height: 100 },
    captureEvidence: {
      state: "confirmed",
      claim: "frame-fresh",
      source: "capture-runtime",
      proof: proof("frame-freshness", displayTarget),
    },
    occlusion: {
      state: "unknown",
      claim: "unknown",
      source: "compositor",
      reason: "occlusion не доказана",
    },
    readiness: readyResult,
    synchronization: { kind: "single-frame" },
    regions: [{
      space: { kind: "macos-screen", display: displayRef },
      imageRect: { x: 0, y: 0, width: 100, height: 100 },
      destinationRect: { x: -200, y: 20, width: 200, height: 200 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -200, ty: 20 },
      frameTimestamp: "2026-09-15T10:00:00.000Z",
      frameStatus: "complete",
    }],
    unavailableReasons: [],
    ...overrides,
  })
}

const proofAuthority: ProofAuthority = {
  async assertValid(proofValue, context) {
    if (
      proofValue.authorityRef !== "proof-authority:1"
      || proofValue.runtimeEpoch !== context.runtimeEpoch
      || proofValue.loginSessionId !== context.loginSessionId
      || proofValue.inventoryRevision !== context.inventoryRevision
      || proofValue.displayLayoutRevision !== context.displayLayoutRevision
    ) {
      throw new Error("proof authority rejected")
    }
  },
}

describe("C1 observation proof and coordinates", () => {
  test("confirmed evidence невозможно подделать source/confidence без proof", () => {
    expect(evidenceSchema.safeParse({
      state: "confirmed",
      claim: "owned",
      source: "guess",
      confidence: 0,
    }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation(), pointerActionable: true }).success).toBe(false)
  })

  test("display composite авторизует exact window point только через frame-bound interaction proof", async () => {
    const value = observation()
    const request = {
      observation: value,
      imagePoint: { x: 25, y: 40 },
      expectedCaptureTarget: displayTarget,
      interactionTarget: windowTarget,
      interactionProof: {
        proof: proof("pixel-ownership", windowTarget),
        observationId: value.observationId,
        frameRef: value.image.frameRef,
        regionIndex: 0,
        space: value.regions[0]!.space,
        coverage: { kind: "point" as const, point: { x: 25, y: 40 }, tolerancePx: 0 },
      },
      expectedSpace: "macos-screen" as const,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      deadlineAt,
      maxFrameAgeMs: 5_000,
      now: new Date("2026-09-15T10:00:01.000Z"),
    }
    const authorized = await authorizeObservationPoint(proofAuthority, request)
    expect(authorized.authorized).toBe(true)
    expect(authorized.interactionTarget).toEqual(windowTarget)
    expect(authorized.destinationPoint).toEqual({ x: -150, y: 100 })
    await expect(authorizeObservationPoint(proofAuthority, {
      ...request,
      expectedSpace: "browser-viewport",
    })).rejects.toThrow("coordinate space")
    await expect(authorizeObservationPoint(proofAuthority, {
      ...request,
      inventoryRevision: 5,
    })).rejects.toThrow("generations/revisions")
    await expect(authorizeObservationPoint(proofAuthority, {
      ...request,
      imagePoint: { x: 26, y: 40 },
    })).rejects.toThrow("Interaction proof")
    const nextFrame = observation({
      image: { ...value.image, frameRef: "frame:2" },
    })
    await expect(authorizeObservationPoint(proofAuthority, {
      ...request,
      observation: nextFrame,
    })).rejects.toThrow("Interaction proof")
  })

  test("future timestamp, stale region и неправильный transform не становятся actionable", async () => {
    const future = observation({
      capturedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
      regions: [{
        ...observation().regions[0],
        frameTimestamp: "2099-01-01T00:00:00.000Z",
      }],
    })
    await expect(authorizeObservationPoint(proofAuthority, {
      observation: future,
      imagePoint: { x: 1, y: 1 },
      expectedCaptureTarget: displayTarget,
      interactionTarget: windowTarget,
      interactionProof: {
        proof: proof("pixel-ownership", windowTarget),
        observationId: future.observationId,
        frameRef: future.image.frameRef,
        regionIndex: 0,
        space: future.regions[0]!.space,
        coverage: { kind: "point", point: { x: 1, y: 1 }, tolerancePx: 0 },
      },
      expectedSpace: "macos-screen",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      inventoryRevision: 4,
      displayLayoutRevision: 3,
      deadlineAt,
      maxFrameAgeMs: 5_000,
      now: new Date("2026-09-15T10:00:01.000Z"),
    })).rejects.toThrow("будущем")
    const stale = observation({ regions: [{ ...observation().regions[0], frameStatus: "stale" }] })
    expect(() => mapObservationPointGeometry(stale, { x: 1, y: 1 })).toThrow("complete frame")
    expect(observationSchema.safeParse({
      ...observation(),
      regions: [{
        ...observation().regions[0],
        imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      }],
    }).success).toBe(false)
  })

  test("readiness policy не допускает duplicate/false/skipped-by-deadline ready", () => {
    expect(readinessResultSchema.safeParse({
      state: "ready",
      policy: readyPolicy,
      steps: [
        { state: "reached", name: "complete-frame", durationMs: 1 },
        { state: "failed", name: "ownership", durationMs: 1, reason: "predicate false" },
      ],
      timedOut: false,
    }).success).toBe(false)
    expect(readinessResultSchema.safeParse({
      state: "ready",
      policy: readyPolicy,
      steps: [
        { state: "reached", name: "complete-frame", durationMs: 1 },
        { state: "skipped", name: "ownership", durationMs: 1, reason: "disabled-by-policy" },
      ],
      timedOut: false,
    }).success).toBe(false)
  })

  test("stitched skew выводится из timestamps, single frame не обязан быть stitched", () => {
    const region = observation().regions[0]!
    expect(observationSchema.safeParse({
      ...observation(),
      synchronization: { kind: "stitched", maxSkewMs: 99 },
      regions: [region, { ...region, imageRect: { x: 50, y: 0, width: 50, height: 100 }, frameTimestamp: "2026-09-15T10:00:00.010Z" }],
    }).success).toBe(false)
    expect(observation().synchronization).toEqual({ kind: "single-frame" })
  })
})

describe("C1 capture publication and binary bytes", () => {
  const publication = {
    observationId: "observation:1",
    frameRef: "frame:1",
    source: "display-composite" as const,
    captureTarget: displayTarget,
    capturePolicySha256: capturePolicySha256({
      clip: { kind: "full-target" },
      fullPage: false,
      cursor: "exclude",
      readinessPolicy: readyPolicy,
      output: {
        format: "image/png",
        scale: 1,
        maxWidthPx: 32_768,
        maxHeightPx: 32_768,
        maxPixels: 32_000_000,
        maxEncodedBytes: 64 * 1024 * 1024,
      },
    }),
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    expiresAt: "2026-09-15T10:01:00.000Z",
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    cacheScopeRef: "client:1",
  }
  const request = screenCaptureRequestSchema.parse({
    source: "display-composite",
    caption: "Ожидаю увидеть основной дисплей",
    publication,
    target: {
      kind: "display",
      target: displayTarget,
      nativeDisplayId: 1,
      mappingEvidence: {
        state: "confirmed",
        claim: "native-display-resolved",
        source: "native-registry",
        proof: proof("target-resolution", displayTarget),
      },
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: readyPolicy,
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 32_768,
      maxHeightPx: 32_768,
      maxPixels: 32_000_000,
      maxEncodedBytes: 64 * 1024 * 1024,
    },
  })
  const displayResolution = () => ({
    target: displayTarget,
    resolutionId: "resolution:display:1",
    proofRef: request.target.kind === "display" && request.target.mappingEvidence.state === "confirmed"
      ? request.target.mappingEvidence.proof.proofRef
      : "proof:none",
    inventoryId: publication.inventoryId,
    inventoryRevision: publication.inventoryRevision,
    displayLayoutRevision: publication.displayLayoutRevision,
    nativeGeneration,
    nativeMapping: { kind: "display" as const, display: { nativeDisplayId: 1, ref: displayRef } },
  })

  test("capture request сохраняет clip/fullPage/output/cursor/readiness policy", () => {
    expect(request.clip).toEqual({ kind: "full-target" })
    expect(request.output.maxPixels).toBe(32_000_000)
    expect(screenCaptureRequestSchema.safeParse({ ...request, fullPage: true }).success).toBe(false)
  })

  test("desktop layout отклоняет foreign display/native generation", () => {
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
    const displayMapping = request.target.kind === "display" ? request.target : undefined
    if (displayMapping === undefined) throw new Error("fixture должен быть display")
    expect(screenCaptureRequestSchema.safeParse({
      ...request,
      target: {
        kind: "desktop-layout",
        target: layoutTarget,
        mappingEvidence: {
          state: "confirmed",
          claim: "layout-resolved",
          source: "native-registry",
          proof: proof("target-resolution", layoutTarget),
        },
        displays: [
          displayMapping,
          {
            ...displayMapping,
            target: {
              kind: "display",
              ref: { ...displayRef, displayRef: "display:foreign", nativeGeneration: "native:foreign" },
            },
            nativeDisplayId: 2,
            mappingEvidence: {
              state: "confirmed",
              claim: "display-resolved",
              source: "native-registry",
              proof: proof("target-resolution", {
                kind: "display",
                ref: { ...displayRef, displayRef: "display:foreign", nativeGeneration: "native:foreign" },
              }, { nativeGeneration: "native:foreign" }),
            },
          },
        ],
      },
    }).success).toBe(false)
  })

  test("window capture regions точно совпадают с covered multi-display resolution set", () => {
    const secondDisplay = { ...displayRef, displayRef: "display:2" }
    const policy = {
      clip: { kind: "full-target" as const },
      fullPage: false,
      cursor: "exclude" as const,
      readinessPolicy: readyPolicy,
      output: request.output,
    }
    const windowPublication = {
      ...publication,
      observationId: "observation:window-span",
      frameRef: "frame:window-span",
      source: "window-isolated" as const,
      captureTarget: windowTarget,
      capturePolicySha256: capturePolicySha256(policy),
    }
    const windowRequest = screenCaptureRequestSchema.parse({
      source: "window-isolated",
      caption: "Ожидаю окно на двух дисплеях",
      publication: windowPublication,
      target: {
        kind: "window",
        target: windowTarget,
        cgWindowId: 77,
        ownerPid: 42,
        mappingEvidence: {
          state: "confirmed",
          claim: "cg-ax-corroborated",
          source: "native-registry",
          proof: proof("cg-ax-correlation", windowTarget),
        },
      },
      ...policy,
    })
    const windowObservation = observationSchema.parse({
      ...observation(),
      observationId: windowPublication.observationId,
      captureTarget: windowTarget,
      caption: windowRequest.caption,
      expiresAt: windowPublication.expiresAt,
      source: "window-isolated",
      image: {
        ...observation().image,
        frameRef: windowPublication.frameRef,
        widthPx: 2,
        heightPx: 1,
      },
      clip: { x: 0, y: 0, width: 2, height: 1 },
      captureEvidence: {
        state: "confirmed",
        claim: "frame-fresh",
        source: "runtime",
        proof: proof("frame-freshness", windowTarget),
      },
      regions: [
        {
          space: { kind: "macos-screen", display: displayRef },
          imageRect: { x: 0, y: 0, width: 1, height: 1 },
          destinationRect: { x: -1, y: 0, width: 1, height: 1 },
          imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: -1, ty: 0 },
          frameTimestamp: "2026-09-15T10:00:00.000Z",
          frameStatus: "complete",
        },
        {
          space: { kind: "macos-screen", display: secondDisplay },
          imageRect: { x: 1, y: 0, width: 1, height: 1 },
          destinationRect: { x: 0, y: 0, width: 1, height: 1 },
          imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: -1, ty: 0 },
          frameTimestamp: "2026-09-15T10:00:00.000Z",
          frameStatus: "complete",
        },
      ],
    })
    const frame = nativeBinaryFrameHeaderSchema.parse({
      frameRef: windowObservation.image.frameRef,
      observationId: windowObservation.observationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      source: windowObservation.source,
      target: windowTarget,
      capturedAt: windowObservation.capturedAt,
      widthPx: windowObservation.image.widthPx,
      heightPx: windowObservation.image.heightPx,
      byteLength: windowObservation.image.byteLength,
      sha256: windowObservation.image.sha256,
      mime: "image/png",
    })
    const result = screenCaptureResultSchema.parse({
      publication: windowPublication,
      observation: windowObservation,
      frame,
      effective: {
        clip: policy.clip,
        fullPage: false,
        cursor: "excluded",
        scale: policy.output.scale,
        widthPx: 2,
        heightPx: 1,
        pixelCount: 2,
        encodedBytes: windowObservation.image.byteLength,
        readinessPolicy: readyPolicy,
      },
      cleanup: { scope: "none", state: "complete", resources: [] },
    })
    const resolution = {
      target: windowTarget,
      resolutionId: "resolution:window-span",
      proofRef: windowRequest.target.kind === "window" && windowRequest.target.mappingEvidence.state === "confirmed"
        ? windowRequest.target.mappingEvidence.proof.proofRef
        : "proof:none",
      inventoryId: windowPublication.inventoryId,
      inventoryRevision: windowPublication.inventoryRevision,
      displayLayoutRevision: windowPublication.displayLayoutRevision,
      nativeGeneration,
      nativeMapping: {
        kind: "window" as const,
        cgWindowId: 77,
        ownerPid: 42,
        displays: [
          { nativeDisplayId: 1, ref: displayRef },
          { nativeDisplayId: 2, ref: secondDisplay },
        ],
      },
    }
    expect(() => assertCaptureResultMatchesRequest(windowRequest, result, resolution)).not.toThrow()
    expect(() => assertCaptureResultMatchesRequest(windowRequest, result, {
      ...resolution,
      nativeMapping: { ...resolution.nativeMapping, displays: [resolution.nativeMapping.displays[0]!] },
    })).toThrow("covered display set")
  })

  test("native display ID принимается только из authoritative target resolution", async () => {
    const wire = nativeExecutionContextSchema.parse({ ...nativeContext(), target: displayTarget })
    const handle = runtimeResourceHandleSchema.parse(resourceHandle("capture-stream", publication.observationId, wire.operationId))
    const adapter: ScreenAdapter = {
      host,
      capabilities: ["capture.desktop", "capture.observation"],
      services: {
        clientSessions: { async assertActive() {} },
        resources: { async assertActive() {}, async assertOwnedSet() {} },
        cleanup: { async verify() {} },
        evidence: {
          async issueTargetResolution() { throw new Error("not used") },
          async issueWindowCorrelation() { throw new Error("not used") },
          async issueFrameFreshness() { throw new Error("not used") },
          async issueInteractionPoint() { throw new Error("not used") },
        },
        targets: {
          async resolve(targetRequest) {
            return {
              target: targetRequest.target,
              resolutionId: "resolution:wrong-display",
              proofRef: request.target.kind === "display" && request.target.mappingEvidence.state === "confirmed"
                ? request.target.mappingEvidence.proof.proofRef
                : "proof:none",
              inventoryId: targetRequest.inventoryId,
              inventoryRevision: targetRequest.inventoryRevision,
              displayLayoutRevision: publication.displayLayoutRevision,
              nativeGeneration,
              nativeMapping: { kind: "display", display: { nativeDisplayId: 999, ref: displayRef } },
            }
          },
        },
        proofs: { async assertValid() {} },
        frames: { async publish() {} },
        observations: { async resolvePoint() { throw new Error("not used") } },
        continuations: {
          async issue() { throw new Error("not used") },
          async registerAcceptedTask() { throw new Error("not used") },
          async advanceVerifiedStatus() { throw new Error("not used") },
          async markVerifiedTerminal() { throw new Error("not used") },
        },
        reservations: { async assertChild() { throw new Error("not used") } },
      },
      async capture() { throw new Error("not used") },
    }
    await expect(authorizeScreenCapture(adapter, {
      wire,
      session,
      resources: [handle],
      control: { signal: new AbortController().signal, checkpoint() {} },
    }, request, new Date("2026-09-15T10:00:00Z"))).rejects.toThrow("native capture mapping")
    const correct: ScreenAdapter = {
      ...adapter,
      services: {
        ...adapter.services,
        targets: {
          async resolve(targetRequest) {
            return { ...displayResolution(), target: targetRequest.target }
          },
        },
      },
    }
    const resolution = await authorizeScreenCapture(correct, {
      wire,
      session,
      resources: [handle],
      control: { signal: new AbortController().signal, checkpoint() {} },
    }, request, new Date("2026-09-15T10:00:00Z"))
    expect(resolution.nativeMapping).toEqual({ kind: "display", display: { nativeDisplayId: 1, ref: displayRef } })
  })

  test("header, observation и actual PNG bytes связаны до publication", async () => {
    const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const value = observation({
      image: {
        frameRef: "frame:1",
        widthPx: 1,
        heightPx: 1,
        mime: "image/png",
        byteLength: bytes.byteLength,
        sha256,
      },
      clip: { x: 0, y: 0, width: 1, height: 1 },
      regions: [{
        space: { kind: "macos-screen", display: displayRef },
        imageRect: { x: 0, y: 0, width: 1, height: 1 },
        destinationRect: { x: -200, y: 20, width: 2, height: 2 },
        imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -200, ty: 20 },
        frameTimestamp: "2026-09-15T10:00:00.000Z",
        frameStatus: "complete",
      }],
    })
    const frame = nativeBinaryFrameHeaderSchema.parse({
      frameRef: "frame:1",
      observationId: value.observationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      source: value.source,
      target: value.captureTarget,
      capturedAt: value.capturedAt,
      widthPx: value.image.widthPx,
      heightPx: value.image.heightPx,
      byteLength: bytes.byteLength,
      sha256,
      mime: "image/png",
    })
    const result = screenCaptureResultSchema.parse({
      publication,
      observation: value,
      frame,
      effective: {
        clip: request.clip,
        fullPage: request.fullPage,
        cursor: "excluded",
        scale: request.output.scale,
        widthPx: value.image.widthPx,
        heightPx: value.image.heightPx,
        pixelCount: value.image.widthPx * value.image.heightPx,
        encodedBytes: value.image.byteLength,
        readinessPolicy: request.readinessPolicy,
      },
      cleanup: { scope: "none", state: "complete", resources: [] },
    })
    const resolution = displayResolution()
    assertCaptureResultMatchesRequest(request, result, resolution)
    let published = false
    const publisher: BinaryFramePublisher = {
      async publish(payload) {
        published = payload.bytes === bytes && payload.target.kind === "display"
      },
    }
    await verifyAndPublishBinaryFrame(publisher, request, result, bytes, resolution)
    expect(published).toBe(true)
    const tightOutput = { ...request.output, maxEncodedBytes: 1 }
    const tightRequest = screenCaptureRequestSchema.parse({
      ...request,
      publication: {
        ...request.publication,
        capturePolicySha256: capturePolicySha256({
          clip: request.clip,
          fullPage: request.fullPage,
          cursor: request.cursor,
          readinessPolicy: request.readinessPolicy,
          output: tightOutput,
        }),
      },
      output: tightOutput,
    })
    const tightResult = { ...result, publication: tightRequest.publication }
    expect(() => assertCaptureResultMatchesRequest(tightRequest, tightResult, resolution)).toThrow("requested capture policy")
    published = false
    await expect(verifyAndPublishBinaryFrame(publisher, tightRequest, tightResult, bytes, resolution)).rejects.toThrow("requested capture policy")
    expect(published).toBe(false)
    expect(() => assertBinaryFrameBytes(frame, bytes.subarray(0, bytes.length - 1))).toThrow("length")
    expect(nativeBinaryFrameHeaderSchema.safeParse({ ...frame, base64: "forbidden" }).success).toBe(false)
    expect(validatePng(bytes)).toEqual({ width: 1, height: 1 })
    expect(() => validatePng(bytes.subarray(0, 24))).toThrow()
    const corrupt = bytes.slice()
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff
    expect(() => validatePng(corrupt)).toThrow("CRC")
    const bomb = bytes.slice()
    const bombView = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength)
    bombView.setUint32(16, 32_768)
    bombView.setUint32(20, 32_768)
    bombView.setUint32(29, testCrc32(bomb.subarray(12, 16), bomb.subarray(16, 29)))
    expect(() => validatePng(bomb)).toThrow("memory budget")
  })

  test("browser/device capture source сохраняет serial и оба transport generations", () => {
    const policy = {
      clip: { kind: "full-target" as const },
      fullPage: true,
      cursor: "exclude" as const,
      readinessPolicy: readyPolicy,
      output: request.output,
    }
    expect(browserCaptureRequestSchema.parse({
      source: "device-browser-viewport",
      caption: "Ожидаю Android viewport",
      publication: {
        ...(({ nativeGeneration: _, ...browserPublication }) => browserPublication)(publication),
        source: "device-browser-viewport",
        captureTarget: { kind: "device-browser-target", ref: deviceBrowserTargetRef },
        capturePolicySha256: capturePolicySha256(policy),
      },
      target: { kind: "device-browser-target", ref: deviceBrowserTargetRef },
      ...policy,
    }).target.ref).toMatchObject({
      serial: "SERIAL-1",
      transportGeneration: "adb:1",
      browserTransportGeneration: "android-cdp:1",
      targetId: "android-target:1",
    })
  })
})

function testCrc32(type: Uint8Array, data: Uint8Array): number {
  let crc = 0xffffffff
  for (const chunk of [type, data]) {
    for (const byte of chunk) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
