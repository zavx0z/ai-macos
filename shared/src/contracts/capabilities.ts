import { z } from "zod"
import { opaqueIdSchema } from "./identities.ts"

export const CAPABILITY_SCHEMA_VERSION = "1" as const

export const CAPABILITY_IDS = [
  "runtime.identity",
  "runtime.health",
  "runtime.install",
  "runtime.transport",
  "runtime.arbitration",
  "runtime.operations",
  "runtime.user-interference",
  "desktop.applications",
  "desktop.application.lifecycle",
  "desktop.windows.all",
  "desktop.window.identity",
  "desktop.window.show",
  "desktop.window.lifecycle",
  "desktop.displays",
  "desktop.ax",
  "capture.desktop",
  "capture.window",
  "capture.observation",
  "input.pointer",
  "input.drag",
  "input.keyboard",
  "input.readiness",
  "input.interaction",
  "input.clipboard",
  "browser.instances",
  "browser.targets",
  "browser.observe",
  "browser.readiness",
  "browser.resources",
  "android.chrome",
  "mcp.catalog",
  "diagnostics.receipts",
] as const

export const capabilityIdSchema = z.enum(CAPABILITY_IDS)
export type CapabilityId = z.infer<typeof capabilityIdSchema>

export const CAPABILITY_STATES = ["ready", "unavailable", "degraded", "unsupported", "unknown"] as const
export const capabilityStateSchema = z.enum(CAPABILITY_STATES)
export type CapabilityState = z.infer<typeof capabilityStateSchema>

export const CAPABILITY_POLICY = {
  "runtime.identity": { dependencies: [], action: "read" },
  "runtime.health": { dependencies: ["runtime.identity"], action: "read" },
  "runtime.install": { dependencies: ["runtime.identity", "runtime.health"], action: "admin" },
  "runtime.transport": { dependencies: ["runtime.identity"], action: "read" },
  "runtime.arbitration": { dependencies: ["runtime.identity", "runtime.transport"], action: "mutation" },
  "runtime.operations": { dependencies: ["runtime.arbitration"], action: "mutation" },
  "runtime.user-interference": { dependencies: ["runtime.identity"], action: "read" },
  "desktop.applications": { dependencies: ["runtime.identity"], action: "read" },
  "desktop.application.lifecycle": { dependencies: ["desktop.applications", "runtime.operations"], action: "mixed" },
  "desktop.windows.all": { dependencies: ["desktop.applications"], action: "read" },
  "desktop.window.identity": { dependencies: ["desktop.windows.all"], action: "read" },
  "desktop.window.show": { dependencies: ["desktop.window.identity", "runtime.arbitration"], action: "mutation" },
  "desktop.window.lifecycle": { dependencies: ["desktop.window.identity", "runtime.arbitration"], action: "mutation" },
  "desktop.displays": { dependencies: ["runtime.identity"], action: "read" },
  "desktop.ax": { dependencies: ["desktop.window.identity"], action: "mixed" },
  "capture.desktop": { dependencies: ["desktop.displays"], action: "read" },
  "capture.window": { dependencies: ["desktop.window.identity"], action: "read" },
  "capture.observation": { dependencies: ["runtime.identity"], action: "read" },
  "input.pointer": { dependencies: ["capture.observation", "runtime.operations"], action: "mutation" },
  "input.drag": { dependencies: ["input.pointer"], action: "mutation" },
  "input.keyboard": { dependencies: ["desktop.window.identity", "runtime.operations"], action: "mutation" },
  "input.readiness": { dependencies: ["runtime.identity"], action: "mixed" },
  "input.interaction": { dependencies: ["runtime.operations", "runtime.user-interference"], action: "mutation" },
  "input.clipboard": { dependencies: ["runtime.operations"], action: "mutation" },
  "browser.instances": { dependencies: ["runtime.identity"], action: "read" },
  "browser.targets": { dependencies: ["browser.instances"], action: "mixed" },
  "browser.observe": { dependencies: ["browser.targets"], action: "read" },
  "browser.readiness": { dependencies: ["browser.targets"], action: "read" },
  "browser.resources": { dependencies: ["browser.targets", "runtime.arbitration"], action: "mutation" },
  "android.chrome": { dependencies: ["runtime.identity"], action: "mixed" },
  "mcp.catalog": { dependencies: ["runtime.health", "runtime.transport"], action: "read" },
  "diagnostics.receipts": { dependencies: ["runtime.operations"], action: "read" },
} as const satisfies Record<CapabilityId, {
  dependencies: readonly CapabilityId[]
  action: "read" | "mutation" | "mixed" | "admin"
}>

export const capabilitySchema = z.strictObject({
  id: capabilityIdSchema,
  state: capabilityStateSchema,
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((capability, context) => {
  if (capability.state !== "ready" && capability.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: `reason обязателен для ${capability.state}` })
  }
})
export type Capability = z.infer<typeof capabilitySchema>

const capabilitySetShape = z.strictObject({
  schemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  scope: z.enum(["runtime", "adapter"]),
  producerRef: opaqueIdSchema,
  capabilities: z.array(capabilitySchema).max(CAPABILITY_IDS.length),
})

export const capabilitySetSchema = capabilitySetShape.superRefine((set, context) => {
  const ids = set.capabilities.map(capability => capability.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "capability ID не должен повторяться" })
  }
  if (set.scope === "runtime") {
    for (const id of CAPABILITY_IDS) {
      if (!ids.includes(id)) context.addIssue({ code: "custom", path: ["capabilities"], message: `runtime snapshot не содержит ${id}` })
    }
  }
})
export type CapabilitySet = z.infer<typeof capabilitySetSchema>

export function capabilityStatus(set: CapabilitySet, id: CapabilityId): Capability | undefined {
  return set.capabilities.find(capability => capability.id === id)
}

export function capabilityIsLocallyReady(set: CapabilitySet, id: CapabilityId): boolean {
  return capabilityStatus(set, id)?.state === "ready"
}

export function capabilityIsReady(set: CapabilitySet, id: CapabilityId): boolean {
  if (set.scope !== "runtime") return false
  const visit = (current: CapabilityId, ancestors: ReadonlySet<CapabilityId>): boolean => {
    if (ancestors.has(current) || capabilityStatus(set, current)?.state !== "ready") return false
    const next = new Set(ancestors).add(current)
    return CAPABILITY_POLICY[current].dependencies.every(dependency => visit(dependency, next))
  }
  return visit(id, new Set())
}

export function unavailableCapabilities(set: CapabilitySet): Capability[] {
  return set.capabilities.filter(capability => !capabilityIsReady(set, capability.id))
}
