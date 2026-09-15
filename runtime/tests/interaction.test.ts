import { describe, expect, test } from "bun:test"
import type {
  AdapterResult,
  NativeAdapter,
  NativeExecutionContext,
  NativeOperationTarget,
  ObservedEvent,
  ObserverCoverage,
  RuntimeOperationContext,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import {
  RuntimeInteractionAuthority,
  type InteractionEndValue,
  type InteractionFocusReceipt,
  type InteractionFocusSnapshot,
  type InteractionFocusValue,
  type InteractionNativeBinding,
} from "../src/interaction.ts"
import type { RuntimeClock, RuntimeIdSource } from "../src/primitives.ts"

const generation = {
  runtimeEpoch: "runtime:interaction",
  loginSessionId: "login:interaction",
}
const nativeGeneration = "native:interaction"

class FakeClock implements RuntimeClock {
  value = new Date("2026-09-15T10:00:00.000Z")

  now(): Date {
    return new Date(this.value)
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds)
  }
}

class FakeIds implements RuntimeIdSource {
  count = 0

  next(prefix: string): string {
    return `${prefix}:${++this.count}`
  }
}

class EventQueue {
  readonly values: ObservedEvent[] = []
  readonly waiters: Array<(event: ObservedEvent) => void> = []

  push(event: ObservedEvent): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(event)
    else waiter(event)
  }

  async *iterate(signal: AbortSignal): AsyncIterable<ObservedEvent> {
    while (!signal.aborted) {
      const event = this.values.shift() ?? await new Promise<ObservedEvent>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("event queue aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.waiters.push(value => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
      yield event
    }
  }

  async *hang(): AsyncIterable<ObservedEvent> {
    await new Promise<never>(() => undefined)
  }
}

function fixture(options: {
  previousFocus?: InteractionFocusSnapshot
  receiptTransform?: (receipt: InteractionFocusReceipt) => InteractionFocusReceipt
  beginGate?: Promise<void>
  hungEvents?: boolean
  hungSyntheticOwnership?: boolean
  hungReceiptVerification?: boolean
  observerRequestMs?: number
  closeMs?: number
} = {}) {
  const clock = new FakeClock()
  const ids = new FakeIds()
  let lastContext: RuntimeOperationContext<NativeExecutionContext> | undefined
  const native = {
    async status(request: { requestId: string }) {
      if (lastContext === undefined) throw new Error("Native operation не запускалась")
      const timestamp = clock.now().toISOString()
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
        lastCheckpoint: "interaction-fixture-finished",
        dispatchAttempts: 1,
        ledgerRevision: 1,
        observer: unavailableCoverage(clock),
      }
    },
  } as unknown as NativeAdapter
  const core = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:interaction",
    native,
    nativeGeneration,
    clock,
    ids,
  })
  const target = windowTarget("target")
  const previousTarget = windowTarget("previous")
  core.targets.register(target, "inventory:interaction", 1, "resolution:interaction", "proof:interaction", 1, undefined, 120_000)
  const events = new EventQueue()
  const coverageStartedAt = new Date(clock.now().getTime() - 1_000)
  let coverageState: "ready" | "unavailable" = "ready"
  let beginCalls = 0
  let endCalls = 0
  const restoreAllowedValues: boolean[] = []
  let nextCoverageGate: {
    promise: Promise<ObserverCoverage>
    resolve: (coverage: ObserverCoverage) => void
    started: () => void
  } | undefined
  const binding: InteractionNativeBinding = {
    bindingRef: "binding:interaction",
    nativeGeneration,
    async beginFocus(context, request) {
      beginCalls++
      await options.beginGate
      lastContext = context
      const coverage = coverageState === "ready" ? readyCoverage(clock, coverageStartedAt) : unavailableCoverage(clock)
      const previousFocus = options.previousFocus ?? {
        state: "known" as const,
        target: previousTarget,
        proofRef: "proof:previous-focus",
      }
      const receipt: InteractionFocusReceipt = {
        receiptId: `focus-receipt:${beginCalls}`,
        bindingRef: "binding:interaction",
        ...generation,
        nativeGeneration,
        operationId: context.wire.operationId,
        requestedTarget: request.target,
        actualTarget: request.target,
        previousFocus,
        focusProofRef: "proof:focused-target",
        observerCoverage: coverage,
        startedAt: clock.now().toISOString(),
      }
      return {
        result: completed(context, {
          requestedTarget: request.target,
          actualTarget: request.target,
          previousFocus,
          focusProofRef: receipt.focusProofRef,
        }),
        receipt: options.receiptTransform?.(receipt) ?? receipt,
      }
    },
    async observerCoverage() {
      const gate = nextCoverageGate
      if (gate !== undefined) {
        nextCoverageGate = undefined
        gate.started()
        return await gate.promise
      }
      return coverageState === "ready" ? readyCoverage(clock, coverageStartedAt) : unavailableCoverage(clock)
    },
    events(signal) {
      return options.hungEvents ? events.hang() : events.iterate(signal)
    },
    async ownsSyntheticEvent(_receipt, event) {
      if (options.hungSyntheticOwnership) return await new Promise<boolean>(() => undefined)
      return event.syntheticTag === "synthetic:own"
    },
    async verifyFocusReceipt() {
      if (options.hungReceiptVerification) await new Promise<void>(() => undefined)
    },
    async endRestore(context, request) {
      endCalls++
      lastContext = context
      restoreAllowedValues.push(request.restoreAllowed)
      const value: InteractionEndValue = request.restoreAllowed
        ? {
            restoration: "restored",
            currentFocus: target,
            restoredFocus: previousTarget,
          }
        : {
            restoration: "skipped-external-change",
            currentFocus: target,
          }
      return completed(context, value)
    },
  }
  const authority = new RuntimeInteractionAuthority({
    core,
    binding,
    now: clock,
    ids,
    observerRequestMs: options.observerRequestMs,
    closeMs: options.closeMs,
  })
  const client = core.openClient("principal:interaction")
  return {
    authority,
    beginCalls: () => beginCalls,
    client,
    clock,
    core,
    endCalls: () => endCalls,
    events,
    deferCoverage() {
      let resolve!: (coverage: ObserverCoverage) => void
      let started!: () => void
      const promise = new Promise<ObserverCoverage>(done => { resolve = done })
      const startedPromise = new Promise<void>(done => { started = done })
      nextCoverageGate = { promise, resolve, started }
      return {
        started: startedPromise,
        resolve: () => resolve(readyCoverage(clock, coverageStartedAt)),
      }
    },
    restoreAllowedValues,
    setCoverage: (state: "ready" | "unavailable") => { coverageState = state },
    target,
  }
}

