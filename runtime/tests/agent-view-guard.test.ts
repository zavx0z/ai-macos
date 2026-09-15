import { expect, test } from "bun:test"
import {
  operationRecordSchema,
  type ObservedEvent,
  type ObserverCoverage,
  type OperationRecord,
} from "@meta/shared/contracts"
import { AgentViewGuard, type AgentSyntheticOwner, type AgentViewObserver, type AgentViewTarget } from "../src/agent-view-guard.ts"

const generation = {
  runtimeEpoch: "runtime:view",
  loginSessionId: "login:view",
  nativeGeneration: "native:view",
}
const target = windowTarget("window:view")

test("fresh observe выдаёт explicit Native admission proof и одноразовый ticket", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:view")
  const ticket = await observe(value, "lineage:view", "target:view", target)
  const proof = await scope.admit(ticket, "operation:view", "ui-action")
  expect(proof).toEqual({
    viewNonce: "agent-view:1",
    targetId: "target:view",
    operationId: "operation:view",
    mode: "ui-action",
    observerInstanceRef: "observer:view",
    expectedCoverageStartCursor: "observer:view:start",
    baselineCursor: "observer:view:start",
    baselineNextSequence: 1,
    observedCursor: "observer:view:start",
    observedNextSequence: 1,
    admissionCursor: "observer:view:start",
    admissionNextSequence: 1,
    expiresAt: "2026-09-15T10:00:30.000Z",
  })
  await expect(scope.admit(ticket, "operation:replay", "ui-action")).rejects.toThrow("consumed")
  await value.guard.close()
})

test("external input, focus, relevant structure и lifecycle инвалидируют view", async () => {
  for (const event of [
    { kind: "input", source: "external-user" },
    { kind: "focus", source: "unknown" },
    { kind: "window-structure", source: "unknown", target },
    { kind: "lifecycle", source: "unknown", lifecycle: "lock" },
  ] as const) {
    const value = fixture()
    const scope = value.guard.forLineage("lineage:event")
    const ticket = await observe(value, "lineage:event", "target:event", target)
    value.observer.push(event)
    await expect(scope.admit(ticket, "operation:event", "ui-action")).rejects.toThrow()
    await value.guard.close()
  }
})

test("false synthetic ownership и other-lineage action инвалидируют latch", async () => {
  const unowned = fixture()
  const unownedScope = unowned.guard.forLineage("lineage:unowned")
  const unownedTicket = await observe(unowned, "lineage:unowned", "target:unowned", target)
  unowned.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:false" })
  await expect(unownedScope.admit(unownedTicket, "operation:after-false", "ui-action")).rejects.toThrow()
  await unowned.guard.close()

  const value = fixture()
  const first = value.guard.forLineage("lineage:first")
  const second = value.guard.forLineage("lineage:second")
  const firstTicket = await observe(value, "lineage:first", "target:first", target)
  const secondTicket = await observe(value, "lineage:second", "target:second", windowTarget("window:second"))
  const siblingTicket = await observe(value, "lineage:first", "target:sibling", windowTarget("window:sibling"))
  await first.admit(firstTicket, "operation:first", "ui-action")
  await expect(second.admit(secondTicket, "operation:second-before-event", "ui-action")).rejects.toThrow("consumed")
  await expect(first.admit(siblingTicket, "operation:sibling-before-event", "ui-action")).rejects.toThrow("consumed")
  value.owners.set("synthetic:first", {
    operationId: "operation:first",
    lineageId: "lineage:first",
    targetId: "target:first",
  })
  value.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:first" })
  await expect(second.admit(secondTicket, "operation:second", "ui-action")).rejects.toThrow()
  await expect(first.admit(siblingTicket, "operation:sibling", "ui-action")).rejects.toThrow()
  await value.guard.close()
})

test("old draft и ticket cancellation не затрагивают новый successful view", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:replacement")
  value.bind("lineage:replacement", "target:replacement", target)
  const oldDraft = await scope.beginObservation("target:replacement", target)
  scope.cancelObservation(oldDraft)
  const oldTicket = await observe(value, "lineage:replacement", "target:replacement", target)
  const nextDraft = await scope.beginObservation("target:replacement", target)
  const nextTicket = await scope.commitObservation(nextDraft)
  scope.invalidateView(oldTicket, "Old caller cancelled")
  await expect(scope.admit(nextTicket, "operation:replacement", "ui-action")).resolves.toMatchObject({
    targetId: "target:replacement",
  })
  await value.guard.close()
})

