import { expect, test } from "bun:test"
import {
  operationOutcomeSchema,
  runtimeOperationIntentSchema,
  type BrowserExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"

const generation = { runtimeEpoch: "runtime:reservation", loginSessionId: "login:reservation" }
const instance1 = {
  kind: "browser-instance" as const,
  ref: {
    ...generation,
    browserInstanceRef: "browser:reservation",
    transportGeneration: "cdp:1",
  },
}
const instance2 = { ...instance1, ref: { ...instance1.ref, transportGeneration: "cdp:2" } }
const target2 = {
  kind: "browser-target" as const,
  ref: {
    ...instance2.ref,
    targetId: "target:reservation",
    resourceRef: "browser-target:reservation",
  },
}
const deviceInstance1 = {
  kind: "device-browser-instance" as const,
  ref: {
    ...generation,
    deviceRef: "device:reservation",
    serial: "SERIAL-RESERVATION",
    transportGeneration: "usb:1",
    browserInstanceRef: "android-browser:reservation",
    browserTransportGeneration: "android-cdp:1",
  },
}
const deviceInstance2 = {
  ...deviceInstance1,
  ref: { ...deviceInstance1.ref, browserTransportGeneration: "android-cdp:2" },
}
const deviceTarget2 = {
  kind: "device-browser-target" as const,
  ref: {
    ...deviceInstance2.ref,
    targetId: "android-target:reservation",
    resourceRef: "android-target-resource:reservation",
  },
}

test("browser lifetime reservation survives resumption, gates child generation and releases by verified cleanup", async () => {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:reservation",
    completionVerifier: { async verify() {} },
  })
  runtime.targets.register(instance1, "browser-inventory:1", 1, "resolution:instance:1", "proof:instance:1", 0)
  const credential = runtime.openClient("principal:reservation")
  const connect = await runtime.runOperation(
    credential.session,
    intent("connect:1", instance1, "browser-inventory:1", 1),
    { connect: true },
    async () => ({ ok: true, value: { instance: instance2 }, outcome: noResourceOutcome() }),
  )
  const reservation = runtime.reservations.reserve({
    session: credential.session,
    operation: connect.operation,
    target: instance2,
    statusRevision: 1,
    ttlMs: 60_000,
  })
  const resumed = runtime.clients.resume(credential.resumptionToken)
  expect(runtime.reservations.resume(resumed.session, reservation.reservationId).reservationGeneration).toBe(reservation.reservationGeneration)
  const unrelated = runtime.openClient("principal:reservation")
  expect(() => runtime.reservations.resume(unrelated.session, reservation.reservationId)).toThrow("lineage")

  runtime.targets.register(target2, "browser-inventory:2", 2, "resolution:target:2", "proof:target:2", 0)
  const child = await runtime.runOperation(
    resumed.session,
    runtimeOperationIntentSchema.parse({
      intent: "read",
      clientRequestId: "child:2",
      precondition: { target: target2, inventoryId: "browser-inventory:2", inventoryRevision: 2 },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      requestedResources: [{ kind: "cdp-target", resourceRef: target2.ref.resourceRef }],
    }),
    { read: true },
    async context => {
      if (context.wire.kind !== "browser") throw new Error("browser context expected")
      const reserved = await runtime.reservations.assertChild({
        session: context.session,
        context: context as RuntimeOperationContext<BrowserExecutionContext>,
        target: target2,
      })
      return { ok: true, value: { reservationId: reserved.reservationId }, outcome: releasedOutcome(context.resources) }
    },
  )
  expect(child.result).toMatchObject({ ok: true, value: { reservationId: reservation.reservationId } })
  const target3 = {
    ...target2,
    ref: { ...target2.ref, transportGeneration: "cdp:3", resourceRef: "browser-target:reservation:3" },
  }
  runtime.reservations.quarantine(reservation.reservationId, reservation.externalGeneration, 2, "target inventory unavailable")
  await expect(runtime.reservations.assertChild({
    session: resumed.session,
    context: {
      wire: child.operation.context.kind === "browser" ? child.operation.context : (() => { throw new Error("browser context expected") })(),
      session: resumed.session,
      resources: [],
      control: { signal: new AbortController().signal, checkpoint() {} },
    },
    target: target2,
  })).rejects.toThrow("active exact")
  const report = {
    reservationId: reservation.reservationId,
    reservationGeneration: reservation.reservationGeneration,
    externalGeneration: reservation.externalGeneration,
    statusRevision: 3,
    cleanupEvidenceRef: "forward-removed:1",
  }
  let verifierCalls = 0
  const receipt = await runtime.reservations.release(resumed.session, report, {
    async verifyRemoval(handle, received) {
      verifierCalls++
      expect(handle.state).toBe("quarantined")
      expect(received.cleanupEvidenceRef).toBe("forward-removed:1")
    },
  })
  expect((await runtime.reservations.release(resumed.session, report, { async verifyRemoval() { throw new Error("duplicate must not verify") } })).receiptId).toBe(receipt.receiptId)
  expect(verifierCalls).toBe(1)

  runtime.targets.register(instance2, "browser-inventory:3", 3, "resolution:instance:2", "proof:instance:2", 0)
  const reconnect = await runtime.runOperation(
    resumed.session,
    intent("connect:2", instance2, "browser-inventory:3", 3),
    { connect: true },
    async () => ({ ok: true, value: { instance: target3.ref }, outcome: noResourceOutcome() }),
  )
  const reservation3 = runtime.reservations.reserve({
    session: resumed.session,
    operation: reconnect.operation,
    target: { kind: "browser-instance", ref: {
      runtimeEpoch: target3.ref.runtimeEpoch,
      loginSessionId: target3.ref.loginSessionId,
      browserInstanceRef: target3.ref.browserInstanceRef,
      transportGeneration: target3.ref.transportGeneration,
    } },
    statusRevision: 1,
    ttlMs: 60_000,
  })
  await expect(runtime.reservations.release(resumed.session, {
    ...report,
    externalGeneration: reservation3.externalGeneration,
  }, { async verifyRemoval() {} })).rejects.toThrow("conflicting facts")
  expect(runtime.reservations.resume(resumed.session, reservation3.reservationId).state).toBe("active")
})

