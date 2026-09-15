import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  type AdapterResult,
  type CapabilityId,
  type NativeAdapter,
  type NativeExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import type { DesktopInputAdapter } from "@meta/input/adapter"
import type { InputAction, InputActionResult } from "@meta/input/actions"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import {
  INPUT_METHOD_GAPS,
  INPUT_METHOD_BUDGETS,
  keyboardInputPreconditionSchema,
  pointerInputPreconditionSchema,
  registerInputMethods,
} from "../src/input-methods.ts"

const generation = {
  runtimeEpoch: "runtime:input-methods",
  loginSessionId: "login:input-methods",
}
const nativeGeneration = "native:input-methods"

function readyCapabilities() {
  const ready = new Set<CapabilityId>([
    "runtime.identity",
    "runtime.transport",
    "runtime.arbitration",
    "runtime.operations",
    "desktop.applications",
    "desktop.windows.all",
    "desktop.window.identity",
    "capture.observation",
    "input.pointer",
    "input.drag",
    "input.keyboard",
  ])
  return capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:input-methods",
    capabilities: CAPABILITY_IDS.map(id => ready.has(id)
      ? { id, state: "ready" }
      : { id, state: "unavailable", reason: "fixture capability отключена" }),
  })
}

function fixture(options: { now?: () => Date } = {}) {
  let lastContext: RuntimeOperationContext<NativeExecutionContext> | undefined
  const native = {
    async status(request: { requestId: string }) {
      if (lastContext === undefined) throw new Error("Fixture input operation не запускалась")
      const timestamp = new Date().toISOString()
      return {
        requestId: request.requestId,
        ...generation,
        nativeGeneration,
        highWaterFence: lastContext.wire.fence,
        acceptedFence: lastContext.wire.fence,
        operationId: lastContext.wire.operationId,
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
          startedAt: timestamp,
          coveredFrom: timestamp,
          coveredThrough: timestamp,
          heartbeatAt: timestamp,
          coveredKinds: [],
          droppedEvents: 0,
          gapDetected: false,
          reason: "Fixture observer отключён",
        },
      }
    },
  } as unknown as NativeAdapter
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:input-methods",
    native,
    nativeGeneration,
  })
  const target = {
    kind: "window",
    ref: {
      ...generation,
      nativeGeneration,
      applicationRef: "application:input-methods",
      windowRef: "window:input-methods",
    },
  } as const
  core.targets.register(
    target,
    "inventory:input-methods",
    1,
    "resolution:input-methods",
    "proof:input-methods",
    1,
  )
  let calls = 0
  const input = {
    async execute(
      context: RuntimeOperationContext<NativeExecutionContext>,
      action: InputAction,
    ): Promise<AdapterResult<InputActionResult>> {
      calls++
      lastContext = context
      return {
        ok: true,
        value: {
          kind: action.kind,
          dispatchedUnits: 1,
          destinationPoints: [],
          ownershipProofRefs: [],
        },
        outcome: {
          dispatch: "finished",
          targetVerified: "verified",
          userInterference: "unknown",
          observation: "unavailable",
          effect: { state: "unverified", proofRefs: [] },
          cleanup: {
            scope: "owned",
            state: "complete",
            resources: context.resources.map(handle => ({ handle, outcome: "released" })),
          },
          restoration: "not-applicable",
          dispatchAttempts: 1,
        },
      }
    },
  } as unknown as DesktopInputAdapter
  const registry = new MethodRegistry(core)
  registerInputMethods(registry, core, input, options)
  return { calls: () => calls, core, input, registry, target }
}

