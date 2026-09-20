import {lstatSync, realpathSync, statSync} from "node:fs"
import {basename, dirname, isAbsolute, join, parse, relative, resolve, sep} from "node:path"
import {ToolError} from "../../shared/errors.ts"
import {text} from "../../shared/validation.ts"

/** Syntax only: no working directory, aliases, registration or filesystem access. */
export function absolutePath(value: unknown): string {
  const path = text(value, "path")
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 4096) {
    throw new ToolError("PATH_NOT_ALLOWED", "An absolute path of at most 4096 bytes without NUL is required", 403)
  }
  return resolve(path)
}

/** Canonicalize existing parents, including system aliases such as macOS /tmp.
 * Final symlinks are rejected unless the operation explicitly works on the link.
 * This is path handling, not authorization or a race-proof OS sandbox. */
export function resolvePath(value: unknown, options: {missing?: boolean; finalSymlink?: boolean; mutable?: boolean} = {}): string {
  const requested = absolutePath(value)
  if (options.mutable && requested === parse(requested).root) {
    throw new ToolError("PATH_NOT_ALLOWED", "The filesystem root cannot be changed", 403)
  }
  let parent = dirname(requested)
  const tail = [basename(requested)]
  let canonical: string
  while (true) {
    try {
      canonical = realpathSync(parent)
      if (!statSync(canonical).isDirectory()) throw new ToolError("INVALID_PATH_TYPE", "A parent is not a directory")
      break
    } catch (error) {
      if (!options.missing || (error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) throw error
      // A dangling parent symlink must not be mistaken for a missing directory.
      try {
        if (lstatSync(parent).isSymbolicLink()) throw new ToolError("PATH_NOT_ALLOWED", "A parent symlink has no target", 403)
      } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure }
      tail.unshift(basename(parent))
      parent = dirname(parent)
    }
  }
  const path = join(canonical, ...tail)
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() && !options.finalSymlink) throw new ToolError("PATH_NOT_ALLOWED", "This operation does not follow a final symlink", 403)
  } catch (error) {
    if (!options.missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (options.mutable && path === parse(path).root) throw new ToolError("PATH_NOT_ALLOWED", "The filesystem root cannot be changed", 403)
  return path
}

export function within(directory: string, path: string): boolean {
  const relation = relative(directory, path)
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}
