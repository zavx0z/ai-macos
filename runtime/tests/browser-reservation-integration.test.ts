import { expect, test } from "bun:test"
import { browserFixture } from "./browser-fixture.ts"
import { runtimeOperationIntentSchema, type BrowserExecutionContext, type RuntimeOperationContext } from "@meta/shared/contracts"

test("raw runOperation не допускает first/second connect и intent read обход", async () => {
  const { runtime, driver, credential, initial, adapter, invoke, register } = browserFixture()
  const raw = (instance: typeof initial, revision: number, intent: "mutation" | "read") => runtime.runOperation(
    credential.session,
    runtimeOperationIntentSchema.parse({
      intent,
      clientRequestId: `raw:${revision}:${intent}`,
      precondition: { target: { kind: "browser-instance", ref: instance }, inventoryId: `inventory:${revision}`, inventoryRevision: revision },
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      requestedResources: [{ kind: "cdp-target", resourceRef: instance.browserInstanceRef }],
    }),
    { kind: "connect-instance" as const, instance },
    (context, request) => adapter.execute(context as RuntimeOperationContext<BrowserExecutionContext>, request),
  )
  await expect(raw(initial, 1, "mutation")).rejects.toThrow("lifetime coordinator")
  await expect(raw(initial, 1, "read")).rejects.toThrow("lifetime coordinator")
  expect(driver.connectCalls).toBe(0)
  const connected = await invoke(credential.session, "connect:owned", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  if ("deviceRef" in instance) throw new Error("browser expected")
  register(instance, 2)
  await expect(raw(instance, 2, "mutation")).rejects.toThrow("lifetime coordinator")
  await expect(raw(instance, 2, "read")).rejects.toThrow("lifetime coordinator")
  expect(driver.connectCalls).toBe(1)
})

test("coordinator резервирует до connect, автоматически допускает child и освобождает после disconnect", async () => {
  const { runtime, driver, credential, initial, invoke, register } = browserFixture()
  const connect = await invoke(credential.session, "connect:1", { kind: "connect-instance", instance: initial }, 1)
  expect(connect.operation.state).toBe("completed")
  if (!connect.result.ok || connect.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connect.result.value.value.instance.ref
  if (!("transportGeneration" in instance) || "deviceRef" in instance) throw new Error("browser instance expected")
  const reservation = await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance })
  expect(reservation?.state).toBe("active")
  register(instance, 2)
  const second = await invoke(credential.session, "connect:2", { kind: "connect-instance", instance }, 2)
  expect(second.operation.state).toBe("rejected")
  expect(driver.connectCalls).toBe(1)
  const open = await invoke(credential.session, "open:1", {
    kind: "open-target", instance, url: "https://example.com", timeoutMs: 1000,
    policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] },
  }, 2)
  expect(open.operation.state).toBe("completed")
  expect(driver.openCalls).toBe(1)
  const disconnect = await invoke(credential.session, "disconnect:1", { kind: "disconnect-instance", instance }, 2)
  expect(disconnect.operation.state).toBe("completed")
  expect(driver.disconnectCalls).toBe(1)
  expect((await runtime.reservations.inspect(credential.session, { kind: "browser-instance", ref: instance }))?.state).toBe("released")
  const replay = await invoke(credential.session, "disconnect:1", { kind: "disconnect-instance", instance }, 2)
  expect(replay.operation.context.operationId).toBe(disconnect.operation.context.operationId)
  expect(driver.disconnectCalls).toBe(1)
})

test("in-flight connect блокирует другую lineage до второго driver call", async () => {
  const { runtime, driver, credential, initial, invoke } = browserFixture()
  let release!: () => void
  driver.verifierGate = new Promise<void>(resolve => { release = resolve })
  const running = invoke(credential.session, "connect:pending", { kind: "connect-instance", instance: initial }, 1)
  while (driver.connectCalls === 0) await Promise.resolve()
  const other = runtime.openClient("principal:lifetime")
  await expect(invoke(other.session, "connect:other", { kind: "connect-instance", instance: initial }, 1)).rejects.toThrow("Resource занят")
  release()
  expect((await running).operation.state).toBe("completed")
  expect(driver.connectCalls).toBe(1)
})