test("terminal operation с foreign exact target отвергается", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:terminal-target")
  const ticket = await observe(value, "lineage:terminal-target", "target:terminal-target", target)
  await scope.admit(ticket, "operation:terminal-target", "ui-action")
  await expect(scope.settleOperation(
    ticket,
    operation("operation:terminal-target", windowTarget("window:foreign"), "completed"),
  )).rejects.toThrow("другой exact target")
  await value.guard.close()
})

test("target binding, synthetic event target и terminal verification проверяются независимо", async () => {
  const mismatched = fixture()
  const mismatchScope = mismatched.guard.forLineage("lineage:mismatch")
  mismatched.bind("lineage:mismatch", "target:a", target)
  await expect(mismatchScope.beginObservation(
    "target:a",
    windowTarget("window:b"),
  )).rejects.toThrow("trusted exact target binding")
  await mismatched.guard.close()

  const foreignEvent = fixture()
  const foreignScope = foreignEvent.guard.forLineage("lineage:foreign-event")
  const foreignTicket = await observe(foreignEvent, "lineage:foreign-event", "target:foreign-event", target)
  await foreignScope.admit(foreignTicket, "operation:foreign-event", "keyboard")
  foreignEvent.owners.set("synthetic:foreign-target", {
    operationId: "operation:foreign-event",
    lineageId: "lineage:foreign-event",
    targetId: "target:foreign-event",
  })
  foreignEvent.observer.push({
    kind: "input",
    source: "synthetic",
    syntheticTag: "synthetic:foreign-target",
    target: windowTarget("window:b"),
  })
  await expect(foreignScope.createKeyboardContinuation(
    foreignTicket,
    operation("operation:foreign-event", target, "completed"),
  )).rejects.toThrow("positive terminal")
  await foreignEvent.guard.close()

  const unverified = fixture()
  const unverifiedScope = unverified.guard.forLineage("lineage:unverified")
  const unverifiedTicket = await observe(unverified, "lineage:unverified", "target:unverified", target)
  await unverifiedScope.admit(unverifiedTicket, "operation:unverified", "keyboard")
  unverified.owners.set("synthetic:unverified", {
    operationId: "operation:unverified",
    lineageId: "lineage:unverified",
    targetId: "target:unverified",
  })
  unverified.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:unverified", target })
  await expect(unverifiedScope.createKeyboardContinuation(
    unverifiedTicket,
    operation("operation:unverified", target, "completed", "unknown"),
  )).rejects.toThrow("positive terminal")
  await unverified.guard.close()
})

test("keyboard continuation требует exact positive terminal Core operation и own input events only", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:keyboard")
  const ticket = await observe(value, "lineage:keyboard", "target:keyboard", target)
  await scope.admit(ticket, "operation:keyboard:1", "keyboard")
  value.owners.set("synthetic:keyboard:1", {
    operationId: "operation:keyboard:1",
    lineageId: "lineage:keyboard",
    targetId: "target:keyboard",
  })
  value.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:keyboard:1" })
  const continuation = await scope.createKeyboardContinuation(
    ticket,
    operation("operation:keyboard:1", target, "completed"),
  )
  const proof = await scope.admitKeyboardContinuation(continuation, "operation:keyboard:2")
  expect(proof).toMatchObject({
    operationId: "operation:keyboard:2",
    mode: "keyboard-continuation",
    observerInstanceRef: "observer:view",
    admissionCursor: "observer:view:start:s1",
    admissionNextSequence: 2,
  })
  await value.guard.close()
})

