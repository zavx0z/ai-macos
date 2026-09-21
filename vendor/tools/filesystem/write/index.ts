/**
 * Атомарно заменяет существующий обычный файл. expectedHash проверяет прежнее содержимое, но не является блокировкой.
 * @packageDocumentation
 */
import {object, text, encoding, hash} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import {decode, digest, replaceFile} from "../shared/files.ts"
import type {WriteFileInput} from "./contract/input.ts"
import type {WriteFileOutput} from "./contract/output.ts"
export type {WriteFileInput} from "./contract/input.ts"
export type {WriteFileOutput} from "./contract/output.ts"

export function writeFile(input: WriteFileInput): WriteFileOutput {
  object(input, ["path", "content", "encoding", "expectedHash"])
  const data = decode(text(input.content, "content", true), encoding(input.encoding))
  const expected = hash(input.expectedHash)
  const path = resolvePath(input.path, {mutable: true})
  replaceFile(path, data, expected)
  return {path, bytes: data.length, contentHash: digest(data)}
}
