import { z } from "zod"

export { z }

export type ContractSchema<T = unknown> = z.ZodType<T>
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const isoTimestampSchema = z.iso.datetime({ offset: true })
export const safeIntegerSchema = z.number().int().safe()
export const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0)
export const positiveSafeIntegerSchema = safeIntegerSchema.min(1)
export const finiteNumberSchema = z.number().finite()

export function contractJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema)
}

export function utf8ByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

export type WireParseLimits = {
  maxBytes: number
  maxDepth: number
}

export const DEFAULT_WIRE_PARSE_LIMITS: Readonly<WireParseLimits> = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 32,
})

export function parseWireJson<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  limits: WireParseLimits = DEFAULT_WIRE_PARSE_LIMITS,
): z.output<Schema> {
  assertWireLimits(limits)
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > limits.maxBytes) throw new Error(`Wire JSON превышает ${limits.maxBytes} байт до JSON.parse`)
  return parseWireValue(schema, JSON.parse(text) as unknown, limits)
}

export function parseWireValue<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  limits: WireParseLimits = DEFAULT_WIRE_PARSE_LIMITS,
): z.output<Schema> {
  assertWireLimits(limits)
  assertWireJsonValue(value, limits.maxDepth)
  if (utf8ByteLength(value) > limits.maxBytes) throw new Error(`Wire value превышает ${limits.maxBytes} байт`)
  return schema.parse(value)
}

function assertWireJsonValue(root: unknown, maxDepth: number): void {
  const pending: Array<{ value: unknown, path: string, depth: number, ancestors: ReadonlySet<object> }> = [{
    value: root,
    path: "$input",
    depth: 0,
    ancestors: new Set(),
  }]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === undefined) continue
    const { value, path, depth, ancestors } = item
    if (depth > maxDepth) throw new Error(`${path} превышает wire depth ${maxDepth}`)
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) {
        throw new Error(`${path} содержит non-finite или unsafe integer`)
      }
      continue
    }
    if (typeof value !== "object") throw new Error(`${path} содержит не-JSON значение`)
    if (ancestors.has(value)) throw new Error(`${path} содержит циклическую object reference`)
    const nextAncestors = new Set(ancestors).add(value)
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path} содержит sparse array hole`)
        pending.push({ value: value[index], path: `${path}[${index}]`, depth: depth + 1, ancestors: nextAncestors })
      }
      continue
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} содержит non-plain object`)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${path}.${key} запрещён на wire boundary`)
      if (child === undefined) throw new Error(`${path}.${key} содержит undefined`)
      pending.push({ value: child, path: `${path}.${key}`, depth: depth + 1, ancestors: nextAncestors })
    }
  }
}

function assertWireLimits(limits: WireParseLimits): void {
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 64 * 1024 * 1024) {
    throw new Error("maxBytes должен быть в пределах 1..67108864")
  }
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 128) {
    throw new Error("maxDepth должен быть в пределах 1..128")
  }
}