test("ADB device reservation quarantines list failure and releases only confirmed owned forward", async () => {
  const runtime = new RuntimeCore({
    generation,
    runtimeBuildId: "runtime-build:device-reservation",
    completionVerifier: { async verify() {} },
  })
  runtime.targets.register(deviceInstance1, "device-inventory:1", 1, "resolution:device:1", "proof:device:1", 0)
  const client = runtime.openClient("principal:device-reservation")
  const connect = await runtime.runOperation(
    client.session,
    runtimeOperationIntentSchema.parse({
      intent: "mutation",
      clientRequestId: "device-connect:1",
      precondition: { target: deviceInstance1, inventoryId: "device-inventory:1", inventoryRevision: 1 },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      requestedResources: [
        { kind: "cdp-target", resourceRef: deviceTarget2.ref.resourceRef },
        { kind: "adb-device", resourceRef: deviceTarget2.ref.deviceRef },
      ],
    }),
    { connect: true },
    async () => ({ ok: true, value: { instance: deviceInstance2 }, outcome: noResourceOutcome() }),
  )
  const reservation = runtime.reservations.reserve({
    session: client.session,
    operation: connect.operation,
    target: deviceInstance2,
    statusRevision: 1,
    ttlMs: 60_000,
  })
  runtime.targets.register(deviceTarget2, "device-inventory:2", 2, "resolution:device-target:2", "proof:device-target:2", 0)
  const child = await runtime.runOperation(
    client.session,
    runtimeOperationIntentSchema.parse({
      intent: "read",
      clientRequestId: "device-child:2",
      precondition: { target: deviceTarget2, inventoryId: "device-inventory:2", inventoryRevision: 2 },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      requestedResources: [],
    }),
    { list: true },
    async context => {
      if (context.wire.kind !== "device") throw new Error("device context expected")
      await runtime.reservations.assertChild({
        session: context.session,
        context: context as RuntimeOperationContext<import("@meta/shared/contracts").DeviceExecutionContext>,
        target: deviceTarget2,
      })
      return { ok: true, value: { listed: true }, outcome: releasedOutcome(context.resources) }
    },
  )
  expect(child.operation.state).toBe("completed")
  runtime.reservations.quarantine(
    reservation.reservationId,
    reservation.externalGeneration,
    2,
    "ADB target list failed after USB reconnect",
  )
  const report = {
    reservationId: reservation.reservationId,
    reservationGeneration: reservation.reservationGeneration,
    externalGeneration: reservation.externalGeneration,
    statusRevision: 3,
    cleanupEvidenceRef: "adb-forward-removed:reservation",
  }
  const receipt = await runtime.reservations.release(client.session, report, {
    async verifyRemoval(handle, cleanup) {
      expect(handle.target.kind).toBe("device-browser-instance")
      expect(cleanup.cleanupEvidenceRef).toBe("adb-forward-removed:reservation")
    },
  })
  expect(receipt.state).toBe("released")
  await expect(runtime.reservations.release(client.session, {
    ...report,
    reservationGeneration: "reservation-generation:foreign",
  }, { async verifyRemoval() {} })).rejects.toThrow("conflicting facts")
})

function intent(
  clientRequestId: string,
  target: typeof instance1 | typeof target2,
  inventoryId: string,
  inventoryRevision: number,
) {
  return runtimeOperationIntentSchema.parse({
    intent: "mutation",
    clientRequestId,
    precondition: { target, inventoryId, inventoryRevision },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    requestedResources: [],
  })
}

function noResourceOutcome() {
  return operationOutcomeSchema.parse({
    dispatch: "none",
    targetVerified: "verified",
    userInterference: "none-observed",
    observation: "available",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: { scope: "none", state: "complete", resources: [] },
    restoration: "not-applicable",
    dispatchAttempts: 0,
  })
}

function releasedOutcome(handles: RuntimeOperationContext["resources"]) {
  return operationOutcomeSchema.parse({
    dispatch: "none",
    targetVerified: "verified",
    userInterference: "none-observed",
    observation: "available",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: {
      scope: "owned",
      state: "complete",
      resources: handles.map(handle => ({ handle, outcome: "released" })),
    },
    restoration: "not-applicable",
    dispatchAttempts: 0,
  })
}
