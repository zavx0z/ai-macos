/**
 * Применяет текстовый patch в явно указанной директории без регистрации workspace.
 * @remarks dryRun ничего не записывает. Нет fuzzy matching или многофайловой транзакции.
 * При PARTIAL_FAILURE сначала проверяют completed и current, а не повторяют запись вслепую.
 * @packageDocumentation
 */
import {lstatSync, mkdirSync, writeFileSync, unlinkSync} from "node:fs"
import {dirname} from "node:path"
import {object, text, boolean} from "../../shared/validation.ts"
import {ToolError, asToolError} from "../../shared/errors.ts"
import {resolvePath} from "../shared/paths.ts"
import {readWhole, digest, replaceFile, MAX_BYTES} from "../shared/files.ts"
import {parsePatch, applyHunks} from "./src/parse.ts"
import {patchPath} from "./src/paths.ts"
import type {ApplyPatchInput} from "./contract/input.ts"
import type {ApplyPatchOutput} from "./contract/output.ts"
export type {ApplyPatchInput} from "./contract/input.ts"
export type {ApplyPatchOutput} from "./contract/output.ts"

export function applyPatch(input: ApplyPatchInput): ApplyPatchOutput {
  object(input, ["directory", "patch", "dryRun"])
  const patch = text(input.patch, "patch")
  const dryRun = boolean(input.dryRun, false, "dryRun")
  if (Buffer.byteLength(patch) > MAX_BYTES) throw new ToolError("LIMIT_EXCEEDED", "Patch exceeds the byte limit", 413)
  const directory = resolvePath(input.directory)
  if (!lstatSync(directory).isDirectory()) throw new ToolError("INVALID_PATH_TYPE", "directory must be a directory")
  const operations = parsePatch(patch)
  const touched = new Set<string>()
  let totalBytes = 0
  const planned = operations.map(operation => {
    const path = patchPath(directory, operation.path, operation.kind === "add")
    const target = operation.kind === "update" && operation.to !== undefined ? patchPath(directory, operation.to, true) : path
    if (touched.has(path) || (target !== path && touched.has(target))) throw new ToolError("PATCH_REJECTED", "Patch touches a path more than once", 409)
    touched.add(path)
    touched.add(target)
    if (operation.kind === "add" || target !== path) {
      try {
        lstatSync(target)
        throw new ToolError("CONFLICT", "Patch destination already exists", 409)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    const before = operation.kind === "add" ? undefined : readWhole(path)
    const data = operation.kind === "add" ? Buffer.from(operation.lines.join("\n") + (operation.lines.length ? "\n" : ""))
      : operation.kind === "update" ? applyHunks(before!, operation.hunks) : undefined
    totalBytes += (before?.length ?? 0) + (data?.length ?? 0)
    if (totalBytes > MAX_BYTES * 2 || (data?.length ?? 0) > MAX_BYTES) throw new ToolError("LIMIT_EXCEEDED", "Patch working set exceeds the byte limit", 413)
    const operationName = operation.kind === "update" && target !== path ? "move" : operation.kind
    const change: ApplyPatchOutput["changes"][number] = {operation: operationName, path: target, ...(target === path ? {} : {from: path}), bytes: data?.length ?? 0}
    return {path, target, before, data, change}
  })
  if (dryRun) return {directory, applied: false, changes: planned.map(item => item.change)}
  const completed: ApplyPatchOutput["changes"] = []
  for (const item of planned) {
    try {
      if (item.before !== undefined && digest(readWhole(item.path)) !== digest(item.before)) throw new ToolError("CONFLICT", "A patch source changed after validation", 409)
      if (item.data !== undefined) {
        if (item.change.operation === "update") replaceFile(item.path, item.data, digest(item.before!))
        else {
          mkdirSync(dirname(item.target), {recursive: true})
          writeFileSync(item.target, item.data, {flag: "wx", mode: item.before === undefined ? 0o600 : lstatSync(item.path).mode & 0o777})
        }
      }
      if (item.change.operation === "delete" || item.change.operation === "move") unlinkSync(item.path)
      completed.push(item.change)
    } catch (error) {
      const failure = asToolError(error)
      throw new ToolError("PARTIAL_FAILURE", "Patch application stopped; inspect affected paths before retrying", 500,
        {completed, current: item.change, cause: failure.code})
    }
  }
  return {directory, applied: true, changes: completed}
}
