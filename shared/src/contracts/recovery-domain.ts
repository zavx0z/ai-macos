import { z } from "zod"
import { generationIdSchema, opaqueIdSchema } from "./identities.ts"

export const RECOVERY_DOMAIN_VERSION = "1" as const
export const recoveryHoldSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key"), code: z.number().int().min(0).max(65535) }),
  z.strictObject({ kind: z.literal("button"), code: z.number().int().min(0).max(2) }),
])
export const nativeRecoveryDescriptorSchema = z.strictObject({
  policyVersion: z.literal(RECOVERY_DOMAIN_VERSION),
  nativeBuildId: opaqueIdSchema,
  method: z.string().min(1).max(128),
  domain: z.enum(["no-held-input", "possible-held-input"]),
  possibleHolds: z.array(recoveryHoldSchema).max(512),
}).superRefine((value, context) => {
  if ((value.domain === "no-held-input") !== (value.possibleHolds.length === 0)) {
    context.addIssue({ code: "custom", path: ["possibleHolds"], message: "Recovery domain должен точно отражать наличие possible holds" })
  }
  const keys = value.possibleHolds.map(hold => `${hold.kind}:${String(hold.code).padStart(5, "0")}`)
  if (keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["possibleHolds"], message: "Possible holds должны быть уникальны и отсортированы kind/code" })
  }
})
export type NativeRecoveryDescriptor = z.infer<typeof nativeRecoveryDescriptorSchema>

/** Grant выдаёт runtime только после durable atomic перехода send gate. */
export const nativeRecoveryGrantSchema = z.strictObject({
  policyVersion: z.literal(RECOVERY_DOMAIN_VERSION),
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  operationId: opaqueIdSchema,
  contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  descriptor: nativeRecoveryDescriptorSchema,
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  journalRevision: z.number().int().safe().min(1),
  durable: z.literal(true),
})
export type NativeRecoveryGrant = z.infer<typeof nativeRecoveryGrantSchema>

export const nativeRecoveryStateSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("not-authorized"), policyVersion: z.literal(RECOVERY_DOMAIN_VERSION),
    nativeBuildId: opaqueIdSchema, nativeGeneration: generationIdSchema }),
  z.strictObject({ phase: z.literal("send-authorized"), grant: nativeRecoveryGrantSchema }),
])
export type NativeRecoveryState = z.infer<typeof nativeRecoveryStateSchema>

/** ASCII keys, fixed hold ordering; plaintext input не входит в descriptor. */
export function canonicalRecoveryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalRecoveryJson(child)}`).join(",")}}`
  }
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error("Recovery canonical value не является JSON")
  return json
}
