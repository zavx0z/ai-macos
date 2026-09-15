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
