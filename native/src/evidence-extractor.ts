import {
  nativeEvidenceReportSchema,
  applicationBundleResolutionSchema,
  sameNativeGeneration,
  parseWireJson,
  type NativeEvidenceReport,
  type NativeTargetMapping,
} from "@meta/shared/contracts"
import {
  nativeCaptureStartResultSchema,
  nativeCaptureExecutionResultSchema,
  nativeInventoryResultSchema,
  nativeTransportResponseFrameSchema,
  nativeWindowTransitionResultSchema,
} from "./protocol.ts"
import type { NativeEvidenceBinder } from "./adapter.ts"
import { nativeHitTestResultSchema } from "./hit-test-protocol.ts"

export interface RuntimeNativeEvidenceAuthority {
  registerSourceExtractor(
    binding: { adapterInstanceRef: string, backendBuildId: string, nativeGeneration: string },
    extractor: (bytes: Uint8Array) => readonly NativeEvidenceReport[],
  ): void
  registerSourceResponse(
    binding: { adapterInstanceRef: string, backendBuildId: string, nativeGeneration: string },
    sourceResponseRef: string,
    bytes: Uint8Array,
  ): void
  bind(binding: {
    adapterInstanceRef: string
    backendBuildId: string
    nativeGeneration: string
  }): { publish(report: NativeEvidenceReport): Promise<import("@meta/shared/contracts").VerifiedNativeEvidenceReceipt> }
}

export function createRuntimeNativeEvidenceBinder(
  authority: RuntimeNativeEvidenceAuthority,
): NativeEvidenceBinder {
  return identity => {
    const binding = {
      adapterInstanceRef: identity.adapterInstanceRef,
      backendBuildId: identity.loadedBuildId,
      nativeGeneration: identity.generation.nativeGeneration,
    }
    authority.registerSourceExtractor(binding, extractNativeEvidenceReports)
    return {
      publisher: authority.bind(binding),
      sourceResponses: {
        register(sourceResponseRef, bytes) {
          authority.registerSourceResponse(binding, sourceResponseRef, bytes)
        },
      },
    }
  }
}

