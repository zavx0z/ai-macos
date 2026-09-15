import { z } from "zod"
import {
  browserInstanceRefSchema,
  deviceBrowserInstanceRefSchema,
  generationIdSchema,
  opaqueIdSchema,
  operationTargetSchema,
} from "./identities.ts"
import type {
  BrowserExecutionContext,
  DeviceExecutionContext,
  RuntimeClientSession,
  RuntimeOperationContext,
} from "./operations.ts"
import { runtimeResourceHandleSchema } from "./resources.ts"
import { isoTimestampSchema } from "./schema.ts"

export const lifetimeReservationHandleSchema = z.strictObject({
  reservationId: opaqueIdSchema,
  reservationGeneration: generationIdSchema,
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  principalId: opaqueIdSchema,
  lineageRef: opaqueIdSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("browser-instance"), ref: browserInstanceRefSchema }),
    z.strictObject({ kind: z.literal("device-browser-instance"), ref: deviceBrowserInstanceRefSchema }),
  ]),
  externalGeneration: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("browser"), browserTransportGeneration: generationIdSchema }),
    z.strictObject({
      kind: z.literal("device-browser"),
      deviceTransportGeneration: generationIdSchema,
      browserTransportGeneration: generationIdSchema,
    }),
  ]),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  state: z.enum(["active", "quarantined", "released"]),
  statusRevision: z.number().int().safe().min(0),
})
export type LifetimeReservationHandle = z.infer<typeof lifetimeReservationHandleSchema>

export const reservationCleanupReceiptSchema = z.strictObject({
  receiptId: opaqueIdSchema,
  reservationId: opaqueIdSchema,
  reservationGeneration: generationIdSchema,
  externalGeneration: lifetimeReservationHandleSchema.shape.externalGeneration,
  statusRevision: z.number().int().safe().min(0),
  cleanupEvidenceRef: opaqueIdSchema,
  issuedAt: isoTimestampSchema,
  state: z.literal("released"),
})
export type ReservationCleanupReceipt = z.infer<typeof reservationCleanupReceiptSchema>

export type ReservationChildRequest = {
  session: RuntimeClientSession
  context: RuntimeOperationContext<BrowserExecutionContext | DeviceExecutionContext>
  target: z.infer<typeof operationTargetSchema>
}

export interface LifetimeReservationAuthority {
  assertChild(request: ReservationChildRequest): Promise<LifetimeReservationHandle>
}
