import { expect, test } from "bun:test"
import { ClientDisconnectGrace } from "../src/client-grace.ts"
import { browserFixture } from "./browser-fixture.ts"

test("reconnect отменяет waiting grace, другой lineage очищается один раз", async () => {
  const cleaned: string[] = []
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  const grace = new ClientDisconnectGrace({ graceMs: 5, async cleanup(lineage) { cleaned.push(lineage); done() }, failed() {} })
  grace.disconnected("lineage:resumed")
  grace.connected("lineage:resumed")
  grace.disconnected("lineage:closed")
  grace.disconnected("lineage:closed")
  await completed
  expect(cleaned).toEqual(["lineage:closed"])
  await grace.close()
})

test("hung cleanup bounded и не повторяется автоматически", async () => {
  let calls = 0
  let failed!: () => void
  const failure = new Promise<void>(resolve => { failed = resolve })
  const grace = new ClientDisconnectGrace({ graceMs: 1, cleanupMs: 5,
    async cleanup() { calls++; return new Promise(() => {}) }, failed() { failed() } })
  grace.disconnected("lineage:hung")
  await failure
  await grace.close()
  expect(calls).toBe(1)
})

for (const cause of ["close", "expiry"] as const) {
  test(`${cause} client очищает только owned browser connection после grace`, async () => {
    const { runtime, driver, credential, initial, invoke, advance } = browserFixture({ clientGraceMs: 5 })
    const connected = await invoke(credential.session, `grace:${cause}`, { kind: "connect-instance", instance: initial }, 1)
    if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
    const instance = connected.result.value.value.instance.ref
    if ("deviceRef" in instance) throw new Error("Browser instance expected")
    let done!: () => void
    const cleaned = new Promise<void>(resolve => { done = resolve })
    const disconnect = driver.disconnect.bind(driver)
    driver.disconnect = async () => { await disconnect(); done() }
    try {
      if (cause === "close") await runtime.closeClientDurable(credential.session)
      else { advance(300_001); runtime.sweepClientExpiries() }
      await cleaned
      await runtime.drainClientGrace()
      expect(driver.connected).toBe(false)
      expect(driver.disconnectCalls).toBe(1)
      const resumed = await runtime.resumeClientDurable(credential.resumptionToken)
      expect((await runtime.reservations.inspect(resumed.session, { kind: "browser-instance", ref: instance }))?.state).toBe("released")
    } finally { await runtime.closeClientLifecycle() }
  })
}

test("resume до grace сохраняет owned connection без раннего disconnect", async () => {
  const { runtime, driver, credential, initial, invoke } = browserFixture({ clientGraceMs: 5 })
  await invoke(credential.session, "grace:resume", { kind: "connect-instance", instance: initial }, 1)
  await runtime.closeClientDurable(credential.session)
  await runtime.resumeClientDurable(credential.resumptionToken)
  await Bun.sleep(15)
  expect(driver.connected).toBe(true)
  expect(driver.disconnectCalls).toBe(0)
  await runtime.browserLifetime.shutdownLineage()
  await runtime.closeClientLifecycle()
})