export function extractNativeEvidenceReports(bytes: Uint8Array): readonly NativeEvidenceReport[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const frame = parseWireJson(nativeTransportResponseFrameSchema, text)
  if (frame.channel === "response" && frame.payload.ok) {
    const hit = nativeHitTestResultSchema.safeParse(frame.payload.result)
    if (hit.success) {
      if (hit.data.status !== "confirmed") return []
      if (hit.data.operationId !== frame.payload.operationId || !sameNativeGeneration(hit.data.interactionTarget.ref, frame.payload)) {
        throw new Error("Point-hit response содержит другой operation или generation")
      }
      return [nativeEvidenceReportSchema.parse({
        factKind: "point-hit", sourceResponseRef: hit.data.sourceResponseRef,
        inventoryId: hit.data.inventoryId, inventoryRevision: hit.data.inventoryRevision, displayLayoutRevision: hit.data.displayLayoutRevision,
        observedAt: hit.data.observedAt, observationId: hit.data.observationId, frameRef: hit.data.frameRef,
        regionIndex: hit.data.regionIndex, imagePoint: hit.data.imagePoint, interactionTarget: hit.data.interactionTarget, expectedSpace: "macos-screen",
      })]
    }
    const bundle = applicationBundleResolutionSchema.safeParse(frame.payload.result)
    if (bundle.success) {
      if (!sameNativeGeneration(bundle.data.target.ref, frame.payload)) throw new Error("Bundle resolution содержит другую native generation")
      return [nativeEvidenceReportSchema.parse({
        factKind: "application-bundle-identity", sourceResponseRef: bundle.data.sourceResponseRef,
        inventoryId: bundle.data.inventoryId, inventoryRevision: bundle.data.inventoryRevision,
        displayLayoutRevision: 0, observedAt: bundle.data.observedAt, target: bundle.data.target,
      })]
    }
    const inventory = nativeInventoryResultSchema.safeParse(frame.payload.result)
    if (inventory.success) return inventoryReports(frame.payload, inventory.data)
    const transition = nativeWindowTransitionResultSchema.safeParse(frame.payload.result)
    if (transition.success) return transitionReports(frame.payload, transition.data)
    const start = nativeCaptureStartResultSchema.safeParse(frame.payload.result)
    if (start.success) {
      return [nativeEvidenceReportSchema.parse({
        factKind: "capture-task-start",
        sourceResponseRef: start.data.sourceResponseRef,
        inventoryId: start.data.inventoryId,
        inventoryRevision: start.data.inventoryRevision,
        displayLayoutRevision: start.data.displayLayoutRevision,
        observedAt: start.data.observedAt,
        operationId: start.data.operationId,
        taskRef: start.data.captureTaskRef,
        acceptedFence: start.data.acceptedFence,
        statusRevision: start.data.status.revision,
        statusEvidenceRef: start.data.statusEvidenceRef,
      })]
    }
  }
  if (frame.channel === "cleanup") {
    if (frame.payload.purpose === "result" && frame.payload.poll.state === "completed") {
      const reports = captureCompletionReports(frame.payload.poll.result, frame.payload.poll.status)
      if (frame.payload.poll.status.cleanup === "complete" && frame.payload.poll.status.drained) return reports
      return [captureStatusReport(frame.payload.statusEvidence, frame.payload.poll.status), ...reports]
    }
    if (frame.payload.purpose === "result") {
      return [captureStatusReport(frame.payload.statusEvidence, frame.payload.poll.status)]
    }
    if (frame.payload.purpose === "status") {
      const statusReport = captureStatusReport(frame.payload.statusEvidence, frame.payload.status)
      if (frame.payload.terminal === undefined) return [statusReport]
      const terminal = frame.payload.terminal
      return [nativeEvidenceReportSchema.parse({
        factKind: "capture-task-terminal",
        sourceResponseRef: terminal.sourceResponseRef,
        inventoryId: terminal.inventoryId,
        inventoryRevision: terminal.inventoryRevision,
        displayLayoutRevision: terminal.displayLayoutRevision,
        observedAt: terminal.observedAt,
        operationId: terminal.operationId,
        taskRef: frame.payload.status.captureTaskRef,
        acceptedFence: terminal.acceptedFence,
        statusRevision: frame.payload.status.revision,
        drainedEvidenceRef: terminal.drainedEvidenceRef,
        terminalReceiptRef: terminal.terminalReceiptRef,
        cleanup: "complete",
        drained: true,
      })]
    }
  }
  return []
}

function captureStatusReport(
  evidence: {
    operationId: string
    acceptedFence: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string, counter: number }
    sourceResponseRef: string
    inventoryId: string
    inventoryRevision: number
    displayLayoutRevision: number
    observedAt: string
    statusEvidenceRef: string
  },
  status: { captureTaskRef: string, revision: number, cleanup: "pending" | "complete" | "unknown", drained: boolean },
): NativeEvidenceReport {
  return nativeEvidenceReportSchema.parse({
    factKind: "capture-task-status",
    sourceResponseRef: evidence.sourceResponseRef,
    inventoryId: evidence.inventoryId,
    inventoryRevision: evidence.inventoryRevision,
    displayLayoutRevision: evidence.displayLayoutRevision,
    observedAt: evidence.observedAt,
    operationId: evidence.operationId,
    taskRef: status.captureTaskRef,
    acceptedFence: evidence.acceptedFence,
    statusRevision: status.revision,
    statusEvidenceRef: evidence.statusEvidenceRef,
    cleanup: status.cleanup === "pending" ? "unknown" : status.cleanup,
    drained: status.drained,
  })
}

