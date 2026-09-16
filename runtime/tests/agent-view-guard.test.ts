import { expect, test } from "bun:test"
import {
  operationRecordSchema,
  type ObservedEvent,
  type ObserverCoverage,
  type OperationRecord,
} from "@meta/shared/contracts"
import { AgentViewGuard, type AgentViewObserver, type AgentViewTarget } from "../src/agent-view-guard.ts"

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
  const proof = await scope.admit(ticket, "operation:view")
  expect(proof).toEqual({
    viewNonce: "agent-view:1",
    targetId: "target:view",
    operationId: "operation:view",
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
  await expect(scope.admit(ticket, "operation:replay")).rejects.toThrow("consumed")
  await scope.settleOperation(ticket, operation("operation:view", target, "completed"))
  const next = await observe(value, "lineage:view", "target:view", target)
  await expect(scope.admit(next, "operation:view:next")).resolves.toMatchObject({ operationId: "operation:view:next" })
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
    await expect(scope.admit(ticket, "operation:event")).rejects.toThrow()
    await value.guard.close()
  }
})

test("targetless focus и window structure инвалидируют все views, но fresh ticket остаётся доступен", async () => {
  for (const kind of ["focus", "window-structure"] as const) {
    const value = fixture()
    const first = value.guard.forLineage(`lineage:global:${kind}:first`)
    const second = value.guard.forLineage(`lineage:global:${kind}:second`)
    const firstTarget = windowTarget(`window:global:${kind}:first`)
    const secondTarget = windowTarget(`window:global:${kind}:second`)
    const firstTicket = await observe(value, `lineage:global:${kind}:first`, `target:global:${kind}:first`, firstTarget)
    const secondTicket = await observe(value, `lineage:global:${kind}:second`, `target:global:${kind}:second`, secondTarget)
    value.observer.push({ kind, source: "unknown" })
    await expect(first.admit(firstTicket, `operation:global:${kind}:first`)).rejects.toThrow()
    await expect(second.admit(secondTicket, `operation:global:${kind}:second`)).rejects.toThrow()
    await expect(value.observer.coverage()).resolves.toMatchObject({ state: "ready", gapDetected: false })
    const fresh = await observe(value, `lineage:global:${kind}:first`, `target:global:${kind}:first`, firstTarget)
    await expect(first.admit(fresh, `operation:global:${kind}:fresh`)).resolves.toMatchObject({
      operationId: `operation:global:${kind}:fresh`,
    })
    await first.settleOperation(fresh, operation(`operation:global:${kind}:fresh`, firstTarget, "completed"))
    await value.guard.close()
  }
})

test("own synthetic event и action admission инвалидируют все fresh views", async () => {
  const synthetic = fixture()
  const syntheticScope = synthetic.guard.forLineage("lineage:synthetic")
  const syntheticTicket = await observe(synthetic, "lineage:synthetic", "target:synthetic", target)
  synthetic.observer.push({ kind: "input", source: "synthetic", syntheticTag: "synthetic:own" })
  await expect(syntheticScope.admit(syntheticTicket, "operation:after-synthetic")).rejects.toThrow()
  await synthetic.guard.close()

  const value = fixture()
  const first = value.guard.forLineage("lineage:first")
  const second = value.guard.forLineage("lineage:second")
  const firstTicket = await observe(value, "lineage:first", "target:first", target)
  const secondTicket = await observe(value, "lineage:second", "target:second", windowTarget("window:second"))
  const siblingTicket = await observe(value, "lineage:first", "target:sibling", windowTarget("window:sibling"))
  await first.admit(firstTicket, "operation:first")
  await expect(second.admit(secondTicket, "operation:second")).rejects.toThrow("consumed")
  await expect(first.admit(siblingTicket, "operation:sibling")).rejects.toThrow("consumed")
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
  await expect(scope.admit(nextTicket, "operation:replacement")).resolves.toMatchObject({
    targetId: "target:replacement",
  })
  await value.guard.close()
})

test("terminal operation с foreign exact target отвергается", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:terminal-target")
  const ticket = await observe(value, "lineage:terminal-target", "target:terminal-target", target)
  await scope.admit(ticket, "operation:terminal-target")
  await expect(scope.settleOperation(
    ticket,
    operation("operation:terminal-target", windowTarget("window:foreign"), "completed"),
  )).rejects.toThrow("другой exact target")
  await value.guard.close()
})

