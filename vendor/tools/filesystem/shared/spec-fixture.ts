import {mkdtempSync, rmSync, realpathSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

export async function fixture<T>(run: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ai-tools-spec-")))
  try { return await run(directory) }
  finally { rmSync(directory, {recursive: true, force: true}) }
}

export function hasCode(code: string): (error: unknown) => boolean {
  return error => (error as {code?: string} | null)?.code === code
}
