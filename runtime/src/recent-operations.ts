import { operationStateSchema, operationTargetSchema, opaqueIdSchema, z } from "@meta/shared/contracts"

export const recentOperationsInputSchema = z.strictObject({ limit: z.number().int().min(1).max(100).default(20) })
export const recentOperationSummarySchema = z.strictObject({
  operationId: opaqueIdSchema,
  state: operationStateSchema,
  targetKind: z.enum(operationTargetSchema.options.map(target => target.shape.kind.value)),
  updatedAt: z.iso.datetime({ offset: true }),
  cleanup: z.enum(["pending", "complete", "incomplete", "unknown"]),
})
export const recentOperationsResultSchema = z.strictObject({ operations: z.array(recentOperationSummarySchema).max(100), truncated: z.boolean() })
export type RecentOperationsResult = z.infer<typeof recentOperationsResultSchema>