test("targetId и exact target независимо проверяются trusted registry resolver", async () => {
  const mismatched = fixture()
  const mismatchScope = mismatched.guard.forLineage("lineage:mismatch")
  mismatched.bind("lineage:mismatch", "target:a", target)
  await expect(mismatchScope.beginObservation(
    "target:a",
    windowTarget("window:b"),
  )).rejects.toThrow("trusted exact target binding")
  await mismatched.guard.close()
})

test("display/layout views используют exact generation и broad invalidation", async () => {
  const display = displayTarget("display:view", 3)
  const value = fixture()
  const scope = value.guard.forLineage("lineage:display")
  const displayTicket = await observe(
    value,
    "lineage:display",
    "target:display",
    display,
  )
  await expect(scope.admit(displayTicket, "operation:display"))
    .resolves.toMatchObject({ targetId: "target:display" })
  await scope.settleOperation(
    displayTicket,
    operation("operation:display", display, "completed"),
  )

  const layout = layoutTarget("layout:view", 3)
  const layoutTicket = await observe(
    value,
    "lineage:display",
    "target:layout",
    layout,
  )
  value.observer.push({
    kind: "window-structure",
    source: "unknown",
    target: { ...windowTarget("window:unrelated"), ref: { ...windowTarget("window:unrelated").ref, applicationRef: "application:unrelated" } },
  })
  await expect(scope.admit(layoutTicket, "operation:layout"))
    .rejects.toThrow("Relevant window structure changed")

  value.bind("lineage:display", "target:stale-layout", layout)
  await expect(scope.beginObservation(
    "target:stale-layout",
    layoutTarget("layout:view", 4),
  )).rejects.toThrow("trusted exact target binding")
  await expect(scope.beginObservation(
    "target:foreign-generation",
    layoutTarget("layout:view", 3, "native:foreign"),
  )).rejects.toThrow("другой native generation")
  await expect(scope.beginObservation(
    "target:browser",
    browserTarget() as unknown as AgentViewTarget,
  )).rejects.toThrow("поддерживает только window/surface/display/desktop-layout")
  await value.guard.close()
})

