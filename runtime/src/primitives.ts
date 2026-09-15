export interface RuntimeClock {
  now(): Date
}

export interface RuntimeIdSource {
  next(prefix: string): string
}

export const systemClock: RuntimeClock = {
  now: () => new Date(),
}

export const randomIdSource: RuntimeIdSource = {
  next: prefix => `${prefix}:${crypto.randomUUID()}`,
}

export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function hmacSha256(key: Uint8Array, value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256", key).update(value).digest("hex")
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}