function inventoryReports(
  envelope: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
  inventory: ReturnType<typeof nativeInventoryResultSchema.parse>,
): NativeEvidenceReport[] {
  const generation = { runtimeEpoch: envelope.runtimeEpoch, loginSessionId: envelope.loginSessionId,
    nativeGeneration: envelope.nativeGeneration }
  const displays = inventory.displays.map(display => ({
    nativeDisplayId: display.nativeDisplayId,
    ref: {
      runtimeEpoch: envelope.runtimeEpoch,
      loginSessionId: envelope.loginSessionId,
      nativeGeneration: envelope.nativeGeneration,
      displayRef: display.displayRef,
      displayLayoutRevision: inventory.displayLayoutRevision,
    },
  }))
  const reports: NativeEvidenceReport[] = displays.map(display => nativeEvidenceReportSchema.parse({
    factKind: "target-resolution",
    sourceResponseRef: inventory.sourceResponseRef,
    inventoryId: inventory.inventoryId,
    inventoryRevision: inventory.revision,
    displayLayoutRevision: inventory.displayLayoutRevision,
    observedAt: inventory.capturedAt,
    target: { kind: "display", ref: display.ref },
    mapping: { kind: "display", display },
  }))
  if (displays.length > 0) {
    const layoutTarget = {
      kind: "desktop-layout" as const,
      ref: {
        ...generation,
        layoutRef: inventory.layoutRef,
        displayLayoutRevision: inventory.displayLayoutRevision,
      },
    }
    reports.push(nativeEvidenceReportSchema.parse({
      factKind: "target-resolution",
      sourceResponseRef: inventory.sourceResponseRef,
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
      displayLayoutRevision: inventory.displayLayoutRevision,
      observedAt: inventory.capturedAt,
      target: layoutTarget,
      mapping: { kind: "desktop-layout", displays },
    }))
  }
  for (const application of inventory.applications) {
    const process = { ...generation, applicationRef: application.applicationRef, pid: application.pid,
      launchedAt: application.launchedAt, registrationNonce: application.registrationNonce }
    const common = { factKind: "native-target-identity" as const, process,
      sourceResponseRef: inventory.sourceResponseRef, inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision, displayLayoutRevision: inventory.displayLayoutRevision,
      observedAt: inventory.capturedAt }
    reports.push(nativeEvidenceReportSchema.parse({ ...common, target: { kind: "application", ref: process } }))
    for (const window of inventory.windows) {
      if (window.kind !== "ax-window" || window.applicationRef !== application.applicationRef
        || window.ownerPid !== application.pid) continue
      const identity = { ...generation, applicationRef: application.applicationRef }
      reports.push(nativeEvidenceReportSchema.parse({ ...common,
        target: { kind: "window", ref: { ...identity, windowRef: window.windowRef } } }))
      for (const surface of window.surfaces) {
        if (surface.applicationRef !== application.applicationRef || surface.ownerWindowRef !== window.windowRef) continue
        reports.push(nativeEvidenceReportSchema.parse({ ...common,
          target: { kind: "surface", ref: { ...identity, surfaceRef: surface.surfaceRef, ownerWindowRef: surface.ownerWindowRef } } }))
      }
    }
  }
  for (const window of inventory.windows) {
    if (
      window.kind !== "ax-window"
      || window.mapping !== "corroborated"
      || window.cgWindowId === undefined
      || window.axSnapshotRef === undefined
      || window.cgInventoryRef === undefined
    ) continue
    const target = {
      kind: "window" as const,
      ref: {
        runtimeEpoch: envelope.runtimeEpoch,
        loginSessionId: envelope.loginSessionId,
        nativeGeneration: envelope.nativeGeneration,
        applicationRef: window.applicationRef,
        windowRef: window.windowRef,
      },
    }
    const coveredDisplays = displays.filter(display => {
      const raw = inventory.displays.find(item => item.displayRef === display.ref.displayRef)
      return raw !== undefined && intersects(raw.bounds, window.frame)
    })
    if (coveredDisplays.length === 0) continue
    reports.push(nativeEvidenceReportSchema.parse({
      factKind: "window-cg-ax-correlation",
      sourceResponseRef: inventory.sourceResponseRef,
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
      displayLayoutRevision: inventory.displayLayoutRevision,
      observedAt: inventory.capturedAt,
      target,
      mapping: {
        kind: "window",
        cgWindowId: window.cgWindowId,
        ownerPid: window.ownerPid,
        displays: coveredDisplays,
      },
      corroboration: {
        axSnapshotRef: window.axSnapshotRef,
        cgInventoryRef: window.cgInventoryRef,
      },
    }))
  }
  return reports
}