function windowTarget(suffix: string): NativeOperationTarget {
  return {
    kind: "window",
    ref: {
      ...generation,
      nativeGeneration,
      applicationRef: `application:${suffix}`,
      windowRef: `window:${suffix}`,
    },
  }
}

function readyCoverage(
  clock: FakeClock,
  startedAt = new Date(clock.now().getTime() - 1_000),
): ObserverCoverage {
  const now = clock.now()
  return {
    state: "ready",
    ...generation,
    nativeGeneration,
    coverageStartCursor: "cursor:start",
    cursor: "cursor:current",
    nextSequence: 2,
    startedAt: startedAt.toISOString(),
    coveredFrom: startedAt.toISOString(),
    coveredThrough: now.toISOString(),
    heartbeatAt: now.toISOString(),
    coveredKinds: ["input", "focus"],
    droppedEvents: 0,
    gapDetected: false,
  }
}

function unavailableCoverage(clock: FakeClock): ObserverCoverage {
  const now = clock.now().toISOString()
  return {
    state: "unavailable",
    ...generation,
    nativeGeneration,
    coverageStartCursor: "cursor:unavailable",
    cursor: "cursor:unavailable",
    nextSequence: 1,
    startedAt: now,
    coveredFrom: now,
    coveredThrough: now,
    heartbeatAt: now,
    coveredKinds: [],
    droppedEvents: 0,
    gapDetected: false,
    reason: "fixture observer unavailable",
  }
}

