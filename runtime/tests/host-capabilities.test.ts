import { expect, test } from "bun:test"
import { capabilityIsReady } from "@meta/shared/contracts"
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
