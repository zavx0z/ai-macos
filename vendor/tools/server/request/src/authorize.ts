import {lstatSync, realpathSync} from "node:fs"
import {ToolError} from "../../../shared/errors.ts"
import {resolvePath, within} from "../../../filesystem/shared/paths.ts"
import type {ToolInvocation} from "../../dispatch/contract/input.ts"

/** Optional HTTP host policy. It is not part of any tool input or function dependency. */
export function directoryAuthorizer(values: string[]): (invocation: ToolInvocation) => boolean {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) throw new ToolError("INVALID_INPUT", "Configure 1 to 64 allowedDirectories on the HTTP host")
  const directories = values.map(value => {
    const path = resolvePath(value)
    if (!lstatSync(path).isDirectory()) throw new ToolError("INVALID_INPUT", "allowedDirectories must contain directories")
    return path
  })
  return invocation => {
    // Do not silently accept a configured boundary that has become a symlink.
    if (directories.some(path => lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !lstatSync(path).isDirectory())) return false
    const removesEntry = invocation.node === "tools/filesystem/remove" || invocation.node === "tools/filesystem/rename"
    return invocation.paths.every(value => {
      const path = resolvePath(value, {missing: true, finalSymlink: true})
      return directories.some(directory => within(directory, path) && !(removesEntry && directory === path))
    })
  }
}
