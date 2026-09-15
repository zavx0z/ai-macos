import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseWireJson, type z } from "@meta/shared/contracts"
import { ensurePrivateDirectory } from "./atomic-file.ts"

export const STORAGE_FORMAT_VERSION = 1 as const
export const MAX_STORAGE_FILE_BYTES = 1024 * 1024
export const MAX_STORAGE_RECORDS = 10_000

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function storageFileName(key: readonly string[]): string {
  return `${sha256(JSON.stringify(key))}.json`
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export async function readStorageFile<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.output<Schema> | undefined> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Storage record не является обычным файлом: ${path}`)
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`Storage record имеет небезопасный mode: ${path}`)
  }
  if (info.size < 1 || info.size > MAX_STORAGE_FILE_BYTES) {
    throw new Error(`Storage record нарушает byte limit: ${path}`)
  }
  const bytes = await readFile(path)
  if (bytes.byteLength !== info.size || bytes.byteLength > MAX_STORAGE_FILE_BYTES) {
    throw new Error(`Storage record изменился во время bounded read: ${path}`)
  }
  return parseWireJson(schema, bytes.toString("utf8"), {
    maxBytes: MAX_STORAGE_FILE_BYTES,
    maxDepth: 64,
  })
}

export async function storageFiles(directory: string): Promise<string[]> {
  await ensurePrivateDirectory(directory)
  const names = await readdir(directory)
  const records: string[] = []
  for (const name of names) {
    if (/^[a-f0-9]{64}\.json$/.test(name)) {
      records.push(join(directory, name))
      continue
    }
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      throw new Error(`Storage содержит незавершённый atomic write: ${name}`)
    }
    throw new Error(`Storage содержит неизвестный файл: ${name}`)
  }
  if (records.length > MAX_STORAGE_RECORDS) {
    throw new Error(`Storage содержит больше ${MAX_STORAGE_RECORDS} records`)
  }
  return records.sort((left, right) => basename(left).localeCompare(basename(right)))
}

export async function assertRecordCapacity(
  directory: string,
  targetPath: string,
): Promise<void> {
  const existing = await readStorageFileIfPresent(targetPath)
  if (existing) return
  const files = await storageFiles(directory)
  if (files.length >= MAX_STORAGE_RECORDS) {
    throw new Error(`Storage record limit ${MAX_STORAGE_RECORDS} исчерпан`)
  }
}

async function readStorageFileIfPresent(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
