import { z } from "zod"
import { generationIdSchema, opaqueIdSchema } from "./identities.ts"
import { isoTimestampSchema, structurallyEqual } from "./schema.ts"

export const RUNTIME_RESOURCE_KINDS = [
  "desktop-input",
  "clipboard",
  "cdp-target",
  "browser-trace",
  "adb-device",
  "capture-stream",
] as const

export const runtimeResourceKindSchema = z.enum(RUNTIME_RESOURCE_KINDS)
export type RuntimeResourceKind = z.infer<typeof runtimeResourceKindSchema>

export const DESKTOP_INPUT_RESOURCE_REF = "desktop" as const
export const CLIPBOARD_RESOURCE_REF = "system" as const

export const runtimeResourceRefSchema = z.strictObject({
  kind: runtimeResourceKindSchema,
  resourceRef: opaqueIdSchema,
})
export type RuntimeResourceRef = z.infer<typeof runtimeResourceRefSchema>

export const runtimeResourceHandleSchema = runtimeResourceRefSchema.extend({
  leaseId: opaqueIdSchema,
  leaseGeneration: generationIdSchema,
  operationId: opaqueIdSchema,
  clientSessionId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  expiresAt: isoTimestampSchema,
  state: z.enum(["active", "revoked", "quarantined"]),
}).strict()
export type RuntimeResourceHandle = z.infer<typeof runtimeResourceHandleSchema>

export const cleanupStateSchema = z.enum(["complete", "incomplete", "unknown"])
export type CleanupState = z.infer<typeof cleanupStateSchema>

const terminalCleanupResourceSchema = z.strictObject({
  handle: runtimeResourceHandleSchema,
  outcome: z.enum(["released", "quarantined"]),
})

const heldCleanupResourceSchema = z.strictObject({
  handle: runtimeResourceHandleSchema,
  outcome: z.literal("held"),
})

const ownedCleanupOutcomeSchema = z.strictObject({
  scope: z.literal("owned"),
  state: cleanupStateSchema,
  resources: z.array(terminalCleanupResourceSchema).min(1).max(64),
  reason: z.string().min(1).max(1_024).optional(),
}).superRefine((cleanup, context) => {
  const leaseIds = cleanup.resources.map(resource => resource.handle.leaseId)
  if (new Set(leaseIds).size !== leaseIds.length) {
    context.addIssue({ code: "custom", path: ["resources"], message: "lease не должен повторяться" })
  }
  const hasQuarantine = cleanup.resources.some(resource => resource.outcome === "quarantined")
  if (cleanup.state === "complete" && hasQuarantine) {
    context.addIssue({ code: "custom", path: ["resources"], message: "complete cleanup не может содержать quarantine" })
  }
  if (cleanup.state !== "complete" && !hasQuarantine) {
    context.addIssue({ code: "custom", path: ["resources"], message: "неполный cleanup должен назвать quarantined resource" })
  }
  if (cleanup.state !== "complete" && cleanup.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "неполный cleanup требует reason" })
  }
})

const pendingCleanupOutcomeSchema = z.strictObject({
  scope: z.literal("owned"),
  state: z.literal("pending"),
  resources: z.array(heldCleanupResourceSchema).min(1).max(64),
}).superRefine((cleanup, context) => {
  const leaseIds = cleanup.resources.map(resource => resource.handle.leaseId)
  if (new Set(leaseIds).size !== leaseIds.length) {
    context.addIssue({ code: "custom", path: ["resources"], message: "held lease не должен повторяться" })
  }
})

export const cleanupOutcomeSchema = z.union([
  z.strictObject({
    scope: z.literal("none"),
    state: z.literal("complete"),
    resources: z.tuple([]),
  }),
  ownedCleanupOutcomeSchema,
  pendingCleanupOutcomeSchema,
])
export type CleanupOutcome = z.infer<typeof cleanupOutcomeSchema>

