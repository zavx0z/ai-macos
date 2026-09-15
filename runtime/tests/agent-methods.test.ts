import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  adapterResultSchema,
  axInspectionRequestSchema,
  axInspectionResultSchema,
  browserInstanceSnapshotSchema,
  browserInstanceRefSchema,
  browserOperationRequestSchema,
  browserOperationResources,
  browserOperationResultSchema,
  browserTargetRefSchema,
  browserTargetSnapshotSchema,
  capabilitySetSchema,
  captureClipSchema,
  captureOutputPolicySchema,
  desktopInventorySnapshotSchema,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  readinessPolicySchema,
  type RuntimeResourceHandle,
  windowTransitionRequestSchema,
  windowTransitionResultSchema,
  windowRecordSchema,
  z,
  type AxInspectionResult,
  type BrowserInstanceRecord,
  type BrowserOperationRequest,
  type ContractError,
  type NativeAdapter,
  type NativeExecutionContext,
  type OperationTarget,
  type RuntimeClientSession,
  type RuntimeOperationIntent,
  type ScreenCaptureResult,
  type WindowRecord,
} from "@meta/shared/contracts"
import { AgentTargetRegistry } from "../src/agent-targets.ts"
import { agentObservedStateSchema, registerAgentMethods, type AgentMethodsOptions } from "../src/agent-methods.ts"
import { captureDesktopMethodInputSchema, captureExecutionSchema, captureWindowMethodInputSchema } from "../src/capture-methods.ts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { RuntimeContractError } from "../src/errors.ts"

const generation = { runtimeEpoch: "runtime:agent", loginSessionId: "login:agent" }
const nativeGeneration = "native:agent"
const appRef = {
  ...generation,
  nativeGeneration,
  applicationRef: "application:chrome:1",
  pid: 101,
  launchedAt: "2026-09-15T10:00:00.000Z",
  registrationNonce: "registration:chrome:1",
}
const windowRef = {
  ...generation,
  nativeGeneration,
  applicationRef: appRef.applicationRef,
  windowRef: "window:chrome:1",
}
const displayRef = { ...generation, nativeGeneration, displayRef: "display:agent:1", displayLayoutRevision: 1 }
const displayTarget = { kind: "display" as const, ref: displayRef }
const layoutRef = { ...generation, nativeGeneration, layoutRef: "layout:agent:1", displayLayoutRevision: 1 }
const layoutTarget = { kind: "desktop-layout" as const, ref: layoutRef }

const browserCapturePublicRequestSchema = z.strictObject({
  kind: z.literal("capture-target"),
  target: browserTargetRefSchema,
  capture: z.strictObject({
    source: z.literal("browser-viewport"),
    caption: z.string().min(1).max(2_048),
    target: z.strictObject({ kind: z.literal("browser-target"), ref: browserTargetRefSchema }),
    clip: captureClipSchema,
    fullPage: z.boolean(),
    cursor: z.literal("exclude"),
    readinessPolicy: readinessPolicySchema,
    output: captureOutputPolicySchema,
  }),
})

test("get_state выдаёт exact lineage handles, фильтрует PID/app и не раскрывает refs", async () => {
  const fixture = createFixture()
  registerDesktop(fixture)
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const first = fixture.core.openClient("principal:first")
  const response = await fixture.registry.dispatch(first.session, "get_state", { app: "Google Chrome", pid: 101 }, new AbortController().signal)
  expect(response.data).toMatchObject({ complete: true, browsers: [], windows: [{ app: "Google Chrome", pid: 101, title: "One" }] })
  expect(JSON.stringify(response.data)).not.toContain("runtimeEpoch")
  expect(JSON.stringify(response.data)).not.toContain("windowRef")
  const id = (response.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const second = fixture.core.openClient("principal:second")
  await expect(fixture.registry.dispatch(second.session, "observe", { targetId: id, mode: "ax" }, new AbortController().signal)).rejects.toThrow("client lineage")
})

test("get_state различает running без AX окон, отсутствующее приложение и AX-denied CG-only окно", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const noWindowsRef = applicationRef("application:no-windows", 201)
  const deniedRef = applicationRef("application:denied", 202)
  const diagnostic = desktopInventorySnapshotSchema.parse({
    ...desktop.inventory,
    applications: [
      { ref: noWindowsRef, name: "No Windows", bundleId: "com.meta.no-windows", hidden: "false",
        axStatus: "no-windows", windowCount: 0 },
      { ref: deniedRef, name: "Denied App", bundleId: "com.meta.denied", hidden: "unknown",
        axStatus: "denied", axReason: "Accessibility permission denied", windowCount: 0 },
    ],
    windows: [{
      kind: "cg-only",
      ...generation,
      nativeGeneration,
      cgEntryRef: "cg-entry:denied",
      ownerPid: deniedRef.pid,
      cgWindowId: 88,
      title: "Denied Window",
      frame: { x: 10, y: 20, width: 300, height: 200 },
      onScreen: "true",
      actionability: "unavailable",
      reason: "AX identity unavailable",
    }],
  })
  desktop.inventory.applications = diagnostic.applications
  desktop.inventory.windows = diagnostic.windows
  const client = fixture.core.openClient("principal:diagnostics")

  const noWindows = await fixture.registry.dispatch(client.session, "get_state", {
    kind: "window", app: "No Windows",
  }, new AbortController().signal)
  const absent = await fixture.registry.dispatch(client.session, "get_state", {
    kind: "window", app: "Missing App",
  }, new AbortController().signal)
  const denied = await fixture.registry.dispatch(client.session, "get_state", {
    kind: "window", app: "Denied App",
  }, new AbortController().signal)

  expect(noWindows.data).toMatchObject({ complete: true, errors: [], windows: [], unavailableWindows: [],
    applications: [{ name: "No Windows", pid: 201, axStatus: "no-windows", axWindowCount: 0 }] })
  expect(absent.data).toMatchObject({ complete: true, applications: [], windows: [], unavailableWindows: [] })
  expect(denied.data).toMatchObject({ complete: true, errors: [], windows: [],
    applications: [{ name: "Denied App", pid: 202, axStatus: "denied",
      axReason: "Accessibility permission denied", axWindowCount: 0 }],
    unavailableWindows: [{ pid: 202, title: "Denied Window", visibility: "true", reason: "AX identity unavailable" }] })
  expect(JSON.stringify(denied.data)).not.toContain("targetId")
})