test("foreign lineage/ticket, expiry, gap, EOF и history loss fail closed", async () => {
  const value = fixture({ ticketTtlMs: 10 })
  const owner = value.guard.forLineage("lineage:owner")
  const foreign = value.guard.forLineage("lineage:foreign")
  const ticket = await observe(value, "lineage:owner", "target:owner", target)
  await expect(foreign.admit(ticket, "operation:foreign")).rejects.toThrow("этой lineage")
  value.advance(11)
  await expect(owner.admit(ticket, "operation:expired")).rejects.toThrow("истёк")
  await value.guard.close()

  const gap = fixture()
  const gapScope = gap.guard.forLineage("lineage:gap")
  const gapTicket = await observe(gap, "lineage:gap", "target:gap", target)
  gap.observer.gap()
  await expect(gapScope.admit(gapTicket, "operation:gap")).rejects.toThrow("healthy continuous")
  await gap.guard.close()

  const eof = fixture()
  const eofScope = eof.guard.forLineage("lineage:eof")
  const eofTicket = await observe(eof, "lineage:eof", "target:eof", target)
  eof.observer.end()
  await Bun.sleep(0)
  await expect(eofScope.admit(eofTicket, "operation:eof")).rejects.toThrow("EOF")
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
  await retainedScope.admit(ticket, "operation:retained")
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
    clock: { now: () => new Date(nowMs) },
    ids: { next: prefix => `${prefix}:${++id}` },
    ticketTtlMs: options.ticketTtlMs,
    maxRecords: options.maxRecords,
    maxBytes: options.maxBytes,
  })
  return {
    guard,
    observer,
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

function displayTarget(
  displayRef: string,
  displayLayoutRevision: number,
): Extract<AgentViewTarget, { kind: "display" }> {
  return {
    kind: "display",
    ref: {
      ...generation,
      displayRef,
      displayLayoutRevision,
    },
  }
}

function layoutTarget(
  layoutRef: string,
  displayLayoutRevision: number,
  targetNativeGeneration = generation.nativeGeneration,
): Extract<AgentViewTarget, { kind: "desktop-layout" }> {
  return {
    kind: "desktop-layout",
    ref: {
      ...generation,
      nativeGeneration: targetNativeGeneration,
      layoutRef,
      displayLayoutRevision,
    },
  }
}

function browserTarget() {
  return {
    kind: "browser-target" as const,
    ref: {
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      browserInstanceRef: "browser:view",
      transportGeneration: "transport:view",
      targetId: "cdp:view",
      resourceRef: "resource:view",
    },
  }
}

function operation(
  operationId: string,
  exactTarget: AgentViewTarget,
  state: "completed" | "failed" | "cancelled" | "interrupted-unknown",
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
      targetVerified: "verified",
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


test("Guard принимает уже пройденный watermark без ожидания счётчика назад", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:overtake")
  const ticket = await observe(value, "lineage:overtake", "target:overtake", target)
  const original = value.observer.coverage.bind(value.observer)
  let once = true
  value.observer.coverage = async () => {
    const snapshot = await original()
    if (once) {
      once = false
      value.observer.push({ kind: "window-structure", source: "unknown", target: { ...windowTarget("window:unrelated"), ref: { ...windowTarget("window:unrelated").ref, applicationRef: "application:unrelated" } } })
      value.observer.push({ kind: "window-structure", source: "unknown", target: { ...windowTarget("window:unrelated"), ref: { ...windowTarget("window:unrelated").ref, applicationRef: "application:unrelated" } } })
      await Bun.sleep(0)
    }
    return snapshot
  }
  try {
    await expect(scope.admit(ticket, "operation:overtake")).resolves.toMatchObject({
      admissionNextSequence: 3, admissionCursor: "observer:view:start:s2",
    })
  } finally { await value.guard.close() }
})

test("пройденный watermark не скрывает более новое вмешательство человека", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:takeover-race")
  const ticket = await observe(value, "lineage:takeover-race", "target:takeover-race", target)
  const original = value.observer.coverage.bind(value.observer)
  value.observer.coverage = async () => {
    const snapshot = await original()
    value.observer.push({ kind: "focus", source: "unknown" })
    await Bun.sleep(0)
    return snapshot
  }
  try {
    await expect(scope.admit(ticket, "operation:takeover-race")).rejects.toThrow("Observer focus")
    expect(value.guard.available).toBe(true)
  } finally { await value.guard.close() }
})

test("временный initial coverage отказ не кешируется навсегда и сохраняет причину", async () => {
  const value = fixture()
  const original = value.observer.coverage.bind(value.observer)
  let fail = true
  value.observer.coverage = async () => {
    const snapshot = await original()
    return fail ? { ...snapshot, state: "unavailable", reason: "fixture transient reply" } : snapshot
  }
  try {
    await expect(value.guard.start()).rejects.toThrow("state=unavailable; fixture transient reply")
    expect(value.guard.available).toBe(false)
    fail = false
    await value.guard.start()
    expect(value.guard.available).toBe(true)
    const ticket = await observe(value, "lineage:retry-start", "target:retry-start", target)
    await expect(value.guard.forLineage("lineage:retry-start").admit(ticket, "operation:retry-start")).resolves.toMatchObject({ operationId: "operation:retry-start" })
  } finally { await value.guard.close() }
})


test("длинная причина coverage не маскируется ошибкой лимита при invalidation", async () => {
  const value = fixture()
  const scope = value.guard.forLineage("lineage:long-reason")
  const ticket = await observe(value, "lineage:long-reason", "target:long-reason", target)
  const original = value.observer.coverage.bind(value.observer)
  value.observer.coverage = async () => ({ ...await original(), state: "unavailable", reason: "x".repeat(1024) })
  try {
    await expect(scope.admit(ticket, "operation:long-reason")).rejects.toThrow("state=unavailable")
    value.observer.coverage = original
    await expect(scope.admit(ticket, "operation:long-reason:stale")).rejects.toThrow("coverage")
  } finally { await value.guard.close() }
})
