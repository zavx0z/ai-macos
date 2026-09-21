import {lstatSync, openSync, closeSync, readSync, constants, realpathSync} from "node:fs"
import {dirname, relative, resolve, sep, isAbsolute} from "node:path"
import {ToolError} from "../../../shared/errors.ts"

export function source(root: string, name: string, optional = false): string | null {
  const path = resolve(root, name)
  const relation = relative(root, path)
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new ToolError("INVALID_STRUCTURE", "Source path escapes the repository", 500)
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path)) throw new ToolError("INVALID_STRUCTURE", "Metadata must be a regular file without symlink parents", 500)
  if (stat.size > 131072) throw new ToolError("LIMIT_EXCEEDED", "Metadata source exceeds 128 KiB", 413)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(stat.size)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes !== stat.size) throw new ToolError("CONFLICT", "Metadata source changed while reading", 409)
    return buffer.toString("utf8")
  } finally { closeSync(fd) }
}

export function overview(text: string | null): string | null {
  const block = text?.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1]
  if (!block?.includes("@packageDocumentation")) return null
  return block.replace(/^\s*\* ?/gm, "").replace("@packageDocumentation", "").trim()
}
