import { z } from "zod"
import { applicationBundleRefSchema, applicationRefSchema, opaqueIdSchema } from "./identities.ts"
import { contractErrorSchema } from "./errors.ts"

export const applicationResolveRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
  bundleId: z.string().min(1).max(255),
})
export const applicationBundleResolutionSchema = z.strictObject({
  sourceResponseRef: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  observedAt: z.iso.datetime({ offset: true }),
  target: z.strictObject({ kind: z.literal("application-bundle"), ref: applicationBundleRefSchema }),
})
export const applicationLaunchRequestSchema = z.strictObject({
  bundle: applicationBundleRefSchema,
  activate: z.boolean().default(true),
  newInstance: z.boolean().default(false),
})
export const applicationLaunchResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("running"), application: applicationRefSchema, reused: z.boolean() }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1).max(1024),
    candidate: applicationRefSchema.optional(), errors: z.array(contractErrorSchema).min(1).max(16) }),
])
export const applicationQuitRequestSchema = z.strictObject({ application: applicationRefSchema })
export const applicationQuitResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("terminated"), application: applicationRefSchema }),
  z.strictObject({ state: z.literal("still-running"), application: applicationRefSchema, attentionMayBeRequired: z.boolean() }),
  z.strictObject({ state: z.literal("unknown"), application: applicationRefSchema,
    reason: z.string().min(1).max(1024), errors: z.array(contractErrorSchema).min(1).max(16) }),
])
export type ApplicationResolveRequest = z.infer<typeof applicationResolveRequestSchema>
export type ApplicationBundleResolution = z.infer<typeof applicationBundleResolutionSchema>
export type ApplicationLaunchRequest = z.infer<typeof applicationLaunchRequestSchema>
export type ApplicationLaunchResult = z.infer<typeof applicationLaunchResultSchema>
export type ApplicationQuitRequest = z.infer<typeof applicationQuitRequestSchema>
export type ApplicationQuitResult = z.infer<typeof applicationQuitResultSchema>