function transitionReports(
  envelope: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
  transition: ReturnType<typeof nativeWindowTransitionResultSchema.parse>,
): NativeEvidenceReport[] {
  const window = transition.actual
  if (
    window.kind !== "ax-window"
    || window.mapping !== "corroborated"
    || window.cgWindowId === undefined
    || window.axSnapshotRef === undefined
    || window.cgInventoryRef === undefined
  ) return []
  const displays = transition.displays
    .filter(display => intersects(display.bounds, window.frame))
    .map(display => ({
      nativeDisplayId: display.nativeDisplayId,
      ref: {
        runtimeEpoch: envelope.runtimeEpoch,
        loginSessionId: envelope.loginSessionId,
        nativeGeneration: envelope.nativeGeneration,
        displayRef: display.displayRef,
        displayLayoutRevision: transition.displayLayoutRevision,
      },
    }))
  if (displays.length === 0) return []
  return [nativeEvidenceReportSchema.parse({
    factKind: "window-cg-ax-correlation",
    sourceResponseRef: transition.sourceResponseRef,
    inventoryId: transition.inventoryId,
    inventoryRevision: transition.inventoryRevision,
    displayLayoutRevision: transition.displayLayoutRevision,
    observedAt: transition.observedAt,
    target: {
      kind: "window",
      ref: {
        runtimeEpoch: envelope.runtimeEpoch,
        loginSessionId: envelope.loginSessionId,
        nativeGeneration: envelope.nativeGeneration,
        applicationRef: window.applicationRef,
        windowRef: window.windowRef,
      },
    },
    mapping: {
      kind: "window",
      cgWindowId: window.cgWindowId,
      ownerPid: window.ownerPid,
      displays,
    },
    corroboration: {
      axSnapshotRef: window.axSnapshotRef,
      cgInventoryRef: window.cgInventoryRef,
    },
  })]
}

function captureCompletionReports(
  completion: ReturnType<typeof nativeCaptureExecutionResultSchema.parse>,
  status: { revision: number, drained: boolean },
): NativeEvidenceReport[] {
  const reports: NativeEvidenceReport[] = []
  if (completion.outcome === "succeeded" && completion.frame !== undefined) {
    reports.push(nativeEvidenceReportSchema.parse({
      factKind: "frame",
      sourceResponseRef: completion.sourceResponseRef,
      inventoryId: completion.inventoryId,
      inventoryRevision: completion.inventoryRevision,
      displayLayoutRevision: completion.displayLayoutRevision,
      observedAt: completion.observedAt,
      observationId: completion.observationId,
      frameRef: completion.frame.frameRef,
      captureTarget: completion.target,
      frameSha256: completion.frame.sha256,
    }))
  }
  if (
    completion.cleanup === "complete"
    && status.drained
    && completion.drainedEvidenceRef !== undefined
    && completion.terminalReceiptRef !== undefined
  ) {
    reports.push(nativeEvidenceReportSchema.parse({
      factKind: "capture-task-terminal",
      sourceResponseRef: completion.sourceResponseRef,
      inventoryId: completion.inventoryId,
      inventoryRevision: completion.inventoryRevision,
      displayLayoutRevision: completion.displayLayoutRevision,
      observedAt: completion.observedAt,
      operationId: completion.operationId,
      taskRef: completion.captureTaskRef,
      acceptedFence: completion.acceptedFence,
      statusRevision: status.revision,
      drainedEvidenceRef: completion.drainedEvidenceRef,
      terminalReceiptRef: completion.terminalReceiptRef,
      cleanup: "complete",
      drained: true,
    }))
  }
  return reports
}

function intersects(
  left: { x: number, y: number, width: number, height: number },
  right: { x: number, y: number, width: number, height: number },
): boolean {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y)
}
