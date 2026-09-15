import { expect, test } from "bun:test"
import { startRuntimeHeartbeat } from "../src/heartbeat.ts"

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
  const failure = new Promise<void>(resolve => { failed = resolve })
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 5,
    native: { async heartbeat() { calls++; return new Promise(() => {}) } }, onFailure() { failed() },
  })
  await failure
  await loop.stop()
  expect(calls).toBe(1)
})

test("wrong-generation heartbeat ACK не продлевает host liveness", async () => {
  let failed!: () => void
  const failure = new Promise<void>(resolve => { failed = resolve })
  let failures = 0
  const loop = startRuntimeHeartbeat({ generation, intervalMs: 1, deadlineMs: 100,
    native: { async heartbeat(request) { return { ...generation, nativeGeneration: "native:wrong", requestId: request.requestId,
      accepted: true, quarantined: false, acknowledgedAt: new Date().toISOString() } } },
    onFailure() { failures++; failed() },
  })
  await failure
  await loop.stop()
  expect(failures).toBe(1)
})
