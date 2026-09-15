import { describe, expect, test } from "bun:test"
import type {
  AdapterServices,
  NativeEvidenceReport,
  ProofRef,
  VerifiedNativeEvidenceReceipt,
} from "@meta/shared/contracts"
import { structurallyEqual } from "@meta/shared/contracts"
import { NativeBrokerAdapter, type NativeTransport } from "../src/adapter.ts"
import type {
  NativeTransportPacket,
  NativeTransportRequestFrame,
} from "../src/protocol.ts"
import { nativeAxInspectionResultSchema, nativeInventoryResultSchema } from "../src/protocol.ts"
import { NativeWindowAdapter } from "../src/window-adapter.ts"
import { extractNativeEvidenceReports } from "../src/evidence-extractor.ts"
import { createRuntimeNativeEvidenceBinder } from "../src/evidence-extractor.ts"
import { RuntimeCore } from "../../runtime/src/core.ts"

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}
const capturedAt = new Date().toISOString()

test("Native AX wire принимает только bounded scalar и отдельную redaction", () => {
  const result = {
    snapshotId: "snapshot-1",
    complete: true,
    nodeCount: 1,
    encodedBytes: 128,
    nodes: [{
      elementRef: "ax-node:1",
      role: "AXTextField",
      subrole: "AXSecureTextField",
      title: "Пароль",
      actions: [],
    }],
    errors: [],
  }
  expect(nativeAxInspectionResultSchema.safeParse({
    ...result,
    nodes: [{ ...result.nodes[0], valueRedacted: true }],
  }).success).toBe(true)
  expect([
    { value: { raw: "forbidden" } },
    { value: Number.NaN },
    { value: "forbidden", valueRedacted: true },
  ].every(fields => !nativeAxInspectionResultSchema.safeParse({
    ...result,
    nodes: [{ ...result.nodes[0], ...fields }],
  }).success)).toBe(true)
})

class InventoryTransport implements NativeTransport {
  constructor(readonly hidden = false) {}
  readonly #packets: NativeTransportPacket[] = []
  readonly #waiters: Array<(packet: NativeTransportPacket) => void> = []

  async send(frame: NativeTransportRequestFrame): Promise<void> {
    if (frame.channel === "handshake") {
      this.push({
        kind: "message",
        frame: {
          channel: "handshake",
          payload: {
            kind: "handshake-response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            ...generation,
            nativeBuildId: "native-build-1",
            capabilitySchemaVersion: "1",
            installRoot: "/tmp/native-window-fixture",
            process: { pid: 100, startedAt: capturedAt, nonce: "process-1" },
            capabilities: {
              schemaVersion: "1",
              scope: "adapter",
              producerRef: "native-window-fixture",
              capabilities: [],
            },
          },
        },
      })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "window.inventory") {
      this.push({
        kind: "message",
        frame: {
          channel: "response",
          payload: {
            kind: "response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            ...generation,
            ok: true,
            result: {
              sourceResponseRef: "inventory-response-1",
              inventoryId: "inventory-1",
              layoutRef: "native-1:layout:1",
              revision: 1,
              displayLayoutRevision: 1,
              capturedAt,
              complete: true,
              errors: [],
              applications: [{
                applicationRef: "application-1",
                registrationNonce: "app-1",
                pid: 42,
                launchedAt: capturedAt,
                name: "Fixture",
                bundleId: "dev.meta.fixture",
                hidden: "false",
                axStatus: "ready",
                windowCount: 2,
              }],
              windows: [{
                kind: "ax-window",
                windowRef: "window-1",
                applicationRef: "application-1",
                ownerPid: 42,
                cgWindowId: 900,
                title: "Документ",
                role: "AXWindow",
                subrole: "AXStandardWindow",
                frame: { x: 0, y: 0, width: 2200, height: 600 },
                applicationHidden: "false",
                minimized: "false",
                onScreen: "true",
                spaceVisibility: "current",
                fullscreen: "false",
                focused: "true",
                main: "true",
                mapping: "corroborated",
                axSnapshotRef: "ax-snapshot-1",
                cgInventoryRef: "cg-inventory-1",
                actionability: "ax",
                advertisedActions: ["raise", "close", "move", "resize"],
                surfaces: [{
                  kind: "sheet",
                  surfaceRef: "surface-1",
                  applicationRef: "application-1",
                  ownerWindowRef: "window-1",
                  ownerPid: 42,
                  title: "Сохранить",
                  role: "AXSheet",
                  subrole: "AXDialog",
                  frame: { x: 100, y: 100, width: 400, height: 300 },
                  focused: "true",
                  advertisedActions: ["close"],
                }],
              }, {
                kind: "cg-only",
                ownerPid: 42,
                cgWindowId: 901,
                title: "Несопоставленное",
                frame: { x: 900, y: 0, width: 200, height: 200 },
                onScreen: "false",
                spaceVisibility: "unknown",
                unavailableReason: "AX correlation отсутствует",
              }],
              displays: [{
                displayRef: "display-1",
                nativeDisplayId: 100,
                bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                usableBounds: { x: 0, y: 23, width: 1920, height: 1057 },
                scale: 2,
                rotationDegrees: 0,
                main: true,
              }, {
                displayRef: "display-2",
                nativeDisplayId: 101,
                bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
                usableBounds: { x: 1920, y: 23, width: 1920, height: 1057 },
                scale: 1,
                rotationDegrees: 0,
                main: false,
              }],
            },
          },
        },
      })
      return
    }
    if (frame.channel === "request" && frame.payload.method === "ax.inspect") {
      this.push({
        kind: "message",
        frame: {
          channel: "response",
          payload: {
            kind: "response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            ...generation,
            ok: true,
            result: {
              snapshotId: "snapshot-1",
              complete: true,
              nodeCount: 2,
              encodedBytes: 512,
              nodes: [{
                elementRef: "ax-node:1",
                role: "AXWindow",
                subrole: "AXStandardWindow",
                title: "Документ",
                identifier: "document-window",
                description: "Основное окно",
                value: 42,
                frame: { x: 10, y: 20, width: 0, height: 0 },
                actions: [],
              }, {
                elementRef: "ax-node:2",
                parentElementRef: "ax-node:1",
                role: "AXTextField",
                subrole: "AXSecureTextField",
                title: "Пароль",
                valueRedacted: true,
                actions: [],
              }],
              errors: [],
            },
          },
        },
      })
    }
  }

