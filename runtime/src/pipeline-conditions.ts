import { z } from "@meta/shared/contracts"
import { agentObservedStateSchema } from "./agent-methods.ts"

const name = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const reference = z.union([name, z.literal("$window")])
export const relativeRegionSchema = z.strictObject({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
  tolerance: z.number().min(0).max(0.2).default(0),
}).superRefine((r, ctx) => {
  if (r.x + r.width > 1 || r.y + r.height > 1) ctx.addIssue({ code: "custom", message: "Region exceeds its anchor" })
})
const selectorSchema = z.strictObject({
  role: z.string().min(1).max(128).optional(),
  subrole: z.string().min(1).max(128).optional(),
  identifier: z.string().min(1).max(256).optional(),
  text: z.string().min(1).max(512).optional(),
  textMode: z.enum(["exact", "contains"]).default("exact"),
}).superRefine((s, ctx) => {
  if (!s.role && !s.subrole && !s.identifier && !s.text) ctx.addIssue({ code: "custom", message: "Empty element selector" })
})
export const pipelineConditionSchema = z.strictObject({
  anchors: z.array(z.strictObject({
    name, within: reference.default("$window"), selector: selectorSchema,
    region: relativeRegionSchema.optional(),
    rightOf: name.optional(), below: name.optional(),
  })).min(1).max(16),
  select: name,
  origin: z.enum(["any", "native-dialog"]).default("any"),
}).superRefine((c, ctx) => {
  const seen = new Set<string>(["$window"])
  for (const a of c.anchors) {
    if (seen.has(a.name) || !seen.has(a.within) || a.rightOf && !seen.has(a.rightOf) || a.below && !seen.has(a.below)) {
      ctx.addIssue({ code: "custom", message: "Anchors require unique names and backward references" })
    }
    seen.add(a.name)
  }
  if (!seen.has(c.select)) ctx.addIssue({ code: "custom", message: "Selected anchor is missing" })
})

export type PipelineCondition = z.infer<typeof pipelineConditionSchema>
export type PipelineObservation = z.infer<typeof agentObservedStateSchema>
export type PipelineElement = PipelineObservation["elements"][number]
export type Rect = { x: number, y: number, width: number, height: number }
export type ConditionMatch =
  | { state: "matched", selected: PipelineElement, anchors: Record<string, PipelineElement>, source: "ax" }
  | { state: "not-found" | "ambiguous" | "unavailable", reason: string }

function validRect(rect: Rect | undefined): rect is Rect {
  return !!rect && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0
}
function inside(child: Rect, parent: Rect): boolean {
  return child.x >= parent.x && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height
}
export function relativeRegion(parent: Rect, region?: z.infer<typeof relativeRegionSchema>): Rect {
  if (!validRect(parent)) throw new Error("Invalid anchor geometry")
  if (!region) return { ...parent }
  const r = relativeRegionSchema.parse(region)
  const x = Math.max(0, r.x - r.tolerance), y = Math.max(0, r.y - r.tolerance)
  const right = Math.min(1, r.x + r.width + r.tolerance), bottom = Math.min(1, r.y + r.height + r.tolerance)
  return { x: parent.x + x * parent.width, y: parent.y + y * parent.height,
    width: (right - x) * parent.width, height: (bottom - y) * parent.height }
}
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim()
function matches(element: PipelineElement, selector: PipelineCondition["anchors"][number]["selector"]): boolean {
  if (selector.role && selector.role !== element.role || selector.subrole && selector.subrole !== element.subrole
    || selector.identifier && selector.identifier !== element.identifier) return false
  if (!selector.text) return true
  const expected = normalized(selector.text)
  // Separate fields: never manufacture a phrase by joining unrelated labels.
  return [element.title, element.description, typeof element.value === "string" && !element.valueRedacted ? element.value : undefined]
    .some(value => typeof value === "string" && (selector.textMode === "exact"
      ? normalized(value) === expected : normalized(value).includes(expected)))
}

