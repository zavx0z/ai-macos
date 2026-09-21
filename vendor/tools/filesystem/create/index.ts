/**
 * Создаёт новый файл, не перезаписывая существующий. Создание родителей только по явному флагу.
 * @packageDocumentation
 */
import {mkdirSync, writeFileSync} from "node:fs"
import {dirname} from "node:path"
import {object, text, encoding, boolean} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import {decode, digest} from "../shared/files.ts"
import type {CreateFileInput} from "./contract/input.ts"
import type {CreateFileOutput} from "./contract/output.ts"
export type {CreateFileInput} from "./contract/input.ts"
export type {CreateFileOutput} from "./contract/output.ts"

export function createFile(input: CreateFileInput): CreateFileOutput {
  object(input, ["path", "content", "encoding", "createParents"])
  const data = decode(text(input.content, "content", true), encoding(input.encoding))
  const parents = boolean(input.createParents, false, "createParents")
  const path = resolvePath(input.path, {missing: true, mutable: true})
  if (parents) mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, data, {flag: "wx", mode: 0o600})
  return {path, bytes: data.length, contentHash: digest(data)}
}
