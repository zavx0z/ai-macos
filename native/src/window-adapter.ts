import {
  NATIVE_PROTOCOL_VERSION,
  authorizeAdapterContext,
  nativeStatusMatchesOperation,
  desktopInventorySnapshotSchema,
  structurallyEqual,
  windowTransitionResultSchema,
  type AdapterControl,
  type AdapterResult,
  type AdapterServices,
  type ApplicationRecord,
  type ContractError,
  type DesktopInventorySnapshot,
  type DesktopLayoutCaptureTarget,
  type DisplayCaptureTarget,
  type DisplayRecord,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeGeneration,
  type NativeOperationStatus,
  type OperationOutcome,
  type ProofRef,
  type RuntimeOperationContext,
  type RuntimeResourceHandle,
  type SurfaceRecord,
  type WindowAdapter,
  type WindowRecord,
  type WindowRef,
  type WindowTransitionRequest,
  type WindowTransitionResult,
  type AxInspectionRequest,
  type AxInspectionResult,
  type AxPressRequest,
  type AxPressResult,
} from "@meta/shared/contracts"
import {
  nativeAxInspectionRequestSchema,
  nativeAxInspectionResponseSchema,
  nativeAxPressRequestSchema,
  nativeAxPressResponseSchema,
  nativeAxPressResultMatches,
  nativeInventoryRequestSchema,
  nativeInventoryResponseSchema,
  nativeWindowTransitionRequestSchema,
  nativeWindowTransitionResponseSchema,
  type NativeInventoryResult,
  type NativeWindowTransitionResult,
} from "./protocol.ts"

const WINDOW_CAPABILITIES = [
  "desktop.applications",
  "desktop.windows.all",
  "desktop.window.identity",
  "desktop.window.show",
  "desktop.window.lifecycle",
  "desktop.displays",
  "desktop.ax",
] as const

export class NativeWindowAdapter implements WindowAdapter {
  readonly host
  readonly services: AdapterServices
  readonly capabilities = WINDOW_CAPABILITIES

  readonly #native: NativeAdapter
  #lastInventory: NativeInventoryResult | undefined

  constructor(options: {
    native: NativeAdapter
    services: AdapterServices
  }) {
    this.#native = options.native
    this.host = options.native.host
    this.services = options.services
  }

