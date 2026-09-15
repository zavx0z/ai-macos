import { describe, expect, test } from "bun:test"
import {
  axInspectionRequestSchema,
  browserInstanceSnapshotSchema,
  browserOperationRequestSchema,
  browserTargetSnapshotSchema,
  desktopInventorySnapshotSchema,
  deviceBrowserTargetSnapshotSchema,
  deviceRecordSchema,
  windowTransitionResultSchema,
} from "./index.ts"
import {
  browserInstanceRef,
  browserTargetRef,
  deviceBrowserInstanceRef,
  deviceBrowserTargetRef,
  displayRef,
  loginSessionId,
  nativeGeneration,
  now,
  proof,
  runtimeEpoch,
  windowRef,
} from "./test-fixtures.ts"

const applicationRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  applicationRef: "application:1",
  pid: 42,
  launchedAt: "2026-09-15T09:00:00.000Z",
  registrationNonce: "registration:1",
}

const windowRecord = {
  kind: "ax-window",
  ref: windowRef,
  surfaces: [],
  ownerPid: 42,
  cgWindowId: 99,
  title: "Editor",
  role: "AXWindow",
  subrole: "AXStandardWindow",
  frame: { x: -100, y: 20, width: 800, height: 600 },
  applicationHidden: "false",
  minimized: "false",
  onScreen: "true",
  spaceVisibility: "current",
  fullscreen: "false",
  focused: "true",
  main: "true",
  mapping: "corroborated",
  mappingEvidence: {
    proof: proof("cg-ax-correlation", { kind: "window", ref: windowRef }),
    cgWindowId: 99,
    ownerPid: 42,
  },
  actionability: "ax",
  advertisedActions: ["raise", "close", "move", "resize"],
  permittedActions: ["raise", "close", "move", "resize"],
}

