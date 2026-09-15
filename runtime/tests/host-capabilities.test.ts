import { expect, test } from "bun:test"
import { CAPABILITY_IDS, capabilityIsReady } from "@meta/shared/contracts"
import { composeHostCapabilities } from "../src/host-capabilities.ts"

test("host browser capabilities отдельны от Native permissions и не подменяют чужого owner", () => {
  const browser = { schemaVersion: "1" as const, scope: "adapter" as const, producerRef: "browser:fixture", capabilities: [
    { id: "browser.instances" as const, state: "ready" as const },
    { id: "browser.resources" as const, state: "ready" as const },
    { id: "browser.targets" as const, state: "ready" as const },
    { id: "browser.observe" as const, state: "ready" as const },
  ] }
  const snapshot = composeHostCapabilities("host", undefined, "Native permission missing", browser)
  expect(capabilityIsReady(snapshot, "browser.instances")).toBe(true)
  expect(capabilityIsReady(snapshot, "desktop.windows.all")).toBe(false)
  expect(() => composeHostCapabilities("host", undefined, undefined, { ...browser, capabilities: [{ id: "input.pointer", state: "ready" }] })).toThrow("чужую capability")
})

test("полный Native handshake не объявляет отсутствующие Runtime bindings", () => {
  const native = {
    schemaVersion: "1" as const,
    scope: "adapter" as const,
    producerRef: "native:fixture",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })),
  }
  const preparing = composeHostCapabilities("host", native)
  const ready = composeHostCapabilities("host", native, undefined, undefined, true)
  expect(capabilityIsReady(preparing, "input.keyboard")).toBe(false)
  expect(capabilityIsReady(preparing, "runtime.user-interference")).toBe(false)
  expect(capabilityIsReady(ready, "input.keyboard")).toBe(true)
  expect(capabilityIsReady(ready, "runtime.user-interference")).toBe(true)
  for (const id of ["capture.desktop", "capture.window", "capture.observation", "desktop.application.lifecycle", "input.readiness"] as const) {
    expect(capabilityIsReady(ready, id)).toBe(true)
  }
  for (const id of ["input.interaction", "input.pointer", "input.drag"] as const) {
    expect(capabilityIsReady(ready, id)).toBe(false)
  }
})