  async inventory(control: AdapterControl): Promise<DesktopInventorySnapshot> {
    const generation = this.#generation()
    const nativeRequestId = requestId("inventory")
    const response = await this.#native.request(
      nativeInventoryRequestSchema,
      {
        kind: "request",
        intent: "read",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: nativeRequestId,
        ...generation,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
        method: "window.inventory",
        payload: {},
      },
      nativeInventoryResponseSchema,
      control,
    )
    if (!response.ok) throw new Error(response.error.message)
    this.#lastInventory = response.result
    return await this.#mapInventory(response.result)
  }

  async transition(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: WindowTransitionRequest,
  ): Promise<AdapterResult<WindowTransitionResult>> {
    await authorizeAdapterContext(this.host, this.services, context, new Date())
    if (!structurallyEqual(context.wire.target, { kind: "window", ref: request.target })) {
      throw new Error("Window transition context содержит другой exact target")
    }
    const response = await this.#native.request(
      nativeWindowTransitionRequestSchema,
      {
        kind: "request",
        intent: "mutation",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: requestId("window-transition"),
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        nativeGeneration: context.wire.nativeGeneration,
        deadlineAt: context.wire.deadlineAt,
        method: "window.transition",
        operation: context.wire,
        payload: request,
      },
      nativeWindowTransitionResponseSchema,
      context.control,
    )
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        outcome: unknownOutcome(context.resources),
      }
    }
    const value = await this.#mapTransition(request, response.result)
    return {
      ok: true,
      value,
      outcome: outcomeFromStatus(response.result.status, context.resources),
    }
  }

  async press(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: AxPressRequest,
  ): Promise<AdapterResult<AxPressResult>> {
    await authorizeAdapterContext(this.host, this.services, context, new Date())
    const nativeRequest = nativeAxPressRequestSchema.parse({
      kind: "request",
      intent: "mutation",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId: requestId("ax-press"),
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: context.wire.nativeGeneration,
      deadlineAt: context.wire.deadlineAt,
      method: "ax.press",
      operation: context.wire,
      payload: request,
    })
    const response = await this.#native.request(
      nativeAxPressRequestSchema,
      nativeRequest,
      nativeAxPressResponseSchema,
      context.control,
    )
    const status = response.ok ? response.result.status : response.nativeStatus
    if (status !== undefined && (status.requestId !== nativeRequest.requestId || !nativeStatusMatchesOperation(context.wire, status))) {
      throw new Error("AXPress status не совпадает с exact request, operation или fence")
    }
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        outcome: status === undefined ? unknownOutcome(context.resources) : outcomeFromStatus(status, context.resources),
        ...(status === undefined ? {} : { nativeStatus: status }),
      }
    }
    if (!nativeAxPressResultMatches(nativeRequest, response.result)) {
      throw new Error("AXPress result содержит другой retained element или accepted fence")
    }
    return {
      ok: true,
      value: response.result.value,
      outcome: outcomeFromStatus(response.result.status, context.resources),
      nativeStatus: response.result.status,
    }
  }

  async inspect(request: AxInspectionRequest, control: AdapterControl): Promise<AxInspectionResult> {
    const generation = this.#generation()
    const response = await this.#native.request(
      nativeAxInspectionRequestSchema,
      {
        kind: "request",
        intent: "read",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: requestId("ax-inspect"),
        ...generation,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
        method: "ax.inspect",
        payload: request,
      },
      nativeAxInspectionResponseSchema,
      control,
    )
    if (!response.ok) throw new Error(response.error.message)
    return {
      snapshotId: response.result.snapshotId,
      target: request.target,
      complete: response.result.complete,
      ...(response.result.nextCursor === undefined ? {} : { nextCursor: response.result.nextCursor }),
      nodeCount: response.result.nodeCount,
      encodedBytes: response.result.encodedBytes,
      nodes: response.result.nodes.map(node => {
        const authority = {
          ...generation,
          applicationRef: request.target.ref.applicationRef,
          snapshotId: response.result.snapshotId,
        }
        return {
          elementRef: { ...authority, elementRef: node.elementRef },
          ...(node.parentElementRef === undefined ? {} : {
            parentElementRef: { ...authority, elementRef: node.parentElementRef },
          }),
          role: node.role,
          subrole: node.subrole,
          title: node.title,
          ...(node.identifier === undefined ? {} : { identifier: node.identifier }),
          ...(node.description === undefined ? {} : { description: node.description }),
          ...(node.value === undefined ? {} : { value: node.value }),
          ...(node.valueRedacted === undefined ? {} : { valueRedacted: node.valueRedacted }),
          ...(node.frame === undefined ? {} : { frame: node.frame }),
          actions: [...node.actions],
        }
      }),
      errors: response.result.errors.map(message => contractError(
        "inventory-incomplete",
        message,
        "ax-inspect",
      )),
    }
  }

  async #mapInventory(raw: NativeInventoryResult): Promise<DesktopInventorySnapshot> {
    const generation = this.#generation()
    const applications: ApplicationRecord[] = raw.applications.map(application => ({
      ref: {
        ...generation,
        applicationRef: application.applicationRef,
        pid: application.pid,
        launchedAt: application.launchedAt,
        registrationNonce: application.registrationNonce,
      },
      name: application.name,
      ...(application.bundleId === undefined ? {} : { bundleId: application.bundleId }),
      hidden: application.hidden,
      axStatus: application.axStatus,
      ...(application.axReason === undefined ? {} : { axReason: application.axReason }),
      windowCount: application.windowCount,
    }))
    const displays: DisplayRecord[] = raw.displays.map(display => ({
      ref: {
        ...generation,
        displayRef: display.displayRef,
        displayLayoutRevision: raw.displayLayoutRevision,
      },
      nativeDisplayId: display.nativeDisplayId,
      bounds: display.bounds,
      usableBounds: display.usableBounds,
      scale: display.scale,
      rotationDegrees: display.rotationDegrees,
      main: display.main,
    }))
    const displayProofs = await Promise.all(
      displays.map(display => this.#publishDisplayEvidence(raw, display)),
    )
    const displayTargets: DisplayCaptureTarget[] = displays.map((display, index) => ({
      kind: "display",
      target: { kind: "display", ref: display.ref },
      nativeDisplayId: display.nativeDisplayId,
      mappingEvidence: {
        state: "confirmed",
        claim: "native-display-resolved",
        source: "runtime-native-evidence",
        proof: displayProofs[index]!,
      },
    }))
    const desktopLayout = displays.length === 0
      ? undefined
      : await this.#publishDesktopLayoutEvidence(raw, generation, displayTargets)

    const mappingErrors: ContractError[] = []
    const publishIdentity = async (target: Extract<import("@meta/shared/contracts").OperationTarget,
      { kind: "application" | "window" | "surface" }>, process: ApplicationRecord["ref"]) => {
      const receipt = await this.#native.evidencePublisher.publish({
        factKind: "native-target-identity", target, process,
        sourceResponseRef: raw.sourceResponseRef, inventoryId: raw.inventoryId,
        inventoryRevision: raw.revision, displayLayoutRevision: raw.displayLayoutRevision,
        observedAt: raw.capturedAt,
      })
      await this.services.evidence.issueTargetResolution({ receipt, target })
    }
    for (const application of applications) {
      await publishIdentity({ kind: "application", ref: application.ref }, application.ref)
    }
    const windows = await Promise.all(raw.windows.map(async (window) => {
      if (window.kind === "cg-only") {
        return {
          kind: "cg-only" as const,
          ...generation,
          cgEntryRef: cgEntryRef(window.ownerPid, window.cgWindowId, raw.revision),
          ownerPid: window.ownerPid,
          cgWindowId: window.cgWindowId,
          title: window.title,
          frame: window.frame,
          onScreen: window.onScreen,
          actionability: "unavailable" as const,
          reason: window.unavailableReason,
        }
      }
      const target: { kind: "window", ref: WindowRef } = {
        kind: "window",
        ref: {
          ...generation,
          applicationRef: window.applicationRef,
          windowRef: window.windowRef,
        },
      }
      let proof: ProofRef | undefined
      if (window.mapping === "corroborated" && window.cgWindowId !== undefined) {
        try {
          proof = await this.#publishWindowEvidence(
            raw,
            target,
            window.cgWindowId,
            window.ownerPid,
            window.axSnapshotRef!,
            window.cgInventoryRef!,
            window.frame,
            displays,
          )
        } catch (error) {
          mappingErrors.push(contractError(
            "proof-invalid",
            error instanceof Error ? error.message : String(error),
            "window-inventory-evidence",
          ))
        }
      }
      const process = applications.find(application => application.ref.applicationRef === window.applicationRef
        && application.ref.pid === window.ownerPid)?.ref
      if (process !== undefined) {
        if (proof === undefined) await publishIdentity(target, process)
        for (const surface of window.surfaces) {
          await publishIdentity({ kind: "surface", ref: surfaceRef(surface, generation) }, process)
        }
      }
      return mapWindowRecord(window, target.ref, generation, proof)
    }))
    const errors = [
      ...raw.errors.map(message => contractError("inventory-incomplete", message, "window-inventory")),
      ...mappingErrors,
    ]
    return desktopInventorySnapshotSchema.parse({
      inventoryId: raw.inventoryId,
      ...generation,
      revision: raw.revision,
      displayLayoutRevision: raw.displayLayoutRevision,
      capturedAt: raw.capturedAt,
      complete: raw.complete,
      errors,
      applications,
      windows,
      displays,
      ...(desktopLayout === undefined ? {} : { desktopLayout }),
    })
  }

  async #publishDisplayEvidence(raw: NativeInventoryResult, display: DisplayRecord): Promise<ProofRef> {
    const target = { kind: "display" as const, ref: display.ref }
    const mapping = {
      kind: "display" as const,
      display: { nativeDisplayId: display.nativeDisplayId, ref: display.ref },
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "target-resolution",
      sourceResponseRef: raw.sourceResponseRef,
      inventoryId: raw.inventoryId,
      inventoryRevision: raw.revision,
      displayLayoutRevision: raw.displayLayoutRevision,
      observedAt: raw.capturedAt,
      target,
      mapping,
    })
    return await this.services.evidence.issueTargetResolution({ receipt, target, nativeMapping: mapping })
  }

  async #publishDesktopLayoutEvidence(
    raw: NativeInventoryResult,
    generation: NativeGeneration,
    displays: DisplayCaptureTarget[],
  ): Promise<DesktopLayoutCaptureTarget> {
    const target = {
      kind: "desktop-layout" as const,
      ref: {
        ...generation,
        layoutRef: raw.layoutRef,
        displayLayoutRevision: raw.displayLayoutRevision,
      },
    }
    const mapping = {
      kind: "desktop-layout" as const,
      displays: displays.map(display => ({
        nativeDisplayId: display.nativeDisplayId,
        ref: display.target.ref,
      })),
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "target-resolution",
      sourceResponseRef: raw.sourceResponseRef,
      inventoryId: raw.inventoryId,
      inventoryRevision: raw.revision,
      displayLayoutRevision: raw.displayLayoutRevision,
      observedAt: raw.capturedAt,
      target,
      mapping,
    })
    const proof = await this.services.evidence.issueTargetResolution({
      receipt,
      target,
      nativeMapping: mapping,
    })
    return {
      kind: "desktop-layout",
      target,
      mappingEvidence: {
        state: "confirmed",
        claim: "desktop-layout-resolved",
        source: "runtime-native-evidence",
        proof,
      },
      displays,
    }
  }

  async #publishWindowEvidence(
    raw: {
      sourceResponseRef: string
      inventoryId: string
      revision: number
      displayLayoutRevision: number
      capturedAt: string
    },
    target: { kind: "window", ref: WindowRef },
    cgWindowId: number,
    ownerPid: number,
    axSnapshotRef: string,
    cgInventoryRef: string,
    windowFrame: { x: number, y: number, width: number, height: number },
    displays: DisplayRecord[],
  ): Promise<ProofRef> {
    const overlaps = displays.filter(display => intersects(
      display.bounds,
      windowFrame,
    ))
    if (overlaps.length === 0) throw new Error("Window mapping не связан ни с одним display")
    const mapping = {
      kind: "window" as const,
      cgWindowId,
      ownerPid,
      displays: overlaps.map(display => ({ nativeDisplayId: display.nativeDisplayId, ref: display.ref })),
    }
    const receipt = await this.#native.evidencePublisher.publish({
      factKind: "window-cg-ax-correlation",
      sourceResponseRef: raw.sourceResponseRef,
      inventoryId: raw.inventoryId,
      inventoryRevision: raw.revision,
      displayLayoutRevision: raw.displayLayoutRevision,
      observedAt: raw.capturedAt,
      target,
      mapping,
      corroboration: { axSnapshotRef, cgInventoryRef },
    })
    return await this.services.evidence.issueWindowCorrelation({ receipt, target, nativeMapping: mapping })
  }

  async #mapTransition(
    request: WindowTransitionRequest,
    raw: NativeWindowTransitionResult,
  ): Promise<WindowTransitionResult> {
    const generation = this.#generation()
    const target = request.target
    if (raw.actual.applicationRef !== target.applicationRef || raw.actual.windowRef !== target.windowRef) {
      throw new Error("Window transition вернул другую application/window identity")
    }
    let proof: ProofRef | undefined
    const inventory = this.#lastInventory
    if (
      raw.actual.kind === "ax-window"
      && inventory !== undefined
      && raw.actual.mapping === "corroborated"
      && raw.actual.cgWindowId !== undefined
      && raw.inventoryId === inventory.inventoryId
      && raw.inventoryRevision === inventory.revision
      && raw.displayLayoutRevision === inventory.displayLayoutRevision
    ) {
      const displays: DisplayRecord[] = raw.displays.map(display => ({
        ref: { ...generation, displayRef: display.displayRef, displayLayoutRevision: raw.displayLayoutRevision },
        nativeDisplayId: display.nativeDisplayId,
        bounds: display.bounds,
        usableBounds: display.usableBounds,
        scale: display.scale,
        rotationDegrees: display.rotationDegrees,
        main: display.main,
      }))
      proof = await this.#publishWindowEvidence(
        {
          sourceResponseRef: raw.sourceResponseRef,
          inventoryId: raw.inventoryId,
          revision: raw.inventoryRevision,
          displayLayoutRevision: raw.displayLayoutRevision,
          capturedAt: raw.observedAt,
        },
        { kind: "window", ref: target },
        raw.actual.cgWindowId,
        raw.actual.ownerPid,
        raw.actual.axSnapshotRef!,
        raw.actual.cgInventoryRef!,
        raw.actual.frame,
        displays,
      )
    }
    const actual = raw.actual.kind === "ax-window" ? mapWindowRecord(raw.actual, target, generation, proof)
      : raw.actual.kind === "closed" ? { kind: "closed" as const, ref: target, absence: "confirmed" as const }
        : { kind: "unknown" as const, ref: target, reason: raw.actual.reason }
    const value = {
      target,
      requested: request,
      actual,
      changed: raw.changed,
      partial: raw.partial,
      ...(raw.newSurface === undefined ? {} : {
        newSurface: surfaceRef(raw.newSurface, generation),
      }),
      errors: raw.errors.map(message => contractError(
        raw.partial ? "inventory-incomplete" : "internal-error",
        message,
        "window-transition",
      )),
    }
    return windowTransitionResultSchema.parse(value)
  }

  #generation() {
    const generation = this.#native.generation
    if (generation === undefined) throw new Error("Native handshake ещё не завершён")
    if (
      generation.runtimeEpoch !== this.host.generation.runtimeEpoch
      || generation.loginSessionId !== this.host.generation.loginSessionId
    ) {
      throw new Error("Native generation не совпадает с WindowAdapter host")
    }
    return generation
  }
}