describe("C1 desktop inventory and window surfaces", () => {
  test("inventory различает completeness/errors и проверяет generations", () => {
    const snapshot = desktopInventorySnapshotSchema.parse({
      inventoryId: "inventory:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 4,
      displayLayoutRevision: 3,
      capturedAt: now,
      complete: true,
      errors: [],
      applications: [{
        ref: applicationRef,
        name: "Editor",
        bundleId: "com.example.editor",
        hidden: "false",
        axStatus: "ready",
        windowCount: 1,
      }],
      windows: [windowRecord],
      displays: [{
        ref: displayRef,
        nativeDisplayId: 1,
        bounds: { x: -1600, y: 0, width: 1600, height: 1200 },
        usableBounds: { x: -1600, y: 24, width: 1600, height: 1176 },
        scale: 2,
        rotationDegrees: 0,
        main: true,
      }],
      desktopLayout: {
        kind: "desktop-layout",
        target: {
          kind: "desktop-layout",
          ref: {
            runtimeEpoch,
            loginSessionId,
            nativeGeneration,
            layoutRef: "layout:1",
            displayLayoutRevision: 3,
          },
        },
        mappingEvidence: {
          state: "confirmed",
          claim: "desktop-layout-resolved",
          source: "native-registry",
          proof: proof("target-resolution", {
            kind: "desktop-layout",
            ref: {
              runtimeEpoch,
              loginSessionId,
              nativeGeneration,
              layoutRef: "layout:1",
              displayLayoutRevision: 3,
            },
          }),
        },
        displays: [{
          kind: "display",
          target: { kind: "display", ref: displayRef },
          nativeDisplayId: 1,
          mappingEvidence: {
            state: "confirmed",
            claim: "native-display-resolved",
            source: "native-registry",
            proof: proof("target-resolution", { kind: "display", ref: displayRef }),
          },
        }],
      },
    })
    expect(snapshot.windows[0]?.kind === "ax-window" ? snapshot.windows[0].ref.windowRef : undefined).toBe("window:1")
    expect(desktopInventorySnapshotSchema.safeParse({ ...snapshot, complete: false, errors: [] }).success).toBe(false)
    expect(desktopInventorySnapshotSchema.safeParse({
      ...snapshot,
      windows: [{ ...windowRecord, ref: { ...windowRef, nativeGeneration: "native:foreign" } }],
    }).success).toBe(false)
    const { desktopLayout: _, ...withoutLayout } = snapshot
    expect(desktopInventorySnapshotSchema.safeParse(withoutLayout).success).toBe(false)
    expect(desktopInventorySnapshotSchema.safeParse({
      ...snapshot,
      desktopLayout: { ...snapshot.desktopLayout, displays: [] },
    }).success).toBe(false)
  })

  test("inventory сохраняет CG-only entry без WindowRef и все owned surfaces", () => {
    const surfaces = [
      {
        ref: {
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          applicationRef: windowRef.applicationRef,
          surfaceRef: "surface:sheet",
          ownerWindowRef: windowRef.windowRef,
        },
        kind: "sheet",
        title: "Save",
        role: "AXSheet",
        frame: { x: 0, y: 0, width: 300, height: 200 },
        actionability: "ax",
        advertisedActions: ["close"],
        permittedActions: ["close"],
      },
      {
        ref: {
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          applicationRef: windowRef.applicationRef,
          surfaceRef: "surface:popup",
          ownerWindowRef: windowRef.windowRef,
        },
        kind: "popup",
        title: "Menu",
        role: "AXMenu",
        frame: { x: 10, y: 10, width: 120, height: 80 },
        actionability: "ax",
        advertisedActions: [],
        permittedActions: [],
      },
    ]
    const snapshot = desktopInventorySnapshotSchema.parse({
      inventoryId: "inventory:surfaces",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 4,
      displayLayoutRevision: 3,
      capturedAt: now,
      complete: true,
      errors: [],
      applications: [{
        ref: applicationRef,
        name: "Editor",
        hidden: "false",
        axStatus: "ready",
        windowCount: 1,
      }],
      windows: [
        { ...windowRecord, surfaces },
        {
          kind: "cg-only",
          runtimeEpoch,
          loginSessionId,
          nativeGeneration,
          cgEntryRef: "cg-entry:1",
          ownerPid: 99,
          cgWindowId: 101,
          title: "Unresolved overlay",
          frame: { x: 10, y: 20, width: 50, height: 60 },
          onScreen: "true",
          actionability: "unavailable",
          reason: "AX correlation unavailable",
        },
      ],
      displays: [],
    })
    expect(snapshot.windows).toHaveLength(2)
    expect(snapshot.windows[0]).toMatchObject({ kind: "ax-window", surfaces })
    expect(snapshot.windows[1]).toMatchObject({ kind: "cg-only", actionability: "unavailable" })
    expect(snapshot.windows[1]).not.toHaveProperty("ref")
    expect(snapshot.windows[1]).not.toHaveProperty("permittedActions")
  })

  test("window transition возвращает requested/actual/partial, AX request bounded", () => {
    expect(windowTransitionResultSchema.parse({
      target: windowRef,
      requested: { kind: "set-bounds", target: windowRef, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      actual: { ...windowRecord, frame: { x: 0, y: 0, width: 640, height: 600 } },
      changed: true,
      partial: true,
      errors: [{
        code: "internal-error",
        message: "resize failed",
        stage: "window-resize",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "none",
      }],
    }).partial).toBe(true)
    expect(axInspectionRequestSchema.safeParse({
      target: { kind: "window", ref: windowRef },
      depth: 13,
      maxNodes: 1_500,
      maxBytes: 1024 * 1024,
    }).success).toBe(false)
    expect(windowTransitionResultSchema.safeParse({
      target: windowRef,
      requested: { kind: "close", target: windowRef },
      actual: windowRecord,
      changed: false,
      partial: true,
      newSurface: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        applicationRef: "application:foreign",
        surfaceRef: "surface:1",
        ownerWindowRef: windowRef.windowRef,
      },
      errors: [{
        code: "operation-in-progress",
        message: "modal appeared",
        stage: "window-close",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "none",
      }],
    }).success).toBe(false)
  })

  test("mapping proof и permitted actions связаны с exact window/current actionability", () => {
    expect(desktopInventorySnapshotSchema.safeParse({
      inventoryId: "inventory:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 4,
      displayLayoutRevision: 3,
      capturedAt: now,
      complete: true,
      errors: [],
      applications: [],
      windows: [{
        ...windowRecord,
        mappingEvidence: {
          proof: proof("pixel-ownership", { kind: "display", ref: displayRef }),
          cgWindowId: 99,
          ownerPid: 42,
        },
      }],
      displays: [],
    }).success).toBe(false)
    expect(desktopInventorySnapshotSchema.safeParse({
      inventoryId: "inventory:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 4,
      displayLayoutRevision: 3,
      capturedAt: now,
      complete: true,
      errors: [],
      applications: [],
      windows: [{
        ...windowRecord,
        actionability: "unavailable",
        unavailableReason: "AX denied",
        permittedActions: ["close"],
      }],
      displays: [],
    }).success).toBe(false)
  })
})