  async *packets(signal: AbortSignal): AsyncIterable<NativeTransportPacket> {
    while (!signal.aborted) {
      const packet = this.#packets.shift()
      if (packet !== undefined) {
        yield packet
        continue
      }
      yield await new Promise<NativeTransportPacket>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("fixture stopped"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.#waiters.push((value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
    }
  }

  async close(): Promise<void> {}

  push(packet: NativeTransportPacket): void {
    if (this.hidden && packet.kind === "message" && packet.frame.channel === "response" && packet.frame.payload.ok) {
      const inventory = nativeInventoryResultSchema.parse(packet.frame.payload.result)
      for (const window of inventory.windows) {
        if (window.kind !== "ax-window") continue
        delete window.cgWindowId
        delete window.axSnapshotRef
        delete window.cgInventoryRef
        window.mapping = "unavailable"
        window.mappingReason = "Скрытое AX окно без CG mapping"
        window.minimized = "true"
        window.applicationHidden = "true"
        window.onScreen = "false"
        window.spaceVisibility = "not-current"
      }
      packet.frame.payload.result = inventory
    }
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#packets.push(packet)
    else waiter(packet)
  }
}

function services(reports: NativeEvidenceReport[]): AdapterServices {
  return {
    clientSessions: { assertActive: async () => undefined },
    resources: {
      assertActive: async () => undefined,
      assertOwnedSet: async () => undefined,
    },
    cleanup: { verify: async () => undefined },
    targets: {
      resolve: async () => { throw new Error("target resolve не ожидался") },
    },
    proofs: { assertValid: async () => undefined },
    evidence: {
      async issueTargetResolution({ receipt, target }): Promise<ProofRef> {
        return {
          proofRef: `proof-${receipt.evidenceReceiptId}`,
          authorityRef: "evidence-authority-1",
          kind: target.kind === "window" ? "cg-ax-correlation" : "target-resolution",
          subject: target,
          ...generation,
          inventoryRevision: receipt.inventoryRevision,
          displayLayoutRevision: receipt.displayLayoutRevision,
          issuedAt: capturedAt,
          expiresAt: new Date(Date.parse(capturedAt) + 60_000).toISOString(),
        }
      },
      async issueWindowCorrelation({ receipt, target }): Promise<ProofRef> {
        return {
          proofRef: `proof-${receipt.evidenceReceiptId}`,
          authorityRef: "evidence-authority-1",
          kind: "cg-ax-correlation",
          subject: target,
          ...generation,
          inventoryRevision: receipt.inventoryRevision,
          displayLayoutRevision: receipt.displayLayoutRevision,
          issuedAt: capturedAt,
          expiresAt: new Date(Date.parse(capturedAt) + 60_000).toISOString(),
        }
      },
      issueFrameFreshness: async () => { throw new Error("frame proof не ожидался") },
      issueInteractionPoint: async () => { throw new Error("point proof не ожидался") },
    },
    frames: { publish: async () => undefined },
    observations: { resolvePoint: async () => { throw new Error("observation не ожидался") } },
    continuations: {
      issue: async () => { throw new Error("continuation не ожидался") },
      registerAcceptedTask: async () => { throw new Error("task registration не ожидался") },
      markVerifiedTerminal: async () => { throw new Error("terminal registration не ожидался") },
      advanceVerifiedStatus: async () => { throw new Error("status registration не ожидался") },
    },
    reservations: { assertChild: async () => { throw new Error("reservation не ожидался") } },
  }
}

describe("NativeWindowAdapter", () => {
  test("публикует CG-AX evidence и сохраняет surfaces/CG-only entries", async () => {
    const transport = new InventoryTransport()
    const reports: NativeEvidenceReport[] = []
    const extracted = new Map<string, readonly NativeEvidenceReport[]>()
    const native = new NativeBrokerAdapter({
      adapterInstanceRef: "native-adapter-1",
      host: {
        generation: {
          runtimeEpoch: generation.runtimeEpoch,
          loginSessionId: generation.loginSessionId,
        },
        runtimeBuildId: "runtime-build-1",
        capabilities: {
          schemaVersion: "1",
          scope: "adapter",
          producerRef: "runtime-fixture",
          capabilities: [],
        },
      },
      transport,
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
      bindEvidence: identity => ({
        sourceResponses: {
          register(sourceResponseRef, bytes) {
            extracted.set(sourceResponseRef, extractNativeEvidenceReports(bytes))
          },
        },
        publisher: {
          async publish(report): Promise<VerifiedNativeEvidenceReceipt> {
            expect(identity.loadedBuildId).toBe("native-build-1")
            expect(extracted.get(report.sourceResponseRef)?.some(candidate => structurallyEqual(candidate, report))).toBe(true)
            reports.push(report)
            return {
              evidenceReceiptId: `receipt-${reports.length}`,
              adapterInstanceRef: identity.adapterInstanceRef,
              backendBuildId: identity.loadedBuildId,
              ...generation,
              sourceResponseRef: report.sourceResponseRef,
              sourceResponseSha256: "0".repeat(64),
              inventoryId: report.inventoryId,
              inventoryRevision: report.inventoryRevision,
              displayLayoutRevision: report.displayLayoutRevision,
              observedAt: report.observedAt,
              factKind: report.factKind,
              factSha256: "1".repeat(64),
              issuedAt: capturedAt,
            }
          },
        },
      }),
    })
    await native.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    const adapter = new NativeWindowAdapter({ native, services: services(reports) })
    const inventory = await adapter.inventory({
      signal: new AbortController().signal,
      checkpoint: () => undefined,
    })
    expect(inventory.windows).toHaveLength(2)
    const window = inventory.windows[0]
    const unresolved = inventory.windows[1]
    expect(window?.kind).toBe("ax-window")
    if (window?.kind !== "ax-window") throw new Error("ожидалось AX window")
    expect(window.mapping).toBe("corroborated")
    expect(window.mappingEvidence?.proof.kind).toBe("cg-ax-correlation")
    expect(window.surfaces).toHaveLength(1)
    expect(window.surfaces[0]?.ref.ownerWindowRef).toBe("window-1")
    expect(unresolved?.kind).toBe("cg-only")
    if (unresolved?.kind !== "cg-only") throw new Error("ожидалось CG-only window")
    expect(unresolved.cgWindowId).toBe(901)
    expect(inventory.desktopLayout).toMatchObject({
      kind: "desktop-layout",
      target: {
        kind: "desktop-layout",
        ref: { layoutRef: "native-1:layout:1", displayLayoutRevision: 1 },
      },
    })
    expect(inventory.desktopLayout?.displays.map(display => display.nativeDisplayId)).toEqual([100, 101])
    expect(inventory.desktopLayout?.mappingEvidence.state).toBe("confirmed")
    if (inventory.desktopLayout?.mappingEvidence.state !== "confirmed") {
      throw new Error("ожидался authoritative desktop layout proof")
    }
    expect(inventory.desktopLayout.mappingEvidence.proof.kind).toBe("target-resolution")
    expect(reports.map(report => report.factKind)).toEqual([
      "target-resolution",
      "target-resolution",
      "target-resolution",
      "native-target-identity",
      "window-cg-ax-correlation",
      "native-target-identity",
    ])
    const windowReport = reports.find(report => report.factKind === "window-cg-ax-correlation")
    expect(windowReport?.factKind).toBe("window-cg-ax-correlation")
    if (windowReport?.factKind !== "window-cg-ax-correlation") {
      throw new Error("ожидался window mapping report")
    }
    expect(windowReport.mapping.displays.map(display => display.nativeDisplayId)).toEqual([100, 101])
    const inspected = await adapter.inspect({
      target: { kind: "window", ref: window.ref },
      depth: 2,
      maxNodes: 10,
      maxBytes: 4096,
    }, {
      signal: new AbortController().signal,
      checkpoint: () => undefined,
    })
    expect(inspected.nodes[0]).toMatchObject({
      identifier: "document-window",
      description: "Основное окно",
      value: 42,
      frame: { x: 10, y: 20, width: 0, height: 0 },
    })
    expect(inspected.nodes[1]).toMatchObject({
      valueRedacted: true,
      parentElementRef: {
        snapshotId: "snapshot-1",
        elementRef: "ax-node:1",
      },
    })
    await native.close()
  })

  test.each([false, true])("связывает exact native source с runtime, hidden=%s", async hidden => {
    const runtime = new RuntimeCore({
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-build-1",
      nativeGeneration: generation.nativeGeneration,
      nativeSourceIdentity: {
        adapterInstanceRef: "native-adapter-real-runtime",
        backendBuildId: "native-build-1",
        nativeGeneration: generation.nativeGeneration,
      },
    })
    const native = new NativeBrokerAdapter({
      adapterInstanceRef: "native-adapter-real-runtime",
      host: {
        generation: runtime.generation,
        runtimeBuildId: "runtime-build-1",
        capabilities: {
          schemaVersion: "1",
          scope: "adapter",
          producerRef: "runtime-window-integration",
          capabilities: [],
        },
      },
      transport: new InventoryTransport(hidden),
      ledgerSink: { persist: async () => { throw new Error("ledger не ожидался") } },
      bindEvidence: createRuntimeNativeEvidenceBinder(runtime.evidence),
    })
    await native.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-real-runtime",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-build-1",
      capabilitySchemaVersion: "1",
    })
    const inventory = await new NativeWindowAdapter({ native, services: runtime.services }).inventory({
      signal: new AbortController().signal,
      checkpoint: () => undefined,
    })
    expect(inventory.desktopLayout?.mappingEvidence.state).toBe("confirmed")
    if (inventory.desktopLayout === undefined) throw new Error("Authoritative desktop layout отсутствует")
    const layoutResolution = await runtime.targets.resolve({
      target: inventory.desktopLayout.target,
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration: generation.nativeGeneration,
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    })
    expect(layoutResolution.nativeMapping).toEqual({
      kind: "desktop-layout",
      displays: inventory.desktopLayout.displays.map(display => ({
        nativeDisplayId: display.nativeDisplayId,
        ref: display.target.ref,
      })),
    })
    const window = inventory.windows.find(entry => entry.kind === "ax-window")
    expect(window?.kind).toBe("ax-window")
    if (window?.kind !== "ax-window") throw new Error("AX window отсутствует")
    expect(window.mappingEvidence?.proof.kind).toBe(hidden ? undefined : "cg-ax-correlation")
    const resolution = await runtime.targets.resolve({
      target: { kind: "window", ref: window.ref },
      inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      nativeGeneration: generation.nativeGeneration,
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    })
    expect(resolution.nativeMapping?.kind).toBe(hidden ? undefined : "window")
    const surface = window.surfaces[0]!
    const surfaceResolution = await runtime.targets.resolve({
      target: { kind: "surface", ref: surface.ref }, inventoryId: inventory.inventoryId,
      inventoryRevision: inventory.revision, ...generation, deadlineAt: new Date(Date.now() + 1000).toISOString(),
    })
    expect(surfaceResolution.nativeMapping).toBeUndefined()
    await expect(runtime.targets.resolve({
      target: { kind: "window", ref: { ...window.ref, windowRef: "window-foreign" } },
      inventoryId: inventory.inventoryId, inventoryRevision: inventory.revision, ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
    })).rejects.toThrow("не зарегистрирован")
    await native.close()
  })
})