function mapWindowRecord(
  window: Extract<NativeInventoryResult["windows"][number], { kind: "ax-window" }>,
  ref: WindowRef,
  generation: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
  proof: ProofRef | undefined,
): WindowRecord {
  const mapping = window.mapping === "corroborated" && proof !== undefined
    ? "corroborated" as const
    : window.mapping === "ambiguous" ? "ambiguous" as const : "unavailable" as const
  const advertisedActions = window.advertisedActions
  return {
    kind: "ax-window",
    ref,
    surfaces: window.surfaces.map(surface => mapSurface(surface, generation)),
    ownerPid: window.ownerPid,
    ...(window.cgWindowId === undefined ? {} : { cgWindowId: window.cgWindowId }),
    title: window.title,
    role: window.role,
    subrole: window.subrole,
    frame: window.frame,
    applicationHidden: window.applicationHidden,
    minimized: window.minimized,
    onScreen: window.onScreen,
    spaceVisibility: window.spaceVisibility,
    fullscreen: window.fullscreen,
    focused: window.focused,
    main: window.main,
    mapping,
    ...(mapping === "corroborated" && proof !== undefined && window.cgWindowId !== undefined
      ? { mappingEvidence: { proof, cgWindowId: window.cgWindowId, ownerPid: window.ownerPid } }
      : { mappingReason: window.mappingReason ?? "Runtime evidence для CG-AX mapping недоступно" }),
    actionability: window.actionability,
    ...(window.unavailableReason === undefined ? {} : { unavailableReason: window.unavailableReason }),
    advertisedActions,
    permittedActions: window.actionability === "ax" ? advertisedActions : [],
  }
}

