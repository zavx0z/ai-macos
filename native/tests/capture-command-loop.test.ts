import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  capturePolicySha256,
  heldInputLedgerDigest,
  nativeHeartbeatRequestSchema,
  type NativeCleanupControl,
  type ScreenCaptureRequest,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import { extractNativeEvidenceReports } from "../src/evidence-extractor.ts"
import {
  nativeCaptureCleanupRequestSchema,
  nativeCaptureCleanupResponseSchema,
  nativeCaptureStartRequestSchema,
  nativeCaptureStartResponseSchema,
} from "../src/protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-capture-command-loop."))
  binary = join(directory, "fixture")
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m",
    "broker_transport.m",
    "operation-receipts/meta_operation_receipts.m",
    "input_job.m",
    "input_executor.m",
    "input_bridge.c",
    "executor.c",
    "ledger.c",
    "broker_core.c",
    "capture_router.m",
    "capture-command/meta_capture_command.m",
    "capture/meta_capture.m",
    "serialization.m",
    "observer/meta_observer.m",
    "observer-index/meta_observer_target_index.m",
    "observer-command/meta_observer_command.m",
  ].map(path => join(native, "src", path))
  const compile = Bun.spawn([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-fblocks",
    "-DMETA_CAPTURE_ROUTER_TESTING=1",
    "-mmacosx-version-min=13.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(native, "include")}`,
    `-I${join(native, "src")}`,
    `-I${join(native, "src/observer")}`,
    `-I${join(native, "src/observer-index")}`,
    ...sources,
    join(import.meta.dir, "capture-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "CoreImage",
    "-framework",
    "CoreMedia",
    "-framework",
    "CoreVideo",
    "-framework",
    "ImageIO",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "Security",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 20_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}

const displayRef = {
  ...generation,
  displayRef: "display-1",
  displayLayoutRevision: 1,
}

const secondDisplayRef = {
  ...generation,
  displayRef: "display-2",
  displayLayoutRevision: 1,
}

const target = { kind: "display" as const, ref: displayRef }
const layoutTarget = {
  kind: "desktop-layout" as const,
  ref: { ...generation, layoutRef: "layout-1", displayLayoutRevision: 1 },
}
const expectedPng = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
))

function screenRequest(now: Date): ScreenCaptureRequest {
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 60_000).toISOString()
  const base: Omit<ScreenCaptureRequest, "publication"> = {
    source: "display-composite",
    caption: "Ожидаю увидеть один пиксель fixture display",
    target: {
      kind: "display",
      target,
      nativeDisplayId: 10,
      mappingEvidence: {
        state: "confirmed",
        claim: "display-resolved",
        source: "fixture-authority",
        proof: {
          proofRef: "proof-target-1",
          authorityRef: "authority-1",
          kind: "target-resolution",
          subject: target,
          ...generation,
          inventoryRevision: 1,
          displayLayoutRevision: 1,
          issuedAt,
          expiresAt,
        },
      },
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: {
      policyId: "readiness-fixture-1",
      requiredSteps: ["permission", "target", "complete-frame"],
      disabledSteps: [],
    },
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 1,
      maxHeightPx: 1,
      maxPixels: 1,
      maxEncodedBytes: 1_000_000,
    },
  }
  return {
    ...base,
    publication: {
      observationId: "observation-1",
      frameRef: "frame-1",
      source: base.source,
      captureTarget: target,
      capturePolicySha256: capturePolicySha256(base),
      ...generation,
      expiresAt,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      cacheScopeRef: "cache-scope-1",
    },
  }
}