test("failed, unknown и non-input keyboard results не создают continuation", async () => {
  for (const state of ["failed", "interrupted-unknown", "cancelled"] as const) {
    const value = fixture()
    const scope = value.guard.forLineage(`lineage:${state}`)
    const ticket = await observe(value, `lineage:${state}`, `target:${state}`, target)
    const operationId = `operation:${state}`
    await scope.admit(ticket, operationId, "keyboard")
    const syntheticTag = `synthetic:${state}`
    value.owners.set(syntheticTag, { operationId, lineageId: `lineage:${state}`, targetId: `target:${state}` })
    value.observer.push({ kind: "input", source: "synthetic", syntheticTag })
    await expect(scope.createKeyboardContinuation(ticket, operation(operationId, target, state))).rejects.toThrow("positive terminal")
    await value.guard.close()
  }

  const focus = fixture()
  const scope = focus.guard.forLineage("lineage:focus")
  const ticket = await observe(focus, "lineage:focus", "target:focus", target)
  await scope.admit(ticket, "operation:focus", "keyboard")
  focus.owners.set("synthetic:focus", {
    operationId: "operation:focus",
    lineageId: "lineage:focus",
    targetId: "target:focus",
  })
  focus.observer.push({ kind: "focus", source: "synthetic", syntheticTag: "synthetic:focus", target })
  await expect(scope.createKeyboardContinuation(
    ticket,
    operation("operation:focus", target, "completed"),
  )).rejects.toThrow("input events only")
  await focus.guard.close()
})

test("event между continuation lookup и admission инвалидирует continuation", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:race")
  const ticket = await observe(value, "lineage:race", "target:race", target)
  await scope.admit(ticket, "operation:race:1", "keyboard")
  value.owners.set("synthetic:race:1", {
    operationId: "operation:race:1",
    lineageId: "lineage:race",
    targetId: "target:race",
  })
  value.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:race:1" })
  const continuation = await scope.createKeyboardContinuation(
    ticket,
    operation("operation:race:1", target, "completed"),
  )
  value.observer.push({ kind: "input", source: "external-user" })
  await expect(scope.admitKeyboardContinuation(continuation, "operation:race:2")).rejects.toThrow("invalidated")
  await value.guard.close()
})

test("foreign lineage/ticket, expiry, gap, EOF и history loss fail closed", async () => {
  const value = fixture({ ticketTtlMs: 10 })
  const owner = value.guard.forLineage("lineage:owner")
  const foreign = value.guard.forLineage("lineage:foreign")
  const ticket = await observe(value, "lineage:owner", "target:owner", target)
  await expect(foreign.admit(ticket, "operation:foreign", "ui-action")).rejects.toThrow("этой lineage")
  value.advance(11)
  await expect(owner.admit(ticket, "operation:expired", "ui-action")).rejects.toThrow("истёк")
  await value.guard.close()

  const gap = fixture()
  const gapScope = gap.guard.forLineage("lineage:gap")
  const gapTicket = await observe(gap, "lineage:gap", "target:gap", target)
  gap.observer.gap()
  await expect(gapScope.admit(gapTicket, "operation:gap", "ui-action")).rejects.toThrow("healthy continuous")
  await gap.guard.close()

  const eof = fixture()
  const eofScope = eof.guard.forLineage("lineage:eof")
  const eofTicket = await observe(eof, "lineage:eof", "target:eof", target)
  eof.observer.end()
  await Bun.sleep(0)
  await expect(eofScope.admit(eofTicket, "operation:eof", "ui-action")).rejects.toThrow("EOF")
  await eof.guard.close()

  const history = fixture({ rejectSubscribe: true })
  await expect(history.guard.start()).rejects.toThrow("history baseline")
})