function mapSurface(
  surface: NativeInventoryResult["windows"][number] extends never ? never : {
    kind: "sheet" | "popup" | "menu" | "unknown"
    surfaceRef: string
    applicationRef: string
    ownerWindowRef: string
    title: string
    role: string
    frame: { x: number, y: number, width: number, height: number }
    advertisedActions: ("raise" | "close" | "minimize" | "move" | "resize")[]
  },
  generation: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
): SurfaceRecord {
  const advertisedActions = surface.advertisedActions.filter(
    (action): action is "raise" | "close" => action === "raise" || action === "close",
  )
  return {
    ref: surfaceRef(surface, generation),
    kind: surface.kind,
    title: surface.title,
    role: surface.role,
    frame: surface.frame,
    actionability: "ax",
    advertisedActions,
    permittedActions: advertisedActions,
  }
}

function surfaceRef(
  surface: { surfaceRef: string, applicationRef: string, ownerWindowRef: string },
  generation: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string },
) {
  return {
    ...generation,
    applicationRef: surface.applicationRef,
    surfaceRef: surface.surfaceRef,
    ownerWindowRef: surface.ownerWindowRef,
  }
}

function intersects(
  left: { x: number, y: number, width: number, height: number },
  right: { x: number, y: number, width: number, height: number } | undefined,
): boolean {
  if (right === undefined) return false
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
}

