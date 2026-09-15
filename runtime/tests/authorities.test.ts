import { expect, test } from "bun:test"
import {
  nativeEvidenceReportSchema,
  nativeExecutionContextSchema,
  observationSchema,
  windowRecordSchema,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { continuationIdempotencyKey } from "../src/continuations.ts"
import { NativeEvidenceAuthority, ProofRegistry, TargetRegistry } from "../src/authorities.ts"
import { canonicalJson, sha256 } from "../src/primitives.ts"

const generation = { runtimeEpoch: "runtime:evidence", loginSessionId: "login:evidence" }
const nativeGeneration = "native:evidence"
const displayRef = {
  ...generation,
  nativeGeneration,
  displayRef: "display:evidence",
  displayLayoutRevision: 3,
}
const displayTarget = { kind: "display" as const, ref: displayRef }
const windowTarget = {
  kind: "window" as const,
  ref: {
    ...generation,
    nativeGeneration,
    applicationRef: "application:evidence",
    windowRef: "window:evidence",
  },
}

test("bound native evidence verifies source response and issues target proof", async () => {
  const binding = {
    adapterInstanceRef: "native-adapter:evidence",
    backendBuildId: "native-build:evidence",
    nativeGeneration,
  }
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:evidence",
    nativeGeneration,
    nativeSourceIdentity: binding,
  })
  runtime.evidence.registerSourceExtractor(binding, extractEvidence)
  runtime.evidence.registerSourceExtractor(binding, extractEvidence)
  expect(() => runtime.evidence.registerSourceExtractor(binding, bytes => extractEvidence(bytes))).toThrow("immutable conflict")
  expect(() => runtime.evidence.registerSourceExtractor({ ...binding, backendBuildId: "native-build:foreign" }, extractEvidence)).toThrow("configured/handshaken")
  const report = nativeEvidenceReportSchema.parse({
    factKind: "window-cg-ax-correlation",
    sourceResponseRef: "native-response:1",
    inventoryId: "inventory:evidence",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    observedAt: new Date().toISOString(),
    target: windowTarget,
    mapping: {
      kind: "window",
      cgWindowId: 50,
      ownerPid: 42,
      displays: [{ nativeDisplayId: 1, ref: displayRef }],
    },
    corroboration: {
      axSnapshotRef: "ax-snapshot:1",
      cgInventoryRef: "cg-inventory:1",
    },
  })
  const responseBytes = new TextEncoder().encode(JSON.stringify(report))
  runtime.evidence.registerSourceResponse(binding, "native-response:1", responseBytes)
  runtime.evidence.registerSourceResponse(binding, "native-response:1", responseBytes)
  expect(() => runtime.evidence.registerSourceResponse(
    binding,
    "native-response:1",
    new TextEncoder().encode(JSON.stringify({ ...report, inventoryRevision: 5 })),
  )).toThrow("immutable conflict")
  const publisher = runtime.evidence.bind(binding)
  const receipt = await publisher.publish(report)
  expect(receipt.sourceResponseSha256).toBe(sha256(responseBytes))
  expect(receipt.factSha256).toBe(sha256(canonicalJson(report)))
  if (report.factKind !== "window-cg-ax-correlation") throw new Error("fixture должен быть window correlation")
  const proof = await runtime.evidence.issueWindowCorrelation({
    receipt,
    target: windowTarget,
    nativeMapping: report.mapping,
  })
  expect(proof).toMatchObject({
    kind: "cg-ax-correlation",
    subject: windowTarget,
    inventoryRevision: 4,
  })
  expect(windowRecordSchema.parse({
    kind: "ax-window",
    ref: windowTarget.ref,
    surfaces: [],
    ownerPid: 42,
    cgWindowId: 50,
    title: "Verified window",
    role: "AXWindow",
    subrole: "AXStandardWindow",
    frame: { x: 0, y: 0, width: 100, height: 100 },
    applicationHidden: "false",
    minimized: "false",
    onScreen: "true",
    spaceVisibility: "current",
    fullscreen: "false",
    focused: "false",
    main: "false",
    mapping: "corroborated",
    mappingEvidence: { proof, cgWindowId: 50, ownerPid: 42 },
    actionability: "ax",
    advertisedActions: ["raise"],
    permittedActions: ["raise"],
  }).mappingEvidence?.proof.kind).toBe("cg-ax-correlation")
  expect((await runtime.targets.resolve({
    target: windowTarget,
    inventoryId: report.inventoryId,
    inventoryRevision: report.inventoryRevision,
    ...generation,
    nativeGeneration,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  })).nativeMapping).toEqual(report.mapping)
  await expect(publisher.publish({ ...report, sourceResponseRef: "native-response:unknown" })).rejects.toThrow("не зарегистрирован")
  expect(nativeEvidenceReportSchema.safeParse({ ...report, sourceResponseSha256: "f".repeat(64) }).success).toBe(false)
})