/** One complete trusted AX observation only. Returned geometry is macOS points,
 * never screenshot pixels or pointer authority. Actions use the exact elementId. */
export function matchPipelineCondition(raw: unknown, expectedTargetId: string, conditionValue: PipelineCondition): ConditionMatch {
  const condition = pipelineConditionSchema.parse(conditionValue)
  const parsed = agentObservedStateSchema.safeParse(raw)
  if (!parsed.success || parsed.data.targetId !== expectedTargetId || !parsed.data.complete || parsed.data.errors.length) {
    return { state: "unavailable", reason: "Complete observation of the exact target is required" }
  }
  const nodes = parsed.data.elements
  const byId = new Map(nodes.map(node => [node.elementId, node]))
  if (byId.size !== nodes.length) return { state: "unavailable", reason: "Duplicate element identity" }
  const roots = nodes.filter(node => !node.parentElementId)
  if (roots.length !== 1 || !["AXWindow", "AXSheet", "AXDialog"].includes(roots[0]!.role) || !validRect(roots[0]!.frame)) {
    return { state: "unavailable", reason: "Unique native root and its geometry are required" }
  }
  const root = roots[0]!
  const ancestry = new Map<string, PipelineElement[]>()
  for (const node of nodes) {
    const path: PipelineElement[] = [], seen = new Set<string>()
    let current: PipelineElement | undefined = node
    while (current) {
      if (seen.has(current.elementId)) return { state: "unavailable", reason: "Cyclic element ancestry" }
      seen.add(current.elementId); path.push(current)
      current = current.parentElementId ? byId.get(current.parentElementId) : undefined
    }
    if (path.at(-1) !== root) return { state: "unavailable", reason: "Disconnected element ancestry" }
    ancestry.set(node.elementId, path)
  }
  const nativeDialog = (node: PipelineElement) => {
    const path = ancestry.get(node.elementId)!
    return !path.some(p => ["AXWebArea", "AXHTMLContent"].includes(p.role))
      && path.some(p => ["AXSheet", "AXDialog"].includes(p.role)
        || ["AXApplicationAlertDialog", "AXApplicationDialog", "AXDialog"].includes(p.subrole))
  }
  const anchors: Record<string, PipelineElement> = Object.create(null)
  anchors.$window = root
  for (const spec of condition.anchors) {
    const parent = anchors[spec.within]!
    if (!validRect(parent.frame)) return { state: "unavailable", reason: `Missing geometry: ${spec.within}` }
    const region = relativeRegion(parent.frame, spec.region)
    let missingGeometry = false
    const candidates = nodes.filter(node => {
      if (!matches(node, spec.selector) || node === parent || !ancestry.get(node.elementId)!.includes(parent)) return false
      if (!validRect(node.frame)) { missingGeometry = true; return false }
      if (!inside(node.frame, parent.frame!)) return false
      // Approximate region limits the search. No approximate click is produced.
      const cx = node.frame.x + node.frame.width / 2, cy = node.frame.y + node.frame.height / 2
      if (cx < region.x || cx > region.x + region.width || cy < region.y || cy > region.y + region.height) return false
      if (spec.rightOf) {
        const other = anchors[spec.rightOf]!.frame!
        if (node.frame.x < other.x + other.width) return false
      }
      if (spec.below) {
        const other = anchors[spec.below]!.frame!
        if (node.frame.y < other.y + other.height) return false
      }
      return true
    })
    if (missingGeometry) return { state: "unavailable", reason: `Candidate geometry unavailable: ${spec.name}` }
    if (candidates.length === 0) return { state: "not-found", reason: `Anchor not found: ${spec.name}` }
    if (candidates.length !== 1) return { state: "ambiguous", reason: `Multiple candidates: ${spec.name}` }
    anchors[spec.name] = candidates[0]!
  }
  const selected = anchors[condition.select]!
  if (condition.origin === "native-dialog" && !nativeDialog(selected)) {
    return { state: "unavailable", reason: "Native dialog ownership is not established; page content cannot grant consent" }
  }
  return { state: "matched", selected, anchors, source: "ax" }
}
