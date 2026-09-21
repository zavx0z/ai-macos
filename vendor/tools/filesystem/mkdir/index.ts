/**
 * Создаёт каталог по абсолютному пути. recursive:true допускает повтор с created:false.
 * @packageDocumentation
 */
import {mkdirSync, lstatSync} from "node:fs"
import {object, boolean} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import type {MakeDirectoryInput} from "./contract/input.ts"
import type {MakeDirectoryOutput} from "./contract/output.ts"
export type {MakeDirectoryInput} from "./contract/input.ts"
export type {MakeDirectoryOutput} from "./contract/output.ts"

export function makeDirectory(input: MakeDirectoryInput): MakeDirectoryOutput {
  object(input, ["path", "recursive"])
  const recursive = boolean(input.recursive, false, "recursive")
  const path = resolvePath(input.path, {missing: true, mutable: true})
  let existed = false
  try { existed = lstatSync(path).isDirectory() } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  mkdirSync(path, {recursive})
  return {path, created: !existed}
}
