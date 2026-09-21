import {ToolError} from "../../../shared/errors.ts"

const MAX_REQUEST_BYTES = 12 * 1024 * 1024

export async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ToolError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", 415)
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new ToolError("INVALID_INPUT", "Invalid Content-Length")
    if (Number(declared) > MAX_REQUEST_BYTES) throw new ToolError("LIMIT_EXCEEDED", "Request body exceeds 12 MiB", 413)
  }
  if (request.body === null) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel()
        throw new ToolError("LIMIT_EXCEEDED", "Request body exceeds 12 MiB", 413)
      }
      chunks.push(item.value)
    }
  } finally { reader.releaseLock() }
  if (bytes === 0) return {}
  try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, bytes))) }
  catch { throw new ToolError("INVALID_INPUT", "Body must contain valid UTF-8 JSON") }
}
