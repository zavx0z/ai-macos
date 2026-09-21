import {createHash, randomUUID} from "node:crypto"
import {constants, openSync, closeSync, fstatSync, fchmodSync, readSync, lstatSync, writeFileSync, renameSync, unlinkSync} from "node:fs"
import {dirname, join} from "node:path"
import {ToolError} from "../../shared/errors.ts"
import type {FileEntry} from "./types.ts"

export const MAX_BYTES = 8 * 1024 * 1024

export function metadata(path: string): FileEntry {
  const stat = lstatSync(path)
  return {path, type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    size: stat.size, mode: stat.mode & 0o777, modifiedAt: stat.mtime.toISOString()}
}

export function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export function readChunk(path: string, offset: number, maxBytes: number): {data: Buffer; size: number} {
  if (!lstatSync(path).isFile()) throw new ToolError("INVALID_PATH_TYPE", "Path must be a regular file")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new ToolError("INVALID_PATH_TYPE", "Path must be a regular file")
    const buffer = Buffer.alloc(Math.max(0, Math.min(maxBytes, stat.size - offset)))
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, offset + bytes)
      if (count === 0) break
      bytes += count
    }
    return {data: buffer.subarray(0, bytes), size: stat.size}
  } finally { closeSync(fd) }
}

export function readWhole(path: string): Buffer {
  const {data, size} = readChunk(path, 0, MAX_BYTES)
  if (size > MAX_BYTES) throw new ToolError("LIMIT_EXCEEDED", "File exceeds the mutation byte limit", 413)
  if (data.length !== size) throw new ToolError("CONFLICT", "File changed while being read", 409)
  return data
}

export function decode(content: string, encoding: "utf8" | "base64"): Buffer {
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES * 1.4) throw new ToolError("LIMIT_EXCEEDED", "Content exceeds the byte limit", 413)
  if (encoding === "base64" && (content.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))) {
    throw new ToolError("INVALID_INPUT", "Content must be canonical base64")
  }
  const data = Buffer.from(content, encoding)
  if (encoding === "base64" && data.toString("base64") !== content) throw new ToolError("INVALID_INPUT", "Content must be canonical base64")
  if (data.length > MAX_BYTES) throw new ToolError("LIMIT_EXCEEDED", "Content exceeds the byte limit", 413)
  return data
}

/** Atomic replacement of one regular file, not a filesystem transaction or a cross-process CAS. */
export function replaceFile(path: string, data: Buffer, expectedHash?: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new ToolError("INVALID_PATH_TYPE", "Path must be a regular file")
  if (expectedHash !== undefined && digest(readWhole(path)) !== expectedHash) throw new ToolError("CONFLICT", "Content hash does not match", 409)
  const temporary = join(dirname(path), `.ai-tools-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode & 0o777)
    try {
      writeFileSync(fd, data)
      fchmodSync(fd, stat.mode & 0o777)
    } finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}
