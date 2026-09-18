import { describe, expect, test } from "bun:test"
import type { NativeObservedEvent, NativeObserverRequest, NativeObserverSnapshot } from "@meta/native/protocol"
import {
  createNativeObserverBinding,
  type NativeObserverBinding,
} from "../src/native-observer-binding.ts"
import type { NativeObserverClient } from "../src/observer-hub.ts"

const generation = {
  runtimeEpoch: "runtime:observer-binding",
  loginSessionId: "login:observer-binding",
  nativeGeneration: "native:observer-binding",
}

class Events {
  readonly values: NativeObservedEvent[] = []
  readonly waiters: Array<(value: NativeObservedEvent) => void> = []

  push(value: NativeObservedEvent): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter(value)
  }

  async *read(signal: AbortSignal): AsyncIterable<NativeObservedEvent> {
    while (!signal.aborted) {
      const current = this.values.shift()
      if (current !== undefined) {
        yield current
        continue
      }
      yield await new Promise<NativeObservedEvent>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("events aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        this.waiters.push(value => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        })
      })
    }
  }
}

function snapshot(): NativeObserverSnapshot {
  return {
    observerInstanceRef: "observer:binding",
    inventoryId: "inventory:binding",
    inventoryRevision: 1,
    indexRevision: 1,
    coverage: {
      state: "ready",
      ...generation,
      coverageStartCursor: "cursor:binding:start",
      cursor: "cursor:binding:start",
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

function event(sequence: number): NativeObservedEvent {
  const cursor = `cursor:binding:start:s${sequence}`
  return {
    observerInstanceRef: "observer:binding",
    eventId: cursor,
    ...generation,
    cursor,
    sequence,
    observedAt: "2026-09-15T10:00:02.000Z",
    kind: "focus",
    source: "unknown",
  }
}

function fixture(options: { prepareError?: boolean, prepareFailures?: number,
  prepareFailure?: { stage: "inventory" | "index" | "readiness" | "main-start" | "cleanup",
    retryDisposition: "clean-no-instance" | "clean-stopped" | "unknown", transient: boolean }, stopError?: boolean } = {}) {
  const events = new Events()
  const calls: string[] = []
  let current = snapshot()
  let stopError = options.stopError ?? false
  let prepareFailures = options.prepareFailures ?? (options.prepareError ? 1 : 0)
  const native: NativeObserverClient = {
    generation,
    loadedBuildId: "native-build:observer-binding",
    events: signal => events.read(signal),
    async observer(request: NativeObserverRequest) {
      calls.push(request.command)
      if (request.command === "prepare" && prepareFailures-- > 0) {
        return {
          kind: "observer-response",
          protocolVersion: "1",
          requestId: request.requestId,
          ...generation,
          command: request.command,
          nativeBuildId: "native-build:observer-binding",
          ok: false,
          error: {
            code: "capability-unavailable",
            message: "observer prepare unavailable",
            stage: "native-observer",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "inspect-health",
          },
          prepareFailure: options.prepareFailure ?? { stage: "index", retryDisposition: "clean-no-instance", transient: false },
        }
      }
      if (request.command === "stop" && stopError) {
        return {
          kind: "observer-response",
          protocolVersion: "1",
          requestId: request.requestId,
          ...generation,
          command: request.command,
          nativeBuildId: "native-build:observer-binding",
          ok: false,
          error: {
            code: "internal-error",
            message: "observer stop failed",
            stage: "native-observer",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "inspect-health",
          },
        }
      }
      return {
        kind: "observer-response",
        protocolVersion: "1",
        requestId: request.requestId,
        ...generation,
        command: request.command,
        nativeBuildId: "native-build:observer-binding",
        ok: true,
        snapshot: structuredClone(current),
      }
    },
  }
  return {
    calls,
    events,
    native,
    setStopError(value: boolean) { stopError = value },
    setSnapshot(value: NativeObserverSnapshot) { current = value },
  }
}

async function first(binding: NativeObserverBinding) {
  const controller = new AbortController()
  const iterator = binding.events(controller.signal)[Symbol.asyncIterator]()
  const promise = iterator.next()
  return { controller, iterator, promise }
}

describe("C3 native observer lifecycle binding", () => {
  test("retry только transient clean failure: максимум3, grants/gen recheck перед каждой попыткой", async () => {
    const value = fixture({ prepareFailures: 2,
      prepareFailure: { stage: "inventory", retryDisposition: "clean-no-instance", transient: true } })
    const attempts: number[] = []
    const sleeps: number[] = []
    const binding = await createNativeObserverBinding({ native: value.native,
      async beforeAttempt(attempt, signal) { signal.throwIfAborted(); attempts.push(attempt) },
      async sleep(ms, signal) { signal.throwIfAborted(); sleeps.push(ms) } })
    expect(attempts).toEqual([1, 2, 3])
    expect(sleeps).toEqual([1000, 1000])
    expect(value.calls).toEqual(["prepare", "prepare", "prepare"])
    await binding.close()
  })

  test("unknown/non-transient failure не повторяется", async () => {
    for (const prepareFailure of [
      { stage: "cleanup" as const, retryDisposition: "unknown" as const, transient: false },
      { stage: "main-start" as const, retryDisposition: "clean-stopped" as const, transient: false },
    ]) {
      const value = fixture({ prepareFailures: 3, prepareFailure })
      await expect(createNativeObserverBinding({ native: value.native, async sleep() { throw new Error("retry forbidden") } })).rejects.toThrow("prepare unavailable")
      expect(value.calls).toEqual(["prepare"])
    }
  })

  test("close/caller abort во время retry backoff не создаёт новую prepare attempt", async () => {
    const value = fixture({ prepareFailures: 3,
      prepareFailure: { stage: "index", retryDisposition: "clean-no-instance", transient: true } })
    const caller = new AbortController()
    const pending = createNativeObserverBinding({ native: value.native, signal: caller.signal,
      async sleep(_ms, signal) {
        caller.abort(new Error("host closing"))
        signal.throwIfAborted()
      } })
    await expect(pending).rejects.toThrow("host closing")
    expect(value.calls).toEqual(["prepare"])
  })

  test("passive grant/generation recheck failure предотвращает Native prepare", async () => {
    const value = fixture()
    await expect(createNativeObserverBinding({ native: value.native,
      async beforeAttempt() { throw new Error("passive grant revoked") } })).rejects.toThrow("grant revoked")
    expect(value.calls).toEqual([])
  })

  test("ignored precheck promise прерывается caller abort и не запускает prepare", async () => {
    const value = fixture()
    const caller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = createNativeObserverBinding({ native: value.native, signal: caller.signal,
      async beforeAttempt() { entered(); return new Promise(() => {}) } })
    await started
    caller.abort(new Error("host shutdown"))
    await expect(pending).rejects.toThrow("host shutdown")
    expect(value.calls).toEqual([])
  })

  test("generation rechecked by binding before retry, независимо от Host callback", async () => {
    const value = fixture({ prepareFailures: 2,
      prepareFailure: { stage: "inventory", retryDisposition: "clean-no-instance", transient: true } })
    const pending = createNativeObserverBinding({ native: value.native, async sleep() {
      Object.assign(value.native.generation!, { nativeGeneration: "native:replacement" })
    } })
    await expect(pending).rejects.toThrow("generation изменилась")
    expect(value.calls).toEqual(["prepare"])
  })

  test("late clean ACK с failed stop публикует unknown cleanup через onGap", async () => {
    const value = fixture({ stopError: true })
    const caller = new AbortController()
    let entered!: () => void
    let release!: () => void
    let gap!: (error: Error) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const failed = new Promise<Error>(resolve => { gap = resolve })
    const original = value.native.observer.bind(value.native)
    value.native.observer = async (request, control) => {
      if (request.command === "prepare") { entered(); await gate }
      return original(request, control)
    }
    const pending = createNativeObserverBinding({ native: value.native, signal: caller.signal, onGap: gap })
    await started
    caller.abort(new Error("host shutdown"))
    await expect(pending).rejects.toThrow("host shutdown")
    release()
    expect((await failed).message).toContain("Late observer cleanup")
    expect(value.calls).toEqual(["prepare", "stop"])
  })

  test("prepare использует6s, coverage/stop сохраняют1s", async () => {
    const value = fixture()
    const original = value.native.observer.bind(value.native)
    const budgets = new Map<string, number>()
    value.native.observer = async (request, control) => {
      budgets.set(request.command, Date.parse(request.deadlineAt) - Date.now())
      return original(request, control)
    }
    const binding = await createNativeObserverBinding({ native: value.native })
    await binding.coverage()
    await binding.close()
    expect(budgets.get("prepare")).toBeGreaterThan(5500)
    expect(budgets.get("prepare")).toBeLessThanOrEqual(6000)
    expect(budgets.get("coverage")).toBeLessThanOrEqual(1000)
    expect(budgets.get("stop")).toBeLessThanOrEqual(1000)
  })

  test("pre-aborted caller не вызывает native prepare", async () => {
    const value = fixture()
    const caller = new AbortController()
    caller.abort(new Error("caller cancelled"))
    await expect(createNativeObserverBinding({ native: value.native, signal: caller.signal })).rejects.toThrow("caller cancelled")
    expect(value.calls).toEqual([])
  })

  test("отмена prepare возвращается сразу; late ACK очищается fresh stop signal", async () => {
    const value = fixture()
    const original = value.native.observer.bind(value.native)
    const caller = new AbortController()
    let entered!: () => void
    let release!: () => void
    let stopped!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const cleanup = new Promise<void>(resolve => { stopped = resolve })
    let prepareSignal: AbortSignal | undefined
    let stopWasAborted: boolean | undefined
    value.native.observer = async (request, control) => {
      if (request.command === "prepare") {
        prepareSignal = control.signal
        entered()
        await gate
      }
      const response = await original(request, control)
      if (request.command === "stop") {
        stopWasAborted = control.signal.aborted
        stopped()
      }
      return response
    }
    const pending = createNativeObserverBinding({ native: value.native, signal: caller.signal })
    await started
    caller.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
    expect(prepareSignal?.aborted).toBe(true)
    release()
    await cleanup
    expect(stopWasAborted).toBe(false)
    expect(value.calls).toEqual(["prepare", "stop"])
  }, 1000)

  test("prepare немедленно запускает sole PUSH hub и close вызывает exact stop", async () => {
    const value = fixture()
    const gaps: Error[] = []
    const binding = await createNativeObserverBinding({ native: value.native, onGap: error => gaps.push(error) })
    const pending = await first(binding)
    value.events.push(event(1))

    await expect(pending.promise).resolves.toMatchObject({ value: { sequence: 1 } })
    expect(binding.snapshot.observerInstanceRef).toBe("observer:binding")
    expect(gaps).toEqual([])
    await pending.iterator.return?.()
    await binding.close()
    await binding.close()
    expect(value.calls).toEqual(["prepare", "stop"])
  })

  test("coverage делегируется hub и не превращает session facts в unlock proof", async () => {
    const value = fixture()
    const binding = await createNativeObserverBinding({ native: value.native })
    value.setSnapshot({
      ...snapshot(),
      sessionReadiness: {
        state: "active-console",
        lockState: "unknown",
        userId: 501,
        onConsole: true,
        loginDone: true,
        auditSessionId: 42,
        evidence: "lock remains unknown",
        observedAt: "2026-09-15T10:00:02.000Z",
      },
      secureInput: "on",
    })

    await expect(binding.coverage()).resolves.toMatchObject({ state: "ready" })
    expect(binding.snapshot.sessionReadiness.lockState).toBe("unknown")
    expect(binding.snapshot.secureInput).toBe("off")
    await binding.close()
  })

  test("prepare failure не создаёт hub, stop failure не оставляет consumer", async () => {
    const failed = fixture({ prepareError: true })
    await expect(createNativeObserverBinding({ native: failed.native })).rejects.toThrow("prepare unavailable")
    expect(failed.calls).toEqual(["prepare"])

    const stopFailed = fixture({ stopError: true })
    const binding = await createNativeObserverBinding({ native: stopFailed.native })
    await expect(binding.close()).rejects.toThrow("stop failed")
    stopFailed.setStopError(false)
    await expect(binding.close()).resolves.toBeUndefined()
    expect(stopFailed.calls).toEqual(["prepare", "stop", "stop"])
  })
})

test("main-start clean-stopped повторяет только prepare и заново проверяет preflight", async () => {
  const value = fixture({ prepareFailures: 2,
    prepareFailure: { stage: "main-start", retryDisposition: "clean-stopped", transient: true } })
  const attempts: number[] = []
  const sleeps: number[] = []
  const binding = await createNativeObserverBinding({ native: value.native,
    async beforeAttempt(attempt, signal) { signal.throwIfAborted(); attempts.push(attempt) },
    async sleep(ms, signal) { signal.throwIfAborted(); sleeps.push(ms) } })
  expect(value.calls).toEqual(["prepare", "prepare", "prepare"])
  expect(attempts).toEqual([1, 2, 3])
  expect(sleeps).toEqual([1000, 1000])
  await binding.close()
})

test("main-start clean failure исчерпывает три попытки без бесконечного retry", async () => {
  const value = fixture({ prepareFailures: 10,
    prepareFailure: { stage: "main-start", retryDisposition: "clean-stopped", transient: true } })
  await expect(createNativeObserverBinding({ native: value.native, async sleep() {} })).rejects.toThrow("prepare unavailable")
  expect(value.calls).toEqual(["prepare", "prepare", "prepare"])
})