test("records и bytes bounded, admitted operation удерживает consumed view", async () => {
  const countLimited = fixture({ maxRecords: 1 })
  const countScope = countLimited.guard.forLineage("lineage:count-limit")
  countLimited.bind("lineage:count-limit", "target:one", target)
  countLimited.bind("lineage:count-limit", "target:two", windowTarget("window:two"))
  await countScope.beginObservation("target:one", target)
  await expect(countScope.beginObservation("target:two", windowTarget("window:two"))).rejects.toThrow("capacity")
  await countLimited.guard.close()

  const retained = fixture({ maxRecords: 2 })
  const retainedScope = retained.guard.forLineage("lineage:retained")
  const ticket = await observe(retained, "lineage:retained", "target:retained", target)
  await retainedScope.admit(ticket, "operation:retained", "ui-action")
  retained.advance(400_000)
  expect(retained.guard.stats()).toMatchObject({ records: 1, operations: 1 })
  await retainedScope.settleOperation(ticket, operation("operation:retained", target, "completed"))
  retained.advance(400_000)
  expect(retained.guard.stats()).toMatchObject({ records: 0, operations: 0 })
  await retained.guard.close()

  const bytes = fixture({ maxBytes: 1024, maxRecords: 100 })
  const byteScope = bytes.guard.forLineage("lineage:bytes")
  let rejected = false
  for (let index = 0; index < 100 && !rejected; index++) {
    try {
      bytes.bind("lineage:bytes", `target:${index}:${"x".repeat(64)}`, target)
      await byteScope.beginObservation(`target:${index}:${"x".repeat(64)}`, target)
    } catch (error) {
      expect(String(error)).toContain("byte budget")
      rejected = true
    }
  }
  expect(rejected).toBe(true)
  expect(bytes.guard.stats().bytes).toBeLessThanOrEqual(1024)
  await bytes.guard.close()
})

class FakeObserver implements AgentViewObserver {
  readonly observerInstanceRef = "observer:view"
  readonly #queue: ObservedEvent[] = []
  readonly #waiters: Array<(event: ObservedEvent | undefined) => void> = []
  readonly #rejectSubscribe: boolean
  #coverage: ObserverCoverage

  constructor(private readonly now: () => Date, rejectSubscribe = false) {
    this.#rejectSubscribe = rejectSubscribe
    const timestamp = now().toISOString()
    this.#coverage = {
      state: "ready",
      ...generation,
      coverageStartCursor: "observer:view:start",
      cursor: "observer:view:start",
      nextSequence: 1,
      startedAt: timestamp,
      coveredFrom: timestamp,
      coveredThrough: timestamp,
      heartbeatAt: timestamp,
      coveredKinds: ["input", "focus", "window-structure", "lifecycle"],
      droppedEvents: 0,
      gapDetected: false,
    }
  }

  async coverage(): Promise<ObserverCoverage> {
    return structuredClone(this.#coverage)
  }

  subscribe(options: { signal?: AbortSignal, afterCursor?: string } = {}): AsyncIterable<ObservedEvent> {
    if (this.#rejectSubscribe) throw new Error("bounded history lost")
    if (options.afterCursor !== this.#coverage.cursor) throw new Error("bounded history cursor unavailable")
    const observer = this
    return {
      async *[Symbol.asyncIterator]() {
        while (!options.signal?.aborted) {
          const event = observer.#queue.shift() ?? await new Promise<ObservedEvent | undefined>(resolve => {
            const onAbort = () => resolve(undefined)
            options.signal?.addEventListener("abort", onAbort, { once: true })
            observer.#waiters.push(value => {
              options.signal?.removeEventListener("abort", onAbort)
              resolve(value)
            })
          })
          if (event === undefined) return
          yield event
        }
      },
    }
  }

  push(value: {
    kind: ObservedEvent["kind"]
    source: ObservedEvent["source"]
    syntheticTag?: string
    target?: ObservedEvent["target"]
    lifecycle?: ObservedEvent["lifecycle"]
  }): void {
    const sequence = this.#coverage.nextSequence
    const cursor = `observer:view:start:s${sequence}`
    const event: ObservedEvent = {
      eventId: cursor,
      cursor,
      sequence,
      observedAt: this.now().toISOString(),
      ...generation,
      kind: value.kind,
      source: value.source,
      ...(value.syntheticTag === undefined ? {} : { syntheticTag: value.syntheticTag }),
      ...(value.target === undefined ? {} : { target: value.target }),
      ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle }),
    }
    this.#coverage = {
      ...this.#coverage,
      cursor,
      nextSequence: sequence + 1,
      coveredThrough: this.now().toISOString(),
      heartbeatAt: this.now().toISOString(),
      lastEventAt: this.now().toISOString(),
    }
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#queue.push(event)
    else waiter(event)
  }

  gap(): void {
    this.#coverage = {
      ...this.#coverage,
      state: "unavailable",
      gapDetected: true,
      reason: "fixture gap",
    }
  }

  touch(): void {
    this.#coverage = {
      ...this.#coverage,
      coveredThrough: this.now().toISOString(),
      heartbeatAt: this.now().toISOString(),
    }
  }

  end(): void {
    for (const waiter of this.#waiters.splice(0)) waiter(undefined)
  }
}

