/**
 * Строит ограниченный инвентарь обычного каталога. Не скрывает .git и не обходит дочерние symlink.
 * @packageDocumentation
 */
import {opendirSync, lstatSync} from "node:fs"
import {join} from "node:path"
import {object, integer, boolean} from "../../shared/validation.ts"
import {ToolError} from "../../shared/errors.ts"
import {resolvePath} from "../shared/paths.ts"
import {metadata} from "../shared/files.ts"
import type {ListFilesInput} from "./contract/input.ts"
import type {ListFilesOutput} from "./contract/output.ts"
export type {ListFilesInput} from "./contract/input.ts"
export type {ListFilesOutput} from "./contract/output.ts"

export function listFiles(input: ListFilesInput): ListFilesOutput {
  object(input, ["path", "recursive", "maxDepth", "maxEntries"])
  const start = resolvePath(input.path)
  const recursive = boolean(input.recursive, false, "recursive")
  const maxDepth = integer(input.maxDepth, 3, 1, 10, "maxDepth")
  const maxEntries = integer(input.maxEntries, 1000, 1, 5000, "maxEntries")
  if (!lstatSync(start).isDirectory()) throw new ToolError("INVALID_PATH_TYPE", "Path must be a directory")
  const entries: ListFilesOutput["entries"] = []
  let truncated = false
  let depthLimited = false
  const visit = (directory: string, depth: number): void => {
    const handle = opendirSync(directory)
    try {
      let child
      while ((child = handle.readSync()) !== null) {
        if (entries.length === maxEntries) { truncated = true; return }
        const path = join(directory, child.name)
        const entry = metadata(path)
        entries.push(entry)
        if (recursive && entry.type === "directory") {
          if (depth < maxDepth) visit(path, depth + 1)
          else depthLimited = true
          if (truncated) return
        }
      }
    } finally { handle.closeSync() }
  }
  visit(start, 1)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return {path: start, entries, truncated: truncated || depthLimited, depthLimited}
}