test("stored observation resolver obtains point-bound proof without Input proof factory", async () => {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:evidence",
    nativeGeneration,
    nativeSourceIdentity: {
      adapterInstanceRef: "native-adapter:evidence",
      backendBuildId: "native-build:evidence",
      nativeGeneration,
    },
  })
  const now = new Date()
  const captureProof = runtime.proofs.issue({
    kind: "frame-freshness",
    subject: displayTarget,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    ttlMs: 10_000,
  })
  const observation = runtime.observations.register(observationSchema.parse({
    observationId: "observation:evidence",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    nativeGeneration,
    captureTarget: displayTarget,
    caption: "Ожидаю display composite",
    backend: { name: "fake-native", buildId: "native-build:evidence" },
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10_000).toISOString(),
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    source: "display-composite",
    image: {
      frameRef: "frame:evidence",
      widthPx: 1,
      heightPx: 1,
      mime: "image/png",
      byteLength: 68,
      sha256: "a".repeat(64),
    },
    cursor: "excluded",
    clip: { x: 0, y: 0, width: 1, height: 1 },
    captureEvidence: {
      state: "confirmed",
      claim: "frame-fresh",
      source: "runtime",
      proof: captureProof,
    },
    occlusion: {
      state: "unknown",
      claim: "unknown",
      source: "native",
      reason: "point proof required",
    },
    readiness: {
      state: "ready",
      policy: { policyId: "policy:evidence", requiredSteps: ["complete-frame"], disabledSteps: [] },
      steps: [{ state: "reached", name: "complete-frame", durationMs: 1 }],
      timedOut: false,
    },
    synchronization: { kind: "single-frame" },
    regions: [{
      space: { kind: "macos-screen", display: displayRef },
      imageRect: { x: 0, y: 0, width: 1, height: 1 },
      destinationRect: { x: 100, y: 200, width: 1, height: 1 },
      imageToDestination: { a: 1, b: 0, c: 0, d: 1, tx: 100, ty: 200 },
      frameTimestamp: now.toISOString(),
      frameStatus: "complete",
    }],
    unavailableReasons: [],
  }))
  const observationRef = {
    observationId: observation.observationId,
    inventoryRevision: observation.inventoryRevision,
    displayLayoutRevision: observation.displayLayoutRevision,
    proofRef: captureProof.proofRef,
  }
  const operation = nativeExecutionContextSchema.parse({
    kind: "native",
    operationId: "operation:evidence",
    clientRequestId: "request:evidence",
    clientSessionId: "client:evidence",
    principalId: "principal:evidence",
    ...generation,
    inventoryId: "inventory:evidence",
    inventoryRevision: 4,
    observationRef,
    deadlineAt: new Date(now.getTime() + 5_000).toISOString(),
    target: windowTarget,
    nativeGeneration,
    fence: { ...generation, nativeGeneration, counter: 1 },
  })
  const binding = {
    adapterInstanceRef: "native-adapter:evidence",
    backendBuildId: "native-build:evidence",
    nativeGeneration,
  }
  runtime.evidence.registerSourceExtractor(binding, extractEvidence)
  const pointReport = nativeEvidenceReportSchema.parse({
    factKind: "point-hit",
    sourceResponseRef: "native-response:point",
    inventoryId: "inventory:evidence",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    observedAt: now.toISOString(),
    observationId: observation.observationId,
    frameRef: observation.image.frameRef,
    regionIndex: 0,
    imagePoint: { x: 0.5, y: 0.5 },
    interactionTarget: windowTarget,
    expectedSpace: "macos-screen",
  })
  runtime.evidence.registerSourceResponse(binding, "native-response:point", new TextEncoder().encode(JSON.stringify(pointReport)))
  await runtime.evidence.bind(binding).publish(pointReport)
  const authorized = await runtime.observations.resolvePoint({
    operation,
    observationRef,
    interactionTarget: windowTarget,
    imagePoint: { x: 0.5, y: 0.5 },
    expectedSpace: "macos-screen",
  })
  expect(authorized).toMatchObject({
    authorized: true,
    interactionTarget: windowTarget,
    destinationPoint: { x: 100.5, y: 200.5 },
  })
})

