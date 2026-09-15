import { expect, test } from "bun:test"
import { runtimeOperationIntentSchema } from "@meta/shared/contracts"
import { browserFixture } from "./browser-fixture.ts"

test("sealed runtime допускает только coordinator-owned cleanup и остаётся sealed", async () => {
  const { runtime, driver, credential, initial, invoke, register } = browserFixture()
  const connected = await invoke(credential.session, "sealed:connect", { kind: "connect-instance", instance: initial }, 1)
  if (!connected.result.ok || connected.result.value.value.kind !== "instance-connected") throw new Error("connect failed")
  const instance = connected.result.value.value.instance.ref
  if ("deviceRef" in instance) throw new Error("Browser instance expected")
  register(instance, 2)
  driver.failOpen = true
  await invoke(credential.session, "sealed:failed", { kind: "open-target", instance, url: "https://example.test",
    policy: { policyId: "empty", requiredSteps: [], disabledSteps: [] }, timeoutMs: 1000 }, 2)
  runtime.sealAdmission()
  const recovery = await runtime.browserLifetime.recover(credential.session, "browser", runtimeOperationIntentSchema.parse({
    intent: "admin", clientRequestId: "sealed:recover", precondition: { target: { kind: "browser-instance", ref: instance },
      inventoryId: "inventory:2", inventoryRevision: 2 }, deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [],
  }))
  expect(recovery.operation.state).toBe("completed")
  expect(driver.connected).toBe(false)
  expect(runtime.admissionSealed).toBe(true)
  await expect(invoke(credential.session, "sealed:reconnect", { kind: "connect-instance", instance }, 2)).rejects.toThrow("sealed")
})
