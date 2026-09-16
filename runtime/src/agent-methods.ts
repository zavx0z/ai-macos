import { operationDeadline } from "./deadline.ts"
import {
  browserOperationResources,
  structurallyEqual,
  observationSchema,
  contractErrorSchema,
  opaqueIdSchema,
  windowTransitionResultSchema,
  type Observation,
  z,
  type AdapterResult,
  type BrowserInstanceRecord,
  type BrowserInstanceSnapshot,
  type BrowserOperationRequest,
  type BrowserOperationResult,
  type BrowserTargetSnapshot,
  type DesktopInventorySnapshot,
  type DesktopLayoutCaptureTarget,
  type DisplayCaptureTarget,
  type DisplayRecord,
  type AxInspectionResult,
  type RuntimeClientSession,
  type ScreenCaptureResult,
  type WindowRecord,
  type WindowTransitionResult,
  type SurfaceRecord,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"
import { AgentOperations, type AgentMutationContext } from "./agent-operations.ts"
import { AgentTargetRegistry, type AgentElementHandle, type AgentTargetActionResolution, type AgentTargetScope } from "./agent-targets.ts"
import { canonicalJson } from "./primitives.ts"
import type { AgentViewBindings } from "./agent-view-bindings.ts"
import { RuntimeContractError } from "./errors.ts"

export const agentTargetIdSchema = z.string().min(1).max(127)
const targetId = agentTargetIdSchema
const errorSchema = z.strictObject({ stage: z.string(), message: z.string() })
// AX metadata одновременно входит в elements и текстовый state, а затем ещё
// раз экранируется общим JSON response. Оставляем запас внутри method 1 MiB.
const AGENT_AX_INSPECTION_MAX_BYTES = 128 * 1024
const elementSchema = z.strictObject({
  elementId: targetId,
  parentElementId: targetId.optional(),
  role: z.string().max(128),
  subrole: z.string().max(128),
  title: z.string().max(4_096),
  identifier: z.string().max(4_096).optional(),
  description: z.string().max(4_096).optional(),
  value: z.union([z.string().max(4_096), z.number().finite(), z.boolean()]).optional(),
  valueRedacted: z.literal(true).optional(),
  frame: z.strictObject({ x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().min(0), height: z.number().finite().min(0) })
    .describe("Read-only AX bounds в глобальных macOS points; не image pixels и не authority для click(point)").optional(),
  actions: z.array(z.string().min(1).max(128)).max(64),
}).superRefine((element, context) => {
  if (element.valueRedacted && element.value !== undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "Redacted AX value не публикуется вместе с value" })
  }
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
  actionExpiresAt: z.string().optional(),
})
const surfaceSchema = z.strictObject({
  targetId,
  ownerTargetId: targetId,
  kind: z.enum(["sheet", "popup", "menu", "unknown"]),
  role: z.string(),
  title: z.string(),
  actionability: z.enum(["ax", "unavailable"]),
  unavailableReason: z.string().optional(),
  actionExpiresAt: z.string().optional(),
})
const displaySchema = z.strictObject({
  targetId,
  kind: z.literal("display"),
  nativeDisplayId: z.number().int(),
  bounds: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  usableBounds: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  scale: z.number().positive(),
  rotationDegrees: z.number().min(0).lt(360),
  main: z.boolean(),
  actionExpiresAt: z.string().optional(),
})
const desktopLayoutSchema = z.strictObject({
  targetId,
  kind: z.literal("desktop-layout"),
  displayTargetIds: z.array(targetId),
  actionExpiresAt: z.string().optional(),
})
const browserSchema = z.strictObject({
  browserId: targetId,
  kind: z.literal("browser"),
  profile: z.string().optional(),
  state: z.enum(["connected", "degraded", "disconnected"]),
  actionExpiresAt: z.string().optional(),
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
  surfaces: z.array(surfaceSchema),
  unavailableWindows: z.array(unavailableWindowSchema),
  displays: z.array(displaySchema),
  desktopLayout: desktopLayoutSchema.optional(),
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
    actionExpiresAt: z.string().optional(),
  })),
})
const agentObservedStateBaseSchema = z.strictObject({
  targetId,
  state: z.string(),
  complete: z.boolean(),
  errors: z.array(errorSchema),
  elements: z.array(elementSchema),
  imageId: targetId.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

function validateElementParents(
  state: Pick<z.infer<typeof agentObservedStateBaseSchema>, "elements">,
  context: z.RefinementCtx,
): void {
  const elementIds = new Set(state.elements.map(element => element.elementId))
  for (const [index, element] of state.elements.entries()) {
    if (element.parentElementId === undefined) continue
    if (element.parentElementId === element.elementId || !elementIds.has(element.parentElementId)) {
      context.addIssue({ code: "custom", path: ["elements", index, "parentElementId"],
        message: "AX parentElementId должен ссылаться на другой element того же returned snapshot" })
    }
  }
}

export const agentObservedStateSchema = agentObservedStateBaseSchema.superRefine(validateElementParents)
const observedStateSchema = agentObservedStateSchema
const shownWindowStateSchema = agentObservedStateBaseSchema
  .omit({ imageId: true, width: true, height: true })
  .superRefine(validateElementParents)

type BrowserExecution = { result: AdapterResult<BrowserOperationResult> }
type BrowserCapturePublicRequest = {
  kind: "capture-target"
  target: Extract<BrowserOperationRequest, { kind: "capture-target" }>["target"]
  capture: Omit<Extract<BrowserOperationRequest, { kind: "capture-target" }>["capture"], "publication">
}
type FreshNative = {
  inventory: DesktopInventorySnapshot
  selected: AgentTargetActionResolution
  window?: WindowRecord
  surface?: SurfaceRecord
  display?: DisplayRecord
  captureTarget?: DisplayCaptureTarget | DesktopLayoutCaptureTarget
}

export type AgentMethodsOptions = {
  now?: () => Date
  ids?: (prefix: string) => string
  operations?: AgentOperations
  views?: Pick<AgentViewBindings, "observe" | "run">
}

/** Композирует короткие agent DTO только через уже зарегистрированные runtime methods. */
export class RuntimeAgentMethods {
  readonly #registry: MethodRegistry
  readonly #core: RuntimeCore
  readonly #targets: AgentTargetRegistry
  readonly #now: () => Date
  readonly #ids: (prefix: string) => string
  readonly #views?: Pick<AgentViewBindings, "observe" | "run">
  readonly operations: AgentOperations
  readonly #frames = new Map<string, string>()
  readonly #observations = new Map<string, { imageId: string, observation: Observation }>()

  constructor(registry: MethodRegistry, core: RuntimeCore, targets: AgentTargetRegistry, options: AgentMethodsOptions = {}) {
    this.#registry = registry
    this.#core = core
    this.#targets = targets
    this.#now = options.now ?? (() => new Date())
    this.#ids = options.ids ?? (prefix => `${prefix}:${crypto.randomUUID()}`)
    this.#views = options.views
    this.operations = options.operations ?? new AgentOperations({ runtime: core, targets })
  }

  register(): void {
    this.#registry.register("get_state", {
      title: "Доступные цели",
      description: "Возвращает handles окон, дисплеев и browser instances. Если пользователь просит посмотреть экран, весь экран или что сейчас на экране — запросите kind=display и используйте main display; для всех экранов используйте desktopLayout.displayTargetIds. Если названо конкретное приложение или окно — используйте kind=window.",
      input: z.strictObject({
        kind: z.enum(["window", "display", "browser"]).optional(),
        app: z.string().min(1).max(256).optional(),
        pid: z.number().int().min(1).max(0x7fffffff).optional(),
      }).superRefine((input, context) => {
        if (input.kind !== undefined && input.kind !== "window" && (input.app !== undefined || input.pid !== undefined)) {
          context.addIssue({ code: "custom", message: "app/pid filters применимы только к window discovery" })
        }
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
      output: shownWindowStateSchema,
      readOnly: false,
      destructive: false,
      requiredCapabilities: ["desktop.window.show", "desktop.ax", "runtime.operations"],
      timeoutMs: 20_000,
      execute: async (context, input) => this.#showWindow(context.session, input.targetId, context.signal),
    })
    this.#registry.register("observe", {
      title: "Наблюдать выбранную цель",
      description: "Возвращает fresh AX, screenshot или оба для exact target handle. Для запроса про экран, весь экран или содержимое экрана используйте display target и screenshot, а не window target; для конкретного приложения или окна используйте window target.",
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
    input: { kind?: "window" | "display" | "browser", app?: string, pid?: number },
    signal: AbortSignal,
  ) {
    await this.#health(session, signal)
    const scope = this.#scope(session)
    const errors: Array<{ stage: string, message: string }> = []
    let complete = true
    const windows: z.infer<typeof windowSchema>[] = []
    const surfaces: z.infer<typeof surfaceSchema>[] = []
    const applications: z.infer<typeof applicationSchema>[] = []
    const unavailableWindows: z.infer<typeof unavailableWindowSchema>[] = []
    const displays: z.infer<typeof displaySchema>[] = []
    let desktopLayout: z.infer<typeof desktopLayoutSchema> | undefined
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
        if (input.kind !== "display") for (const application of inventory.applications) {
          if (input.app !== undefined && ![application.name, application.bundleId, application.ref.applicationRef].includes(input.app)) continue
          if (input.pid !== undefined && application.ref.pid !== input.pid) continue
          applications.push({
            name: application.name,
            pid: application.ref.pid,
            ...(application.bundleId === undefined ? {} : { bundleId: application.bundleId }),
            hidden: application.hidden,
            axStatus: application.axStatus,
            ...(application.axReason === undefined ? {} : { axReason: application.axReason }),
            axWindowCount: inventory.windows.filter(window => window.kind === "ax-window"
              && window.ownerPid === application.ref.pid).length,
          })
        }
        const filteredApplicationPids = new Set(applications.map(application => application.pid))
        if (input.kind !== "display") for (const window of inventory.windows) {
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
            ...(handle.actionExpiresAt === undefined ? {} : { actionExpiresAt: handle.actionExpiresAt }),
          })
          for (const surface of window.surfaces) {
            if (!surfaceOwnedByWindow(surface, window)) {
              throw new Error("Surface owner ref не совпадает с содержащим exact window")
            }
            const surfaceHandle = scope.registerTarget({ kind: "surface", ref: surface.ref }, {
              inventoryId: inventory.inventoryId,
              inventoryRevision: inventory.revision,
            })
            surfaces.push({
              targetId: surfaceHandle.targetId,
              ownerTargetId: handle.targetId,
              kind: surface.kind,
              role: surface.role,
              title: surface.title,
              actionability: surface.actionability,
              ...(surface.unavailableReason === undefined ? {} : { unavailableReason: surface.unavailableReason }),
              ...(surfaceHandle.actionExpiresAt === undefined ? {} : { actionExpiresAt: surfaceHandle.actionExpiresAt }),
            })
          }
        }
        if (input.kind === "display" || input.kind === undefined && input.app === undefined && input.pid === undefined) {
          const displayHandles = new Map<string, string>()
          for (const display of inventory.displays) {
            const handle = scope.registerTarget({ kind: "display", ref: display.ref }, {
              inventoryId: inventory.inventoryId,
              inventoryRevision: inventory.revision,
            })
            displayHandles.set(display.ref.displayRef, handle.targetId)
            displays.push({
              targetId: handle.targetId,
              kind: "display",
              nativeDisplayId: display.nativeDisplayId,
              bounds: display.bounds,
              usableBounds: display.usableBounds,
              scale: display.scale,
              rotationDegrees: display.rotationDegrees,
              main: display.main,
              ...(handle.actionExpiresAt === undefined ? {} : { actionExpiresAt: handle.actionExpiresAt }),
            })
          }
          if (inventory.desktopLayout !== undefined) {
            const handle = scope.registerTarget(inventory.desktopLayout.target, {
              inventoryId: inventory.inventoryId,
              inventoryRevision: inventory.revision,
            })
            desktopLayout = {
              targetId: handle.targetId,
              kind: "desktop-layout",
              displayTargetIds: inventory.desktopLayout.displays.map(display => {
                const displayTargetId = displayHandles.get(display.target.ref.displayRef)
                if (displayTargetId === undefined) throw new Error("Desktop layout содержит неизвестный display")
                return displayTargetId
              }),
              ...(handle.actionExpiresAt === undefined ? {} : { actionExpiresAt: handle.actionExpiresAt }),
            }
          }
        }
      } catch (error) {
        complete = false
        errors.push(publicError("list_windows", error))
      }
    }
    const chromeAvailable = this.#registry.internal.descriptors().tools.some(tool => tool.name === "browser_chrome_instances")
    if (chromeAvailable && input.kind !== "window" && input.kind !== "display" && input.app === undefined && input.pid === undefined) {
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
            ...(handle.actionExpiresAt === undefined ? {} : { actionExpiresAt: handle.actionExpiresAt }),
          })
        }
      } catch (error) {
        complete = false
        errors.push(publicError("browser_chrome_instances", error))
      }
    }
    return stateOutputSchema.parse({ complete, errors, applications, windows, surfaces,
      unavailableWindows, displays, ...(desktopLayout === undefined ? {} : { desktopLayout }), browsers })
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
          deadlineAt: operationDeadline(signal, 20_000, this.#now().getTime()),
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
        ...(handle.actionExpiresAt === undefined ? {} : { actionExpiresAt: handle.actionExpiresAt }),
      }
    })
    return tabsOutputSchema.parse({ browserId: currentBrowserId, complete: targets.complete === true, errors, tabs })
  }

  async #showWindow(session: RuntimeClientSession, targetIdValue: string, signal: AbortSignal) {
    await this.#health(session, signal)
    this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
    await this.operations.runTrackedMutation(session, targetIdValue, "show-window-show",
      context => this.#transitionWindow(session, targetIdValue, context), signal)
    const scope = this.#scope(session)
    const fresh = await this.#refreshWindow(session, scope, targetIdValue, scope.resolveAction(targetIdValue), signal)
    if (this.#views !== undefined && fresh.selected.target.kind === "window") {
      return this.#views.observe(session, targetIdValue, fresh.selected.target,
        () => this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal), result => result.complete)
    }
    return this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal)
  }

  async refreshNativeAction(
    session: RuntimeClientSession,
    targetIdValue: string,
    binding: AgentTargetActionResolution,
    signal: AbortSignal,
  ): Promise<AgentTargetActionResolution> {
    await this.#health(session, signal)
    return (await this.#refreshNative(session, this.#scope(session), targetIdValue, binding, signal)).selected
  }

  async getLatestObservation(session: RuntimeClientSession, targetIdValue: string): Promise<{ imageId: string, observation: Observation }> {
    await this.#core.clients.assertActive(session, this.#now())
    const lineage = this.#core.clients.lineage(session)
    const target = this.#scope(session).resolveAction(targetIdValue)
    const stored = this.#observations.get(canonicalJson([lineage, targetIdValue]))
    if (stored === undefined || !structurallyEqual(stored.observation.captureTarget, target.target)
      || this.#now().getTime() >= Date.parse(stored.observation.expiresAt)) {
      throw new Error("Latest owned screenshot отсутствует, истёк или относится к другому target")
    }
    if (stored.observation.readiness.state !== "ready" || stored.observation.unavailableReasons.length > 0) {
      throw new Error("Latest owned screenshot не имеет image-ready readiness для point action")
    }
    if (!this.#core.frames.hasVerified(stored.observation.image.frameRef, stored.observation.image.sha256)) {
      throw new Error("Latest owned screenshot frame bytes отсутствуют или не подтверждены")
    }
    return structuredClone(stored)
  }

  withViewAction<T>(session: RuntimeClientSession, targetIdValue: string, clientRequestId: string,
    mode: "ui-action" | "keyboard", action: () => Promise<T>): Promise<T> {
    if (this.#views === undefined) throw new Error("Protected agent action требует configured view admission")
    return this.#views.run(session, targetIdValue, clientRequestId, mode, action)
  }

  async #transitionWindow(
    session: RuntimeClientSession,
    targetIdValue: string,
    context: AgentMutationContext,
  ): Promise<void> {
    const scope = this.#scope(session)
    const fresh = await this.#refreshWindow(session, scope, targetIdValue, context.binding, context.signal)
    const response = await this.#registry.internal.dispatch(session, "window_transition", {
      inventoryId: fresh.selected.inventoryId,
      inventoryRevision: fresh.selected.inventoryRevision,
      clientRequestId: context.clientRequestId,
      request: { kind: "show", target: fresh.selected.target.ref },
    }, context.signal)
    if (response.isError) {
      const result = objectRecord(response.data.result)
      const transition = result?.ok === true ? windowTransitionResultSchema.safeParse(result.value) : undefined
      if (transition?.success && transition.data.partial) throw partialWindowTransitionError(response, transition.data)
      throw internalMethodError(response, "window_transition")
    }
    await this.#refreshWindow(session, scope, targetIdValue, fresh.selected, context.signal)
  }

  async #observe(
    session: RuntimeClientSession,
    targetIdValue: string,
    mode: "ax" | "screenshot" | "both",
    caption: string | undefined,
    signal: AbortSignal,
  ): Promise<z.infer<typeof observedStateSchema>> {
    await this.#health(session, signal)
    const scope = this.#scope(session)
    const selected = scope.resolveAction(targetIdValue)
    if (selected.target.kind === "browser-target") {
      this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
      return this.#observeBrowser(session, scope, targetIdValue, selected, mode, caption, signal)
    }
    if (["display", "desktop-layout"].includes(selected.target.kind)) {
      if (mode !== "screenshot") throw new Error("Display/layout observe поддерживает только screenshot")
      this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
      const fresh = await this.#refreshNative(session, scope, targetIdValue, selected, signal)
      if (fresh.selected.target.kind !== "display" && fresh.selected.target.kind !== "desktop-layout") {
        throw new Error("Fresh display/layout target изменил kind")
      }
      const capture = async () => observedStateSchema.parse({
        targetId: targetIdValue,
        state: "",
        elements: [],
        ...await this.#captureDesktop(session, targetIdValue, fresh, caption!, signal),
      })
      if (this.#views !== undefined) {
        try { return await this.#views.observe(session, targetIdValue, fresh.selected.target, capture, result => result.complete) }
        catch (error) {
          this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
          throw error
        }
      }
      return capture()
    }
    if (selected.target.kind === "surface") {
      if (mode !== "ax") throw new Error("Surface observe поддерживает только AX; isolated surface screenshot недоступен")
      this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
      const fresh = await this.#refreshNative(session, scope, targetIdValue, selected, signal)
      if (fresh.selected.target.kind !== "surface") throw new Error("Fresh surface target изменил kind")
      const inspect = () => this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal)
      if (this.#views !== undefined) {
        try { return await this.#views.observe(session, targetIdValue, fresh.selected.target, inspect, result => result.complete) }
        catch (error) { scope.invalidateElements(targetIdValue); throw error }
      }
      return inspect()
    }
    if (selected.target.kind !== "window") throw new Error("observe не поддерживает этот target kind")
    this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
    const fresh = await this.#refreshNative(session, scope, targetIdValue, selected, signal)
    let viewEligible = false
    const capture = async () => {
      const ax = mode === "screenshot" ? undefined : await this.#inspectWindow(session, scope, targetIdValue, fresh.selected, signal)
      const screenshot = mode === "ax" ? undefined : await this.#captureWindow(session, targetIdValue, fresh, caption!, signal)
      if (mode === "screenshot") scope.invalidateElements(targetIdValue)
      viewEligible = ax?.complete === true || screenshot?.complete === true
      return observedStateSchema.parse({
        targetId: targetIdValue,
        state: ax?.state ?? "",
        complete: (ax?.complete ?? true) && (screenshot?.complete ?? true),
        errors: [...(ax?.errors ?? []), ...(screenshot?.errors ?? [])],
        elements: ax?.elements ?? [],
        ...(screenshot === undefined ? {} : {
          imageId: screenshot.imageId,
          width: screenshot.width,
          height: screenshot.height,
        }),
      })
    }
    if (this.#views !== undefined && fresh.selected.target.kind === "window") {
      try { return await this.#views.observe(session, targetIdValue, fresh.selected.target, capture, () => viewEligible) }
      catch (error) {
        scope.invalidateElements(targetIdValue)
        this.#observations.delete(canonicalJson([this.#core.clients.lineage(session), targetIdValue]))
        throw error
      }
    }
    return capture()
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
      this.#observations.set(canonicalJson([this.#core.clients.lineage(session), targetIdValue]), { imageId, observation: observationSchema.parse(capture.observation) })
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
        deadlineAt: operationDeadline(signal, 20_000, this.#now().getTime()),
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
      request: { target: selected.target, depth: 12, maxNodes: 1_500, maxBytes: AGENT_AX_INSPECTION_MAX_BYTES },
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
    fresh: FreshNative,
    caption: string,
    signal: AbortSignal,
  ) {
    const { inventory, selected, window } = fresh
    if (selected.target.kind !== "window" || window === undefined) throw new Error("Window capture требует exact window target")
    if (window.mapping !== "corroborated" || window.mappingEvidence === undefined || window.cgWindowId === undefined) {
      throw new Error("Window screenshot требует current corroborated CG/AX mapping")
    }
    const response = await this.#dispatch(session, "capture_window", {
      clientRequestId: this.#ids("agent-window-capture"),
      inventoryId: inventory.inventoryId,
      caption,
      clip: { kind: "full-target" },
      cursor: "exclude",
      readinessPolicy: { policyId: "agent-window-observe", requiredSteps: ["complete-frame", "permission", "target"], disabledSteps: ["ownership"] },
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
    return this.#rememberCapture(session, targetIdValue, capture.result.value.observation, response.frameRefs[0]!, "window-capture")
  }

  #rememberCapture(
    session: RuntimeClientSession,
    targetIdValue: string,
    observationValue: Observation,
    frameRef: string,
    stage: "window-capture" | "desktop-capture",
  ) {
    const observation = observationSchema.parse(observationValue)
    if (observation.image.frameRef !== frameRef) throw new Error("Capture frameRef не совпадает с observation")
    const imageId = this.#ids("agent-image")
    this.#frames.set(imageId, frameRef)
    this.#observations.set(canonicalJson([this.#core.clients.lineage(session), targetIdValue]), { imageId, observation })
    this.#pruneFrames()
    this.#pruneObservations()
    const errors = observation.unavailableReasons.map(message => ({ stage, message }))
    if (observation.readiness.state !== "ready") {
      errors.unshift({ stage, message: `Capture readiness: ${observation.readiness.state}` })
    }
    return {
      imageId,
      width: observation.image.widthPx,
      height: observation.image.heightPx,
      complete: observation.readiness.state === "ready" && observation.unavailableReasons.length === 0,
      errors,
    }
  }

  async #captureDesktop(
    session: RuntimeClientSession,
    targetIdValue: string,
    fresh: FreshNative,
    caption: string,
    signal: AbortSignal,
  ) {
    const { inventory, selected, captureTarget } = fresh
    if (!["display", "desktop-layout"].includes(selected.target.kind) || captureTarget === undefined) {
      throw new Error("Desktop capture требует exact display/layout target")
    }
    const response = await this.#dispatch(session, "capture_desktop", {
      clientRequestId: this.#ids("agent-desktop-capture"),
      inventoryId: inventory.inventoryId,
      caption,
      clip: { kind: "full-target" },
      cursor: "exclude",
      readinessPolicy: { policyId: "agent-display-observe",
        requiredSteps: ["complete-frame", "permission", "target"], disabledSteps: ["ownership"] },
      output: { format: "image/png", scale: 0.5, maxWidthPx: 16_384, maxHeightPx: 16_384,
        maxPixels: 8_000_000, maxEncodedBytes: 8 * 1024 * 1024 },
      target: captureTarget,
    }, signal)
    const capture = response.data as { result: AdapterResult<ScreenCaptureResult>, frameAvailable: boolean }
    if (!capture.result.ok || capture.frameAvailable !== true || response.frameRefs.length !== 1) {
      throw new Error("Desktop capture не вернул exact available frame")
    }
    return this.#rememberCapture(session, targetIdValue, capture.result.value.observation, response.frameRefs[0]!, "desktop-capture")
  }

  async #refreshWindow(
    session: RuntimeClientSession,
    scope: AgentTargetScope,
    targetIdValue: string,
    selected: AgentTargetActionResolution,
    signal: AbortSignal,
  ): Promise<FreshNative> {
    if (selected.target.kind !== "window") throw new Error("Window refresh требует window target")
    return this.#refreshNative(session, scope, targetIdValue, selected, signal)
  }

  async #refreshNative(
    session: RuntimeClientSession,
    scope: AgentTargetScope,
    targetIdValue: string,
    selected: AgentTargetActionResolution,
    signal: AbortSignal,
  ): Promise<FreshNative> {
    const applicationRef = selected.target.kind === "window" || selected.target.kind === "surface"
      ? selected.target.ref.applicationRef
      : undefined
    const inventory = await this.#inventory(session, signal, applicationRef === undefined
      ? {}
      : { applicationRef })
    let result: Omit<FreshNative, "inventory" | "selected"> | undefined
    switch (selected.target.kind) {
      case "window": {
        const window = inventory.windows.find((candidate): candidate is WindowRecord => {
          return candidate.kind === "ax-window" && structurallyEqual(candidate.ref, selected.target.ref)
        })
        if (window !== undefined) result = { window }
        break
      }
      case "surface": {
        for (const window of inventory.windows) {
          if (window.kind !== "ax-window") continue
          const surface = window.surfaces.find(candidate => structurallyEqual(candidate.ref, selected.target.ref))
          if (surface !== undefined && surfaceOwnedByWindow(surface, window)) { result = { window, surface }; break }
        }
        break
      }
      case "display": {
        const display = inventory.displays.find(candidate => structurallyEqual(candidate.ref, selected.target.ref))
        const captureTarget = inventory.desktopLayout?.displays.find(candidate => {
          return structurallyEqual(candidate.target, selected.target)
        })
        if (display !== undefined) result = { display, ...(captureTarget === undefined ? {} : { captureTarget }) }
        break
      }
      case "desktop-layout": {
        const captureTarget = inventory.desktopLayout
        if (captureTarget !== undefined && structurallyEqual(captureTarget.target, selected.target)) result = { captureTarget }
        break
      }
      default:
        throw new Error("Native refresh не поддерживает browser/device target")
    }
    if (result === undefined) {
      if (!inventory.complete) {
        throw new Error("Fresh inventory incomplete; exact native target absence не подтверждено")
      }
      scope.closeTarget(targetIdValue, "Exact native target отсутствует в fresh inventory")
      throw new Error("Exact native target closed or stale; handle не ретаргетирован")
    }
    scope.registerTarget(selected.target, {
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
    })
    return { inventory, ...result, selected: scope.resolveAction(targetIdValue) }
  }

  async #inventory(
    session: RuntimeClientSession,
    signal: AbortSignal,
    filter: { app?: string, pid?: number, applicationRef?: string } = {},
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
    const response = await this.#registry.internal.dispatch(session, name, input, signal)
    if (response.isError) throw internalMethodError(response, name)
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function responseOperationId(response: RuntimeMethodResponse): string | undefined {
  const operation = objectRecord(response.data.operation)
  const context = objectRecord(operation?.context)
  const parsed = opaqueIdSchema.safeParse(context?.operationId)
  return parsed.success ? parsed.data : undefined
}

