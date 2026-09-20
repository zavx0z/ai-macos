/**
 * Перемещает между абсолютными путями без перезаписи цели. EXDEV не заменяется скрытым копированием.
 * @packageDocumentation
 */
import {lstatSync, renameSync} from "node:fs"
import {object} from "../../shared/validation.ts"
import {ToolError} from "../../shared/errors.ts"
import {resolvePath, within} from "../shared/paths.ts"
import type {RenamePathInput} from "./contract/input.ts"
import type {RenamePathOutput} from "./contract/output.ts"
export type {RenamePathInput} from "./contract/input.ts"
export type {RenamePathOutput} from "./contract/output.ts"

export function renamePath(input: RenamePathInput): RenamePathOutput {
  object(input, ["from", "to"])
  const from = resolvePath(input.from, {finalSymlink: true, mutable: true})
  const to = resolvePath(input.to, {missing: true, finalSymlink: true, mutable: true})
  try {
    lstatSync(to)
    throw new ToolError("CONFLICT", "Destination already exists", 409)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (lstatSync(from).isDirectory() && within(from, to)) throw new ToolError("INVALID_INPUT", "A directory cannot be moved into itself")
  renameSync(from, to)
  return {from, to, renamed: true}
}