export const cleanupAuthorityReceiptSchema = z.strictObject({
  receiptId: opaqueIdSchema,
  authorityRef: opaqueIdSchema,
  operationId: opaqueIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  issuedAt: isoTimestampSchema,
  state: z.literal("complete"),
  leases: z.array(z.strictObject({
    leaseId: opaqueIdSchema,
    leaseGeneration: generationIdSchema,
  })).max(64),
}).superRefine((receipt, context) => {
  const leaseIds = receipt.leases.map(lease => lease.leaseId)
  if (new Set(leaseIds).size !== leaseIds.length) {
    context.addIssue({ code: "custom", path: ["leases"], message: "cleanup receipt lease не должен повторяться" })
  }
})
export type CleanupAuthorityReceipt = z.infer<typeof cleanupAuthorityReceiptSchema>

const resourceOrder: Readonly<Record<RuntimeResourceKind, number>> = {
  "desktop-input": 0,
  clipboard: 1,
  "cdp-target": 2,
  "browser-trace": 3,
  "adb-device": 4,
  "capture-stream": 5,
}

export function sortRuntimeResources(resources: readonly RuntimeResourceRef[]): RuntimeResourceRef[] {
  return [...resources].sort((left, right) => {
    const kindDifference = resourceOrder[left.kind] - resourceOrder[right.kind]
    return kindDifference === 0 ? left.resourceRef.localeCompare(right.resourceRef) : kindDifference
  })
}

export type ResourceAuthorityRequest = {
  handle: RuntimeResourceHandle
  operationId: string
  clientSessionId: string
  principalId: string
  runtimeEpoch: string
  loginSessionId: string
  now: Date
}

export interface ResourceAuthority {
  assertActive(request: ResourceAuthorityRequest): Promise<void>
  assertOwnedSet(operationId: string, handles: readonly RuntimeResourceHandle[]): Promise<void>
}

export interface CleanupAuthority {
  verify(receipt: CleanupAuthorityReceipt, handles: readonly RuntimeResourceHandle[]): Promise<void>
}

export async function requireAuthorizedResourceHandles(
  authority: ResourceAuthority,
  handles: readonly RuntimeResourceHandle[],
  owner: Omit<ResourceAuthorityRequest, "handle">,
  required: readonly RuntimeResourceRef[],
): Promise<void> {
  for (const requirement of required) {
    const handle = handles.find(candidate => candidate.kind === requirement.kind && candidate.resourceRef === requirement.resourceRef)
    if (handle === undefined) throw new Error(`Не выдан resource handle ${requirement.kind}:${requirement.resourceRef}`)
    await authority.assertActive({ ...owner, handle })
  }
}

export async function assertCleanupOwnsExactHandles(
  authority: ResourceAuthority,
  operationId: string,
  handles: readonly RuntimeResourceHandle[],
  cleanup: CleanupOutcome,
): Promise<void> {
  await authority.assertOwnedSet(operationId, handles)
  if (handles.length === 0) {
    if (cleanup.scope !== "none") throw new Error("Cleanup объявил ресурсы для операции без lease")
    return
  }
  if (cleanup.scope !== "owned") throw new Error("Cleanup потерял принадлежащие операции ресурсы")
  const expected = new Set(handles.map(handle => handle.leaseId))
  const actual = new Set(cleanup.resources.map(resource => resource.handle.leaseId))
  if (expected.size !== actual.size || [...expected].some(leaseId => !actual.has(leaseId))) {
    throw new Error("Cleanup не является точным partition ресурсов операции")
  }
  for (const resource of cleanup.resources) {
    const issued = handles.find(handle => handle.leaseId === resource.handle.leaseId)
    if (issued === undefined || !structurallyEqual(issued, resource.handle)) {
      throw new Error("Cleanup содержит невыданный или изменённый resource handle")
    }
  }
}

export function cleanupCoversExactHandles(
  handles: readonly RuntimeResourceHandle[],
  cleanup: CleanupOutcome,
): boolean {
  if (handles.length === 0) return cleanup.scope === "none"
  if (cleanup.scope !== "owned" || cleanup.resources.length !== handles.length) return false
  return handles.every(handle => cleanup.resources.some(resource => {
    return resource.handle.leaseId === handle.leaseId && structurallyEqual(resource.handle, handle)
  }))
}