test("get_state выдаёт exact surface/display/layout handles с явным owner и честными observe modes", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  desktop.inventory.windows = [windowRecord(windowRef, [surfaceRecord()])]
  const mappedDisplay = displayCaptureTarget()
  desktop.inventory.displays = [{
    ref: displayRef,
    nativeDisplayId: 11,
    bounds: { x: -640, y: 0, width: 640, height: 480 },
    usableBounds: { x: -640, y: 20, width: 640, height: 460 },
    scale: 2,
    rotationDegrees: 0,
    main: true,
  }]
  desktop.inventory.desktopLayout = desktopLayoutTarget(mappedDisplay)
  fixture.core.targets.register(displayTarget, desktop.inventory.inventoryId, desktop.inventory.revision,
    "resolution:display-agent", "proof:display-agent", 1)
  fixture.core.targets.register(layoutTarget, desktop.inventory.inventoryId, desktop.inventory.revision,
    "resolution:layout-agent", "proof:layout-agent", 1)
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:native-targets")
  const windows = await fixture.registry.dispatch(client.session, "get_state", {
    kind: "window",
  }, new AbortController().signal)
  const owner = (windows.data.windows as Array<{ targetId: string }>)[0]!
  const surface = (windows.data.surfaces as Array<{ targetId: string, ownerTargetId: string }>)[0]!
  expect(surface).toMatchObject({ ownerTargetId: owner.targetId, kind: "sheet", role: "AXSheet", title: "Modal" })
  const surfaceAx = await fixture.registry.dispatch(client.session, "observe", {
    targetId: surface.targetId,
    mode: "ax",
  }, new AbortController().signal)
  expect(surfaceAx.data).toMatchObject({ targetId: surface.targetId, complete: true,
    elements: [{ role: "AXButton", title: "Save" }] })
  await expect(fixture.registry.dispatch(client.session, "observe", {
    targetId: surface.targetId,
    mode: "screenshot",
    caption: "Ожидаю modal",
  }, new AbortController().signal)).rejects.toThrow("Surface observe поддерживает только AX")

  const displayState = await fixture.registry.dispatch(client.session, "get_state", {
    kind: "display",
  }, new AbortController().signal)
  const display = (displayState.data.displays as Array<{ targetId: string }>)[0]!
  const layout = displayState.data.desktopLayout as { targetId: string, displayTargetIds: string[] }
  expect(displayState.data).toMatchObject({ applications: [], windows: [], surfaces: [], browsers: [],
    displays: [{ nativeDisplayId: 11, bounds: { x: -640, y: 0 }, scale: 2, main: true }] })
  expect(layout.displayTargetIds).toEqual([display.targetId])
  const captured = await fixture.registry.dispatch(client.session, "observe", {
    targetId: display.targetId,
    mode: "screenshot",
    caption: "Ожидаю левый display",
  }, new AbortController().signal)
  expect(captured).toMatchObject({ frameRefs: ["frame:display:1"], data: {
    targetId: display.targetId, state: "", elements: [], width: 320, height: 240, complete: true,
  } })
  expect(desktop.desktopCaptureRequests[0]).toMatchObject({
    caption: "Ожидаю левый display",
    readinessPolicy: {
      requiredSteps: ["complete-frame", "permission", "target"],
      disabledSteps: ["ownership"],
    },
    target: { kind: "display", target: displayTarget, nativeDisplayId: 11 },
  })
  expect(desktop.desktopCaptureResults[0]?.observation).toMatchObject({
    readiness: { state: "ready", steps: [{ name: "complete-frame", state: "reached" },
      { name: "permission", state: "reached" }, { name: "target", state: "reached" },
      { name: "ownership", state: "skipped" }] },
    captureEvidence: { proof: { kind: "frame-freshness" } },
  })
  const layoutCapture = await fixture.registry.dispatch(client.session, "observe", {
    targetId: layout.targetId,
    mode: "screenshot",
    caption: "Ожидаю полный desktop layout",
  }, new AbortController().signal)
  expect(layoutCapture.frameRefs).toEqual(["frame:display:1"])
  expect(desktop.desktopCaptureRequests[1]).toMatchObject({
    caption: "Ожидаю полный desktop layout",
    readinessPolicy: {
      requiredSteps: ["complete-frame", "permission", "target"],
      disabledSteps: ["ownership"],
    },
    target: { kind: "desktop-layout", target: layoutTarget,
      displays: [{ target: displayTarget, nativeDisplayId: 11 }] },
  })
  await expect(fixture.registry.dispatch(client.session, "observe", {
    targetId: layout.targetId,
    mode: "ax",
  }, new AbortController().signal)).rejects.toThrow("Display/layout observe поддерживает только screenshot")
})

test("incomplete inventory и отсутствующий capture mapping не tombstone существующий display handle", async () => {
  const fixture = createFixture()
  const mappedDisplay = displayCaptureTarget()
  const full = {
    inventoryId: "inventory:display-recovery",
    ...generation,
    nativeGeneration,
    revision: 1,
    displayLayoutRevision: 1,
    capturedAt: "2026-09-15T10:00:01.000Z",
    complete: true,
    errors: [],
    applications: [],
    windows: [],
    displays: [{ ref: displayRef, nativeDisplayId: 11,
      bounds: { x: -640, y: 0, width: 640, height: 480 },
      usableBounds: { x: -640, y: 20, width: 640, height: 460 },
      scale: 2, rotationDegrees: 0, main: true }],
    desktopLayout: desktopLayoutTarget(mappedDisplay),
  }
  let inventory: any = structuredClone(full)
  fixture.registry.register("system_health", method(async () => ({
    machine: { matchesExpected: true }, runtime: { draining: false, admissionSealed: false },
  })))
  fixture.registry.register("list_windows", method(async () => structuredClone(inventory)))
  const methods = registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:display-recovery")
  const scope = fixture.targets.forLineage(fixture.core.clients.lineage(client.session))
  const handle = scope.registerTarget(displayTarget, { inventoryId: full.inventoryId, inventoryRevision: full.revision })

  delete inventory.desktopLayout
  const withoutMapping = await methods.refreshNativeAction(
    client.session, handle.targetId, scope.resolveAction(handle.targetId), new AbortController().signal,
  )
  expect(withoutMapping.target).toEqual(displayTarget)
  await expect(fixture.registry.dispatch(client.session, "observe", {
    targetId: handle.targetId,
    mode: "screenshot",
    caption: "Ожидаю display без mapping",
  }, new AbortController().signal)).rejects.toThrow("capture")
  expect(scope.resolveAction(handle.targetId).target).toEqual(displayTarget)

  const { desktopLayout: _ignoredLayout, ...withoutLayout } = structuredClone(full)
  inventory = { ...withoutLayout, complete: false,
    errors: [{ code: "inventory-incomplete", message: "partial fixture", stage: "fixture",
      retryable: true, replayAllowed: false, recoveryAction: "refresh-inventory" }],
    displays: [] }
  await expect(methods.refreshNativeAction(
    client.session, handle.targetId, scope.resolveAction(handle.targetId), new AbortController().signal,
  )).rejects.toThrow("absence не подтверждено")
  expect(scope.resolveAction(handle.targetId).target).toEqual(displayTarget)

  inventory = structuredClone(full)
  const restored = await methods.refreshNativeAction(
    client.session, handle.targetId, scope.resolveAction(handle.targetId), new AbortController().signal,
  )
  expect(restored.targetId).toBe(handle.targetId)
  expect(restored.target).toEqual(displayTarget)
})

test("show_window делает один exact show, refresh и возвращает snapshot-bound element IDs", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  registerBrowsers(fixture)
  const methods = registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:show")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const id = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const shown = await fixture.registry.dispatch(client.session, "show_window", { targetId: id }, new AbortController().signal)
  expect(desktop.transitions.map(call => call.request.kind)).toEqual(["show"])
  expect(shown.data).toMatchObject({ targetId: id, complete: true, elements: [{ role: "AXButton", title: "Save", actions: ["AXPress"] }] })
  expect(String(shown.data.state)).toContain("role=AXButton")
  expect(JSON.stringify(shown.data)).not.toContain("elementRef")
  const status = await methods.operations.getTargetStatus(client.session, id)
  expect(status.recent.map(operation => operation.action)).toEqual(["show-window-show"])
  expect(new Set(status.recent.map(operation => operation.operationId)).size).toBe(1)
})

