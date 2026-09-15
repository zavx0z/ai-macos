import { describe, expect, test } from "bun:test"
import type { ObservedEvent } from "@meta/shared/contracts"
import type {
  NativeObservedEvent,
  NativeObserverRequest,
  NativeObserverSnapshot,
} from "@meta/native/protocol"
import {
  RuntimeNativeObserverHub,
  type NativeObserverClient,
} from "../src/observer-hub.ts"

const generation = {
  runtimeEpoch: "runtime:hub",
  loginSessionId: "login:hub",
  nativeGeneration: "native:hub",
}

class EventQueue {
  readonly values: NativeObservedEvent[] = []
  readonly waiters: Array<(value: NativeObservedEvent | undefined) => void> = []
  ended = false

  push(event: NativeObservedEvent): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(event)
    else waiter(event)
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  async *events(signal: AbortSignal): AsyncIterable<NativeObservedEvent> {
    while (!signal.aborted) {
      const current = this.values.shift()
      if (current !== undefined) {
        yield current
        continue
      }
      if (this.ended) return
      const next = await new Promise<NativeObservedEvent | undefined>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("event queue aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.waiters.push(value => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
      if (next === undefined) return
      yield next
    }
  }
}

function snapshot(): NativeObserverSnapshot {
  return {
    observerInstanceRef: "observer:1",
    inventoryId: "inventory:1",
    inventoryRevision: 1,
    indexRevision: 1,
    coverage: {
      state: "ready",
      ...generation,
      coverageStartCursor: "cursor:start",
      cursor: "cursor:start",
      nextSequence: 1,
      startedAt: "2026-09-15T10:00:00.000Z",
      coveredFrom: "2026-09-15T10:00:00.000Z",
      coveredThrough: "2026-09-15T10:00:01.000Z",
      heartbeatAt: "2026-09-15T10:00:01.000Z",
      coveredKinds: ["input", "focus", "window-structure", "lifecycle"],
      droppedEvents: 0,
      gapDetected: false,
    },
    sessionReadiness: {
      state: "active-console",
      lockState: "unknown",
      userId: 501,
      onConsole: true,
      loginDone: true,
      auditSessionId: 42,
      evidence: "fixture public session facts",
      observedAt: "2026-09-15T10:00:01.000Z",
    },
    secureInput: "off",
  }
}

function fixture(options: {
  maxEventsPerSubscriber?: number
  closeMs?: number
  hangEvents?: boolean
  hangCoverage?: boolean
  controlTimeoutMs?: number
  maxHistoryEvents?: number
  maxHistoryBytes?: number
  initialSnapshot?: NativeObserverSnapshot
} = {}) {
  const queue = new EventQueue()
  let currentSnapshot = options.initialSnapshot ?? snapshot()
  const diagnostics: ObservedEvent[] = []
  const gaps: Error[] = []
  const native: NativeObserverClient = {
    generation,
    loadedBuildId: "native-build:hub",
    events(signal) {
      if (options.hangEvents) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<never>(() => undefined)
          },
        }
      }
      return queue.events(signal)
    },
    async observer(request: NativeObserverRequest) {
      if (options.hangCoverage) await new Promise<never>(() => undefined)
      return {
        kind: "observer-response",
        protocolVersion: "1",
        requestId: request.requestId,
        ...generation,
        command: request.command,
        nativeBuildId: "native-build:hub",
        ok: true,
        snapshot: structuredClone(currentSnapshot),
      }
    },
  }
  let id = 0
  const hub = new RuntimeNativeObserverHub({
    native,
    snapshot: currentSnapshot,
    ids: { next: prefix => `${prefix}:${++id}` },
    diagnostic: event => diagnostics.push(event),
    onGap: error => gaps.push(error),
    maxEventsPerSubscriber: options.maxEventsPerSubscriber,
    closeMs: options.closeMs,
    controlTimeoutMs: options.controlTimeoutMs,
    maxHistoryEvents: options.maxHistoryEvents,
    maxHistoryBytes: options.maxHistoryBytes,
  })
  return {
    diagnostics,
    gaps,
    hub,
    queue,
    setSnapshot(value: NativeObserverSnapshot) { currentSnapshot = value },
  }
}

