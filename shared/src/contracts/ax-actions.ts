import { z } from "zod"
import { elementRefSchema } from "./identities.ts"
import { structurallyEqual } from "./schema.ts"

export const axPressRequestSchema = z.strictObject({
  element: elementRefSchema,
})
export type AxPressRequest = z.infer<typeof axPressRequestSchema>

export const axPressResultSchema = z.strictObject({
  element: elementRefSchema,
  action: z.literal("AXPress"),
  // Подтверждает принятие AX API, но не semantic effect в приложении.
  performed: z.literal(true),
})
export type AxPressResult = z.infer<typeof axPressResultSchema>

export function axPressResultMatches(
  request: AxPressRequest,
  result: AxPressResult,
): boolean {
  return result.action === "AXPress"
    && result.performed
    && structurallyEqual(result.element, request.element)
}
