/**
 * Читает ограниченный диапазон байтов по абсолютному пути. Без регистрации и контекста.
 * @packageDocumentation
 */
import {object, integer, encoding} from "../../shared/validation.ts"
import {resolvePath} from "../shared/paths.ts"
import {readChunk, digest, MAX_BYTES} from "../shared/files.ts"
import type {ReadFileInput} from "./contract/input.ts"
import type {ReadFileOutput} from "./contract/output.ts"
export type {ReadFileInput} from "./contract/input.ts"
export type {ReadFileOutput} from "./contract/output.ts"

export function readFile(input: ReadFileInput): ReadFileOutput {
  object(input, ["path", "offset", "maxBytes", "encoding"])
  const offset = integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset")
  const maxBytes = integer(input.maxBytes, 65536, 1, MAX_BYTES, "maxBytes")
  const format = encoding(input.encoding)
  const path = resolvePath(input.path)
  const {data, size} = readChunk(path, offset, maxBytes)
  return {path, content: data.toString(format), encoding: format,
    offset, bytesRead: data.length, size, truncated: offset + data.length < size,
    contentHash: offset === 0 && data.length === size ? digest(data) : null}
}
