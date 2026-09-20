/**
 * Возвращает метаданные абсолютного пути, не разыменовывая конечный symlink.
 * @packageDocumentation
 */
import {object} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import {metadata} from "../shared/files.ts"
import type {StatPathInput} from "./contract/input.ts"
import type {StatPathOutput} from "./contract/output.ts"
export type {StatPathInput} from "./contract/input.ts"
export type {StatPathOutput} from "./contract/output.ts"

export function statPath(input: StatPathInput): StatPathOutput {
  object(input, ["path"])
  return {entry: metadata(resolvePath(input.path, {finalSymlink: true}))}
}
