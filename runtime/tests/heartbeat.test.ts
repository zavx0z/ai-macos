import { expect, test } from "bun:test"
import { runtimeHeartbeatFailureReason, startRuntimeHeartbeat, type RuntimeHeartbeatFailure } from "../src/heartbeat.ts"

const generation = { runtimeEpoch: "runtime:heartbeat", loginSessionId: "login:heartbeat", nativeGeneration: "native:heartbeat" }

test("heartbeat имеет один in-flight и stop не сообщает ложный failure", async () => {
  let calls = 0
  let failures = 0
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 100,
    native: { async heartbeat() { calls++; entered(); return new Promise(() => {}) } },
    onFailure() { failures++ },
  })
  await started
  expect(calls).toBe(1)
  await loop.stop()
  expect(failures).toBe(0)
  expect(calls).toBe(1)
})

test("heartbeat deadline вызывает fail-closed один раз без повторного request", async () => {
  let calls = 0
  let failed!: () => void
  let observed: RuntimeHeartbeatFailure | undefined
  let clockReads = 0
  const failure = new Promise<void>(resolve => { failed = resolve })
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 5,
    monotonicNow: () => clockReads++ === 0 ? 100 : 108,
    native: { async heartbeat() { calls++; return new Promise(() => {}) } }, onFailure(error) { observed = error; failed() },
  })
  await failure
  await loop.stop()
  expect(calls).toBe(1)
  expect(observed).toMatchObject({ failureClass: "deadline", elapsedMs: 8, timerLagMs: 3 })
  expect(runtimeHeartbeatFailureReason(observed!)).toBe("Native heartbeat deadline; elapsedMs=8; timerLagMs=3")
})

test("wrong-generation heartbeat ACK не продлевает host liveness", async () => {
  let failed!: () => void
  const failure = new Promise<void>(resolve => { failed = resolve })
  let failures = 0
  let observed: RuntimeHeartbeatFailure | undefined
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 100,
    monotonicNow: (() => { const values = [100, 103]; return () => values.shift() ?? 103 })(),
    native: { async heartbeat(request) { return { ...generation, nativeGeneration: "native:wrong", requestId: request.requestId,
      accepted: true, quarantined: false, acknowledgedAt: new Date().toISOString() } } },
    onFailure(error) { failures++; observed = error; failed() },
  })
  await failure
  await loop.stop()
  expect(failures).toBe(1)
  expect(observed).toMatchObject({ failureClass: "invalid-ack", elapsedMs: 3, timerLagMs: 0 })
})

test("adapter rejection публикует только controlled class/timing без неподтверждённой причины", async () => {
  let observed!: RuntimeHeartbeatFailure
  let failed!: () => void
  const failure = new Promise<void>(resolve => { failed = resolve })
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 100,
    monotonicNow: (() => { const values = [100, 102]; return () => values.shift() ?? 102 })(),
    native: { async heartbeat() { throw new Error("PRIVATE TRANSPORT DETAIL") } },
    onFailure(error) { observed = error; failed() },
  })
  await failure
  await loop.stop()
  expect(observed).toMatchObject({ failureClass: "adapter", elapsedMs: 2, timerLagMs: 0 })
  expect(runtimeHeartbeatFailureReason(observed)).toBe("Native heartbeat adapter; elapsedMs=2; timerLagMs=0")
  expect(runtimeHeartbeatFailureReason(observed)).not.toContain("PRIVATE")
})

test("простой не создаёт heartbeat; завершение operation подавляет поздний отказ", async () => {
  let calls = 0
  const failures: unknown[] = []
  const loop = startRuntimeHeartbeat({ generation, active: false, intervalMs: 1, deadlineMs: 5,
    native: { async heartbeat() { calls++; return new Promise(() => {}) } },
    onFailure: error => { failures.push(error) },
  })
  try {
    await Bun.sleep(15)
    expect(calls).toBe(0)
    loop.setActive(true)
    expect(calls).toBe(1)
    loop.setActive(false)
    await Bun.sleep(15)
    expect(calls).toBe(1)
    expect(failures).toEqual([])
    loop.setActive(true)
    loop.setActive(false)
    loop.setActive(true)
    await Bun.sleep(0)
    expect(calls).toBe(3)
    loop.setActive(false)
    await Bun.sleep(10)
    expect(failures).toEqual([])
  } finally { await loop.stop() }
})
