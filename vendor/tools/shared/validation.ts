import {ToolError} from "./errors.ts"

export function object(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_INPUT", "Input must be an object")
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ToolError("INVALID_INPUT", `Unknown field: ${key}`)
  }
}

export function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new ToolError("INVALID_INPUT", `${label} must be ${empty ? "a" : "a non-empty"} string`)
  }
  return value
}

export function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolError("INVALID_INPUT", `${label} must be an integer in [${min}, ${max}]`)
  }
  return value
}

export function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new ToolError("INVALID_INPUT", `${label} must be a boolean`)
  return value
}

export function encoding(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8"
  if (value === "base64") return "base64"
  throw new ToolError("INVALID_INPUT", "encoding must be utf8 or base64")
}

export function hash(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ToolError("INVALID_INPUT", "expectedHash must be a lowercase SHA-256 hash")
  }
  return value
}