test("FrameStore принимает только runtime-preissued frameRef и scoped publication", async () => {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:frame",
    nativeGeneration,
    nativeSourceIdentity: {
      adapterInstanceRef: "native-adapter:frame",
      backendBuildId: "native-build:frame",
      nativeGeneration,
    },
  })
  const publication = runtime.frames.registerPublication({
    observationId: "observation:frame",
    frameRef: "frame:preissued",
    source: "display-composite",
    captureTarget: displayTarget,
    capturePolicySha256: "a".repeat(64),
    ...generation,
    nativeGeneration,
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    inventoryId: "inventory:frame",
    inventoryRevision: 1,
    displayLayoutRevision: 3,
    cacheScopeRef: "client:frame",
  })
  const bytes = new TextEncoder().encode("png bytes are verified before this store")
  const base = {
    observationId: publication.observationId,
    ...generation,
    nativeGeneration,
    source: "display-composite" as const,
    target: displayTarget,
    capturedAt: new Date().toISOString(),
    widthPx: 1,
    heightPx: 1,
    mime: "image/png" as const,
    expectedByteLength: bytes.byteLength,
    expectedSha256: sha256(bytes),
    bytes,
  }
  await expect(runtime.frames.publish({ ...base, frameRef: "frame:producer" })).rejects.toThrow("publication")
  await expect(runtime.frames.publish({ ...base, frameRef: publication.frameRef, target: windowTarget })).rejects.toThrow("publication")
  await runtime.frames.publish({ ...base, frameRef: publication.frameRef })
  await expect(runtime.frames.publish({ ...base, frameRef: publication.frameRef })).rejects.toThrow("перезаписан")
  expect(runtime.frames.get(publication.frameRef, publication.cacheScopeRef)).toEqual(bytes)
  expect(runtime.frames.get(publication.frameRef, "client:foreign")).toBeUndefined()
  const binding = {
    adapterInstanceRef: "native-adapter:frame",
    backendBuildId: "native-build:frame",
    nativeGeneration,
  }
  runtime.evidence.registerSourceExtractor(binding, extractEvidence)
  const frameReport = nativeEvidenceReportSchema.parse({
    factKind: "frame",
    sourceResponseRef: "native-response:frame",
    inventoryId: publication.inventoryId,
    inventoryRevision: publication.inventoryRevision,
    displayLayoutRevision: publication.displayLayoutRevision,
    observedAt: base.capturedAt,
    observationId: publication.observationId,
    frameRef: publication.frameRef,
    captureTarget: displayTarget,
    frameSha256: base.expectedSha256,
  })
  runtime.evidence.registerSourceResponse(binding, "native-response:frame", new TextEncoder().encode(JSON.stringify(frameReport)))
  const receipt = await runtime.evidence.bind(binding).publish(frameReport)
  expect((await runtime.evidence.issueFrameFreshness({
    receipt,
    observationId: publication.observationId,
    frameRef: publication.frameRef,
    captureTarget: displayTarget,
    frameSha256: base.expectedSha256,
  })).kind).toBe("frame-freshness")
  await expect(runtime.evidence.issueFrameFreshness({
    receipt,
    observationId: publication.observationId,
    frameRef: publication.frameRef,
    captureTarget: displayTarget,
    frameSha256: "f".repeat(64),
  })).rejects.toThrow("verified frame")
})