test("partial show_window возвращает actual/error/operationId и не запускает orphan focus", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  desktop.setTransitionFailure({
    code: "operation-outcome-unknown",
    message: "Immediate focus readback не подтвердил focused window",
    stage: "window-show-readback",
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
    context: { checkpoint: "focus-readback" },
  })
  registerBrowsers(fixture)
  const methods = registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:show-partial")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const targetId = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  let failure: unknown
  try {
    await fixture.registry.dispatch(client.session, "show_window", { targetId }, new AbortController().signal)
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(RuntimeContractError)
  const contract = (failure as RuntimeContractError).contract
  expect(contract).toMatchObject({
    code: "operation-outcome-unknown",
    stage: "window-show-readback",
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
    context: { checkpoint: "focus-readback" },
  })
  expect(contract.message).toContain("actual=ax-window hidden=true minimized=false focused=false onScreen=false visibility=not-current")
  expect(contract.message).toContain("Immediate focus readback не подтвердил focused window")
  expect(contract.context?.operationId).toStartWith("operation:")
  expect(desktop.transitions.map(call => call.request.kind)).toEqual(["show"])
  const operation = await fixture.core.getOperation(client.session, contract.context!.operationId!)
  expect(operation).toMatchObject({ state: "completed", outcome: { cleanup: { state: "complete" } } })
  const status = await methods.operations.getTargetStatus(client.session, targetId)
  expect(status.recent).toHaveLength(1)
  expect(status.recent[0]).toMatchObject({ action: "show-window-show" })
})

test("AX facade сохраняет static text value, zero frame, redaction и opaque parent lineage", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  const snapshotId = "snapshot:agent:1"
  const ref = (elementRef: string) => ({ ...generation, nativeGeneration, applicationRef: appRef.applicationRef, snapshotId, elementRef })
  desktop.setInspectionNodes([
    { elementRef: ref("element:root"), role: "AXWindow", subrole: "AXStandardWindow", title: "Документ",
      identifier: "main-window", description: "Главное окно", frame: { x: 10, y: 20, width: 800, height: 600 }, actions: [] },
    { elementRef: ref("element:static"), parentElementRef: ref("element:root"), role: "AXStaticText", subrole: "", title: "",
      value: "Состояние готово", frame: { x: 20, y: 40, width: 0, height: 0 }, actions: [] },
    { elementRef: ref("element:progress"), parentElementRef: ref("element:root"), role: "AXProgressIndicator", subrole: "", title: "",
      value: 0.5, actions: [] },
    { elementRef: ref("element:secure"), parentElementRef: ref("element:root"), role: "AXTextField", subrole: "AXSecureTextField",
      title: "Пароль", valueRedacted: true, actions: [] },
  ])
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:ax-metadata")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const targetId = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const observed = await fixture.registry.dispatch(client.session, "observe", { targetId, mode: "ax" }, new AbortController().signal)
  const elements = observed.data.elements as Array<Record<string, unknown>>
  expect(elements).toMatchObject([
    { role: "AXWindow", title: "Документ", identifier: "main-window", description: "Главное окно" },
    { parentElementId: elements[0]!.elementId, role: "AXStaticText", title: "", value: "Состояние готово", frame: { width: 0, height: 0 } },
    { parentElementId: elements[0]!.elementId, role: "AXProgressIndicator", value: 0.5 },
    { parentElementId: elements[0]!.elementId, role: "AXTextField", valueRedacted: true },
  ])
  expect(String(observed.data.state)).toContain('title="" value="Состояние готово"')
  expect(String(observed.data.state)).toContain("value=0.5")
  expect(String(observed.data.state)).toContain("valueRedacted=true")
  expect(desktop.inspectionRequests).toMatchObject([{ maxBytes: 128 * 1024 }])
  expect(JSON.stringify(observed.data)).not.toContain("element:root")
  expect(JSON.stringify(observed.data)).not.toContain("parentElementRef")
  expect(agentObservedStateSchema.safeParse({ ...observed.data,
    elements: elements.map((element, index) => index === 1 ? { ...element, parentElementId: "agent-element:not-returned" } : element) }).success).toBe(false)
})

test("closed exact window tombstones old handle и не выбирает replacement с тем же title", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:closed")
  const state = await fixture.registry.dispatch(client.session, "get_state", {}, new AbortController().signal)
  const id = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  desktop.inventory.windows = [windowRecord({ ...windowRef, windowRef: "window:replacement" })]
  await expect(fixture.registry.dispatch(client.session, "show_window", { targetId: id }, new AbortController().signal)).rejects.toThrow("не ретаргетирован")
  const lineage = fixture.targets.forLineage(fixture.core.clients.lineage(client.session))
  expect(lineage.resolveControl(id).state).toBe("closed")
  expect(desktop.transitions).toHaveLength(0)
})

test("observe both регистрирует elements, скрывает observation и форвардит тот же frameRef", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:observe")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const id = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  await expect(fixture.registry.dispatch(client.session, "observe", {
    targetId: id, mode: "screenshot",
  }, new AbortController().signal)).rejects.toThrow("expectation caption")
  const observed = await fixture.registry.dispatch(client.session, "observe", {
    targetId: id, mode: "both", caption: "Ожидаю окно Chrome с кнопкой Save",
  }, new AbortController().signal)
  expect(observed.frameRefs).toEqual(["frame:agent:1"])
  expect(observed.data).toMatchObject({ targetId: id, width: 320, height: 240, complete: true })
  expect(JSON.stringify(observed.data)).not.toContain("observationId")
  expect(JSON.stringify(observed.data)).not.toContain("frame:agent:1")
  expect(desktop.inventoryCalls()).toBe(2)
  expect(desktop.captureRequests[0]).toMatchObject({
    caption: "Ожидаю окно Chrome с кнопкой Save",
    readinessPolicy: {
      requiredSteps: ["complete-frame", "permission", "target"],
      disabledSteps: ["ownership"],
    },
    output: { format: "image/png", scale: 0.5 },
    target: { mappingEvidence: { state: "confirmed", proof: { kind: "cg-ax-correlation" } } },
  })
  expect(desktop.windowCaptureResults[0]?.observation).toMatchObject({
    readiness: { state: "ready", steps: [{ name: "complete-frame", state: "reached" },
      { name: "permission", state: "reached" }, { name: "target", state: "reached" },
      { name: "ownership", state: "skipped" }] },
    captureEvidence: { proof: { kind: "frame-freshness" } },
  })
  expect(JSON.stringify(desktop.windowCaptureResults[0]?.observation)).not.toContain("pixel-ownership")
  const elementId = (observed.data.elements as Array<{ elementId: string }>)[0]!.elementId
  const scope = fixture.targets.forLineage(fixture.core.clients.lineage(client.session))
  expect(scope.resolveElement(id, elementId).elementId).toBe(elementId)
  await fixture.registry.dispatch(client.session, "observe", {
    targetId: id, mode: "screenshot", caption: "Ожидаю то же окно после AX чтения",
  }, new AbortController().signal)
  expect(() => scope.resolveElement(id, elementId)).toThrow("latest target snapshot")
})

test("both с partial AX и image-ready сохраняет public partial, но mint view по свежему image", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  desktop.setInspectionFailure(axFixtureError("Optional AXDescription read failed"))
  registerBrowsers(fixture)
  const probe = viewEligibilityProbe()
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds(), views: probe.views })
  const client = fixture.core.openClient("principal:both-ax-partial")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const targetId = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const observed = await fixture.registry.dispatch(client.session, "observe", {
    targetId, mode: "both", caption: "Ожидаю свежий кадр при partial AX metadata",
  }, new AbortController().signal)
  expect(observed.data).toMatchObject({ complete: false, imageId: expect.any(String),
    errors: [{ message: "Optional AXDescription read failed" }], elements: [{ role: "AXButton" }] })
  expect(probe.eligibility).toEqual([true])
  expect(desktop.windowCaptureResults[0]?.observation.readiness.state).toBe("ready")
})