function completed<T>(
  context: RuntimeOperationContext<NativeExecutionContext>,
  value: T,
): AdapterResult<T> {
  return {
    ok: true,
    value,
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
}

function event(
  kind: "input" | "focus" | "lifecycle",
  source: "synthetic" | "external-user" | "unknown",
  syntheticTag?: string,
): ObservedEvent {
  return {
    eventId: `event:${kind}:${source}:${syntheticTag ?? "none"}`,
    ...generation,
    nativeGeneration,
    cursor: `cursor:${kind}:${source}`,
    sequence: 1,
    observedAt: "2026-09-15T10:00:01.000Z",
    kind,
    source,
    ...(syntheticTag === undefined ? {} : { syntheticTag }),
    ...(kind === "lifecycle" ? { lifecycle: "sleep" as const } : {}),
  }
}

async function begin(value: ReturnType<typeof fixture>, requestId = "request:begin") {
  return await value.authority.begin(value.client.session, {
    clientRequestId: requestId,
    target: value.target,
    inventoryId: "inventory:interaction",
    inventoryRevision: 1,
  })
}

describe("C3 runtime interaction authority", () => {
  test("begin сохраняет immutable host receipt после verified operation и не держит resource", async () => {
    const value = fixture()
    const interaction = await begin(value)

    expect(interaction).toMatchObject({
      state: "active",
      receipt: {
        bindingRef: "binding:interaction",
        requestedTarget: value.target,
        actualTarget: value.target,
        previousFocus: { state: "known" },
      },
      operation: { state: "completed", outcome: { cleanup: { state: "complete" } } },
    })
    expect(value.core.resources.handlesForOperation(interaction.operation.context.operationId)).toEqual([])
    const mutableReceipt = interaction.receipt as { focusProofRef: string }
    expect(() => { mutableReceipt.focusProofRef = "forged" }).toThrow()
    const repeated = await begin(value)
    expect(repeated).toEqual(interaction)
    expect(value.beginCalls()).toBe(1)
    await value.authority.close()
  })

  test("runStep сам освобождает token и продлевает только continuous coverage", async () => {
    const value = fixture()
    const interaction = await begin(value)
    value.clock.advance(20_000)
    const result = await value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async signal => ({ aborted: signal.aborted }),
    )

    expect(result).toEqual({ aborted: false })
    value.setCoverage("unavailable")
    await expect(value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )).rejects.toMatchObject({ contract: { code: "user-interference" } })
    await expect(value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    await value.authority.close()
  })

  test("recheck запрещает step, если event отозвал interaction во время coverage await", async () => {
    const value = fixture()
    const interaction = await begin(value)
    const gate = value.deferCoverage()
    let callbacks = 0
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => ++callbacks,
    )
    await gate.started
    value.events.push(event("focus", "external-user"))
    await Bun.sleep(0)
    gate.resolve()

    await expect(step).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    expect(callbacks).toBe(0)
    await value.authority.close()
  })

  test("recheck запрещает step после expiry во время coverage await", async () => {
    const value = fixture()
    const interaction = await begin(value)
    const gate = value.deferCoverage()
    let callbacks = 0
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => ++callbacks,
    )
    await gate.started
    value.clock.advance(30_001)
    gate.resolve()

    await expect(step).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    expect(callbacks).toBe(0)
    await value.authority.close()
  })

  test("caller abort во время coverage await не вызывает callback и не продлевает session", async () => {
    const value = fixture({ observerRequestMs: 20 })
    const interaction = await begin(value)
    const gate = value.deferCoverage()
    const controller = new AbortController()
    let callbacks = 0
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      controller.signal,
      async () => ++callbacks,
    )
    await gate.started
    controller.abort("caller cancelled")

    await expect(step).rejects.toMatchObject({ contract: { code: "cancelled" } })
    expect(callbacks).toBe(0)
    gate.resolve()
    expect(await value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "next",
    )).toBe("next")
    await value.authority.close()
  })

  test("foreign synthetic event отзывает и aborts in-flight step; own synthetic не отзывает", async () => {
    const value = fixture()
    const interaction = await begin(value)
    let stepSignal: AbortSignal | undefined
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async signal => {
        stepSignal = signal
        return await new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("step aborted")), { once: true })
          void resolve
        })
      },
    )
    while (stepSignal === undefined) await Bun.sleep(0)
    value.events.push(event("input", "synthetic", "synthetic:own"))
    await Bun.sleep(0)
    expect(stepSignal.aborted).toBe(false)
    value.events.push(event("focus", "synthetic", "synthetic:foreign"))
    await expect(step).rejects.toThrow("step aborted")
    expect(stepSignal.aborted).toBe(true)
    const repeated = await begin(value)
    expect(repeated).toMatchObject({
      state: "revoked",
      tombstone: { state: "revoked", interactionId: interaction.interactionId },
    })
    expect(value.beginCalls()).toBe(1)
    await value.authority.close()
  })

  test("idle expiry запрещает следующий step без автоматического restore", async () => {
    const value = fixture()
    const interaction = await begin(value)
    value.clock.advance(30_001)

    await expect(value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    expect(value.endCalls()).toBe(0)
    await value.authority.close()
  })

  test("hard expiry не продлевается последовательными step", async () => {
    const value = fixture()
    const interaction = await begin(value)
    for (let index = 0; index < 5; index++) {
      value.clock.advance(20_000)
      await value.authority.runStep(
        value.client.session,
        interaction.interactionId,
        value.target,
        undefined,
        async () => undefined,
      )
    }
    value.clock.advance(20_001)

    await expect(value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    await value.authority.close()
  })

  test("receipt другой begin operation не становится interaction authority", async () => {
    const value = fixture({
      receiptTransform: receipt => ({ ...receipt, operationId: "operation:foreign" }),
    })

    await expect(begin(value)).rejects.toMatchObject({ contract: { code: "proof-invalid" } })
    await expect(begin(value)).rejects.toMatchObject({ contract: { code: "proof-invalid" } })
    expect(value.beginCalls()).toBe(1)
    await value.authority.close()
  })

  test("pending lineage reservation отклоняет второй concurrent begin", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const value = fixture({ beginGate: gate })
    const first = begin(value, "request:begin-first")
    while (value.beginCalls() === 0) await Bun.sleep(0)

    await expect(begin(value, "request:begin-second")).rejects.toMatchObject({
      contract: { code: "operation-in-progress" },
    })
    release()
    await expect(first).resolves.toMatchObject({ state: "active" })
    expect(value.beginCalls()).toBe(1)
    await value.authority.close()
  })

  test("hung observer coverage и event stream завершаются bounded revoke/close", async () => {
    const value = fixture({ hungEvents: true, observerRequestMs: 5, closeMs: 5 })
    const interaction = await begin(value)
    const gate = value.deferCoverage()
    const started = performance.now()
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )
    await gate.started
    await expect(step).rejects.toMatchObject({ contract: { code: "user-interference" } })
    await value.authority.close()
    expect(performance.now() - started).toBeLessThan(100)
    gate.resolve()
  })

  test("hung synthetic ownership check bounded отзывает active step", async () => {
    const value = fixture({ hungSyntheticOwnership: true, observerRequestMs: 5 })
    const interaction = await begin(value)
    const started = performance.now()
    const step = value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async signal => await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ownership check revoked")), { once: true })
      }),
    )
    value.events.push(event("input", "synthetic", "synthetic:unknown-owner"))

    await expect(step).rejects.toThrow("ownership check revoked")
    expect(performance.now() - started).toBeLessThan(100)
    await value.authority.close()
  })

  test("hung runtime focus receipt verifier не создаёт interaction", async () => {
    const value = fixture({ hungReceiptVerification: true, observerRequestMs: 5 })
    const started = performance.now()

    await expect(begin(value)).rejects.toMatchObject({ contract: { code: "proof-invalid" } })
    expect(performance.now() - started).toBeLessThan(100)
    expect(value.beginCalls()).toBe(1)
    await value.authority.close()
  })

  test("host может отозвать waiting interaction при disconnect client session", async () => {
    const value = fixture()
    const interaction = await begin(value)
    value.authority.revokeClientSession(value.client.session.clientSessionId)

    await expect(value.authority.runStep(
      value.client.session,
      interaction.interactionId,
      value.target,
      undefined,
      async () => "never",
    )).rejects.toMatchObject({ contract: { code: "lease-revoked" } })
    const repeated = await begin(value)
    expect(repeated).toMatchObject({ state: "revoked", tombstone: { reason: "client disconnected" } })
    await value.authority.close()
  })

  test("end передаёт restore advisory только при known previous focus и safe coverage", async () => {
    const value = fixture()
    const interaction = await begin(value)
    const ended = await value.authority.end(value.client.session, {
      clientRequestId: "request:end",
      interactionId: interaction.interactionId,
    })
    const repeated = await value.authority.end(value.client.session, {
      clientRequestId: "request:end",
      interactionId: interaction.interactionId,
    })

    expect(value.restoreAllowedValues).toEqual([true])
    expect(ended).toMatchObject({
      state: "ended",
      tombstone: { state: "ended", interactionId: interaction.interactionId },
      operation: { state: "completed" },
    })
    expect(repeated).toEqual(ended)
    expect(value.endCalls()).toBe(1)
    await value.authority.close()

    const unknown = fixture({ previousFocus: { state: "unknown", reason: "frontmost unavailable" } })
    const unknownInteraction = await begin(unknown)
    const skipped = await unknown.authority.end(unknown.client.session, {
      clientRequestId: "request:end-unknown",
      interactionId: unknownInteraction.interactionId,
    })
    expect(unknown.restoreAllowedValues).toEqual([false])
    expect(skipped.state).toBe("revoked")
    await unknown.authority.close()
  })
})