function cgEntryRef(pid: number, windowId: number, revision: number): string {
  return `cg-${pid}-${windowId}-${revision}`
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`
}

function contractError(
  code: ContractError["code"],
  message: string,
  stage: string,
): ContractError {
  return {
    code,
    message,
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: code === "inventory-incomplete" ? "refresh-inventory" : "inspect-health",
  }
}

function outcomeFromStatus(
  status: NativeOperationStatus,
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome {
  return {
    dispatch: status.dispatch,
    targetVerified: status.targetVerified,
    userInterference: status.userInterference,
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: cleanupOutcome(status.cleanup, resources),
    restoration: status.restorationAllowed ? "kept-target" : "unknown",
    ...(status.lastCheckpoint === undefined ? {} : { lastCheckpoint: status.lastCheckpoint }),
    dispatchAttempts: status.dispatchAttempts,
    ledgerRevision: status.ledgerRevision,
  }
}

function unknownOutcome(resources: readonly RuntimeResourceHandle[]): OperationOutcome {
  return {
    dispatch: "unknown",
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: cleanupOutcome("unknown", resources),
    restoration: "unknown",
    dispatchAttempts: 0,
  }
}

function cleanupOutcome(
  state: NativeOperationStatus["cleanup"],
  resources: readonly RuntimeResourceHandle[],
): OperationOutcome["cleanup"] {
  if (resources.length === 0) {
    if (state !== "complete") throw new Error("Native cleanup unknown для операции без runtime-owned resources")
    return { scope: "none", state: "complete", resources: [] }
  }
  if (state === "complete") {
    return {
      scope: "owned",
      state: "complete",
      resources: resources.map(handle => ({ handle, outcome: "released" as const })),
    }
  }
  return {
    scope: "owned",
    state,
    resources: resources.map(handle => ({ handle, outcome: "quarantined" as const })),
    reason: "Native physical cleanup не подтверждён",
  }
}