test("ResourceRegistry проверяет immutable leaseGeneration до любой cleanup mutation", async () => {
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "runtime-build:resource" })
  const client = runtime.openClient("principal:resource")
  const handles = runtime.resources.acquire(
    client.session,
    "operation:resource",
    [
      { kind: "clipboard", resourceRef: "system" },
      { kind: "cdp-target", resourceRef: "target:resource" },
    ],
    new Date(Date.now() + 10_000).toISOString(),
  )
  const forged = { ...handles[0]!, leaseGeneration: "lease-generation:forged" }
  await expect(runtime.resources.assertOwnedSet("operation:resource", [forged])).rejects.toThrow("не владеет")
  expect(() => runtime.resources.applyCleanup("operation:resource", handles, {
    scope: "owned",
    state: "complete",
    resources: [
      { handle: forged, outcome: "released" },
      { handle: handles[1], outcome: "released" },
    ],
  })).toThrow("не покрывает exact")
  expect(runtime.resources.handlesForOperation("operation:resource")).toHaveLength(2)
  const mutated = handles[1]!
  mutated.principalId = "principal:mutated"
  await expect(runtime.resources.assertActive({
    handle: mutated,
    operationId: "operation:resource",
    clientSessionId: client.session.clientSessionId,
    principalId: client.session.principalId,
    ...generation,
    now: new Date(),
  })).rejects.toThrow("не выдан")
  expect(runtime.resources.handlesForOperation("operation:resource")[1]?.principalId).toBe(client.session.principalId)
})

test("native-bound proof не проходит при omitted nativeGeneration в caller context", async () => {
  const runtime = new RuntimeCore({ generation, runtimeBuildId: "runtime-build:proof", nativeGeneration })
  const proof = runtime.proofs.issue({
    kind: "pixel-ownership",
    subject: windowTarget,
    inventoryRevision: 1,
    displayLayoutRevision: 3,
    ttlMs: 10_000,
  })
  await expect(runtime.proofs.assertValid(proof, {
    expectedCaptureTarget: displayTarget,
    interactionTarget: windowTarget,
    interactionProof: {
      proof,
      observationId: "observation:proof",
      frameRef: "frame:proof",
      regionIndex: 0,
      space: { kind: "macos-screen", display: displayRef },
      coverage: { kind: "point", point: { x: 0, y: 0 }, tolerancePx: 0 },
    },
    expectedSpace: "macos-screen",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    inventoryRevision: 1,
    displayLayoutRevision: 3,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    maxFrameAgeMs: 5_000,
    now: new Date(),
  })).rejects.toThrow("требует exact native generation")
})

test("TargetRegistry проверяет current inventory age и request deadline", async () => {
  let nowMs = Date.now()
  const targets = new TargetRegistry(generation, { clock: { now: () => new Date(nowMs) }, maxAgeMs: 100 })
  targets.register(windowTarget, "inventory:target", 1, "resolution:target", "proof:target", 3, undefined, 100)
  const request = {
    target: windowTarget,
    inventoryId: "inventory:target",
    inventoryRevision: 1,
    ...generation,
    nativeGeneration,
    deadlineAt: new Date(nowMs + 1_000).toISOString(),
  }
  expect((await targets.resolve(request)).resolutionId).toBe("resolution:target")
  nowMs += 101
  await expect(targets.resolve(request)).rejects.toThrow("stale")
  targets.register(windowTarget, "inventory:target", 2, "resolution:target:2", "proof:target:2", 3)
  expect(() => targets.register(
    windowTarget,
    "inventory:delayed",
    1,
    "resolution:stale",
    "proof:stale",
    3,
  )).toThrow("high-water")
  expect((await targets.resolve({
    ...request,
    inventoryId: "inventory:target",
    inventoryRevision: 2,
    deadlineAt: new Date(nowMs + 1_000).toISOString(),
  })).resolutionId).toBe("resolution:target:2")
  await expect(targets.resolve({
    ...request,
    inventoryRevision: 2,
    deadlineAt: new Date(nowMs - 1).toISOString(),
  })).rejects.toThrow("stale")
})