function fixture(options: {
  ticketTtlMs?: number
  maxRecords?: number
  maxBytes?: number
  rejectSubscribe?: boolean
} = {}) {
  let nowMs = Date.parse("2026-09-15T10:00:00.000Z")
  let id = 0
  const owners = new Map<string, AgentSyntheticOwner>()
  const bindings = new Map<string, AgentViewTarget>()
  const observer = new FakeObserver(() => new Date(nowMs), options.rejectSubscribe)
  const guard = new AgentViewGuard({
    generation,
    observer,
    resolveTarget(lineageId, targetId) {
      const resolved = bindings.get(bindingKey(lineageId, targetId))
      if (resolved === undefined) throw new Error("trusted target binding отсутствует")
      return {
        targetId,
        target: resolved,
        inventoryId: "inventory:view",
        inventoryRevision: 1,
        actionExpiresAt: "2026-09-15T10:02:00.000Z",
      }
    },
    syntheticOwner: event => event.syntheticTag === undefined ? false : owners.get(event.syntheticTag) ?? false,
    clock: { now: () => new Date(nowMs) },
    ids: { next: prefix => `${prefix}:${++id}` },
    ticketTtlMs: options.ticketTtlMs,
    maxRecords: options.maxRecords,
    maxBytes: options.maxBytes,
  })
  return {
    guard,
    observer,
    owners,
    bind(lineageId: string, targetId: string, exactTarget: AgentViewTarget) {
      bindings.set(bindingKey(lineageId, targetId), exactTarget)
    },
    advance(milliseconds: number) { nowMs += milliseconds; observer.touch() },
  }
}

async function observe(
  value: ReturnType<typeof fixture>,
  lineageId: string,
  targetId: string,
  exactTarget: AgentViewTarget,
) {
  value.bind(lineageId, targetId, exactTarget)
  const scope = value.guard.forLineage(lineageId)
  const draft = await scope.beginObservation(targetId, exactTarget)
  return await scope.commitObservation(draft)
}

function bindingKey(lineageId: string, targetId: string): string {
  return JSON.stringify([lineageId, targetId])
}

function windowTarget(windowRef: string): Extract<AgentViewTarget, { kind: "window" }> {
  return {
    kind: "window",
    ref: {
      ...generation,
      applicationRef: "application:view",
      windowRef,
    },
  }
}

function operation(
  operationId: string,
  exactTarget: AgentViewTarget,
  state: "completed" | "failed" | "cancelled" | "interrupted-unknown",
  targetVerified: "verified" | "unknown" = "verified",
): OperationRecord {
  const completed = state === "completed"
  return operationRecordSchema.parse({
    clientSessionId: "client:view",
    principalId: "principal:view",
    intent: "mutation",
    context: {
      kind: "native",
      operationId,
      clientRequestId: `request:${operationId}`,
      clientSessionId: "client:view",
      principalId: "principal:view",
      ...generation,
      inventoryId: "inventory:view",
      inventoryRevision: 1,
      deadlineAt: "2026-09-15T10:01:00.000Z",
      target: exactTarget,
      fence: { ...generation, counter: 1 },
    },
    state,
    outcome: {
      dispatch: completed ? "finished" : state === "failed" ? "partial" : "unknown",
      targetVerified,
      userInterference: completed ? "none-observed" : "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: { scope: "none", state: "complete", resources: [] },
      restoration: "not-applicable",
      dispatchAttempts: 1,
    },
    resources: [],
    payloadReceipt: { keyGeneration: "key:view", hmacSha256: "a".repeat(64) },
    registeredAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:01.000Z",
    ...(completed ? {} : {
      error: {
        code: state === "cancelled" ? "cancelled" : "operation-outcome-unknown",
        message: `fixture ${state}`,
        stage: "fixture",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
    }),
  })
}
