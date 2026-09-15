import {
  browserOperationResources,
  structurallyEqual,
  z,
  type AdapterResult,
  type BrowserInstanceRecord,
  type BrowserInstanceSnapshot,
  type BrowserOperationRequest,
  type BrowserOperationResult,
  type BrowserTargetSnapshot,
  type DesktopInventorySnapshot,
  type AxInspectionResult,
  type RuntimeClientSession,
  type ScreenCaptureResult,
  type WindowRecord,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"
import { AgentOperations, type AgentMutationContext } from "./agent-operations.ts"
import { AgentTargetRegistry, type AgentTargetActionResolution, type AgentTargetScope } from "./agent-targets.ts"

export const agentTargetIdSchema = z.string().min(1).max(127)
const targetId = agentTargetIdSchema
const errorSchema = z.strictObject({ stage: z.string(), message: z.string() })
const elementSchema = z.strictObject({
  elementId: targetId,
  role: z.string(),
  subrole: z.string(),
  title: z.string(),
  actions: z.array(z.string()),
})
const windowSchema = z.strictObject({
  targetId,
  kind: z.literal("window"),
  app: z.string(),
  pid: z.number().int(),
  title: z.string(),
  hidden: z.enum(["true", "false", "unknown"]),
  minimized: z.enum(["true", "false", "unknown"]),
  visibility: z.enum(["current", "not-current", "unknown"]),
  focused: z.enum(["true", "false", "unknown"]),
  actionExpiresAt: z.string(),
})
const browserSchema = z.strictObject({
  browserId: targetId,
  kind: z.literal("browser"),
  profile: z.string().optional(),
  state: z.enum(["connected", "degraded", "disconnected"]),
  actionExpiresAt: z.string(),
})
const applicationSchema = z.strictObject({
  name: z.string(),
  pid: z.number().int(),
  bundleId: z.string().optional(),
  hidden: z.enum(["true", "false", "unknown"]),
  axStatus: z.enum(["ready", "no-windows", "timed-out", "denied", "unavailable", "failed"]),
  axReason: z.string().optional(),
  axWindowCount: z.number().int().safe().min(0),
})
const unavailableWindowSchema = z.strictObject({
  pid: z.number().int(),
  title: z.string(),
  visibility: z.enum(["true", "false", "unknown"]),
  reason: z.string(),
})
const stateOutputSchema = z.strictObject({
  complete: z.boolean(),
  errors: z.array(errorSchema),
  applications: z.array(applicationSchema),
  windows: z.array(windowSchema),
  unavailableWindows: z.array(unavailableWindowSchema),
  browsers: z.array(browserSchema),
})
const tabsOutputSchema = z.strictObject({
  browserId: targetId,
  complete: z.boolean(),
  errors: z.array(errorSchema),
  tabs: z.array(z.strictObject({
    targetId,
    cdpTargetId: z.string(),
    profile: z.string().optional(),
    title: z.string(),
    url: z.string(),
    actionExpiresAt: z.string(),
  })),
})
export const agentObservedStateSchema = z.strictObject({
  targetId,
  state: z.string(),
  complete: z.boolean(),
  errors: z.array(errorSchema),
  elements: z.array(elementSchema),
  imageId: targetId.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})
const observedStateSchema = agentObservedStateSchema

type BrowserExecution = { result: AdapterResult<BrowserOperationResult> }
type BrowserCapturePublicRequest = {
  kind: "capture-target"
  target: Extract<BrowserOperationRequest, { kind: "capture-target" }>["target"]
  capture: Omit<Extract<BrowserOperationRequest, { kind: "capture-target" }>["capture"], "publication">
}
type FreshWindow = {
  inventory: DesktopInventorySnapshot
  selected: AgentTargetActionResolution
  window: WindowRecord
}

export type AgentMethodsOptions = {
  now?: () => Date
  ids?: (prefix: string) => string
  operations?: AgentOperations
}

/** Композирует короткие agent DTO только через уже зарегистрированные runtime methods. */
export class RuntimeAgentMethods {
  readonly #registry: MethodRegistry
  readonly #core: RuntimeCore
  readonly #targets: AgentTargetRegistry
  readonly #now: () => Date
  readonly #ids: (prefix: string) => string
  readonly operations: AgentOperations
  readonly #frames = new Map<string, string>()
  readonly #observations = new Map<string, unknown>()

  constructor(registry: MethodRegistry, core: RuntimeCore, targets: AgentTargetRegistry, options: AgentMethodsOptions = {}) {
    this.#registry = registry
    this.#core = core
    this.#targets = targets
    this.#now = options.now ?? (() => new Date())
    this.#ids = options.ids ?? (prefix => `${prefix}:${crypto.randomUUID()}`)
    this.operations = options.operations ?? new AgentOperations({ runtime: core, targets })
  }

  register(): void {
    this.#registry.register("get_state", {
      title: "Доступные цели",
      description: "Возвращает короткие lineage-scoped handles точных окон и настроенных browser instances.",
      input: z.strictObject({
        kind: z.enum(["window", "browser"]).optional(),
        app: z.string().min(1).max(256).optional(),
        pid: z.number().int().min(1).max(0x7fffffff).optional(),
      }),
      output: stateOutputSchema,
      readOnly: true,
      requiredCapabilities: ["runtime.identity"],
      execute: async (context, input) => this.#getState(context.session, input, context.signal),
    })
    this.#registry.register("get_tabs", {
      title: "Вкладки выбранного browser",
      description: "Подключает только выбранный configured browser lifetime и возвращает exact CDP target handles.",
      input: z.strictObject({ browserId: targetId }),
      output: tabsOutputSchema,
      readOnly: false,
      requiredCapabilities: ["browser.instances", "browser.targets", "runtime.operations"],
      timeoutMs: 30_000,
      execute: async (context, input) => this.#getTabs(context.session, input.browserId, context.signal),
    })
    this.#registry.register("show_window", {
      title: "Показать точное окно",
      description: "Показывает и фокусирует существующее окно без запуска приложения, затем возвращает fresh AX state.",
      input: z.strictObject({ targetId: targetId }),
      output: observedStateSchema.omit({ imageId: true, width: true, height: true }),
      readOnly: false,
      destructive: false,
      requiredCapabilities: ["desktop.window.show", "desktop.ax", "runtime.operations"],
      timeoutMs: 20_000,
      execute: async (context, input) => this.#showWindow(context.session, input.targetId, context.signal),
    })
    this.#registry.register("observe", {
      title: "Наблюдать выбранную цель",
      description: "Возвращает fresh AX, screenshot или оба для exact target handle.",
      input: z.strictObject({
        targetId,
        mode: z.enum(["ax", "screenshot", "both"]),
        caption: z.string().min(1).max(2_048).optional(),
      }).superRefine((input, context) => {
        if (input.mode !== "ax" && input.caption === undefined) {
          context.addIssue({ code: "custom", path: ["caption"], message: "Screenshot observation требует expectation caption" })
        }
      }),
      output: observedStateSchema,
      readOnly: true,
      requiredCapabilities: ["runtime.identity"],
      timeoutMs: 20_000,
      execute: async (context, input) => this.#observe(context.session, input.targetId, input.mode, input.caption, context.signal),
      frames: output => output.imageId === undefined ? [] : this.#takeFrame(output.imageId),
    })
  }

  async #getState(
    session: RuntimeClientSession,
    input: { kind?: "window" | "browser", app?: string, pid?: number },
    signal: AbortSignal,
  ) {
    await this.#health(session, signal)
    const scope = this.#scope(session)
    const errors: Array<{ stage: string, message: string }> = []
    let complete = true
    const windows: z.infer<typeof windowSchema>[] = []
    const applications: z.infer<typeof applicationSchema>[] = []
    const unavailableWindows: z.infer<typeof unavailableWindowSchema>[] = []
    const browsers: z.infer<typeof browserSchema>[] = []
    if (input.kind !== "browser") {
      try {
        const inventory = await this.#inventory(session, signal, {
          ...(input.app === undefined ? {} : { app: input.app }),
          ...(input.pid === undefined ? {} : { pid: input.pid }),
        })
        complete &&= inventory.complete
        errors.push(...publicErrors("list_windows", inventory.errors))
        const applicationByRef = new Map(inventory.applications.map(app => [String(app.ref.applicationRef), app]))
        for (const application of inventory.applications) {
          if (input.app !== undefined && ![application.name, application.bundleId, application.ref.applicationRef].includes(input.app)) continue
          if (input.pid !== undefined && application.ref.pid !== input.pid) continue
          applications.push({
            name: application.name,
            pid: application.ref.pid,
            ...(application.bundleId === undefined ? {} : { bundleId: application.bundleId }),
            hidden: application.hidden,
            axStatus: application.axStatus,
            ...(application.axReason === undefined ? {} : { axReason: application.axReason }),
            axWindowCount: application.windowCount,
          })
        }
        const filteredApplicationPids = new Set(applications.map(application => application.pid))
        for (const window of inventory.windows) {
          if (window.kind !== "ax-window") {
            if (input.pid !== undefined && window.ownerPid !== input.pid) continue
            if (input.app !== undefined && !filteredApplicationPids.has(window.ownerPid)) continue
            unavailableWindows.push({
              pid: window.ownerPid,
              title: window.title,
              visibility: window.onScreen,
              reason: window.reason,
            })
            continue
          }
          const application = applicationByRef.get(String(window.ref.applicationRef))
          if (application === undefined) continue
          if (input.app !== undefined && ![application.name, application.bundleId, application.ref.applicationRef].includes(input.app)) continue
          if (input.pid !== undefined && window.ownerPid !== input.pid) continue
          const handle = scope.registerTarget({ kind: "window", ref: window.ref }, {
            inventoryId: inventory.inventoryId,
            inventoryRevision: inventory.revision,
          })
          windows.push({
            targetId: handle.targetId,
            kind: "window",
            app: application.name,
            pid: window.ownerPid,
            title: window.title,
            hidden: window.applicationHidden,
            minimized: window.minimized,
            visibility: window.spaceVisibility,
            focused: window.focused,
            actionExpiresAt: handle.actionExpiresAt,
          })
        }
      } catch (error) {
        complete = false
        errors.push(publicError("list_windows", error))
      }
    }
    const chromeAvailable = this.#registry.descriptors().tools.some(tool => tool.name === "browser_chrome_instances")
    if (chromeAvailable && input.kind !== "window" && input.app === undefined && input.pid === undefined) {
      try {
        const response = await this.#dispatch(session, "browser_chrome_instances", {}, signal)
        const snapshot = response.data as BrowserInstanceSnapshot
        complete &&= snapshot.complete === true
        errors.push(...publicErrors("browser_chrome_instances", snapshot.errors))
        for (const instance of snapshot.instances ?? []) {
          const handle = scope.registerTarget({ kind: "browser-instance", ref: instance.ref }, {
            inventoryId: snapshot.inventoryId,
            inventoryRevision: snapshot.inventoryRevision,
          })
          browsers.push({
            browserId: handle.targetId,
            kind: "browser",
            ...(instance.profileLabel === undefined ? {} : { profile: instance.profileLabel }),
            state: instance.state,
            actionExpiresAt: handle.actionExpiresAt,
          })
        }
      } catch (error) {
        complete = false
        errors.push(publicError("browser_chrome_instances", error))
      }
    }
    return stateOutputSchema.parse({ complete, errors, applications, windows, unavailableWindows, browsers })
  }

  async #getTabs(session: RuntimeClientSession, browserId: string, signal: AbortSignal) {
    await this.#health(session, signal)
    const scope = this.#scope(session)
    const selected = scope.resolveAction(browserId)
    if (selected.target.kind !== "browser-instance") throw new Error("browserId не является browser instance handle")
    const snapshot = (await this.#dispatch(session, "browser_chrome_instances", {}, signal)).data as BrowserInstanceSnapshot
    const instance = snapshot.instances.find(candidate => structurallyEqual(candidate.ref, selected.target.ref))
    if (instance === undefined) {
      scope.invalidateTarget(browserId, "Configured browser instance исчез из fresh inventory")
      throw new Error("Selected browser instance stale; получите fresh state")
    }
    let current: BrowserInstanceRecord = instance
    let currentBrowserId = browserId
    if (instance.state === "disconnected") {
      const request: BrowserOperationRequest = { kind: "connect-instance", instance: instance.ref }
      const operation = await this.#dispatch(session, "browser_chrome_operation", {
        intent: {
          intent: "mutation",
          clientRequestId: this.#ids("agent-browser-connect"),
          precondition: { target: { kind: "browser-instance", ref: instance.ref },
            inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.inventoryRevision },
          deadlineAt: new Date(this.#now().getTime() + 20_000).toISOString(),
          requestedResources: browserOperationResources(request),
        },
        request,
      }, signal)
      const execution = operation.data as BrowserExecution
      if (!execution.result.ok || execution.result.value.value.kind !== "instance-connected") {
        throw new Error("Selected browser connect не подтверждён")
      }
      current = execution.result.value.value.instance
      if (
        current.ref.runtimeEpoch !== instance.ref.runtimeEpoch
        || current.ref.loginSessionId !== instance.ref.loginSessionId
        || current.ref.browserInstanceRef !== instance.ref.browserInstanceRef
        || current.ref.transportGeneration === instance.ref.transportGeneration
      ) {
        throw new Error("Selected browser connect вернул другую instance identity/generation")
      }
      scope.invalidateTarget(browserId, "Browser transport generation advanced")
    } else if (instance.state !== "connected") {
      throw new Error(`Selected browser state ${instance.state}; recovery required`)
    }
    const response = await this.#dispatch(session, "browser_chrome_targets", { instance: current.ref }, signal)
    const targets = response.data as BrowserTargetSnapshot
    if (!structurallyEqual(targets.instance, current.ref)) {
      throw new Error("Browser targets snapshot принадлежит другой instance")
    }
    const currentHandle = scope.registerTarget({ kind: "browser-instance", ref: current.ref }, {
      inventoryId: targets.inventoryId,
      inventoryRevision: targets.inventoryRevision,
    })
    currentBrowserId = currentHandle.targetId
    const errors = publicErrors("browser_chrome_targets", targets.errors)
    const tabs = targets.targets.map(tab => {
      const handle = scope.registerTarget({ kind: "browser-target", ref: tab.ref }, {
        inventoryId: targets.inventoryId,
        inventoryRevision: targets.inventoryRevision,
      })
      return {
        targetId: handle.targetId,
        cdpTargetId: tab.ref.targetId,
        ...(current.profileLabel === undefined ? {} : { profile: current.profileLabel }),
        title: tab.title,
        url: tab.url,
        actionExpiresAt: handle.actionExpiresAt,
      }
    })
    return tabsOutputSchema.parse({ browserId: currentBrowserId, complete: targets.complete === true, errors, tabs })
  }

  async #showWindow(session: RuntimeClientSession, targetIdValue: string, signal: AbortSignal) {
    await this.#health(session, signal)
    const show = this.operations.runTrackedMutation(session, targetIdValue, "show-window-show",
      context => this.#transitionWindow(session, targetIdValue, "show", context), signal)
    await Promise.resolve()
    const focus = this.operations.runTrackedMutation(session, targetIdValue, "show-window-focus",
      context => this.#transitionWindow(session, targetIdValue, "focus", context), signal)
    await Promise.all([show, focus])
    const scope = this.#scope(session)
    const fresh = await this.#refreshWindow(session, scope, targetIdValue, scope.resolveAction(targetIdValue), signal)
    return this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal)
  }

  async refreshWindowAction(
    session: RuntimeClientSession,
    targetIdValue: string,
    binding: AgentTargetActionResolution,
    signal: AbortSignal,
  ): Promise<AgentTargetActionResolution> {
    await this.#health(session, signal)
    return (await this.#refreshWindow(session, this.#scope(session), targetIdValue, binding, signal)).selected
  }

  async #transitionWindow(
    session: RuntimeClientSession,
    targetIdValue: string,
    kind: "show" | "focus",
    context: AgentMutationContext,
  ): Promise<void> {
    const scope = this.#scope(session)
    const fresh = await this.#refreshWindow(session, scope, targetIdValue, context.binding, context.signal)
    await this.#dispatch(session, "window_transition", {
      inventoryId: fresh.selected.inventoryId,
      inventoryRevision: fresh.selected.inventoryRevision,
      clientRequestId: context.clientRequestId,
      request: { kind, target: fresh.selected.target.ref },
    }, context.signal)
    await this.#refreshWindow(session, scope, targetIdValue, fresh.selected, context.signal)
  }

  async #observe(
    session: RuntimeClientSession,
    targetIdValue: string,
    mode: "ax" | "screenshot" | "both",
    caption: string | undefined,
    signal: AbortSignal,
  ) {
    await this.#health(session, signal)
    const scope = this.#scope(session)
    const selected = scope.resolveAction(targetIdValue)
    if (selected.target.kind === "browser-target") {
      return this.#observeBrowser(session, scope, targetIdValue, selected, mode, caption, signal)
    }
    if (selected.target.kind !== "window") throw new Error("observe поддерживает window или browser target")
    const fresh = await this.#refreshWindow(session, scope, targetIdValue, selected, signal)
    const ax = mode === "screenshot" ? undefined : await this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal)
    const screenshot = mode === "ax" ? undefined : await this.#captureWindow(session, targetIdValue, fresh, caption!, signal)
    if (mode === "screenshot") scope.invalidateElements(targetIdValue)
    return observedStateSchema.parse({
      targetId: targetIdValue,
      state: ax?.state ?? "",
      complete: (ax?.complete ?? true) && (screenshot?.complete ?? true),
      errors: [...(ax?.errors ?? []), ...(screenshot?.errors ?? [])],
      elements: ax?.elements ?? [],
      ...(screenshot === undefined ? {} : screenshot),
    })
  }

  async #observeBrowser(
    session: RuntimeClientSession,
    scope: AgentTargetScope,
    targetIdValue: string,
    selected: AgentTargetActionResolution,
    mode: "ax" | "screenshot" | "both",
    caption: string | undefined,
    signal: AbortSignal,
  ) {
    if (selected.target.kind !== "browser-target") throw new Error("Browser observe требует browser target")
    const target = selected.target.ref
    let state = ""
    let complete = true
    const errors: Array<{ stage: string, message: string }> = []
    if (mode !== "screenshot") {
      const request: BrowserOperationRequest = {
        kind: "read-accessibility",
        target,
        maxNodes: 1_500,
        maxBytes: 1024 * 1024,
      }
      const execution = await this.#browserOperation(session, selected, request, signal)
      if (!execution.result.ok || execution.result.value.value.kind !== "accessibility-read") {
        throw new Error("Browser AX observation не подтверждён")
      }
      const value = execution.result.value.value
      state = formatBrowserAxState(value.content, value.truncated)
      if (value.truncated) {
        complete = false
        errors.push({ stage: "browser-accessibility", message: "Browser AX response truncated by declared budget" })
      }
    }
    let screenshot: { imageId: string, width: number, height: number } | undefined
    if (mode !== "ax") {
      const request: BrowserCapturePublicRequest = {
        kind: "capture-target",
        target,
        capture: {
          source: "browser-viewport",
          caption: caption!,
          target: { kind: "browser-target", ref: target },
          clip: { kind: "full-target" },
          fullPage: false,
          cursor: "exclude",
          readinessPolicy: {
            policyId: "agent-observe",
            requiredSteps: ["target", "document-ready", "complete-frame"],
            disabledSteps: ["fonts", "network-idle", "images", "reflow-stable", "animations", "final-commit", "permission", "ownership"],
          },
          output: { format: "image/png", scale: 0.5, maxWidthPx: 32_768, maxHeightPx: 32_768,
            maxPixels: 32_000_000, maxEncodedBytes: 64 * 1024 * 1024 },
        },
      }
      const execution = await this.#browserOperation(session, selected, request, signal)
      if (!execution.result.ok || execution.result.value.value.kind !== "target-captured") {
        throw new Error("Browser screenshot observation не подтверждён")
      }
      const capture = execution.result.value.value.capture
      const responseFrameRefs = execution.frameRefs
      if (responseFrameRefs.length !== 1 || responseFrameRefs[0] !== capture.frame.frameRef) {
        throw new Error("Browser capture не вернул exact available frame")
      }
      const imageId = this.#ids("agent-image")
      this.#frames.set(imageId, responseFrameRefs[0])
      this.#observations.set(`${this.#core.clients.lineage(session)}:${targetIdValue}`, structuredClone(capture.observation))
      this.#pruneFrames()
      this.#pruneObservations()
      screenshot = { imageId, width: capture.observation.image.widthPx, height: capture.observation.image.heightPx }
      if (capture.observation.readiness.state !== "ready") {
        complete = false
        errors.push({ stage: "browser-capture", message: `Browser capture readiness: ${capture.observation.readiness.state}` })
      }
      if (capture.observation.unavailableReasons.length > 0) complete = false
      errors.push(...capture.observation.unavailableReasons.map(message => ({ stage: "browser-capture", message })))
    }
    scope.invalidateElements(targetIdValue)
    return observedStateSchema.parse({
      targetId: targetIdValue,
      state,
      complete,
      errors,
      elements: [],
      ...(screenshot ?? {}),
    })
  }

  async #browserOperation(
    session: RuntimeClientSession,
    selected: AgentTargetActionResolution,
    request: BrowserOperationRequest | BrowserCapturePublicRequest,
    signal: AbortSignal,
  ): Promise<BrowserExecution & { frameRefs: string[] }> {
    const requestedResources = request.kind === "capture-target"
      ? []
      : browserOperationResources(request)
    const response = await this.#dispatch(session, "browser_chrome_operation", {
      intent: {
        intent: "read",
        clientRequestId: this.#ids(`agent-browser-${request.kind}`),
        precondition: {
          target: selected.target,
          inventoryId: selected.inventoryId,
          inventoryRevision: selected.inventoryRevision,
        },
        deadlineAt: new Date(this.#now().getTime() + 20_000).toISOString(),
        requestedResources,
      },
      request,
    }, signal)
    return { ...(response.data as BrowserExecution), frameRefs: response.frameRefs }
  }

  async #inspectWindow(
    session: RuntimeClientSession,
    scope: AgentTargetScope,
    targetIdValue: string,
    selected: AgentTargetActionResolution,
    signal: AbortSignal,
  ) {
    const response = await this.#dispatch(session, "inspect_accessibility", {
      inventoryId: selected.inventoryId,
      inventoryRevision: selected.inventoryRevision,
      request: { target: selected.target, depth: 12, maxNodes: 1_500, maxBytes: 1024 * 1024 },
    }, signal)
    const inspection = response.data as AxInspectionResult
    const elements = scope.registerElements(targetIdValue, inspection)
    const errors = publicErrors("inspect_accessibility", inspection.errors)
    if (!inspection.complete && errors.length === 0) {
      errors.push({ stage: "inspect_accessibility", message: "AX snapshot incomplete; continuation не опубликован high-level API" })
    }
    return {
      targetId: targetIdValue,
      state: formatAxState(inspection, elements),
      complete: inspection.complete === true,
      errors,
      elements,
    }
  }

  async #captureWindow(
    session: RuntimeClientSession,
    targetIdValue: string,
    fresh: FreshWindow,
    caption: string,
    signal: AbortSignal,
  ) {
    const { inventory, selected, window } = fresh
    if (window.mapping !== "corroborated" || window.mappingEvidence === undefined || window.cgWindowId === undefined) {
      throw new Error("Window screenshot требует current corroborated CG/AX mapping")
    }
    const response = await this.#dispatch(session, "capture_window", {
      clientRequestId: this.#ids("agent-window-capture"),
      inventoryId: inventory.inventoryId,
      caption,
      clip: { kind: "full-target" },
      cursor: "exclude",
      readinessPolicy: { policyId: "agent-window-observe", requiredSteps: ["complete-frame", "permission", "target", "ownership"], disabledSteps: [] },
      output: { format: "image/png", scale: 0.5, maxWidthPx: 16_384, maxHeightPx: 16_384,
        maxPixels: 8_000_000, maxEncodedBytes: 8 * 1024 * 1024 },
      target: { kind: "window", target: selected.target, cgWindowId: window.cgWindowId,
        ownerPid: window.ownerPid, mappingEvidence: {
          state: "confirmed", claim: "cg-ax-correlation", source: "desktop-inventory",
          proof: window.mappingEvidence.proof,
        } },
    }, signal)
    const capture = response.data as { result: AdapterResult<ScreenCaptureResult>, frameAvailable: boolean }
    if (!capture.result.ok || capture.frameAvailable !== true || response.frameRefs.length !== 1) {
      throw new Error("Window capture не вернул exact available frame")
    }
    const observation = capture.result.value.observation
    const imageId = this.#ids("agent-image")
    this.#frames.set(imageId, response.frameRefs[0]!)
    this.#observations.set(`${this.#core.clients.lineage(session)}:${targetIdValue}`, structuredClone(observation))
    this.#pruneFrames()
    this.#pruneObservations()
    const errors = observation.unavailableReasons.map(message => ({ stage: "window-capture", message }))
    if (observation.readiness.state !== "ready") {
      errors.unshift({ stage: "window-capture", message: `Window capture readiness: ${observation.readiness.state}` })
    }
    return {
      imageId,
      width: observation.image.widthPx,
      height: observation.image.heightPx,
      complete: observation.readiness.state === "ready" && observation.unavailableReasons.length === 0,
      errors,
    }
  }

  async #refreshWindow(
    session: RuntimeClientSession,
    scope: AgentTargetScope,
    targetIdValue: string,
    selected: AgentTargetActionResolution,
    signal: AbortSignal,
  ): Promise<FreshWindow> {
    if (selected.target.kind !== "window") throw new Error("Window refresh требует window target")
    const inventory = await this.#inventory(session, signal)
    const targetRef = selected.target.ref
    const window = inventory.windows.find((candidate): candidate is WindowRecord => {
      return candidate.kind === "ax-window" && structurallyEqual(candidate.ref, targetRef)
    })
    if (window === undefined) {
      scope.closeTarget(targetIdValue, "Exact window отсутствует в fresh inventory")
      throw new Error("Exact window closed or stale; handle не ретаргетирован")
    }
    scope.registerTarget({ kind: "window", ref: window.ref }, {
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
    })
    return { inventory, window, selected: scope.resolveAction(targetIdValue) }
  }

  async #inventory(
    session: RuntimeClientSession,
    signal: AbortSignal,
    filter: { app?: string, pid?: number } = {},
  ): Promise<DesktopInventorySnapshot> {
    return (await this.#dispatch(session, "list_windows", filter, signal)).data as DesktopInventorySnapshot
  }

  async #health(session: RuntimeClientSession, signal: AbortSignal): Promise<void> {
    const health = (await this.#dispatch(session, "system_health", {}, signal)).data as any
    if (health.machine?.matchesExpected !== true || health.runtime?.draining === true
      || health.runtime?.admissionSealed === true) throw new Error("Runtime machine/admission health не готов")
  }

  #scope(session: RuntimeClientSession): AgentTargetScope {
    return this.#targets.forLineage(this.#core.clients.lineage(session))
  }

  async #dispatch(
    session: RuntimeClientSession,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<RuntimeMethodResponse> {
    signal.throwIfAborted()
    const response = await this.#registry.dispatch(session, name, input, signal)
    if (response.isError) throw new Error(`Internal runtime method ${name} failed`)
    return response
  }

  #takeFrame(imageId: string): string[] {
    const frame = this.#frames.get(imageId)
    this.#frames.delete(imageId)
    return frame === undefined ? [] : [frame]
  }

  #pruneFrames(): void {
    while (this.#frames.size > 128) this.#frames.delete(this.#frames.keys().next().value!)
  }

  #pruneObservations(): void {
    while (this.#observations.size > 128) this.#observations.delete(this.#observations.keys().next().value!)
  }
}

