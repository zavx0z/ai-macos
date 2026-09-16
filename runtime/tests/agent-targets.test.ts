import { expect, test } from "bun:test"
import type { AxInspectionResult } from "@meta/shared/contracts"
import { AgentTargetRegistry, type AgentTarget } from "../src/agent-targets.ts"

const generation = { runtimeEpoch: "runtime:agent-targets", loginSessionId: "login:agent-targets" }
const nativeGeneration = "native:agent-targets"

test("same exact Chrome window сохраняет handle при refresh, replacement получает новый", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:chrome")
  const original = windowTarget("window:chrome:1")
  const first = scope.registerTarget(original, authority(1))
  const refreshed = scope.registerTarget(original, authority(2))
  const replacement = scope.registerTarget(windowTarget("window:chrome:2"), authority(3))
  expect(refreshed.targetId).toBe(first.targetId)
  expect(scope.resolveAction(first.targetId)).toMatchObject({ target: original, inventoryRevision: 2 })
  expect(replacement.targetId).not.toBe(first.targetId)
  expect(() => scope.registerTarget({
    ...original,
    ref: { ...original.ref, runtimeEpoch: "runtime:replacement" },
  }, authority(4))).toThrow("другой runtime/login generation")
})

test("same target ID и URL в разных profiles не смешивают browser identity", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:profiles")
  const profileOne = browserTarget("browser:profile:one", "transport:one", "CDP-TARGET")
  const profileTwo = browserTarget("browser:profile:two", "transport:two", "CDP-TARGET")
  const one = scope.registerTarget(profileOne, authority(1))
  const two = scope.registerTarget(profileTwo, authority(1))
  expect(one.targetId).not.toBe(two.targetId)
  expect(scope.resolveAction(one.targetId).target).toEqual(profileOne)
  expect(scope.resolveAction(two.targetId).target).toEqual(profileTwo)
})

test("display и desktop layout сохраняют exact native/layout generation identity", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:display")
  const display = displayTarget("display:main", 3)
  const first = scope.registerTarget(display, authority(1))
  const refreshed = scope.registerTarget(display, authority(2))
  const changedLayout = scope.registerTarget(displayTarget("display:main", 4), authority(3))
  const changedGeneration = scope.registerTarget(
    displayTarget("display:main", 4, "native:replacement"),
    authority(4),
  )
  const layout = scope.registerTarget(layoutTarget("layout:desktop", 4), authority(3))

  expect(first.kind).toBe("display")
  expect(refreshed.targetId).toBe(first.targetId)
  expect(changedLayout.targetId).not.toBe(first.targetId)
  expect(changedGeneration.targetId).not.toBe(changedLayout.targetId)
  expect(scope.resolveAction(first.targetId).target).toEqual(display)
  expect(scope.resolveAction(layout.targetId).target).toEqual(layoutTarget("layout:desktop", 4))
})

test("foreign lineage не читает target или element handle", () => {
  const value = fixture()
  const owner = value.registry.forLineage("lineage:owner")
  const foreign = value.registry.forLineage("lineage:foreign")
  const target = owner.registerTarget(windowTarget("window:private"), authority(1))
  const [element] = owner.registerElements(target.targetId, inspection("window:private", "snapshot:private", "element:private"))
  expect(() => foreign.resolveAction(target.targetId)).toThrow("этой client lineage")
  expect(() => foreign.resolveControl(target.targetId)).toThrow("этой client lineage")
  expect(() => foreign.resolveElement(target.targetId, element!.elementId)).toThrow("этой client lineage")
})

test("closed handle не ретаргетится на новое окно с тем же внешним title", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:closed")
  const originalRef = windowTarget("window:closed")
  const original = scope.registerTarget(originalRef, authority(1))
  scope.closeTarget(original.targetId, "Window close подтверждён")
  const replacementRef = windowTarget("window:new-same-title")
  const replacement = scope.registerTarget(replacementRef, authority(2))
  expect(replacement.targetId).not.toBe(original.targetId)
  expect(() => scope.resolveAction(original.targetId)).toThrow("closed")
  expect(scope.resolveControl(original.targetId)).toMatchObject({ state: "closed", target: originalRef })
  expect(scope.resolveAction(replacement.targetId).target).toEqual(replacementRef)
})

test("action TTL и control retention разделены, active owner запрещает prune", () => {
  const value = fixture({ actionTtlMs: 10, controlRetentionMs: 50 })
  const scope = value.registry.forLineage("lineage:control")
  const target = scope.registerTarget(windowTarget("window:control"), authority(1))
  scope.retainControl(target.targetId, "operation:active")
  value.advance(11)
  expect(() => scope.resolveAction(target.targetId)).toThrow("action TTL")
  expect(scope.resolveControl(target.targetId).target).toEqual(windowTarget("window:control"))
  value.advance(100)
  value.registry.prune()
  expect(scope.resolveControl(target.targetId).targetId).toBe(target.targetId)
  scope.releaseControl(target.targetId, "operation:active")
  value.advance(51)
  value.registry.prune()
  expect(() => scope.resolveControl(target.targetId)).toThrow("этой client lineage")
})

