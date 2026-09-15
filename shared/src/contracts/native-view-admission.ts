import { z } from "zod"
import { opaqueIdSchema } from "./identities.ts"

/** Runtime выдаёт proof после durable send grant; это не доказательство visual effect. */
export const nativeViewAdmissionSchema = z.strictObject({
  version: z.literal("1"),
  contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  viewNonce: opaqueIdSchema,
  observerInstanceRef: opaqueIdSchema,
  coverageStartCursor: opaqueIdSchema,
  baselineCursor: opaqueIdSchema,
  baselineNextSequence: z.number().int().safe().min(1),
  observedCursor: opaqueIdSchema,
  observedNextSequence: z.number().int().safe().min(1),
  admissionCursor: opaqueIdSchema,
  admissionNextSequence: z.number().int().safe().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
}).superRefine((proof, context) => {
  if (proof.baselineNextSequence > proof.observedNextSequence || proof.observedNextSequence > proof.admissionNextSequence) {
    context.addIssue({ code: "custom", message: "View admission нарушает порядок observer watermarks" })
  }
})
export type NativeViewAdmission = z.infer<typeof nativeViewAdmissionSchema>
