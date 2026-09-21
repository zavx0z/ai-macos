import {ToolError} from "../../../shared/errors.ts"

export interface Hunk {old: string[]; next: string[]; end: boolean; anchor?: string}
export type Operation = {kind: "add"; path: string; lines: string[]} | {kind: "delete"; path: string} | {kind: "update"; path: string; to?: string; hunks: Hunk[]}

export function parsePatch(patch: string): Operation[] {
  const lines = patch.replaceAll("\r\n", "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") throw new ToolError("PATCH_REJECTED", "Patch must have Begin Patch and End Patch markers", 409)
  const operations: Operation[] = []
  let i = 1
  const marker = (line: string): boolean => /^\*\*\* (?:Add|Delete|Update) File: /.test(line)
  while (i < lines.length - 1) {
    const header = lines[i++]!
    if (header.startsWith("*** Add File: ")) {
      const added: string[] = []
      while (i < lines.length - 1 && !marker(lines[i]!)) {
        const line = lines[i++]!
        if (!line.startsWith("+")) throw new ToolError("PATCH_REJECTED", "Added lines must start with +", 409)
        added.push(line.slice(1))
      }
      operations.push({kind: "add", path: header.slice(14), lines: added})
    } else if (header.startsWith("*** Delete File: ")) {
      operations.push({kind: "delete", path: header.slice(17)})
    } else if (header.startsWith("*** Update File: ")) {
      const path = header.slice(17)
      let to: string | undefined
      if (lines[i]?.startsWith("*** Move to: ")) to = lines[i++]!.slice(13)
      const hunks: Hunk[] = []
      let hunk: Hunk | undefined
      while (i < lines.length - 1 && !marker(lines[i]!)) {
        const line = lines[i++]!
        if (line === "@@" || line.startsWith("@@ ")) {
          hunk = {old: [], next: [], end: false, ...(line === "@@" ? {} : {anchor: line.slice(3)})}
          hunks.push(hunk)
        } else if (line === "*** End of File" && hunk !== undefined) {
          hunk.end = true
        } else {
          if (hunk === undefined || hunk.end || ![" ", "+", "-"].includes(line[0]!)) throw new ToolError("PATCH_REJECTED", "Invalid hunk; use @@ followed by context, + or - lines", 409)
          if (line[0] !== "+") hunk.old.push(line.slice(1))
          if (line[0] !== "-") hunk.next.push(line.slice(1))
        }
      }
      if (hunks.length === 0 && to === undefined) throw new ToolError("PATCH_REJECTED", "Update has no hunks", 409)
      if (hunks.some(h => h.old.length === 0 && h.next.length === 0)) throw new ToolError("PATCH_REJECTED", "Empty hunks are not allowed", 409)
      operations.push({kind: "update", path, to, hunks})
    } else throw new ToolError("PATCH_REJECTED", "Unknown patch operation", 409)
    if (operations.length > 50) throw new ToolError("LIMIT_EXCEEDED", "A patch may affect at most 50 files", 413)
  }
  if (operations.length === 0) throw new ToolError("PATCH_REJECTED", "Patch has no operations", 409)
  return operations
}

export function applyHunks(data: Buffer, hunks: Hunk[]): Buffer {
  let before: string
  try { before = new TextDecoder("utf-8", {fatal: true}).decode(data) } catch { throw new ToolError("PATCH_REJECTED", "Patches only support UTF-8 text", 409) }
  const eol = before.includes("\r\n") ? "\r\n" : "\n"
  const normalized = before.replaceAll("\r\n", "\n")
  if (normalized.includes("\r") || (eol === "\r\n" && before.replaceAll("\r\n", "").includes("\n"))) throw new ToolError("PATCH_REJECTED", "Mixed line endings are not supported", 409)
  const trailing = normalized.endsWith("\n")
  const lines = normalized === "" ? [] : normalized.split("\n")
  if (trailing) lines.pop()
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.anchor !== undefined) {
      const anchor = lines.indexOf(hunk.anchor, cursor)
      if (anchor < 0 || lines.indexOf(hunk.anchor, anchor + 1) >= 0) throw new ToolError("PATCH_REJECTED", "Hunk anchor is absent or ambiguous", 409)
      cursor = anchor + 1
    }
    let position = -1
    for (let i = cursor; i <= lines.length - hunk.old.length; i++) {
      if (hunk.end && i + hunk.old.length !== lines.length) continue
      if (!hunk.old.every((line, j) => lines[i + j] === line)) continue
      if (position !== -1 && hunk.old.length !== 0) throw new ToolError("PATCH_REJECTED", "Hunk matches more than once; provide more context", 409)
      position = i
      if (hunk.old.length === 0) break
    }
    if (position < 0) throw new ToolError("PATCH_REJECTED", "Hunk does not match the current file", 409)
    lines.splice(position, hunk.old.length, ...hunk.next)
    cursor = position + hunk.next.length
  }
  return Buffer.from(lines.join(eol) + (lines.length > 0 && (trailing || before === "") ? eol : ""), "utf8")
}