function layoutScreenRequest(now: Date): ScreenCaptureRequest {
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 60_000).toISOString()
  const display = (ref: typeof displayRef, nativeDisplayId: number) => ({
    kind: "display" as const,
    target: { kind: "display" as const, ref },
    nativeDisplayId,
    mappingEvidence: {
      state: "confirmed" as const,
      claim: `display-${nativeDisplayId}-resolved`,
      source: "fixture-authority",
      proof: {
        proofRef: `proof-target-${nativeDisplayId}`,
        authorityRef: "authority-1",
        kind: "target-resolution" as const,
        subject: { kind: "display" as const, ref },
        ...generation,
        inventoryRevision: 1,
        displayLayoutRevision: 1,
        issuedAt,
        expiresAt,
      },
    },
  })
  const base: Omit<ScreenCaptureRequest, "publication"> = {
    source: "display-composite",
    caption: "Ожидаю layout из двух fixture displays",
    target: {
      kind: "desktop-layout",
      target: layoutTarget,
      mappingEvidence: {
        state: "confirmed",
        claim: "desktop-layout-resolved",
        source: "fixture-authority",
        proof: {
          proofRef: "proof-layout-1",
          authorityRef: "authority-1",
          kind: "target-resolution",
          subject: layoutTarget,
          ...generation,
          inventoryRevision: 1,
          displayLayoutRevision: 1,
          issuedAt,
          expiresAt,
        },
      },
      displays: [display(displayRef, 10), display(secondDisplayRef, 20)],
    },
    clip: { kind: "full-target" },
    fullPage: false,
    cursor: "exclude",
    readinessPolicy: {
      policyId: "readiness-layout-fixture-1",
      requiredSteps: ["permission", "target", "complete-frame"],
      disabledSteps: [],
    },
    output: {
      format: "image/png",
      scale: 1,
      maxWidthPx: 4,
      maxHeightPx: 2,
      maxPixels: 8,
      maxEncodedBytes: 1_000_000,
    },
  }
  return {
    ...base,
    publication: {
      observationId: "observation-layout-1",
      frameRef: "frame-layout-1",
      source: base.source,
      captureTarget: layoutTarget,
      capturePolicySha256: capturePolicySha256(base),
      ...generation,
      expiresAt,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      cacheScopeRef: "cache-scope-layout-1",
    },
  }
}

function operation(
  deadlineAt: string,
  operationId = "operation-1",
  operationTarget: typeof target | typeof layoutTarget = target,
  counter = 1,
) {
  return {
    kind: "native" as const,
    operationId,
    clientRequestId: `client-request-${counter}`,
    clientSessionId: "client-1",
    principalId: "principal-1",
    ...generation,
    deadlineAt,
    inventoryId: "inventory-1",
    inventoryRevision: 1,
    fence: { ...generation, counter },
    target: operationTarget,
  }
}

