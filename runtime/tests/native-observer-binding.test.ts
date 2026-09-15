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

function fixture(options: { prepareError?: boolean, stopError?: boolean } = {}) {
  const events = new Events()
  const calls: string[] = []
  let current = snapshot()
  let stopError = options.stopError ?? false
  const native: NativeObserverClient = {
    generation,
    loadedBuildId: "native-build:observer-binding",
    events: signal => events.read(signal),
    async observer(request: NativeObserverRequest) {
      calls.push(request.command)
      if (request.command === "prepare" && options.prepareError) {
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