test("AX-ready не заменяет image-ready для pointer, both-failed не mint view и старый image не переиспользуется", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  desktop.setWindowCaptureReady(false)
  registerBrowsers(fixture)
  const probe = viewEligibilityProbe()
  const methods = registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds(), views: probe.views })
  const client = fixture.core.openClient("principal:both-image-partial")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const targetId = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const imagePartial = await fixture.registry.dispatch(client.session, "observe", {
    targetId, mode: "both", caption: "Ожидаю AX-ready и image-unavailable",
  }, new AbortController().signal)
  expect(imagePartial.data).toMatchObject({ complete: false, elements: [{ role: "AXButton" }] })
  expect((imagePartial.data.errors as Array<{ message: string }>).map(error => error.message)).toEqual([
    "Capture readiness: unavailable",
    "Fixture capture target unavailable",
  ])
  expect(probe.eligibility).toEqual([true])
  await expect(methods.getLatestObservation(client.session, targetId)).rejects.toThrow("image-ready readiness")

  desktop.setInspectionFailure(axFixtureError("AX metadata unavailable"))
  const bothFailed = await fixture.registry.dispatch(client.session, "observe", {
    targetId, mode: "both", caption: "Ожидаю обе partial modalities",
  }, new AbortController().signal)
  expect(bothFailed.data).toMatchObject({ complete: false })
  expect((bothFailed.data.errors as Array<{ message: string }>).map(error => error.message)).toEqual([
    "AX metadata unavailable",
    "Capture readiness: unavailable",
    "Fixture capture target unavailable",
  ])
  expect(probe.eligibility).toEqual([true, false])

  const axOnly = await fixture.registry.dispatch(client.session, "observe", { targetId, mode: "ax" }, new AbortController().signal)
  expect(axOnly.data).not.toHaveProperty("imageId")
  expect(probe.eligibility).toEqual([true, false, false])
  await expect(methods.getLatestObservation(client.session, targetId)).rejects.toThrow("отсутствует")
})

test("failed capture сохраняет typed contract error и реальный operationId без user payload", async () => {
  const fixture = createFixture()
  const desktop = registerDesktop(fixture)
  desktop.setCaptureFailure({
    code: "permission-denied",
    message: "Screen Recording permission revoked",
    stage: "screen-capture",
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
    context: { operationId: "operation:forged", resourceRef: "resource:screen", checkpoint: "capture-native" },
  })
  registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:capture-error")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "window" }, new AbortController().signal)
  const targetId = (state.data.windows as Array<{ targetId: string }>)[0]!.targetId
  const privateCaption = "PRIVATE CAPTION MUST NOT LEAK"
  let failure: unknown
  try {
    await fixture.registry.dispatch(client.session, "observe", {
      targetId,
      mode: "screenshot",
      caption: privateCaption,
    }, new AbortController().signal)
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(RuntimeContractError)
  const contract = (failure as RuntimeContractError).contract
  expect(contract).toMatchObject({
    code: "permission-denied",
    message: "Screen Recording permission revoked",
    stage: "screen-capture",
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
    context: { resourceRef: "resource:screen", checkpoint: "capture-native" },
  })
  expect(contract.context?.operationId).toStartWith("operation:agent-window-capture:")
  expect(contract.context?.operationId).not.toBe("operation:forged")
  expect(JSON.stringify(contract)).not.toContain(privateCaption)
})

test("get_tabs подключает только выбранный profile и возвращает новое generation binding", async () => {
  const fixture = createFixture()
  registerDesktop(fixture)
  const browser = registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:tabs")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "browser" }, new AbortController().signal)
  const browserId = (state.data.browsers as Array<{ browserId: string }>)[0]!.browserId
  const tabs = await fixture.registry.dispatch(client.session, "get_tabs", { browserId }, new AbortController().signal)
  expect(browser.connectedRefs).toEqual(["browser:one"])
  expect(browser.targetRefs).toEqual(["browser:one"])
  expect(tabs.data).toMatchObject({ complete: true, tabs: [{ cdpTargetId: "cdp-target:one", title: "Same URL", url: "https://example.com" }] })
  expect((tabs.data as any).browserId).not.toBe(browserId)
  expect(() => fixture.targets.forLineage(fixture.core.clients.lineage(client.session)).resolveAction(browserId)).toThrow("invalidated")
})

test("observe browser выполняет exact AX и capture через выбранную lifetime reservation", async () => {
  const fixture = createFixture()
  registerDesktop(fixture)
  const browser = registerBrowsers(fixture)
  registerAgentMethods(fixture.registry, fixture.core, fixture.targets, { ids: sequenceIds() })
  const client = fixture.core.openClient("principal:browser-observe")
  const state = await fixture.registry.dispatch(client.session, "get_state", { kind: "browser" }, new AbortController().signal)
  const initialBrowserId = (state.data.browsers as Array<{ browserId: string }>)[0]!.browserId
  const tabs = await fixture.registry.dispatch(client.session, "get_tabs", { browserId: initialBrowserId }, new AbortController().signal)
  const tabId = (tabs.data.tabs as Array<{ targetId: string }>)[0]!.targetId
  const observed = await fixture.registry.dispatch(client.session, "observe", {
    targetId: tabId, mode: "both", caption: "Ожидаю страницу с кнопкой Save",
  }, new AbortController().signal)
  expect(observed.data).toMatchObject({ targetId: tabId, complete: true, elements: [], width: 320, height: 240 })
  expect(String(observed.data.state)).toContain('role="button" title="Save" actions=["focus"]')
  expect(observed.frameRefs).toEqual(["frame:browser:1"])
  expect(browser.operationKinds).toEqual(["connect-instance", "read-accessibility", "capture-target"])
  expect(browser.captureResources).toEqual([[]])
  expect(browser.captureRequests[0]).toMatchObject({ capture: {
    caption: "Ожидаю страницу с кнопкой Save",
    readinessPolicy: {
      requiredSteps: ["target", "document-ready", "complete-frame"],
      disabledSteps: ["fonts", "network-idle", "images", "reflow-stable", "animations", "final-commit", "permission", "ownership"],
    },
    output: { format: "image/png", scale: 0.5 },
  } })
  expect(JSON.stringify(observed.data)).not.toContain("cdp-target:one")
  expect(JSON.stringify(observed.data)).not.toContain("backend-node:save")
})

function axFixtureError(message: string): ContractError {
  return {
    code: "inventory-incomplete",
    message,
    stage: "ax-inspect-attribute",
    retryable: true,
    replayAllowed: false,
    recoveryAction: "retry-read-only",
  }
}

function viewEligibilityProbe() {
  const eligibility: boolean[] = []
  const views: NonNullable<AgentMethodsOptions["views"]> = {
    async observe(_session, _targetId, _target, capture, complete) {
      const value = await capture()
      eligibility.push(complete(value))
      return value
    },
    async run(_session, _targetId, _clientRequestId, _mode, action) { return action() },
  }
  return { eligibility, views }
}

function createFixture() {
  const native = {
    lastStatus: undefined as ReturnType<typeof nativeStatus> | undefined,
    async status(request: { requestId: string }) {
      if (this.lastStatus === undefined) throw new Error("Fixture native status отсутствует")
      return { ...this.lastStatus, requestId: request.requestId }
    },
  }
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "build:agent",
    nativeGeneration,
    native: native as unknown as NativeAdapter,
  })
  core.updateCapabilities(capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:agent-capabilities",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })),
  }))
  return {
    core,
    native,
    registry: new MethodRegistry(core),
    targets: new AgentTargetRegistry({ generation }),
  }
}

