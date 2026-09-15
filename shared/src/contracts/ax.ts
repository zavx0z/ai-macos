import { z } from "zod"
import { contractErrorSchema } from "./errors.ts"
import {
  elementRefSchema,
  opaqueIdSchema,
  surfaceRefSchema,
  windowRefSchema,
  type ElementRef,
} from "./identities.ts"

// AX может честно сообщать точку или линию с нулевой шириной/высотой.
// Capture geometry сохраняет отдельный положительный rect contract.
const axFrameSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
}).describe("Read-only AX bounds в глобальных macOS points; это не image pixels, не click authority, а нулевой размер не создаёт pointer target")

const axValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
])

export const axInspectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
])
export type AxInspectionTarget = z.infer<typeof axInspectionTargetSchema>

export const axInspectionRequestSchema = z.strictObject({
  target: axInspectionTargetSchema,
  depth: z.number().int().min(0).max(12),
  maxNodes: z.number().int().min(1).max(1_500),
  maxBytes: z.number().int().min(1).max(1024 * 1024),
  cursor: opaqueIdSchema.optional(),
})
export type AxInspectionRequest = z.infer<typeof axInspectionRequestSchema>

export const axInspectionNodeSchema = z.strictObject({
  elementRef: elementRefSchema,
  parentElementRef: elementRefSchema.optional(),
  role: z.string().max(128),
  subrole: z.string().max(128),
  title: z.string().max(4_096),
  identifier: z.string().max(4_096).optional(),
  description: z.string().max(4_096).optional(),
  value: axValueSchema.optional(),
  valueRedacted: z.literal(true).optional(),
  frame: axFrameSchema.optional(),
  actions: z.array(z.string().min(1).max(128)).max(64),
}).superRefine((node, context) => {
  if (new Set(node.actions).size !== node.actions.length) {
    context.addIssue({ code: "custom", path: ["actions"], message: "AX actions не должны повторяться" })
  }
  if (
    node.parentElementRef !== undefined
    && !sameElementSnapshot(node.elementRef, node.parentElementRef)
  ) {
    context.addIssue({ code: "custom", path: ["parentElementRef"], message: "AX parent принадлежит другому snapshot" })
  }
  if (
    node.parentElementRef !== undefined
    && node.parentElementRef.elementRef === node.elementRef.elementRef
  ) {
    context.addIssue({ code: "custom", path: ["parentElementRef"], message: "AX node не может быть собственным parent" })
  }
  if (node.valueRedacted && node.value !== undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "Redacted AX value не публикуется вместе с value" })
  }
})
export type AxInspectionNode = z.infer<typeof axInspectionNodeSchema>

export const axInspectionResultSchema = z.strictObject({
  snapshotId: opaqueIdSchema,
  target: axInspectionTargetSchema,
  complete: z.boolean(),
  nextCursor: opaqueIdSchema.optional(),
  nodeCount: z.number().int().safe().min(0),
  encodedBytes: z.number().int().safe().min(0).max(1024 * 1024),
  nodes: z.array(axInspectionNodeSchema).max(1_500),
  errors: z.array(contractErrorSchema).max(128),
}).superRefine((result, context) => {
  if (result.nodeCount !== result.nodes.length) {
    context.addIssue({ code: "custom", path: ["nodeCount"], message: "AX nodeCount должен совпадать с nodes" })
  }
  if (result.complete && (result.nextCursor !== undefined || result.errors.length > 0)) {
    context.addIssue({ code: "custom", path: ["complete"], message: "Complete AX snapshot не содержит cursor или errors" })
  }
  if (!result.complete && result.nextCursor === undefined && result.errors.length === 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "Incomplete AX snapshot требует cursor или reason" })
  }
  const expected = {
    runtimeEpoch: result.target.ref.runtimeEpoch,
    loginSessionId: result.target.ref.loginSessionId,
    nativeGeneration: result.target.ref.nativeGeneration,
    applicationRef: result.target.ref.applicationRef,
    snapshotId: result.snapshotId,
  }
  const identifiers = new Set<string>()
  for (const [index, node] of result.nodes.entries()) {
    if (!sameElementAuthority(node.elementRef, expected)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "elementRef"], message: "AX element принадлежит другому target snapshot" })
    }
    if (identifiers.has(node.elementRef.elementRef)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "elementRef"], message: "AX elementRef не должен повторяться" })
    }
    identifiers.add(node.elementRef.elementRef)
    if (
      node.parentElementRef !== undefined
      && !sameElementAuthority(node.parentElementRef, expected)
    ) {
      context.addIssue({ code: "custom", path: ["nodes", index, "parentElementRef"], message: "AX parent принадлежит другому target snapshot" })
    }
  }
})
export type AxInspectionResult = z.infer<typeof axInspectionResultSchema>

function sameElementSnapshot(left: ElementRef, right: ElementRef): boolean {
  return sameElementAuthority(left, right)
}

function sameElementAuthority(
  value: ElementRef,
  expected: Omit<ElementRef, "elementRef">,
): boolean {
  return value.runtimeEpoch === expected.runtimeEpoch
    && value.loginSessionId === expected.loginSessionId
    && value.nativeGeneration === expected.nativeGeneration
    && value.applicationRef === expected.applicationRef
    && value.snapshotId === expected.snapshotId
}
