import {isAbsolute, join} from "node:path"
import {ToolError} from "../../../shared/errors.ts"
import {text} from "../../../shared/validation.ts"
import {resolvePath, within} from "../../shared/paths.ts"

/** A patch supplies relative filenames, not a session or a registered workspace. */
export function patchPath(directory: string, value: unknown, missing = false): string {
  const name = text(value, "patch path")
  const parts = name.split("/").filter(part => part !== "" && part !== ".")
  if (isAbsolute(name) || name.includes("\\") || name.includes("\0") || /^[a-zA-Z]:/.test(name) || parts.length === 0 || parts.includes("..")) {
    throw new ToolError("PATH_NOT_ALLOWED", "Patch filenames must stay relative to directory", 403)
  }
  const path = resolvePath(join(directory, ...parts), {missing, mutable: true})
  if (path === directory || !within(directory, path)) throw new ToolError("PATH_NOT_ALLOWED", "A patch filename escapes directory", 403)
  return path
}