describe("C1 browser and device inventory surfaces", () => {
  const instanceRecord = {
    ref: browserInstanceRef,
    provenance: {
      kind: "local-cdp",
      endpointHost: "127.0.0.1",
      endpointPort: 9222,
      profilePath: "/Users/test/Library/Application Support/Chrome-CDP",
    },
    process: {
      runtimeEpoch,
      loginSessionId,
      processRef: "browser-process:1",
      pid: 42,
      launchedAt: "2026-09-15T09:00:00.000Z",
      registrationNonce: "registration:browser:1",
    },
    state: "connected",
  }

  test("browser list возвращает snapshots и exact instance-target relation", () => {
    expect(browserInstanceSnapshotSchema.parse({
      inventoryId: "browser-inventory:1",
      runtimeEpoch,
      loginSessionId,
      capturedAt: now,
      complete: true,
      errors: [],
      instances: [instanceRecord],
    }).instances).toHaveLength(1)
    const targetSnapshot = {
      inventoryId: "target-inventory:1",
      runtimeEpoch,
      loginSessionId,
      capturedAt: now,
      complete: true,
      errors: [],
      instance: browserInstanceRef,
      targets: [{ ref: browserTargetRef, type: "page", title: "Example", url: "chrome://newtab/" }],
    }
    expect(browserTargetSnapshotSchema.parse(targetSnapshot).targets[0]?.url).toBe("chrome://newtab/")
    expect(browserTargetSnapshotSchema.safeParse({
      ...targetSnapshot,
      targets: [{ ...targetSnapshot.targets[0], ref: { ...browserTargetRef, browserInstanceRef: "browser:foreign" } }],
    }).success).toBe(false)
  })

  test("connect/disconnect и DOM/AX operations объявлены строгими schemas", () => {
    expect(browserOperationRequestSchema.parse({ kind: "connect-instance", instance: browserInstanceRef }).kind).toBe("connect-instance")
    expect(browserOperationRequestSchema.parse({
      kind: "read-accessibility",
      target: browserTargetRef,
      maxNodes: 1_500,
      maxBytes: 1024 * 1024,
    }).kind).toBe("read-accessibility")
    expect(browserOperationRequestSchema.safeParse({
      kind: "read-dom",
      target: browserTargetRef,
      maxBytes: 1024 * 1024,
      rawCdpFallback: true,
    }).success).toBe(false)
  })

  test("device record различает unauthorized/offline/forward и target snapshot требует exact browser instance", () => {
    expect(deviceRecordSchema.parse({
      ref: {
        runtimeEpoch,
        loginSessionId,
        deviceRef: "device:1",
        serial: "SERIAL-1",
        transportGeneration: "adb:1",
      },
      state: "unauthorized",
      forward: { state: "absent" },
      reason: "USB debugging authorization required",
    }).state).toBe("unauthorized")
    const snapshot = {
      inventoryId: "android-targets:1",
      runtimeEpoch,
      loginSessionId,
      capturedAt: now,
      complete: true,
      errors: [],
      instance: deviceBrowserInstanceRef,
      targets: [{ ref: deviceBrowserTargetRef, type: "page", title: "Phone", url: "https://example.com" }],
    }
    expect(deviceBrowserTargetSnapshotSchema.parse(snapshot).targets).toHaveLength(1)
    expect(deviceBrowserTargetSnapshotSchema.safeParse({
      ...snapshot,
      targets: [{ ...snapshot.targets[0], ref: { ...deviceBrowserTargetRef, serial: "SERIAL-OTHER" } }],
    }).success).toBe(false)
  })
})
