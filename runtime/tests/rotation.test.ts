import { expect, test } from "bun:test"
import { startRuntimeRotation } from "../src/rotation.ts"

test("managed rotation делает seal→confirmed drain→close→exit", async () => {
  const stages: string[] = []
  let done!: () => void
  const exited = new Promise<void>(resolve => { done = resolve })
  const rotation = startRuntimeRotation({ managed: true, reason: () => "native-budget", seal() { stages.push("seal") },
    async drain() { stages.push("drain") }, async close() { stages.push("close") }, exit() { stages.push("exit"); done() } })
  rotation.check()
  await exited
  expect(stages).toEqual(["seal", "drain", "close", "exit"])
  rotation.stop()
})

test("unmanaged rotation требует restart без закрытия процессов", () => {
  let actions = 0
  const rotation = startRuntimeRotation({ managed: false, reason: () => "native-budget", seal() {},
    async drain() { actions++ }, async close() { actions++ }, exit() { actions++ } })
  rotation.check()
  expect(rotation.status().state).toBe("restart-needed")
  expect(actions).toBe(0)
  rotation.stop()
})

test("late drain после deadline не закрывает host и не вызывает exit", async () => {
  let resolve!: () => void
  let actions = 0
  const late = new Promise<void>(done => { resolve = done })
  const rotation = startRuntimeRotation({ managed: true, reason: () => "native-budget", seal() {}, deadlineMs: 5,
    drain: () => late, async close() { actions++ }, exit() { actions++ } })
  rotation.check()
  await Bun.sleep(10)
  expect(rotation.status().state).toBe("blocked")
  resolve()
  await Promise.resolve()
  expect(actions).toBe(0)
  rotation.stop()
})

test("неподтверждённый close не разрешает exit после успешного drain", async () => {
  let exits = 0
  const rotation = startRuntimeRotation({ managed: true, reason: () => "native-budget", seal() {}, deadlineMs: 5,
    async drain() {}, close: () => new Promise(() => {}), exit() { exits++ } })
  rotation.check()
  await Bun.sleep(10)
  expect(rotation.status().state).toBe("blocked")
  expect(exits).toBe(0)
  rotation.stop()
})

test("managed restart с подтверждённым actor exit сохраняет quarantine вместо ложного drain complete", async () => {
  const stages: string[] = []
  let done!: () => void
  const finished = new Promise<void>(resolve => { done = resolve })
  const rotation = startRuntimeRotation({ managed: true, reason: () => "actor-quarantined", seal() { stages.push("seal") },
    async drain() { stages.push("drain-failed"); throw new Error("cleanup unknown") },
    async prepareRecoveryRestart() {
      stages.push("durable-quarantine-owned-exit")
      return { state: "restart-safe-quarantined", journalDurable: true, operationIds: ["operation:old"],
        nativeExit: { pid: 100, exitConfirmed: true, exitCode: 137 } }
    },
    async close() { stages.push("close") }, exit() { stages.push("exit"); done() } })
  rotation.check()
  await finished
  expect(stages).toEqual(["seal", "drain-failed", "durable-quarantine-owned-exit", "close", "exit"])
  expect(rotation.status()).toMatchObject({ state: "restarting", recovery: "restart-safe-quarantined" })
  rotation.stop()
})

test("зависший drain оставляет recovery budget; late drain не разрешает close до retained exit", async () => {
  let finishDrain!: () => void
  let finishRecovery!: () => void
  let enteredRecovery!: () => void
  let exited!: () => void
  let drainSignal: AbortSignal | undefined
  let recoverySignal: AbortSignal | undefined
  let closes = 0
  let exits = 0
  const drain = new Promise<void>(resolve => { finishDrain = resolve })
  const recovery = new Promise<void>(resolve => { finishRecovery = resolve })
  const recoveryStarted = new Promise<void>(resolve => { enteredRecovery = resolve })
  const finished = new Promise<void>(resolve => { exited = resolve })
  const rotation = startRuntimeRotation({ managed: true, reason: () => "quarantined", seal() {}, deadlineMs: 500, drainDeadlineMs: 5,
    drain(signal) { drainSignal = signal; return drain },
    async prepareRecoveryRestart(signal) {
      recoverySignal = signal
      enteredRecovery()
      await recovery
      return { state: "restart-safe-quarantined", journalDurable: true, operationIds: ["old:operation"],
        nativeExit: { pid: 100, exitConfirmed: true, exitCode: 137 } }
    },
    async close() { closes++ }, exit() { exits++; exited() },
  })
  try {
    rotation.check()
    await recoveryStarted
    expect(drainSignal?.aborted).toBe(true)
    expect(recoverySignal?.aborted).toBe(false)
    finishDrain()
    await Promise.resolve()
    await Promise.resolve()
    expect(closes).toBe(0)
    expect(exits).toBe(0)
    finishRecovery()
    await finished
    expect(closes).toBe(1)
    expect(exits).toBe(1)
    expect(rotation.status()).toMatchObject({ state: "restarting", recovery: "restart-safe-quarantined" })
  } finally { rotation.stop() }
}, 1000)

test("recovery после drain timeout всё ещё ограничен общим attempt deadline", async () => {
  let recoverySignal: AbortSignal | undefined
  let closes = 0
  const rotation = startRuntimeRotation({ managed: true, reason: () => "quarantined", seal() {}, deadlineMs: 30, drainDeadlineMs: 5,
    drain: () => new Promise(() => {}),
    prepareRecoveryRestart(signal) { recoverySignal = signal; return new Promise(() => {}) },
    async close() { closes++ }, exit() { closes++ },
  })
  try {
    rotation.check()
    await Bun.sleep(50)
    expect(recoverySignal?.aborted).toBe(true)
    expect(rotation.status().state).toBe("blocked")
    expect(closes).toBe(0)
  } finally { rotation.stop() }
})

test("recovery configuration не может отдать весь attempt budget drain фазе", () => {
  expect(() => startRuntimeRotation({ managed: true, reason: () => "quarantined", seal() {}, deadlineMs: 100, drainDeadlineMs: 100,
    async drain() {}, async prepareRecoveryRestart() { throw new Error("not called") }, async close() {}, exit() {},
  })).toThrow("резерва")
})
