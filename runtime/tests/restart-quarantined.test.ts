import { expect, test } from "bun:test"
import { prepareQuarantinedRestart } from "../src/restart-quarantined.ts"

test("recovery restart сохраняет quarantine перед owned exit без cleanup-complete claim", async () => {
  const steps: string[] = []
  const receipt = await prepareQuarantinedRestart({
    seal() { steps.push("seal") },
    async retain() { steps.push("retain"); return { journalDurable: true, operationIds: ["operation:unknown"] } },
    async stopOwnedNative() { steps.push("exit"); return { pid: 100, exitConfirmed: true, exitCode: 137 } },
    async persistExit() { steps.push("persist-exit") },
  })
  expect(steps).toEqual(["seal", "retain", "exit", "persist-exit"])
  expect(receipt.state).toBe("restart-safe-quarantined")
  expect("cleanup" in receipt).toBe(false)
})

test("нельзя заменить живой actor или actor без durable send gates", async () => {
  let stops = 0
  const base = { seal() {}, async stopOwnedNative() { stops++; return { pid: 100, exitConfirmed: false, exitCode: null } }, async persistExit() {} }
  await expect(prepareQuarantinedRestart({ ...base, async retain() { throw new Error("journal missing") } })).rejects.toThrow("journal missing")
  expect(stops).toBe(0)
  await expect(prepareQuarantinedRestart({ ...base, async retain() { return { journalDurable: true, operationIds: [] } } })).rejects.toThrow("exit не подтверждён")
})

test("late owned-exit после deadline не получает restart receipt", async () => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let persisted = false
  await expect(prepareQuarantinedRestart({ deadlineMs: 5, seal() {},
    async retain() { return { journalDurable: true, operationIds: [] } },
    async stopOwnedNative() { await wait; return { pid: 100, exitConfirmed: true, exitCode: 0 } },
    async persistExit() { persisted = true },
  })).rejects.toThrow("deadline")
  release()
  await Promise.resolve()
  expect(persisted).toBe(false)
})