function registerDesktop(fixture: ReturnType<typeof createFixture>) {
  const inventory = desktopInventorySnapshotSchema.parse({
    inventoryId: "inventory:desktop:1",
    ...generation,
    nativeGeneration,
    revision: 1,
    displayLayoutRevision: 1,
    capturedAt: "2026-09-15T10:00:01.000Z",
    complete: true,
    errors: [],
    applications: [{ ref: appRef, name: "Google Chrome", bundleId: "com.google.Chrome", hidden: "true",
      axStatus: "ready", windowCount: 1 }],
    windows: [windowRecord()],
    displays: [],
  })
  const transitions: Array<{ request: z.infer<typeof windowTransitionRequestSchema> }> = []
  const captureRequests: Array<z.infer<typeof captureWindowMethodInputSchema>> = []
  const desktopCaptureRequests: Array<z.infer<typeof captureDesktopMethodInputSchema>> = []
  const windowCaptureResults: ScreenCaptureResult[] = []
  const desktopCaptureResults: ScreenCaptureResult[] = []
  const inspectionRequests: Array<z.infer<typeof axInspectionRequestSchema>> = []
  let captureFailure: ContractError | undefined
  let transitionFailure: ContractError | undefined
  let inspectionFailure: ContractError | undefined
  let windowCaptureReady = true
  let inspectionNodes: AxInspectionResult["nodes"] = [{
    elementRef: { ...generation, nativeGeneration, applicationRef: appRef.applicationRef,
      snapshotId: "snapshot:agent:1", elementRef: "element:save" },
    role: "AXButton",
    subrole: "",
    title: "Save",
    actions: ["AXPress"],
  }]
  let inventoryCalls = 0
  fixture.core.targets.register(
    { kind: "window", ref: windowRef },
    inventory.inventoryId,
    inventory.revision,
    "resolution:agent-window",
    "proof:agent-window",
    inventory.displayLayoutRevision,
  )
  fixture.registry.register("system_health", method(async () => ({ machine: { matchesExpected: true }, runtime: { draining: false, admissionSealed: false } })))
  fixture.registry.register("list_windows", method(async () => {
    inventoryCalls++
    return structuredClone(inventory)
  }, z.strictObject({
    app: z.string().min(1).max(1024).optional(),
    pid: z.number().int().min(1).max(0x7fffffff).optional(),
  }), desktopInventorySnapshotSchema))
  fixture.registry.register("window_transition", { ...method(async (context, input) => {
    transitions.push(input)
    const actual = transitionFailure === undefined
      ? windowRecord(input.request.target)
      : { ...windowRecord(input.request.target), focused: "false" as const }
    const target = { kind: "window" as const, ref: input.request.target }
    const intent = runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: input.clientRequestId,
      precondition: { target, inventoryId: input.inventoryId, inventoryRevision: input.inventoryRevision },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    })
    return fixture.core.runOperation(context.session, intent, input.request, async operation => {
      if (operation.wire.kind !== "native") throw new Error("Fixture требует native operation")
      const status = nativeStatus(operation.wire)
      fixture.native.lastStatus = status
      return {
        ok: true,
        value: windowTransitionResultSchema.parse({
        target: input.request.target,
        requested: input.request,
        actual,
        changed: true,
        partial: transitionFailure !== undefined,
        errors: transitionFailure === undefined ? [] : [transitionFailure],
        }),
        outcome: successfulOutcome(operation.resources),
        nativeStatus: status,
      }
    }, context.signal)
  }, z.strictObject({
    inventoryId: z.string(),
    inventoryRevision: z.number().int(),
    clientRequestId: z.string(),
    request: windowTransitionRequestSchema,
  }), z.strictObject({
    operation: operationRecordSchema,
    result: adapterResultSchema(windowTransitionResultSchema),
  })), isError: output => !output.result.ok || output.result.value.partial })
  fixture.registry.register("inspect_accessibility", method(async (_context, input) => {
    inspectionRequests.push(structuredClone(input.request))
    return {
      snapshotId: "snapshot:agent:1",
      target: input.request.target,
      complete: inspectionFailure === undefined,
      nodeCount: inspectionNodes.length,
      encodedBytes: 100,
      nodes: structuredClone(inspectionNodes),
      errors: inspectionFailure === undefined ? [] : [inspectionFailure],
    }
  }, z.strictObject({
    inventoryId: z.string(),
    inventoryRevision: z.number().int(),
    request: axInspectionRequestSchema,
  }), axInspectionResultSchema))
  fixture.registry.register("capture_window", {
    ...method(async (context, input) => {
      if (input.target.mappingEvidence.state !== "confirmed") throw new Error("Fixture требует confirmed mapping")
      captureRequests.push(input)
      const operation = completedOperation(context.session, input.clientRequestId, input.inventoryId,
        input.target.mappingEvidence.proof.inventoryRevision, input.target.target, "native", "read")
      if (captureFailure !== undefined) {
        return { operation, frameAvailable: false,
          result: { ok: false as const, error: structuredClone(captureFailure), outcome: successfulOutcome() } }
      }
      const value = captureResult(input, windowCaptureReady)
      windowCaptureResults.push(structuredClone(value))
      return {
        operation,
        frameAvailable: true,
        result: { ok: true as const, value, outcome: successfulOutcome() },
      }
    }, captureWindowMethodInputSchema, captureExecutionSchema),
    frames: output => output.result.ok ? ["frame:agent:1"] : [],
    isError: output => !output.result.ok,
  })
  fixture.registry.register("capture_desktop", {
    ...method(async (context, input) => {
      if (input.target.mappingEvidence.state !== "confirmed") throw new Error("Fixture требует confirmed desktop mapping")
      desktopCaptureRequests.push(input)
      const value = desktopCaptureResult(input)
      desktopCaptureResults.push(structuredClone(value))
      return {
        operation: completedOperation(context.session, input.clientRequestId, input.inventoryId,
          input.target.mappingEvidence.proof.inventoryRevision, input.target.target, "native"),
        frameAvailable: true,
        result: { ok: true as const, value, outcome: successfulOutcome() },
      }
    }, captureDesktopMethodInputSchema, captureExecutionSchema),
    frames: () => ["frame:display:1"],
  })
  return {
    inventory,
    transitions,
    captureRequests,
    desktopCaptureRequests,
    windowCaptureResults,
    desktopCaptureResults,
    inspectionRequests,
    inventoryCalls: () => inventoryCalls,
    setInspectionNodes(nodes: AxInspectionResult["nodes"]) { inspectionNodes = structuredClone(nodes) },
    setCaptureFailure(error: ContractError | undefined) { captureFailure = error === undefined ? undefined : structuredClone(error) },
    setTransitionFailure(error: ContractError | undefined) { transitionFailure = error === undefined ? undefined : structuredClone(error) },
    setInspectionFailure(error: ContractError | undefined) { inspectionFailure = error === undefined ? undefined : structuredClone(error) },
    setWindowCaptureReady(ready: boolean) { windowCaptureReady = ready },
  }
}