function cleanupControl(
  purpose: NativeCleanupControl["purpose"],
  expectedStatusRevision: number,
  expectedDrainedEvidenceRef: string,
  requestId: string,
  operationId = "operation-1",
  counter = 1,
): NativeCleanupControl {
  return {
    kind: "cleanup-only",
    purpose,
    requestId,
    cleanupRequestId: `cleanup-${purpose}-1`,
    operationId,
    ...generation,
    acceptedFence: { ...generation, counter },
    currentHighWaterFence: { ...generation, counter },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    expectedStatusRevision,
    expectedDrainedEvidenceRef,
  }
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

test("production command loop проводит observer ACK перед PUSH и capture lifecycle", async () => {
  const registeredSources: Array<{ ref: string, bytes: Uint8Array }> = []
  const immutableSources = new Map<string, string>()
  const extractedFactRefs: string[] = []
  const transport = new NativeProcessTransport(binary)
  const channels: string[] = []
  const adapter = new NativeBrokerAdapter({
    host: {
      generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId },
      runtimeBuildId: "runtime-build-1",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "capture-loop-adapter",
        capabilities: [],
      },
    },
    adapterInstanceRef: "capture-loop-adapter",
    transport: {
      send: frame => transport.send(frame),
      close: () => transport.close(),
      async *packets(signal) {
        for await (const packet of transport.packets(signal)) {
          if (packet.kind === "message") channels.push(packet.frame.channel)
          yield packet
        }
      },
    },
    ledgerSink: {
      async persist(requestId, snapshot) {
        return {
          requestId,
          operationId: snapshot.operationId,
          runtimeEpoch: snapshot.runtimeEpoch,
          loginSessionId: snapshot.loginSessionId,
          nativeGeneration: snapshot.nativeGeneration,
          revision: snapshot.revision,
          snapshotSha256: heldInputLedgerDigest(snapshot),
          persistedAt: new Date().toISOString(),
          durable: true as const,
        }
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Fixture не публикует producer-authored evidence")
        },
      },
      sourceResponses: {
        register(ref, bytes) {
          const copy = Uint8Array.from(bytes)
          const encoded = Buffer.from(copy).toString("base64")
          const previous = immutableSources.get(ref)
          if (previous !== undefined && previous !== encoded) {
            throw new Error(`Source response ref ${ref} переиспользован для других raw bytes`)
          }
          immutableSources.set(ref, encoded)
          const facts = extractNativeEvidenceReports(copy)
          if (!facts.some(fact => fact.sourceResponseRef === ref)) {
            throw new Error(`Source response ${ref} не извлекает exact native fact`)
          }
          extractedFactRefs.push(...facts.map(fact => fact.sourceResponseRef))
          registeredSources.push({ ref, bytes: copy })
        },
      },
    }),
  })
  let layoutAdapter: NativeBrokerAdapter | undefined

  try {
    const handshake = await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "capture-loop-build",
      capabilitySchemaVersion: "1",
    }, AbortSignal.timeout(5_000))
    expect(handshake.nativeGeneration).toBe(generation.nativeGeneration)

    const observerRequest = {
      kind: "observer" as const,
      protocolVersion: "1" as const,
      requestId: "observer-prepare-1",
      ...generation,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      command: "prepare" as const,
    }
    const prepared = await adapter.observer(observerRequest, control())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.message)
    const eventStream = adapter.events(AbortSignal.timeout(5_000))[Symbol.asyncIterator]()
    const pushed = await eventStream.next()
    expect(pushed.value?.observerInstanceRef).toBe(prepared.snapshot.observerInstanceRef)
    expect(channels.indexOf("observer")).toBeLessThan(channels.indexOf("event"))
    const backfill = await adapter.observer({
      ...observerRequest,
      command: "events",
      requestId: "observer-events-1",
      observerInstanceRef: prepared.snapshot.observerInstanceRef,
      afterCursor: prepared.snapshot.coverage.coverageStartCursor,
    }, control())
    expect(backfill.ok).toBe(true)
    if (!backfill.ok) throw new Error(backfill.error.message)
    expect(backfill.events?.some(event => event.eventId === pushed.value?.eventId)).toBe(true)
    const wrongInstance = await adapter.observer({
      ...observerRequest,
      command: "coverage",
      requestId: "observer-stale-1",
      observerInstanceRef: "wrong-observer-instance",
    }, control())
    expect(wrongInstance.ok).toBe(false)
    await eventStream.return?.()

    const now = new Date()
    const deadlineAt = new Date(now.getTime() + 10_000).toISOString()
    const request = nativeCaptureStartRequestSchema.parse({
      kind: "request",
      protocolVersion: "1",
      requestId: "capture-start-1",
      ...generation,
      deadlineAt,
      intent: "mutation",
      method: "capture.start",
      operation: operation(deadlineAt),
      payload: {
        request: screenRequest(now),
        nativeMapping: {
          kind: "display",
          display: { nativeDisplayId: 10, ref: displayRef },
        },
        captureTimeoutMs: 1_000,
        stopTimeoutMs: 100,
      },
    })
    const started = await adapter.request(
      nativeCaptureStartRequestSchema,
      request,
      nativeCaptureStartResponseSchema,
      control(),
    )
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error(started.error.message)
    expect(started.result.status.startPending).toBe(true)
    expect(started.result.operationId).toBe("operation-1")

    const heartbeatRequest = nativeHeartbeatRequestSchema.parse({
      requestId: "heartbeat-1",
      ...generation,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    })
    const heartbeat = await adapter.heartbeat(heartbeatRequest, control())
    expect(heartbeat.accepted).toBe(true)

    const pendingRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "result",
        1,
        started.result.statusEvidenceRef,
        "capture-result-pending-1",
      ),
      payload: { captureTaskRef: started.result.captureTaskRef },
    })
    const pending = await adapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      pendingRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(pending.purpose).toBe("result")
    if (pending.purpose !== "result") throw new Error("Ожидался result cleanup")
    expect(pending.poll.state).toBe("pending")

    await Bun.sleep(30)
    const completedRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "result",
        1,
        started.result.statusEvidenceRef,
        "capture-result-complete-1",
      ),
      payload: { captureTaskRef: started.result.captureTaskRef },
    })
    const completed = await adapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      completedRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(completed.purpose).toBe("result")
    if (completed.purpose !== "result" || completed.poll.state !== "completed") {
      throw new Error("Capture completion не доставлена")
    }
    expect(completed.poll.status.cleanup).toBe("complete")
    expect(completed.poll.status.drained).toBe(true)
    expect(completed.poll.result.sourceResponseRef).not.toBe(started.result.sourceResponseRef)
    expect(completed.poll.result.frame?.frameStatus).toBe("complete")
    expect(completed.poll.result.frame?.widthPx).toBe(1)
    expect(completed.poll.result.frame?.heightPx).toBe(1)
    expect(completed.poll.result.nativeMapping).toEqual(request.payload.nativeMapping)

    const frame = completed.poll.result.frame
    if (frame === undefined) throw new Error("Capture frame отсутствует")
    const binaryBytes = await adapter.takeBinary(
      frame.binaryToken,
      frame.encodedBytes,
      AbortSignal.timeout(3_000),
    )
    expect(binaryBytes).toEqual(expectedPng)
    expect(registeredSources.length).toBeGreaterThanOrEqual(2)
    expect(new Set(registeredSources.map(source => source.ref)).size).toBe(registeredSources.length)
    expect(extractedFactRefs).toEqual(expect.arrayContaining(registeredSources.map(source => source.ref)))
    expect(new Bun.CryptoHasher("sha256").update(binaryBytes).digest("hex")).toBe(frame.sha256)

    const drainedEvidenceRef = completed.poll.result.drainedEvidenceRef
    if (drainedEvidenceRef === undefined) throw new Error("Drained evidence отсутствует")
    const releaseRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "release",
        completed.poll.status.revision,
        drainedEvidenceRef,
        "capture-release-1",
      ),
      payload: { captureTaskRef: started.result.captureTaskRef },
    })
    const released = await adapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      releaseRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(released.purpose).toBe("release")
    if (released.purpose !== "release") throw new Error("Ожидался release cleanup")
    expect(released.ack.cleanup).toBe("complete")
    expect(released.alreadyReleased).toBe(false)

    const layoutRegisteredSources: Array<{ ref: string, bytes: Uint8Array }> = []
    const layoutImmutableSources = new Map<string, string>()
    const layoutTransport = new NativeProcessTransport(binary)
    layoutAdapter = new NativeBrokerAdapter({
      host: {
        generation: { runtimeEpoch: generation.runtimeEpoch, loginSessionId: generation.loginSessionId },
        runtimeBuildId: "runtime-build-1",
        capabilities: {
          schemaVersion: "1",
          scope: "adapter",
          producerRef: "capture-layout-loop-adapter",
          capabilities: [],
        },
      },
      adapterInstanceRef: "capture-layout-loop-adapter",
      transport: layoutTransport,
      ledgerSink: {
        async persist(requestId, snapshot) {
          return {
            requestId,
            operationId: snapshot.operationId,
            runtimeEpoch: snapshot.runtimeEpoch,
            loginSessionId: snapshot.loginSessionId,
            nativeGeneration: snapshot.nativeGeneration,
            revision: snapshot.revision,
            snapshotSha256: heldInputLedgerDigest(snapshot),
            persistedAt: new Date().toISOString(),
            durable: true as const,
          }
        },
      },
      bindEvidence: () => ({
        publisher: {
          async publish() {
            throw new Error("Layout fixture не публикует producer-authored evidence")
          },
        },
        sourceResponses: {
          register(ref, bytes) {
            const copy = Uint8Array.from(bytes)
            const encoded = Buffer.from(copy).toString("base64")
            const previous = layoutImmutableSources.get(ref)
            if (previous !== undefined && previous !== encoded) {
              throw new Error(`Layout source response ref ${ref} переиспользован для других raw bytes`)
            }
            layoutImmutableSources.set(ref, encoded)
            const facts = extractNativeEvidenceReports(copy)
            if (!facts.some(fact => fact.sourceResponseRef === ref)) {
              throw new Error(`Layout source response ${ref} не извлекает exact native fact`)
            }
            layoutRegisteredSources.push({ ref, bytes: copy })
          },
        },
      }),
    })
    const layoutHandshake = await layoutAdapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "layout-handshake-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "capture-loop-build",
      capabilitySchemaVersion: "1",
    }, AbortSignal.timeout(5_000))
    expect(layoutHandshake.nativeGeneration).toBe(generation.nativeGeneration)

    const layoutDeadlineAt = new Date(Date.now() + 10_000).toISOString()
    const layoutRequest = nativeCaptureStartRequestSchema.parse({
      kind: "request",
      protocolVersion: "1",
      requestId: "capture-layout-start-1",
      ...generation,
      deadlineAt: layoutDeadlineAt,
      intent: "mutation",
      method: "capture.start",
      operation: operation(layoutDeadlineAt, "operation-layout-1", layoutTarget, 1),
      payload: {
        request: layoutScreenRequest(new Date()),
        nativeMapping: {
          kind: "desktop-layout",
          displays: [
            { nativeDisplayId: 10, ref: displayRef },
            { nativeDisplayId: 20, ref: secondDisplayRef },
          ],
        },
        captureTimeoutMs: 1_000,
        stopTimeoutMs: 100,
      },
    })
    const layoutStarted = await layoutAdapter.request(
      nativeCaptureStartRequestSchema,
      layoutRequest,
      nativeCaptureStartResponseSchema,
      control(),
    )
    if (!layoutStarted.ok) throw new Error(JSON.stringify(layoutStarted.error))
    expect(layoutStarted.ok).toBe(true)
    expect(layoutStarted.result.status.startPending).toBe(true)

    const layoutPendingRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "result",
        1,
        layoutStarted.result.statusEvidenceRef,
        "capture-layout-pending-1",
        "operation-layout-1",
        1,
      ),
      payload: { captureTaskRef: layoutStarted.result.captureTaskRef },
    })
    const layoutPending = await layoutAdapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      layoutPendingRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(layoutPending.purpose).toBe("result")
    if (layoutPending.purpose !== "result") throw new Error("Ожидался layout result cleanup")
    expect(layoutPending.poll.state).toBe("pending")

    await Bun.sleep(30)
    const layoutCompleteRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "result",
        layoutPending.poll.status.revision,
        layoutPending.statusEvidence.statusEvidenceRef,
        "capture-layout-complete-1",
        "operation-layout-1",
        1,
      ),
      payload: { captureTaskRef: layoutStarted.result.captureTaskRef },
    })
    const layoutCompleted = await layoutAdapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      layoutCompleteRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(layoutCompleted.purpose).toBe("result")
    if (layoutCompleted.purpose !== "result" || layoutCompleted.poll.state !== "completed") {
      throw new Error("Layout completion не доставлена")
    }
    expect(layoutCompleted.poll.status.cleanup).toBe("complete")
    expect(layoutCompleted.poll.status.drained).toBe(true)
    expect(layoutCompleted.poll.result.sourceResponseRef).not.toBe(layoutStarted.result.sourceResponseRef)
    expect(layoutCompleted.poll.result.nativeMapping).toEqual(layoutRequest.payload.nativeMapping)
    const layoutFrame = layoutCompleted.poll.result.frame
    if (layoutFrame === undefined) throw new Error("Layout frame отсутствует")
    expect(layoutFrame.widthPx).toBe(4)
    expect(layoutFrame.heightPx).toBe(2)
    expect(layoutFrame.regions).toHaveLength(2)
    expect(layoutFrame.regions.map(region => ({
      nativeDisplayId: region.nativeDisplayId,
      x: region.destinationRect.x,
      backingScaleX: region.backingScaleX,
    }))).toEqual([
      { nativeDisplayId: 10, x: -1, backingScaleX: 1 },
      { nativeDisplayId: 20, x: 0, backingScaleX: 2 },
    ])
    const layoutBytes = await layoutAdapter.takeBinary(
      layoutFrame.binaryToken,
      layoutFrame.encodedBytes,
      AbortSignal.timeout(3_000),
    )
    expect([...layoutBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(new Bun.CryptoHasher("sha256").update(layoutBytes).digest("hex")).toBe(layoutFrame.sha256)
    const layoutDrainedEvidenceRef = layoutCompleted.poll.result.drainedEvidenceRef
    if (layoutDrainedEvidenceRef === undefined) throw new Error("Layout drained evidence отсутствует")
    const layoutReleaseRequest = nativeCaptureCleanupRequestSchema.parse({
      control: cleanupControl(
        "release",
        layoutCompleted.poll.status.revision,
        layoutDrainedEvidenceRef,
        "capture-layout-release-1",
        "operation-layout-1",
        1,
      ),
      payload: { captureTaskRef: layoutStarted.result.captureTaskRef },
    })
    const layoutReleased = await layoutAdapter.cleanup(
      nativeCaptureCleanupRequestSchema,
      layoutReleaseRequest,
      nativeCaptureCleanupResponseSchema,
      control(),
    )
    expect(layoutReleased.purpose).toBe("release")
    if (layoutReleased.purpose !== "release") throw new Error("Ожидался layout release cleanup")
    expect(layoutReleased.ack.cleanup).toBe("complete")
    expect(layoutReleased.alreadyReleased).toBe(false)
    expect(layoutRegisteredSources.length).toBeGreaterThanOrEqual(2)
    expect(new Set(layoutRegisteredSources.map(source => source.ref)).size)
      .toBe(layoutRegisteredSources.length)

    const drained = await adapter.drain({
      requestId: "drain-1",
      ...generation,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    }, control())
    expect(drained.cleanup).toBe("complete")
    expect(drained.activeOperationIds).toEqual([])
    for (const command of ["coverage", "stop"] as const) {
      const sealedObserver = await adapter.observer({
        ...observerRequest,
        command,
        requestId: `sealed-observer-${command}`,
        deadlineAt: new Date(Date.now() + 3_000).toISOString(),
        observerInstanceRef: prepared.snapshot.observerInstanceRef,
      }, control())
      expect(sealedObserver.ok).toBe(true)
    }
  } finally {
    await layoutAdapter?.close()
    await adapter.close()
  }
}, 20_000)
