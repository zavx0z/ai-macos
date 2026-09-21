/**
 * Удаляет файл, конечный symlink или каталог. Рекурсия только явно; корень файловой системы защищён.
 * @packageDocumentation
 */
import {lstatSync, unlinkSync, rmSync, rmdirSync} from "node:fs"
import {object, boolean} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import type {RemovePathInput} from "./contract/input.ts"
import type {RemovePathOutput} from "./contract/output.ts"
export type {RemovePathInput} from "./contract/input.ts"
export type {RemovePathOutput} from "./contract/output.ts"

export function removePath(input: RemovePathInput): RemovePathOutput {
  object(input, ["path", "recursive"])
  const recursive = boolean(input.recursive, false, "recursive")
  const path = resolvePath(input.path, {finalSymlink: true, mutable: true})
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    if (recursive) rmSync(path, {recursive: true, force: false})
    else rmdirSync(path)
  } else unlinkSync(path)
  return {path, removed: true}
}