test("новый AX snapshot атомарно инвалидирует старые element handles", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:ax")
  const target = scope.registerTarget(windowTarget("window:ax"), authority(1))
  const [oldElement] = scope.registerElements(target.targetId, inspection("window:ax", "snapshot:1", "element:1"))
  const oldResolution = scope.resolveElement(target.targetId, oldElement!.elementId, "AXPress")
  expect(oldResolution.elementRef.elementRef).toBe("element:1")
  expect(oldResolution).not.toHaveProperty("frame")

  const [currentElement] = scope.registerElements(target.targetId, inspection("window:ax", "snapshot:2", "element:2"))
  expect(() => scope.resolveElement(target.targetId, oldElement!.elementId)).toThrow("latest target snapshot")
  expect(scope.resolveElement(target.targetId, currentElement!.elementId, "AXPress")).toMatchObject({
    snapshotId: "snapshot:2",
    elementRef: { elementRef: "element:2" },
    actions: ["AXPress"],
  })
  expect(() => scope.resolveElement(target.targetId, currentElement!.elementId, "AXConfirm")).toThrow("не объявляет action")
  scope.invalidateElements(target.targetId)
  expect(() => scope.resolveElement(target.targetId, currentElement!.elementId)).toThrow("latest target snapshot")
})

test("AX metadata и parent публикуются только opaque handles того же snapshot и учитываются в byte budget", () => {
  const value = fixture()
  const owner = value.registry.forLineage("lineage:ax-metadata")
  const foreign = value.registry.forLineage("lineage:ax-metadata-foreign")
  const target = owner.registerTarget(windowTarget("window:ax-metadata"), authority(1))
  const result = inspection("window:ax-metadata", "snapshot:metadata", "element:root", "element:static", "element:orphan")
  const rootRef = result.nodes[0]!.elementRef
  result.nodes[0] = { ...result.nodes[0]!, role: "AXWindow", title: "Документ", identifier: "main-window",
    description: "x".repeat(4_096), frame: { x: 10, y: 20, width: 800, height: 600 } }
  result.nodes[1] = { ...result.nodes[1]!, parentElementRef: rootRef, role: "AXStaticText", title: "",
    value: "Состояние готово", frame: { x: 20, y: 40, width: 0, height: 0 }, actions: [] }
  result.nodes[2] = { ...result.nodes[2]!, parentElementRef: { ...rootRef, elementRef: "element:not-returned" },
    role: "AXTextField", title: "Пароль", valueRedacted: true, actions: [] }
  const handles = owner.registerElements(target.targetId, result)
  expect(handles).toMatchObject([
    { role: "AXWindow", identifier: "main-window", frame: { width: 800, height: 600 } },
    { parentElementId: handles[0]!.elementId, role: "AXStaticText", title: "", value: "Состояние готово", frame: { width: 0, height: 0 } },
    { role: "AXTextField", valueRedacted: true },
  ])
  expect(handles[2]).not.toHaveProperty("parentElementId")
  expect(JSON.stringify(handles)).not.toContain("element:root")
  expect(value.registry.stats().bytes).toBeGreaterThan(4_096)
  expect(() => foreign.resolveElement(target.targetId, handles[1]!.elementId)).toThrow("client lineage")
})

test("foreign AX parent отклоняется без потери latest valid handles", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:ax-parent")
  const target = scope.registerTarget(windowTarget("window:parent"), authority(1))
  const [element] = scope.registerElements(target.targetId, inspection("window:parent", "snapshot:valid", "element:valid"))
  expect(() => scope.registerElements(
    target.targetId,
    inspection("window:foreign", "snapshot:foreign", "element:foreign"),
  )).toThrow("другому exact parent")
  expect(scope.resolveElement(target.targetId, element!.elementId).snapshotId).toBe("snapshot:valid")
})

