/**
 * Читает до 50 абсолютных путей с общим бюджетом байтов и отдельными результатами ошибок.
 * @packageDocumentation
 */
import {object, integer, encoding, text} from "../../shared/validation.ts"
import {ToolError, asToolError} from "../../shared/errors.ts"
import {MAX_BYTES} from "../shared/files.ts"
import {readFile} from "../read/index.ts"
import type {ReadFilesInput} from "./contract/input.ts"
import type {ReadFilesOutput} from "./contract/output.ts"
export type {ReadFilesInput} from "./contract/input.ts"
export type {ReadFilesOutput} from "./contract/output.ts"

export function readFiles(input: ReadFilesInput): ReadFilesOutput {
  object(input, ["paths", "encoding", "maxBytesPerFile", "maxTotalBytes"])
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 50) throw new ToolError("INVALID_INPUT", "paths must contain 1 to 50 strings")
  input.paths.forEach(path => text(path, "path"))
  const format = encoding(input.encoding)
  const perFile = integer(input.maxBytesPerFile, 65536, 1, MAX_BYTES, "maxBytesPerFile")
  const total = integer(input.maxTotalBytes, 2 * 1024 * 1024, 1, MAX_BYTES, "maxTotalBytes")
  let remaining = total
  let truncated = false
  const files = input.paths.map(path => {
    try {
      if (remaining === 0) throw new ToolError("LIMIT_EXCEEDED", "The shared read budget is exhausted", 413)
      const result = readFile({path, encoding: format, maxBytes: Math.min(perFile, remaining)})
      remaining -= result.bytesRead
      truncated ||= result.truncated
      return {path, result}
    } catch (error) {
      const failure = asToolError(error)
      truncated = true
      return {path, error: {code: failure.code, message: failure.message}}
    }
  })
  return {files, bytesRead: total - remaining, remainingBytes: remaining, truncated}
}