describe("C3 runtime input method catalogue", () => {
  test("не публикует methods до end-to-end capability readiness", () => {
    const value = fixture()

    expect(value.registry.descriptors().tools).toEqual([])
  })

  test("публикует семь action methods с object schemas, но не readiness/interaction placeholders", () => {
    const value = fixture()
    value.core.updateCapabilities(readyCapabilities())
    const tools = value.registry.descriptors().tools

    expect(tools.map(tool => tool.name)).toEqual([
      "mouse_move",
      "mouse_click",
      "mouse_scroll",
      "mouse_drag",
      "keyboard_type",
      "keyboard_key",
      "keyboard_shortcut",
    ])
    expect(tools.every(tool => tool.inputSchema.type === "object" && tool.outputSchema.type === "object")).toBe(true)
    expect(tools.every(tool => tool.annotations.destructiveHint && !tool.annotations.readOnlyHint)).toBe(true)
    expect(INPUT_METHOD_GAPS).toHaveProperty("input_readiness")
    expect(INPUT_METHOD_GAPS).toHaveProperty("begin_interaction")
    expect(INPUT_METHOD_GAPS).toHaveProperty("end_interaction")
  })

  test("keyboard_type проходит Runtime authority и возвращает operation receipt без текста", async () => {
    const value = fixture()
    value.core.updateCapabilities(readyCapabilities())
    const client = value.core.openClient("principal:input-methods")
    const request = {
      clientRequestId: "request:keyboard-type",
      precondition: {
        target: value.target,
        inventoryId: "inventory:input-methods",
        inventoryRevision: 1,
      },
      action: { kind: "text", text: "секретный текст", delayMs: 0 },
    } as const
    const first = await value.registry.dispatch(
      client.session,
      "keyboard_type",
      request,
      new AbortController().signal,
    )
    const repeated = await value.registry.dispatch(
      client.session,
      "keyboard_type",
      request,
      new AbortController().signal,
    )

    expect(first.data).toMatchObject({
      operation: {
        state: "completed",
        context: { kind: "native", target: value.target },
        payloadReceipt: { hmacSha256: expect.any(String) },
      },
      result: { ok: true, value: { kind: "text", dispatchedUnits: 1 } },
    })
    expect(first.frameRefs).toEqual([])
    expect(JSON.stringify(first.data)).not.toContain("секретный текст")
    expect(repeated.data.operation).toEqual(first.data.operation)
    expect(value.calls()).toBe(1)
  })

  test("pointer schema требует observationRef и exact action leaf", async () => {
    const value = fixture()
    value.core.updateCapabilities(readyCapabilities())
    const client = value.core.openClient("principal:pointer-schema")
    const input = {
      clientRequestId: "request:pointer",
      precondition: {
        target: value.target,
        inventoryId: "inventory:input-methods",
        inventoryRevision: 1,
      },
      action: { kind: "hover", point: { x: 10, y: 20 } },
    }

    await expect(value.registry.dispatch(
      client.session,
      "mouse_move",
      input,
      new AbortController().signal,
    )).rejects.toThrow()
    await expect(value.registry.dispatch(
      client.session,
      "mouse_click",
      {
        ...input,
        precondition: {
          ...input.precondition,
          observationRef: {
            observationId: "observation:1",
            inventoryRevision: 1,
            displayLayoutRevision: 1,
            proofRef: "proof:observation:1",
          },
        },
      },
      new AbortController().signal,
    )).rejects.toThrow()
    expect(value.calls()).toBe(0)
  })

  test("public input targets не рекламируют unretained element или application focus", () => {
    const value = fixture()
    const observationRef = {
      observationId: "observation:target-scope",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      proofRef: "proof:target-scope",
    }
    const element = {
      kind: "element" as const,
      ref: {
        ...generation,
        nativeGeneration,
        applicationRef: "application:scope",
        elementRef: "element:scope",
        snapshotId: "snapshot:scope",
      },
    }
    const application = {
      kind: "application" as const,
      ref: {
        ...generation,
        nativeGeneration,
        applicationRef: "application:scope",
        pid: 100,
        launchedAt: "2026-09-15T10:00:00.000Z",
        registrationNonce: "registration:scope",
      },
    }

    expect(pointerInputPreconditionSchema.safeParse({
      target: element,
      inventoryId: "inventory:input-methods",
      inventoryRevision: 1,
      observationRef,
    }).success).toBe(false)
    expect(keyboardInputPreconditionSchema.safeParse({
      target: application,
      inventoryId: "inventory:input-methods",
      inventoryRevision: 1,
    }).success).toBe(false)
    expect(pointerInputPreconditionSchema.safeParse({
      target: {
        kind: "display",
        ref: {
          ...generation,
          nativeGeneration,
          displayRef: "display:scope",
          displayLayoutRevision: 1,
        },
      },
      inventoryId: "inventory:input-methods",
      inventoryRevision: 1,
      observationRef,
    }).success).toBe(true)
    expect(value.calls()).toBe(0)
  })

  test("near-max actions получают отдельные operation и method margins без ожидания", async () => {
    const startedAt = new Date()
    const value = fixture({ now: () => startedAt })
    value.core.updateCapabilities(readyCapabilities())
    const client = value.core.openClient("principal:near-max")
    const text = await value.registry.dispatch(
      client.session,
      "keyboard_type",
      {
        clientRequestId: "request:near-max-text",
        precondition: {
          target: value.target,
          inventoryId: "inventory:input-methods",
          inventoryRevision: 1,
        },
        action: { kind: "text", text: "1234567", delayMs: 5_000 },
      },
      new AbortController().signal,
    )
    const drag = await value.registry.dispatch(
      client.session,
      "mouse_drag",
      {
        clientRequestId: "request:near-max-drag",
        precondition: {
          target: value.target,
          inventoryId: "inventory:input-methods",
          inventoryRevision: 1,
          observationRef: {
            observationId: "observation:near-max",
            inventoryRevision: 1,
            displayLayoutRevision: 1,
            proofRef: "proof:observation:near-max",
          },
        },
        action: {
          kind: "drag",
          points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
          durationMs: 5_000,
          button: "left",
          modifiers: [],
        },
      },
      new AbortController().signal,
    )

    const textOperation = text.data.operation as { context: { deadlineAt: string } }
    const dragOperation = drag.data.operation as { context: { deadlineAt: string } }
    expect(Date.parse(textOperation.context.deadlineAt) - startedAt.getTime()).toBe(33_000)
    expect(Date.parse(dragOperation.context.deadlineAt) - startedAt.getTime()).toBe(8_000)
    expect(INPUT_METHOD_BUDGETS.typing).toEqual({ actionMs: 30_000, operationMs: 33_000, methodMs: 35_000 })
    expect(INPUT_METHOD_BUDGETS.short).toEqual({ actionMs: 5_000, operationMs: 8_000, methodMs: 10_000 })
  })
})