function registerBrowsers(fixture: ReturnType<typeof createFixture>) {
  const base = (name: string) => ({
    ...generation,
    browserInstanceRef: `browser:${name}`,
    transportGeneration: `transport:${name}:0`,
  })
  const instances: BrowserInstanceRecord[] = ["one", "two"].map(name => ({
    ref: base(name),
    provenance: { kind: "local-cdp", endpointHost: "127.0.0.1", endpointPort: name === "one" ? 9222 : 9224,
      profilePath: `/tmp/profile-${name}` },
    profileLabel: `Profile ${name === "one" ? "One" : "Two"}`,
    state: "disconnected",
    reason: "explicit-connect-required",
  }))
  const connectedRefs: string[] = []
  const targetRefs: string[] = []
  const operationKinds: string[] = []
  const captureResources: unknown[][] = []
  const captureRequests: Array<z.infer<typeof browserCapturePublicRequestSchema>> = []
  fixture.registry.register("browser_chrome_instances", method(async () => ({
    inventoryId: "inventory:browser:1",
    inventoryRevision: 1,
    ...generation,
    capturedAt: "2026-09-15T10:00:01.000Z",
    complete: true,
    errors: [],
    instances,
  }), z.strictObject({}), browserInstanceSnapshotSchema))
  const browserMethod = method(async (context, input) => {
    operationKinds.push(input.request.kind)
    if (input.request.kind === "connect-instance") {
      const ref = input.request.instance
      connectedRefs.push(ref.browserInstanceRef)
      const connected: BrowserInstanceRecord = {
        ref: { ...ref, transportGeneration: `${ref.transportGeneration}:connected` },
        provenance: instances.find(item => item.ref.browserInstanceRef === ref.browserInstanceRef)!.provenance,
        profileLabel: instances.find(item => item.ref.browserInstanceRef === ref.browserInstanceRef)!.profileLabel,
        state: "connected",
      }
      return browserExecution(context.session, input.intent, {
        value: { kind: "instance-connected" as const, instance: connected },
        cleanup: noCleanup(),
      })
    }
    if (input.request.kind === "read-accessibility") {
      const content = JSON.stringify([{ nodeId: "backend-node:save", role: { value: "button" },
        name: { value: "Save" }, actions: ["focus"] }])
      return browserExecution(context.session, input.intent, {
        value: { kind: "accessibility-read" as const, target: input.request.target,
          content, contentBytes: new TextEncoder().encode(content).byteLength, nodeCount: 1, truncated: false },
        cleanup: noCleanup(),
      })
    }
    if (input.request.kind === "capture-target") {
      if (input.request.capture.source !== "browser-viewport") throw new Error("Fixture требует browser viewport")
      captureResources.push(input.intent.requestedResources)
      const request = browserCapturePublicRequestSchema.parse(input.request)
      captureRequests.push(request)
      return browserExecution(context.session, input.intent, {
        value: { kind: "target-captured" as const, target: input.request.target,
          capture: browserCaptureResult(request) },
        cleanup: noCleanup(),
      })
    }
    throw new Error(`Fixture не поддерживает ${input.request.kind}`)
  }, z.strictObject({
    intent: runtimeOperationIntentSchema,
    request: z.union([browserOperationRequestSchema, browserCapturePublicRequestSchema]),
  }), z.strictObject({
    operation: operationRecordSchema,
    result: adapterResultSchema(browserOperationResultSchema),
  }))
  fixture.registry.register("browser_chrome_operation", {
    ...browserMethod,
    frames: output => output.result.ok && output.result.value.value.kind === "target-captured"
      ? [output.result.value.value.capture.frame.frameRef]
      : [],
  })
  fixture.registry.register("browser_chrome_targets", method(async (_context, input) => {
    targetRefs.push(input.instance.browserInstanceRef)
    return {
      inventoryId: "inventory:targets:1",
      inventoryRevision: 2,
      ...generation,
      capturedAt: "2026-09-15T10:00:02.000Z",
      complete: true,
      errors: [],
      instance: input.instance,
      targets: [{
        ref: { ...input.instance, targetId: "cdp-target:one", resourceRef: "resource:target:one" },
        type: "page",
        title: "Same URL",
        url: "https://example.com",
      }],
    }
  }, z.strictObject({ instance: browserInstanceRefSchema }), browserTargetSnapshotSchema))
  return { connectedRefs, targetRefs, operationKinds, captureResources, captureRequests }
}

function method<Input, Output extends Record<string, unknown>>(
  execute: (context: { session: RuntimeClientSession, signal: AbortSignal }, input: Input) => Promise<Output>,
  input: z.ZodType<Input> = z.object({}).passthrough() as z.ZodType<Input>,
  output: z.ZodType<Output> = z.object({}).passthrough() as z.ZodType<Output>,
) {
  return {
    title: "fixture",
    description: "fixture",
    input,
    output,
    readOnly: true,
    execute,
  }
}

function windowRecord(ref = windowRef, surfaces: WindowRecord["surfaces"] = []): WindowRecord {
  return windowRecordSchema.parse({
    kind: "ax-window",
    ref,
    ownerPid: 101,
    cgWindowId: 77,
    title: "One",
    role: "AXWindow",
    subrole: "AXStandardWindow",
    frame: { x: 0, y: 0, width: 640, height: 480 },
    applicationHidden: "true",
    minimized: "false",
    onScreen: "false",
    spaceVisibility: "not-current",
    fullscreen: "false",
    focused: "false",
    main: "true",
    mapping: "corroborated",
    mappingEvidence: {
      cgWindowId: 77,
      ownerPid: 101,
      proof: { proofRef: "proof:window", authorityRef: "authority:window", kind: "cg-ax-correlation",
        subject: { kind: "window", ref }, ...generation, nativeGeneration,
        inventoryRevision: 1, displayLayoutRevision: 1,
        issuedAt: "2026-09-15T10:00:00.000Z", expiresAt: "2099-09-15T10:00:00.000Z" },
    },
    actionability: "ax",
    surfaces,
    advertisedActions: ["raise"],
    permittedActions: ["raise"],
  })
}

function surfaceRecord() {
  return {
    ref: { ...generation, nativeGeneration, applicationRef: windowRef.applicationRef,
      surfaceRef: "surface:agent:modal", ownerWindowRef: windowRef.windowRef },
    kind: "sheet" as const,
    title: "Modal",
    role: "AXSheet",
    frame: { x: 40, y: 40, width: 300, height: 200 },
    actionability: "ax" as const,
    advertisedActions: ["close" as const],
    permittedActions: ["close" as const],
  }
}

function displayCaptureTarget() {
  return {
    kind: "display" as const,
    target: displayTarget,
    nativeDisplayId: 11,
    mappingEvidence: { state: "confirmed" as const, claim: "target-resolution", source: "fixture", proof: {
      proofRef: "proof:display-mapping", authorityRef: "authority:display-mapping", kind: "target-resolution" as const,
      subject: displayTarget, ...generation, nativeGeneration, inventoryRevision: 1, displayLayoutRevision: 1,
      issuedAt: "2026-09-15T10:00:00.000Z", expiresAt: "2099-09-15T10:00:00.000Z",
    } },
  }
}