export function registerAgentMethods(
  registry: MethodRegistry,
  core: RuntimeCore,
  targets: AgentTargetRegistry,
  options?: AgentMethodsOptions,
): RuntimeAgentMethods {
  const methods = new RuntimeAgentMethods(registry, core, targets, options)
  methods.register()
  return methods
}

function formatAxState(inspection: AxInspectionResult, elements: Array<{ elementId: string, role: string, subrole: string, title: string, actions: string[] }>): string {
  const header = `AX tree complete=${inspection.complete === true}`
  return [header, ...elements.map(element => {
    const title = element.title === "" ? "" : ` title=${JSON.stringify(element.title)}`
    return `[${element.elementId}] role=${element.role} subrole=${element.subrole}${title} actions=${JSON.stringify(element.actions)}`
  })].join("\n")
}

function formatBrowserAxState(content: string, truncated: boolean): string {
  const parsed: unknown = JSON.parse(content)
  if (!Array.isArray(parsed)) throw new Error("Browser AX response не является массивом nodes")
  const lines = parsed.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Browser AX node ${index} имеет неверную форму`)
    }
    const node = raw as Record<string, unknown>
    const role = axValue(node.role)
    const title = axValue(node.name)
    const actions = Array.isArray(node.actions)
      ? node.actions.filter(action => typeof action === "string")
      : []
    return `role=${JSON.stringify(role)} title=${JSON.stringify(title)} actions=${JSON.stringify(actions)}`
  })
  return [`Browser AX tree complete=${!truncated}`, ...lines].join("\n")
}

function axValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).value
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw)
  }
  return ""
}

function publicErrors(stage: string, errors: unknown): Array<{ stage: string, message: string }> {
  return Array.isArray(errors) ? errors.map(error => publicError(stage, error)) : []
}

function publicError(stage: string, error: unknown): { stage: string, message: string } {
  const message = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String(error.message)
      : String(error)
  return { stage, message: message.slice(0, 1024) }
}
