import { expect, test } from "bun:test"
import { lifetimeReservationHandleSchema, runtimeOperationIntentSchema } from "@meta/shared/contracts"
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
  advance(6000)
  const recovery = await runtime.browserLifetime.recover(resumed.session, "browser", runtimeOperationIntentSchema.parse({
    intent: "admin", clientRequestId: "recover:expiry", precondition: { target, inventoryId: "inventory:2", inventoryRevision: 2 },
    deadlineAt: new Date(Date.now() + 10000).toISOString(), requestedResources: [],
  }))
  expect(recovery.operation.state).toBe("completed")
  expect(driver.connected).toBe(false)
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
  const recoveryIntent = runtimeOperationIntentSchema.parse({
    intent: "admin", clientRequestId: "recover:1",
    precondition: { target: { kind: "browser-instance", ref: instance }, inventoryId: "inventory:2", inventoryRevision: 2 },
    deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [],
  })
  const recovered = await runtime.browserLifetime.recover(credential.session, "browser", recoveryIntent)
  expect(recovered.operation.state).toBe("completed")
  expect(driver.connected).toBe(false)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("released")
  expect(runtime.resources.handlesForOperation(failed.operation.context.operationId)).toHaveLength(0)
  expect((await runtime.getOperation(credential.session, failed.operation.context.operationId))?.outcome.cleanup.state).toBe("complete")
  const repeated = await runtime.browserLifetime.recover(credential.session, "browser", recoveryIntent)
  expect(repeated.operation.context.operationId).toBe(recovered.operation.context.operationId)
  expect(driver.disconnectCalls).toBe(1)
  const reconnected = await invoke(credential.session, "connect:new-generation", { kind: "connect-instance", instance }, 2)
  expect(reconnected.operation.state).toBe("completed")
  if (!reconnected.result.ok || reconnected.result.value.value.kind !== "instance-connected") throw new Error("reconnect failed")
  const next = reconnected.result.value.value.instance.ref
  if ("deviceRef" in next) throw new Error("browser expected")
  const staleRecovery = await runtime.browserLifetime.recover(credential.session, "browser", {
    ...recoveryIntent, clientRequestId: "recover:stale-generation",
  })
  expect(staleRecovery.operation.state).toBe("rejected")
  expect(driver.disconnectCalls).toBe(1)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: next }))?.state).toBe("active")
})

test("device transport generations остаются отдельными полями при colon и maximum length", () => {
  const shape = lifetimeReservationHandleSchema.shape.externalGeneration
  const first = shape.parse({ kind: "device-browser", deviceTransportGeneration: "a:b", browserTransportGeneration: "c" })
  const second = shape.parse({ kind: "device-browser", deviceTransportGeneration: "a", browserTransportGeneration: "b:c" })
  expect(first).not.toEqual(second)
  expect(shape.safeParse({ kind: "device-browser", deviceTransportGeneration: "u".repeat(64), browserTransportGeneration: "b".repeat(64) }).success).toBe(true)
})
