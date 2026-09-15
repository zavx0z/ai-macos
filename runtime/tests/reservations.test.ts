import { expect, test } from "bun:test"
import { lifetimeReservationHandleSchema } from "@meta/shared/contracts"
import { browserFixture } from "./browser-fixture.ts"

test("reservation mutations не принимают caller journal/verifier и binding immutable", () => {
  const { runtime, adapter, verifier } = browserFixture()
  expect(runtime.reservations).not.toHaveProperty("reserve")
  expect(runtime.reservations).not.toHaveProperty("release")
  expect(runtime.reservations).not.toHaveProperty("quarantine")
  expect(() => runtime.browserLifetime.configure("browser", { domain: "browser", adapter, verifier })).toThrow("immutable")
})

test("expiry quarantines reservation; resume требует active session той же lineage", async () => {
  const { runtime, driver, credential, initial, invoke, register, advance } = browserFixture({ ttlMs: 100 })
  const connected = await invoke(credential.session, "connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  if (!("transportGeneration" in instance) || "deviceRef" in instance) throw new Error("browser expected")
  const target = { kind: "browser-instance" as const, ref: instance }
  const reservation = await runtime.reservations.inspect(credential.session, target)
  if (reservation === undefined) throw new Error("reservation missing")
  const resumed = runtime.clients.resume(credential.resumptionToken)
  expect((await runtime.reservations.resume(resumed.session, reservation.reservationId)).state).toBe("active")
  await expect(runtime.reservations.resume(credential.session, reservation.reservationId)).rejects.toThrow("отключена")
  const stranger = runtime.openClient("principal:lifetime")
  await expect(runtime.reservations.resume(stranger.session, reservation.reservationId)).rejects.toThrow("lineage")
  register(instance, 2)
  advance(101)
  expect((await runtime.reservations.inspect(resumed.session, target))?.state).toBe("quarantined")
  const reconnect = await invoke(resumed.session, "reconnect:expired", { kind: "connect-instance", instance }, 2)
  expect(reconnect.operation.state).toBe("rejected")
  expect(driver.connectCalls).toBe(1)
  runtime.clients.revokePrincipal(resumed.session.principalId)
  await expect(runtime.reservations.inspect(resumed.session, target)).rejects.toThrow("отозвана")
})

test("failed child operation quarantines lifetime connection", async () => {
  const { runtime, driver, credential, initial, invoke, register } = browserFixture()
  const connected = await invoke(credential.session, "connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  if (!("transportGeneration" in instance) || "deviceRef" in instance) throw new Error("browser expected")
  register(instance, 2)
  driver.failOpen = true
  const failed = await invoke(credential.session, "open:fail", {
    kind: "open-target", instance, url: "https://example.com", timeoutMs: 100,
    policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
  }, 2)
  expect(failed.result.ok).toBe(false)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("quarantined")
})

test("device transport generations остаются отдельными полями при colon и maximum length", () => {
  const shape = lifetimeReservationHandleSchema.shape.externalGeneration
  const first = shape.parse({ kind: "device-browser", deviceTransportGeneration: "a:b", browserTransportGeneration: "c" })
  const second = shape.parse({ kind: "device-browser", deviceTransportGeneration: "a", browserTransportGeneration: "b:c" })
  expect(first).not.toEqual(second)
  expect(shape.safeParse({ kind: "device-browser", deviceTransportGeneration: "u".repeat(64), browserTransportGeneration: "b".repeat(64) }).success).toBe(true)
})
