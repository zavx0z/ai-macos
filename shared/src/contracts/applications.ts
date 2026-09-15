import { z } from "zod"
import { applicationBundleRefSchema, applicationRefSchema, opaqueIdSchema } from "./identities.ts"
import { contractErrorSchema } from "./errors.ts"
import type { AdapterHostContext, AdapterServices, AdapterResult } from "./adapters.ts"
import type { AdapterControl, RuntimeOperationContext, NativeExecutionContext } from "./operations.ts"

export const applicationResolveRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
  bundleId: z.string().min(1).max(255),
})
export const applicationBundleResolutionSchema = z.strictObject({
  requestedPath: z.string().min(1).max(4096).startsWith("/"),
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

export interface ApplicationAdapter {
  readonly host: AdapterHostContext
  readonly services: AdapterServices
  readonly capabilities: readonly ("desktop.applications" | "desktop.application.lifecycle")[]
  resolve(request: ApplicationResolveRequest, control: AdapterControl): Promise<ApplicationBundleResolution>
  launch(context: RuntimeOperationContext<NativeExecutionContext>, request: ApplicationLaunchRequest): Promise<AdapterResult<ApplicationLaunchResult>>
  quit(context: RuntimeOperationContext<NativeExecutionContext>, request: ApplicationQuitRequest): Promise<AdapterResult<ApplicationQuitResult>>
}
