import { expect, test } from "bun:test"
import { browserFixture } from "./browser-fixture.ts"

test("shutdownLineage освобождает active и quarantined reservations через configured verifier", async () => {
  for (const mode of ["active", "quarantined"] as const) {
    const { runtime, driver, credential, initial, invoke, register } = browserFixture()
    const connected = await invoke(credential.session, `${mode}:connect`, { kind: "connect-instance", instance: initial }, 1)
    if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
    const instance = connected.result.value.value.instance.ref
    const effectBefore = (await runtime.getOperation(credential.session, connected.operation.context.operationId))!.outcome.effect
    register(instance, 2)
    if (mode === "quarantined") {
      driver.failOpen = true
      await invoke(credential.session, "shutdown:failed-child", {
        kind: "open-target",
        instance,
        url: "https://example.test",
        policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
        timeoutMs: 1_000,
      }, 2)
      expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("quarantined")
    }
    await runtime.browserLifetime.shutdownLineage(runtime.clients.lineage(credential.session))
    expect(driver.connected).toBe(false)
    expect(driver.disconnectCalls).toBe(1)
    expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("released")
    expect((await runtime.getOperation(credential.session, connected.operation.context.operationId))!.outcome.effect).toEqual(effectBefore)
  }
})

test("shutdownLineage failure quarantines reservation and does not forge released receipt", async () => {
  const { runtime, driver, credential, initial, invoke } = browserFixture()
  const connected = await invoke(credential.session, "failure:connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  driver.disconnect = async () => { throw new Error("physical cleanup failed") }
  await expect(runtime.browserLifetime.shutdownLineage(runtime.clients.lineage(credential.session))).rejects.toThrow("physical cleanup failed")
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("quarantined")
})

test("exact lineage shutdown не затрагивает чужую reservation", async () => {
  const { runtime, driver, credential, initial, invoke } = browserFixture()
  const connected = await invoke(credential.session, "lineage:connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  await runtime.browserLifetime.shutdownLineage("lineage:other")
  expect(driver.disconnectCalls).toBe(0)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("active")
})

test("shutdownLineage не вызывает verifier при active child", async () => {
  const { runtime, driver, credential, initial, invoke, register } = browserFixture()
  const connected = await invoke(credential.session, "child:connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  register(instance, 2)
  let release = () => {}
  driver.verifierGate = new Promise<void>(resolve => { release = resolve })
  const child = invoke(credential.session, "child:open", {
    kind: "open-target",
    instance,
    url: "https://example.test",
    policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
    timeoutMs: 1_000,
  }, 2)
  while (driver.openCalls === 0) await Promise.resolve()
  await expect(runtime.browserLifetime.shutdownLineage()).rejects.toThrow("drained child")
  expect(driver.disconnectCalls).toBe(0)
  release()
  await child
})

test("shutdownLineage не принимает caller verifier", () => {
  const { runtime } = browserFixture()
  expect(runtime.browserLifetime.shutdownLineage.length).toBeLessThanOrEqual(2)
  expect(runtime.browserLifetime).not.toHaveProperty("shutdownWithVerifier")
})

test("pre-aborted shutdown не вызывает cleanup и не меняет active reservation", async () => {
  const { runtime, driver, credential, initial, invoke } = browserFixture()
  const connected = await invoke(credential.session, "abort:connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  const controller = new AbortController()
  controller.abort()
  await expect(runtime.browserLifetime.shutdownLineage(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  expect(driver.disconnectCalls).toBe(0)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("active")
})