function event(sequence: number, options: {
  instance?: string
  kind?: "input" | "focus"
  source?: "synthetic" | "unknown"
} = {}): NativeObservedEvent {
  const cursor = `cursor:start:s${sequence}`
  return {
    observerInstanceRef: options.instance ?? "observer:1",
    eventId: cursor,
    ...generation,
    cursor,
    sequence,
    observedAt: "2026-09-15T10:00:02.000Z",
    kind: options.kind ?? "input",
    source: options.source ?? "unknown",
    ...(options.source === "synthetic" ? { syntheticTag: `synthetic:${sequence}` } : {}),
  }
}

async function next(iterable: AsyncIterable<ObservedEvent>): Promise<IteratorResult<ObservedEvent>> {
  return await iterable[Symbol.asyncIterator]().next()
}

describe("C3 runtime native observer hub", () => {
  test("длительный PUSH сохраняет continuity после вытеснения старой истории", async () => {
    const value = fixture({ maxHistoryEvents: 3 })
    value.hub.start()
    const live = value.hub.subscribe()[Symbol.asyncIterator]()
    let last = 0
    for (let sequence = 1; sequence <= 2_001; sequence++) {
      value.queue.push(event(sequence))
      last = (await live.next()).value!.sequence
    }
    value.setSnapshot({
      ...snapshot(),
      coverage: { ...snapshot().coverage, cursor: "cursor:start:s2001", nextSequence: 2002 },
    })
    expect(last).toBe(2001)
    expect(value.gaps).toEqual([])
    await expect(value.hub.coverage()).resolves.toMatchObject({ state: "ready", nextSequence: 2002 })
    expect(() => value.hub.subscribe({ afterCursor: "cursor:start" })).toThrow("bounded hub history")
    expect(() => value.hub.subscribe({ afterCursor: "cursor:start:s1997" })).toThrow("bounded hub history")
    const replay = value.hub.subscribe({ afterCursor: "cursor:start:s1998" })[Symbol.asyncIterator]()
    const replayed = []
    for (let count = 0; count < 3; count++) replayed.push((await replay.next()).value!.sequence)
    expect(replayed).toEqual([1999, 2000, 2001])
    await live.return?.()
    await replay.return?.()
    await value.hub.close()
  })

  test("byte budget вытесняет историю без потери живой доставки", async () => {
    const value = fixture({ maxHistoryBytes: 700 })
    value.hub.start()
    const live = value.hub.subscribe()[Symbol.asyncIterator]()
    for (let sequence = 1; sequence <= 10; sequence++) {
      value.queue.push(event(sequence))
      await live.next()
    }
    expect(value.gaps).toEqual([])
    expect(() => value.hub.subscribe({ afterCursor: "cursor:start:s1" })).toThrow("bounded hub history")
    await live.return?.()
    await value.hub.close()
  })

  test("coverage завершается по deadline даже когда backend игнорирует abort", async () => {
    const value = fixture({ hangCoverage: true, controlTimeoutMs: 5 })
    value.hub.start()
    await expect(value.hub.coverage()).resolves.toMatchObject({ state: "unavailable", reason: "Observer coverage timeout" })
    await value.hub.close()
  })

  test("один native consumer валидирует event и fanout двум subscribers", async () => {
    const value = fixture()
    value.hub.start()
    const first = value.hub.subscribe()[Symbol.asyncIterator]()
    const second = value.hub.subscribe()[Symbol.asyncIterator]()
    value.queue.push({ ...event(99), observerInstanceRef: undefined })
    value.queue.push(event(1))

    await expect(first.next()).resolves.toMatchObject({ value: { sequence: 1 } })
    await expect(second.next()).resolves.toMatchObject({ value: { sequence: 1 } })
    expect(value.diagnostics).toHaveLength(1)
    expect(value.gaps).toEqual([])
    value.setSnapshot({
      ...snapshot(),
      coverage: { ...snapshot().coverage, cursor: "cursor:start:s1", nextSequence: 2 },
    })
    await expect(value.hub.coverage()).resolves.toMatchObject({ state: "ready", nextSequence: 2 })
    await first.return?.()
    await second.return?.()
    await value.hub.close()
  })

  test("foreign instance и skipped sequence создают terminal gap", async () => {
    const foreign = fixture()
    foreign.hub.start()
    const subscriber = foreign.hub.subscribe()[Symbol.asyncIterator]()
    foreign.queue.push(event(1, { instance: "observer:foreign" }))
    await expect(subscriber.next()).rejects.toThrow("Foreign observer instance")
    expect(foreign.gaps).toHaveLength(1)
    await expect(foreign.hub.coverage()).resolves.toMatchObject({ state: "unavailable", gapDetected: true })
    await foreign.hub.close()

    const skipped = fixture()
    skipped.hub.start()
    const skippedSubscriber = skipped.hub.subscribe()[Symbol.asyncIterator]()
    skipped.queue.push(event(2))
    await expect(skippedSubscriber.next()).rejects.toThrow("continuity")
    expect(skipped.gaps).toHaveLength(1)
    await skipped.hub.close()

    const foreignCoverage = fixture()
    foreignCoverage.hub.start()
    foreignCoverage.setSnapshot({ ...snapshot(), observerInstanceRef: "observer:foreign" })
    await expect(foreignCoverage.hub.coverage()).resolves.toMatchObject({
      state: "unavailable",
      gapDetected: true,
    })
    expect(foreignCoverage.gaps).toHaveLength(1)
    await foreignCoverage.hub.close()
  })

  test("subscriber overflow не теряет event молча и отзывает всех", async () => {
    const value = fixture({ maxEventsPerSubscriber: 1 })
    value.hub.start()
    const slow = value.hub.subscribe()[Symbol.asyncIterator]()
    value.queue.push(event(1))
    value.queue.push(event(2))

    await Bun.sleep(0)
    await expect(slow.next()).rejects.toThrow("subscriber overflow")
    expect(value.gaps).toHaveLength(1)
    await value.hub.close()
  })

  test("EOF отзывает subscribers, а close hung source bounded", async () => {
    const eof = fixture()
    eof.hub.start()
    const subscriber = eof.hub.subscribe()[Symbol.asyncIterator]()
    eof.queue.end()
    await expect(subscriber.next()).rejects.toThrow("завершился")
    await eof.hub.close()

    const hung = fixture({ hangEvents: true, closeMs: 5 })
    hung.hub.start()
    const started = performance.now()
    await hung.hub.close()
    expect(performance.now() - started).toBeLessThan(100)
  })

  test("afterCursor replay использует bounded immutable history", async () => {
    const value = fixture()
    value.hub.start()
    const live = value.hub.subscribe()[Symbol.asyncIterator]()
    value.queue.push(event(1))
    value.queue.push(event(2))
    await live.next()
    await live.next()
    const replay = value.hub.subscribe({ afterCursor: "cursor:start:s1" })[Symbol.asyncIterator]()

    await expect(replay.next()).resolves.toMatchObject({ value: { sequence: 2 } })
    await live.return?.()
    await replay.return?.()
    await value.hub.close()
  })

  test("prepare baseline исключает pre-ACK events и требует первый post-ACK sequence", async () => {
    const baseline = snapshot()
    baseline.coverage.cursor = "cursor:start:s2"
    baseline.coverage.nextSequence = 3
    const value = fixture({ initialSnapshot: baseline })
    value.hub.start()
    const subscriber = value.hub.subscribe()[Symbol.asyncIterator]()
    value.queue.push(event(3))
    await expect(subscriber.next()).resolves.toMatchObject({ value: { sequence: 3 } })
    await subscriber.return?.()
    await value.hub.close()

    const stale = fixture({ initialSnapshot: baseline })
    stale.hub.start()
    const staleSubscriber = stale.hub.subscribe()[Symbol.asyncIterator]()
    stale.queue.push(event(2))
    await expect(staleSubscriber.next()).rejects.toThrow("continuity")
    await stale.hub.close()
  })
})