function desktopLayoutTarget(display: ReturnType<typeof displayCaptureTarget>) {
  return {
    kind: "desktop-layout" as const,
    target: layoutTarget,
    mappingEvidence: { state: "confirmed" as const, claim: "target-resolution", source: "fixture", proof: {
      proofRef: "proof:layout-mapping", authorityRef: "authority:layout-mapping", kind: "target-resolution" as const,
      subject: layoutTarget, ...generation, nativeGeneration, inventoryRevision: 1, displayLayoutRevision: 1,
      issuedAt: "2026-09-15T10:00:00.000Z", expiresAt: "2099-09-15T10:00:00.000Z",
    } },
    displays: [display],
  }
}

function applicationRef(applicationRef: string, pid: number) {
  return {
    ...generation,
    nativeGeneration,
    applicationRef,
    pid,
    launchedAt: "2026-09-15T10:00:00.000Z",
    registrationNonce: `registration:${pid}`,
  }
}

function successfulOutcome(resources: readonly RuntimeResourceHandle[] = []) {
  return {
    dispatch: "finished" as const,
    targetVerified: "verified" as const,
    userInterference: "none-observed" as const,
    observation: "available" as const,
    effect: { state: "verified" as const, proofRefs: ["proof:effect"] },
    cleanup: resources.length === 0
      ? { scope: "none" as const, state: "complete" as const, resources: [] as [] }
      : { scope: "owned" as const, state: "complete" as const,
          resources: resources.map(handle => ({ handle, outcome: "released" as const })) },
    restoration: "kept-target" as const,
    dispatchAttempts: 1,
  }
}

function nativeStatus(wire: NativeExecutionContext) {
  const now = new Date().toISOString()
  return {
    requestId: `native-status:${wire.operationId}`,
    ...generation,
    nativeGeneration,
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
    lastCheckpoint: "fixture-finished",
    dispatchAttempts: 1,
    ledgerRevision: 1,
    observer: {
      state: "unavailable" as const,
      ...generation,
      nativeGeneration,
      coverageStartCursor: "cursor:fixture",
      cursor: "cursor:fixture",
      nextSequence: 1,
      startedAt: now,
      coveredFrom: now,
      coveredThrough: now,
      heartbeatAt: now,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "Fixture observer отключён",
    },
  }
}

function completedOperation(
  session: RuntimeClientSession,
  clientRequestId: string,
  inventoryId: string,
  inventoryRevision: number,
  target: OperationTarget,
  kind: "native" | "browser",
  intent: "read" | "mutation" | "admin" = "mutation",
) {
  const context = kind === "native" ? {
    kind,
    operationId: `operation:${clientRequestId}`,
    clientRequestId,
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    ...generation,
    inventoryId,
    inventoryRevision,
    deadlineAt: "2099-09-15T10:00:00.000Z",
    target,
    nativeGeneration,
    fence: { ...generation, nativeGeneration, counter: 1 },
  } : {
    kind,
    operationId: `operation:${clientRequestId}`,
    clientRequestId,
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    ...generation,
    inventoryId,
    inventoryRevision,
    deadlineAt: "2099-09-15T10:00:00.000Z",
    target,
  }
  return operationRecordSchema.parse({
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    intent,
    context,
    state: "completed",
    outcome: successfulOutcome(),
    resources: [],
    payloadReceipt: { keyGeneration: "payload:key:1", hmacSha256: "0".repeat(64) },
    registeredAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:01.000Z",
  })
}

function noCleanup() {
  return { scope: "none" as const, state: "complete" as const, resources: [] as [] }
}

function browserExecution(
  session: RuntimeClientSession,
  intent: RuntimeOperationIntent,
  value: z.infer<typeof browserOperationResultSchema>,
) {
  return {
    operation: completedOperation(session, intent.clientRequestId, intent.precondition.inventoryId,
      intent.precondition.inventoryRevision, intent.precondition.target, "browser", intent.intent),
    result: { ok: true as const, value, outcome: successfulOutcome() },
  }
}

function captureResult(input: z.infer<typeof captureWindowMethodInputSchema>, ready = true) {
  if (input.target.mappingEvidence.state !== "confirmed") throw new Error("Fixture требует confirmed mapping")
  const capturedAt = "2026-09-15T10:00:02.000Z"
  const expiresAt = "2099-09-15T10:00:00.000Z"
  const captureTarget = input.target.target
  const inventoryRevision = input.target.mappingEvidence.proof.inventoryRevision
  const displayLayoutRevision = input.target.mappingEvidence.proof.displayLayoutRevision
  const display = { ...generation, nativeGeneration, displayRef: "display:fixture", displayLayoutRevision }
  const publication = {
    observationId: "observation:agent:1",
    frameRef: "frame:agent:1",
    source: "window-isolated" as const,
    captureTarget,
    capturePolicySha256: "1".repeat(64),
    ...generation,
    nativeGeneration,
    expiresAt,
    inventoryId: input.inventoryId,
    inventoryRevision,
    displayLayoutRevision,
    cacheScopeRef: "cache:agent:1",
  }
  const frame = {
    frameRef: publication.frameRef,
    observationId: publication.observationId,
    ...generation,
    nativeGeneration,
    source: publication.source,
    target: captureTarget,
    capturedAt,
    widthPx: 320,
    heightPx: 240,
    byteLength: 10,
    sha256: "2".repeat(64),
    mime: "image/png" as const,
  }
  const steps = [
    ...input.readinessPolicy.requiredSteps.map(name => !ready && name === "target"
      ? { name, state: "unavailable" as const, durationMs: 1, reason: "Fixture capture target unavailable" }
      : { name, state: "reached" as const, durationMs: 1 }),
    ...input.readinessPolicy.disabledSteps.map(name => ({ name, state: "skipped" as const, durationMs: 0, reason: "disabled-by-policy" as const })),
  ]
  const observation = {
    observationId: publication.observationId,
    ...generation,
    nativeGeneration,
    captureTarget,
    caption: input.caption,
    backend: { name: "fixture", buildId: "build:capture:fixture" },
    capturedAt,
    expiresAt,
    inventoryRevision,
    displayLayoutRevision,
    source: publication.source,
    image: { frameRef: frame.frameRef, widthPx: frame.widthPx, heightPx: frame.heightPx,
      mime: frame.mime, byteLength: frame.byteLength, sha256: frame.sha256 },
    cursor: "excluded" as const,
    clip: { x: 0, y: 0, width: 320, height: 240 },
    captureEvidence: { state: "confirmed" as const, claim: "frame-freshness", source: "fixture", proof: {
      proofRef: "proof:frame", authorityRef: "authority:frame", kind: "frame-freshness" as const,
      subject: captureTarget, ...generation, nativeGeneration, inventoryRevision, displayLayoutRevision,
      issuedAt: capturedAt, expiresAt,
    } },
    occlusion: { state: "unknown" as const, claim: "occlusion", source: "fixture", reason: "isolated window" },
    readiness: { state: ready ? "ready" as const : "unavailable" as const, policy: input.readinessPolicy, steps, timedOut: false },
    synchronization: { kind: "single-frame" as const },
    regions: [{
      space: { kind: "macos-screen" as const, display },
      imageRect: { x: 0, y: 0, width: 320, height: 240 },
      destinationRect: { x: 0, y: 0, width: 640, height: 480 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 },
      frameTimestamp: capturedAt,
      frameStatus: "complete" as const,
    }],
    unavailableReasons: ready ? [] : ["Fixture capture target unavailable"],
  }
  return {
    publication,
    observation,
    frame,
    effective: {
      clip: input.clip,
      fullPage: false,
      cursor: "excluded" as const,
      scale: input.output.scale,
      widthPx: 320,
      heightPx: 240,
      pixelCount: 320 * 240,
      encodedBytes: frame.byteLength,
      readinessPolicy: input.readinessPolicy,
    },
    cleanup: { scope: "none" as const, state: "complete" as const, resources: [] as [] },
  }
}