test("raw unknown capture status нельзя повысить до forged complete terminal receipt", async () => {
  const binding = {
    adapterInstanceRef: "native-adapter:terminal",
    backendBuildId: "native-build:terminal",
    nativeGeneration,
  }
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:terminal",
    nativeGeneration,
    nativeSourceIdentity: binding,
  })
  runtime.evidence.registerSourceExtractor(binding, extractEvidence)
  const actualUnknown = nativeEvidenceReportSchema.parse({
    factKind: "capture-task-terminal",
    sourceResponseRef: "native-response:terminal",
    inventoryId: "inventory:terminal",
    inventoryRevision: 1,
    displayLayoutRevision: 3,
    observedAt: new Date().toISOString(),
    operationId: "operation:terminal",
    taskRef: "capture-task:terminal",
    acceptedFence: { ...generation, nativeGeneration, counter: 1 },
    statusRevision: 2,
    drainedEvidenceRef: "drained-evidence:unknown",
    cleanup: "unknown",
    drained: false,
  })
  if (actualUnknown.factKind !== "capture-task-terminal") throw new Error("fixture должен быть capture terminal")
  runtime.evidence.registerSourceResponse(
    binding,
    actualUnknown.sourceResponseRef,
    new TextEncoder().encode(JSON.stringify(actualUnknown)),
  )
  const publisher = runtime.evidence.bind(binding)
  await expect(publisher.publish({
    ...actualUnknown,
    cleanup: "complete",
    drained: true,
    terminalReceiptRef: "terminal-receipt:forged",
  })).rejects.toThrow("normalized facts")
  const receipt = await publisher.publish(actualUnknown)
  await expect(runtime.continuations.markVerifiedTerminal({
    receipt,
    operationId: actualUnknown.operationId,
    taskRef: actualUnknown.taskRef,
    acceptedFence: actualUnknown.acceptedFence,
    statusRevision: actualUnknown.statusRevision,
    drainedEvidenceRef: actualUnknown.drainedEvidenceRef,
    terminalReceiptRef: "terminal-receipt:forged",
  })).rejects.toThrow("Terminal capture task status")
})

test("native source response key использует canonical adapter/ref tuple без colon collision", async () => {
  const bindings = [
    { adapterInstanceRef: "a", backendBuildId: "build:1", nativeGeneration },
    { adapterInstanceRef: "a:b", backendBuildId: "build:2", nativeGeneration },
  ]
  const targets = new TargetRegistry(generation)
  const proofs = new ProofRegistry(generation, { nativeGeneration })
  const evidence = new NativeEvidenceAuthority(generation, proofs, targets, {
    validateBinding: binding => bindings.some(candidate => canonicalJson(candidate) === canonicalJson(binding)),
  })
  const refs = ["b:c", "c"]
  const receipts = []
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index]!
    const sourceResponseRef = refs[index]!
    evidence.registerSourceExtractor(binding, extractEvidence)
    const report = nativeEvidenceReportSchema.parse({
      factKind: "target-resolution",
      sourceResponseRef,
      inventoryId: `inventory:key:${index}`,
      inventoryRevision: index + 1,
      displayLayoutRevision: 3,
      observedAt: new Date().toISOString(),
      target: displayTarget,
      mapping: { kind: "display", display: { nativeDisplayId: index + 1, ref: displayRef } },
    })
    evidence.registerSourceResponse(binding, sourceResponseRef, new TextEncoder().encode(JSON.stringify(report)))
    receipts.push(await evidence.bind(binding).publish(report))
  }
  expect(receipts.map(receipt => receipt.adapterInstanceRef)).toEqual(bindings.map(binding => binding.adapterInstanceRef))
  expect(receipts[0]?.sourceResponseSha256).not.toBe(receipts[1]?.sourceResponseSha256)
})

test("continuation idempotency key не смешивает colon-containing operation/task tuple", () => {
  expect(continuationIdempotencyKey({
    operationId: "a",
    taskRef: "b:c",
    purpose: "status",
    expectedRevision: 1,
  })).not.toBe(continuationIdempotencyKey({
    operationId: "a:b",
    taskRef: "c",
    purpose: "status",
    expectedRevision: 1,
  }))
})

function extractEvidence(bytes: Uint8Array) {
  return [nativeEvidenceReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)]
}
