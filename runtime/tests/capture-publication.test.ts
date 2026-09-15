import { expect, test } from "bun:test"
import { RuntimeCore } from "../src/core.ts"

test("capture reservation идемпотентна при concurrent retry и изолирована по lineage", async () => {
  const generation = { runtimeEpoch: "runtime:publication", loginSessionId: "login:publication" }
  const core = new RuntimeCore({ generation, runtimeBuildId: "build:publication" })
  const session = core.openClient("principal:publication").session
  const target = { kind: "browser-target" as const, ref: { ...generation,
    browserInstanceRef: "browser:publication", transportGeneration: "transport:publication", targetId: "target:publication", resourceRef: "resource:publication" } }
  core.targets.register(target, "inventory:publication", 1, "resolution:publication", "proof:publication", 1)
  const request = { clientRequestId: "request:publication", source: "browser-viewport" as const, captureTarget: target,
    capturePolicySha256: "a".repeat(64), inventoryId: "inventory:publication", inventoryRevision: 1, displayLayoutRevision: 1 }
  const [first, second] = await Promise.all([core.reserveCapturePublication(session, request), core.reserveCapturePublication(session, request)])
  expect(first).toEqual(second)
  await expect(core.reserveCapturePublication(session, { ...request, capturePolicySha256: "b".repeat(64) })).rejects.toThrow("другую reservation")
  const other = await core.reserveCapturePublication(core.openClient("principal:publication").session, request)
  expect(other.frameRef).not.toBe(first.frameRef)
  expect(other.cacheScopeRef).not.toBe(first.cacheScopeRef)
  expect(await core.getObservation(session)).toBeUndefined()
})