function desktopCaptureResult(input: z.infer<typeof captureDesktopMethodInputSchema>) {
  if (input.target.mappingEvidence.state !== "confirmed") throw new Error("Fixture требует confirmed desktop mapping")
  const capturedAt = "2026-09-15T10:00:02.000Z"
  const expiresAt = "2099-09-15T10:00:00.000Z"
  const captureTarget = input.target.target
  const inventoryRevision = input.target.mappingEvidence.proof.inventoryRevision
  const displayLayoutRevision = input.target.mappingEvidence.proof.displayLayoutRevision
  const display = input.target.kind === "display" ? input.target : input.target.displays[0]!
  const publication = {
    observationId: "observation:display:1",
    frameRef: "frame:display:1",
    source: "display-composite" as const,
    captureTarget,
    capturePolicySha256: "5".repeat(64),
    ...generation,
    nativeGeneration,
    expiresAt,
    inventoryId: input.inventoryId,
    inventoryRevision,
    displayLayoutRevision,
    cacheScopeRef: "cache:display:1",
  }
  const frame = {
    frameRef: publication.frameRef,
    observationId: publication.observationId,
    ...generation,
    nativeGeneration,
    source: publication.source,
    target: captureTarget,
    capturedAt,
    widthPx: 320,
    heightPx: 240,
    byteLength: 10,
    sha256: "6".repeat(64),
    mime: "image/png" as const,
  }
  const steps = [
    ...input.readinessPolicy.requiredSteps.map(name => ({ name, state: "reached" as const, durationMs: 1 })),
    ...input.readinessPolicy.disabledSteps.map(name => ({ name, state: "skipped" as const, durationMs: 0, reason: "disabled-by-policy" as const })),
  ]
  const observation = {
    observationId: publication.observationId,
    ...generation,
    nativeGeneration,
    captureTarget,
    caption: input.caption,
    backend: { name: "fixture", buildId: "build:display-capture" },
    capturedAt,
    expiresAt,
    inventoryRevision,
    displayLayoutRevision,
    source: publication.source,
    image: { frameRef: frame.frameRef, widthPx: frame.widthPx, heightPx: frame.heightPx,
      mime: frame.mime, byteLength: frame.byteLength, sha256: frame.sha256 },
    cursor: "excluded" as const,
    clip: { x: 0, y: 0, width: 320, height: 240 },
    captureEvidence: { state: "confirmed" as const, claim: "frame-freshness", source: "fixture", proof: {
      proofRef: "proof:display-frame", authorityRef: "authority:display-frame", kind: "frame-freshness" as const,
      subject: captureTarget, ...generation, nativeGeneration, inventoryRevision, displayLayoutRevision,
      issuedAt: capturedAt, expiresAt,
    } },
    occlusion: { state: "unknown" as const, claim: "occlusion", source: "fixture", reason: "display composite" },
    readiness: { state: "ready" as const, policy: input.readinessPolicy, steps, timedOut: false },
    synchronization: { kind: "single-frame" as const },
    regions: [{
      space: { kind: "macos-screen" as const, display: display.target.ref },
      imageRect: { x: 0, y: 0, width: 320, height: 240 },
      destinationRect: { x: -640, y: 0, width: 640, height: 480 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: -640, ty: 0 },
      frameTimestamp: capturedAt,
      frameStatus: "complete" as const,
    }],
    unavailableReasons: [],
  }
  return {
    publication,
    observation,
    frame,
    effective: { clip: input.clip, fullPage: false, cursor: "excluded" as const,
      scale: input.output.scale, widthPx: 320, heightPx: 240, pixelCount: 320 * 240,
      encodedBytes: frame.byteLength, readinessPolicy: input.readinessPolicy },
    cleanup: { scope: "none" as const, state: "complete" as const, resources: [] as [] },
  }
}

function browserCaptureResult(input: z.infer<typeof browserCapturePublicRequestSchema>) {
  const capturedAt = "2026-09-15T10:00:03.000Z"
  const expiresAt = "2099-09-15T10:00:00.000Z"
  const publication = {
    observationId: "observation:browser:1",
    frameRef: "frame:browser:1",
    source: "browser-viewport" as const,
    captureTarget: input.capture.target,
    capturePolicySha256: "3".repeat(64),
    ...generation,
    expiresAt,
    inventoryId: "inventory:targets:1",
    inventoryRevision: 2,
    displayLayoutRevision: 0,
    cacheScopeRef: "cache:browser:1",
  }
  const frame = {
    frameRef: publication.frameRef,
    observationId: publication.observationId,
    ...generation,
    source: publication.source,
    target: input.capture.target,
    capturedAt,
    widthPx: 320,
    heightPx: 240,
    byteLength: 10,
    sha256: "4".repeat(64),
    mime: "image/png" as const,
  }
  const steps = input.capture.readinessPolicy.requiredSteps.map(name => ({ name, state: "reached" as const, durationMs: 1 }))
  const observation = {
    observationId: publication.observationId,
    ...generation,
    captureTarget: input.capture.target,
    caption: input.capture.caption,
    backend: { name: "fixture", buildId: "build:browser-capture" },
    capturedAt,
    expiresAt,
    inventoryRevision: publication.inventoryRevision,
    displayLayoutRevision: 0,
    source: publication.source,
    image: { frameRef: frame.frameRef, widthPx: frame.widthPx, heightPx: frame.heightPx,
      mime: frame.mime, byteLength: frame.byteLength, sha256: frame.sha256 },
    cursor: "excluded" as const,
    clip: { x: 0, y: 0, width: 320, height: 240 },
    captureEvidence: { state: "confirmed" as const, claim: "frame-freshness", source: "fixture", proof: {
      proofRef: "proof:browser-frame", authorityRef: "authority:browser-frame", kind: "frame-freshness" as const,
      subject: input.capture.target, ...generation, inventoryRevision: 2, displayLayoutRevision: 0,
      issuedAt: capturedAt, expiresAt,
    } },
    occlusion: { state: "unknown" as const, claim: "occlusion", source: "fixture", reason: "browser compositor" },
    readiness: { state: "ready" as const, policy: input.capture.readinessPolicy, steps, timedOut: false },
    synchronization: { kind: "single-frame" as const },
    regions: [{
      space: { kind: "browser-viewport" as const, target: input.target },
      imageRect: { x: 0, y: 0, width: 320, height: 240 },
      destinationRect: { x: 0, y: 0, width: 640, height: 480 },
      imageToDestination: { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 },
      frameTimestamp: capturedAt,
      frameStatus: "complete" as const,
    }],
    unavailableReasons: [],
  }
  return {
    publication,
    observation,
    frame,
    effective: {
      clip: input.capture.clip,
      fullPage: input.capture.fullPage,
      cursor: "excluded" as const,
      scale: input.capture.output.scale,
      widthPx: 320,
      heightPx: 240,
      pixelCount: 320 * 240,
      encodedBytes: frame.byteLength,
      readinessPolicy: input.capture.readinessPolicy,
    },
    cleanup: noCleanup(),
  }
}

function sequenceIds() {
  let value = 0
  return (prefix: string) => `${prefix}:${++value}`
}
