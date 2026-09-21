/**
 * Читает Git status checkout по абсолютному пути без shell и произвольных аргументов.
 * @remarks Вывод ограничен 1 MiB, выполнение — 10 секундами. Не запускает commit/push.
 * @packageDocumentation
 */
import {spawnSync} from "node:child_process"
import {lstatSync} from "node:fs"
import {join, dirname} from "node:path"
import {ToolError} from "../../shared/errors.ts"
import {object, integer} from "../../shared/validation.ts"
import {resolvePath} from "../../filesystem/shared/paths.ts"
import type {GitStatusInput} from "./contract/input.ts"
import type {GitStatusOutput} from "./contract/output.ts"
export type {GitStatusInput} from "./contract/input.ts"
export type {GitStatusOutput} from "./contract/output.ts"

export function gitStatus(input: GitStatusInput): GitStatusOutput {
  object(input, ["path", "maxEntries"])
  const path = resolvePath(input.path)
  const maxEntries = integer(input.maxEntries, 1000, 1, 5000, "maxEntries")
  let gitMetadata
  try { gitMetadata = lstatSync(join(path, ".git")) } catch { throw new ToolError("NOT_A_REPOSITORY", "The path is not a Git checkout", 400) }
  if (gitMetadata.isSymbolicLink() || (!gitMetadata.isFile() && !gitMetadata.isDirectory())) throw new ToolError("NOT_A_REPOSITORY", "Git metadata has an unsupported type", 400)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"], {
    cwd: path, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    env: {...env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(path)},
  })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new ToolError("TIMEOUT", "Git status exceeded its execution budget", 504)
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") throw new ToolError("LIMIT_EXCEEDED", "Git status exceeded its output budget", 413)
  if (result.error !== undefined || result.status !== 0) throw new ToolError("GIT_ERROR", "Git status failed", 502)
  const records = result.stdout.split("\0")
  const header = records.shift() ?? ""
  if (!header.startsWith("## ")) throw new ToolError("GIT_ERROR", "Unexpected Git status header", 502)
  const entries: GitStatusOutput["entries"] = []
  let truncated = false
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record === "") continue
    if (entries.length >= maxEntries) { truncated = true; break }
    if (record.length < 4 || record[2] !== " ") throw new ToolError("GIT_ERROR", "Unexpected Git status record", 502)
    const index = record[0]!
    const worktree = record[1]!
    const renamed = [index, worktree].some(status => status === "R" || status === "C")
    const originalPath = renamed ? records[++i] : undefined
    if (renamed && !originalPath) throw new ToolError("GIT_ERROR", "Incomplete Git rename record", 502)
    entries.push({index, worktree, path: record.slice(3), ...(originalPath === undefined ? {} : {originalPath})})
  }
  return {path, branch: header.slice(3), entries, truncated}
}
