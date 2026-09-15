import { CAPABILITY_IDS, CAPABILITY_POLICY, capabilitySetSchema, type CapabilityId, type CapabilitySet } from "@meta/shared/contracts"

const hostCapabilities: readonly CapabilityId[] = [
  "runtime.identity", "runtime.health", "runtime.transport", "runtime.arbitration", "runtime.operations", "mcp.catalog", "diagnostics.receipts",
]
const implementedNative: readonly CapabilityId[] = [
  "desktop.applications", "desktop.windows.all", "desktop.displays", "input.clipboard",
  "desktop.window.identity", "desktop.window.show", "desktop.window.lifecycle", "desktop.ax",
  "desktop.application.lifecycle",
  "capture.desktop", "capture.window", "capture.observation", "input.keyboard",
]
const browserCapabilities: readonly CapabilityId[] = [
  "browser.instances", "browser.targets", "browser.observe", "browser.readiness", "browser.resources", "android.chrome",
]

export function composeHostCapabilities(producerRef: string, native?: CapabilitySet, unavailableReason = "Native backend unavailable", browser?: CapabilitySet): CapabilitySet {
  const statuses = new Map(CAPABILITY_IDS.map(id => [id, {
    id, state: "unavailable" as "ready" | "unavailable" | "degraded" | "unsupported" | "unknown",
    reason: "Capability implementation не подключена к host",
  }]))
  for (const id of hostCapabilities) statuses.set(id, { id, state: "ready", reason: "Runtime implementation connected" })
  statuses.set("runtime.install", { id: "runtime.install", state: "unavailable",
    reason: "External installer owns artifact/signature/launchd/admin transaction; capability не исполняется через MCP" })
  for (const id of implementedNative) {
    const declared = native?.capabilities.find(capability => capability.id === id)
    statuses.set(id, declared === undefined ? { id, state: "unavailable", reason: unavailableReason }
      : { ...declared, reason: declared.reason ?? "Negotiated native implementation" })
  }
  for (const capability of browser?.capabilities ?? []) {
    if (!browserCapabilities.includes(capability.id)) throw new Error("Browser composition не может объявлять чужую capability")
    statuses.set(capability.id, { ...capability, reason: capability.reason ?? "Configured browser implementation" })
  }
  for (let pass = 0; pass < CAPABILITY_IDS.length; pass++) {
    for (const id of CAPABILITY_IDS) {
      const current = statuses.get(id)!
      if (current.state !== "ready") continue
      const missing = CAPABILITY_POLICY[id].dependencies.find(dependency => statuses.get(dependency)?.state !== "ready")
      if (missing !== undefined) statuses.set(id, { id, state: "unavailable", reason: `Required ${missing} unavailable` })
    }
  }
  return capabilitySetSchema.parse({ schemaVersion: "1", scope: "runtime", producerRef, capabilities: [...statuses.values()] })
}