/** Сохраняет проверенную ошибку внутреннего метода и его настоящий operationId. */
export function internalMethodError(response: RuntimeMethodResponse, name: string): RuntimeContractError {
  const result = objectRecord(response.data.result)
  const parsed = contractErrorSchema.safeParse(objectRecord(result?.error))
  if (parsed.success) {
    const operationId = responseOperationId(response)
    const context = {
      ...(parsed.data.context ?? {}),
      ...(operationId === undefined ? {} : { operationId }),
    }
    return new RuntimeContractError(parsed.data.code, parsed.data.message, parsed.data.stage, {
      retryable: parsed.data.retryable,
      replayAllowed: parsed.data.replayAllowed,
      recoveryAction: parsed.data.recoveryAction,
      ...(Object.keys(context).length === 0 ? {} : { context }),
    })
  }
  return new RuntimeContractError("internal-error", `Internal runtime method ${name} вернул malformed error`, "agent-method-dispatch", {
    recoveryAction: "get-operation",
  })
}

function partialWindowTransitionError(
  response: RuntimeMethodResponse,
  transition: WindowTransitionResult,
): RuntimeContractError {
  const primary = transition.errors[0]!
  const actual = transition.actual.kind === "ax-window"
    ? `ax-window hidden=${transition.actual.applicationHidden} minimized=${transition.actual.minimized} focused=${transition.actual.focused} onScreen=${transition.actual.onScreen} visibility=${transition.actual.spaceVisibility}`
    : transition.actual.kind === "unknown"
      ? `unknown reason=${transition.actual.reason}`
      : "closed"
  const errors = transition.errors.map(error => `${error.code}@${error.stage}: ${error.message}`).join("; ")
  const message = `Window transition partial; actual=${actual}; errors=${errors}`.slice(0, 2_048)
  const operationId = responseOperationId(response)
  const context = {
    ...(primary.context ?? {}),
    ...(operationId === undefined ? {} : { operationId }),
  }
  return new RuntimeContractError(primary.code, message, primary.stage, {
    retryable: primary.retryable,
    replayAllowed: primary.replayAllowed,
    recoveryAction: primary.recoveryAction,
    ...(Object.keys(context).length === 0 ? {} : { context }),
  })
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

function formatAxState(inspection: AxInspectionResult, elements: AgentElementHandle[]): string {
  const header = `AX tree complete=${inspection.complete === true}`
  return [header, ...elements.map(element => {
    const fields = [
      `[${element.elementId}]`,
      ...(element.parentElementId === undefined ? [] : [`parent=${element.parentElementId}`]),
      `role=${element.role}`,
      `subrole=${element.subrole}`,
      `title=${JSON.stringify(element.title)}`,
      ...(element.identifier === undefined ? [] : [`identifier=${JSON.stringify(element.identifier)}`]),
      ...(element.description === undefined ? [] : [`description=${JSON.stringify(element.description)}`]),
      ...(element.value === undefined ? [] : [`value=${JSON.stringify(element.value)}`]),
      ...(element.valueRedacted === undefined ? [] : ["valueRedacted=true"]),
      ...(element.frame === undefined ? [] : [`frame=${JSON.stringify(element.frame)}`]),
      `actions=${JSON.stringify(element.actions)}`,
    ]
    return fields.join(" ")
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

function surfaceOwnedByWindow(surface: SurfaceRecord, window: WindowRecord): boolean {
  return surface.ref.runtimeEpoch === window.ref.runtimeEpoch
    && surface.ref.loginSessionId === window.ref.loginSessionId
    && surface.ref.nativeGeneration === window.ref.nativeGeneration
    && surface.ref.applicationRef === window.ref.applicationRef
    && surface.ref.ownerWindowRef === window.ref.windowRef
}