test("target, element и byte budgets fail closed", () => {
  const targetLimited = fixture({ maxTargets: 1 })
  const targets = targetLimited.registry.forLineage("lineage:target-budget")
  targets.registerTarget(windowTarget("window:budget:1"), authority(1))
  expect(() => targets.registerTarget(windowTarget("window:budget:2"), authority(2))).toThrow("capacity")
  expect(() => targetLimited.registry.forLineage("lineage:empty-leak").registerTarget(
    windowTarget("window:budget:foreign-lineage"),
    authority(3),
  )).toThrow("capacity")
  expect(targetLimited.registry.stats().lineages).toBe(1)

  const elementLimited = fixture({ maxElements: 1 })
  const elements = elementLimited.registry.forLineage("lineage:element-budget")
  const parent = elements.registerTarget(windowTarget("window:elements"), authority(1))
  expect(() => elements.registerElements(parent.targetId, inspection(
    "window:elements",
    "snapshot:too-many",
    "element:one",
    "element:two",
  ))).toThrow("element registry capacity")
  expect(elementLimited.registry.stats().elements).toBe(0)

  const byteLimited = fixture({ maxBytes: 1024, maxTargets: 100 })
  const bytes = byteLimited.registry.forLineage("lineage:byte-budget")
  let rejected = false
  for (let index = 0; index < 100 && !rejected; index++) {
    try {
      bytes.registerTarget(windowTarget(`window:${index}:${"x".repeat(80)}`), authority(index))
    } catch (error) {
      expect(String(error)).toContain("byte budget")
      rejected = true
    }
  }
  expect(rejected).toBe(true)
  expect(byteLimited.registry.stats().bytes).toBeLessThanOrEqual(1024)
})

function fixture(options: {
  actionTtlMs?: number
  controlRetentionMs?: number
  maxTargets?: number
  maxElements?: number
  maxBytes?: number
} = {}) {
  let nowMs = Date.parse("2026-09-15T12:00:00.000Z")
  let nextId = 0
  const registry = new AgentTargetRegistry({
    generation,
    clock: { now: () => new Date(nowMs) },
    ids: { next: prefix => `${prefix}:${++nextId}` },
    ...options,
  })
  return { registry, advance: (milliseconds: number) => { nowMs += milliseconds } }
}

function authority(inventoryRevision: number) {
  return { inventoryId: `inventory:${inventoryRevision}`, inventoryRevision }
}

function windowTarget(windowRef: string): Extract<AgentTarget, { kind: "window" }> {
  return {
    kind: "window",
    ref: {
      ...generation,
      nativeGeneration,
      applicationRef: "application:chrome",
      windowRef,
    },
  }
}

function browserTarget(browserInstanceRef: string, transportGeneration: string, targetId: string): AgentTarget {
  return {
    kind: "browser-target",
    ref: {
      ...generation,
      browserInstanceRef,
      transportGeneration,
      targetId,
      resourceRef: `resource:${browserInstanceRef}`,
    },
  }
}

function displayTarget(
  displayRef: string,
  displayLayoutRevision: number,
  targetNativeGeneration = nativeGeneration,
): Extract<AgentTarget, { kind: "display" }> {
  return {
    kind: "display",
    ref: {
      ...generation,
      nativeGeneration: targetNativeGeneration,
      displayRef,
      displayLayoutRevision,
    },
  }
}

function layoutTarget(
  layoutRef: string,
  displayLayoutRevision: number,
): Extract<AgentTarget, { kind: "desktop-layout" }> {
  return {
    kind: "desktop-layout",
    ref: {
      ...generation,
      nativeGeneration,
      layoutRef,
      displayLayoutRevision,
    },
  }
}

function inspection(
  windowRef: string,
  snapshotId: string,
  ...elementRefs: string[]
): AxInspectionResult {
  return {
    snapshotId,
    target: windowTarget(windowRef) as Extract<AgentTarget, { kind: "window" }>,
    complete: true,
    nodeCount: elementRefs.length,
    encodedBytes: 256,
    nodes: elementRefs.map(elementRef => ({
      elementRef: {
        ...generation,
        nativeGeneration,
        applicationRef: "application:chrome",
        snapshotId,
        elementRef,
      },
      role: "AXButton",
      subrole: "",
      title: "Продолжить",
      frame: { x: 10, y: 20, width: 100, height: 30 },
      actions: ["AXPress"],
    })),
    errors: [],
  }
}

test("default handles не истекают в простое; закрытие lineage не удаляет удерживаемый control", () => {
  const value = fixture()
  const scope = value.registry.forLineage("lineage:lifetime")
  const handle = scope.registerTarget(windowTarget("window:lifetime"), authority(1))
  const [element] = scope.registerElements(handle.targetId, inspection("window:lifetime", "snapshot:lifetime", "element:lifetime"))
  expect(handle.actionExpiresAt).toBeUndefined()
  value.advance(86_400_000)
  value.registry.prune()
  expect(scope.resolveAction(handle.targetId).targetId).toBe(handle.targetId)
  expect(scope.resolveElement(handle.targetId, element!.elementId).expiresAt).toBeUndefined()
  scope.retainControl(handle.targetId, "operation:held")
  value.registry.releaseLineage("lineage:lifetime")
  expect(() => scope.resolveAction(handle.targetId)).toThrow("invalidated")
  expect(scope.resolveControl(handle.targetId).targetId).toBe(handle.targetId)
  scope.releaseControl(handle.targetId, "operation:held")
  value.advance(300_001)
  value.registry.prune()
  expect(value.registry.stats().targets).toBe(0)
})
