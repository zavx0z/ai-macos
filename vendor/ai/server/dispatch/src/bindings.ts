import {statPath} from "../../../filesystem/stat/index.ts"
import {readFile} from "../../../filesystem/read/index.ts"
import {readFiles} from "../../../filesystem/read-many/index.ts"
import {listFiles} from "../../../filesystem/list/index.ts"
import {writeFile} from "../../../filesystem/write/index.ts"
import {createFile} from "../../../filesystem/create/index.ts"
import {makeDirectory} from "../../../filesystem/mkdir/index.ts"
import {removePath} from "../../../filesystem/remove/index.ts"
import {renamePath} from "../../../filesystem/rename/index.ts"
import {applyPatch} from "../../../filesystem/apply-patch/index.ts"
import {gitStatus} from "../../../git/status/index.ts"

interface Binding {
  run(input: unknown): unknown
  fields: readonly string[]
  write: boolean
}
function bind<I>(run: (input: I) => unknown, fields: readonly string[], write = false): Binding {
  return {run: input => run(input as I), fields, write}
}

/** Fixed public functions, not a second schema catalogue or dynamic imports. */
export function bindings(): ReadonlyMap<string, Binding> {
  return new Map([
    ["ai/filesystem/stat", bind(statPath, ["path"])],
    ["ai/filesystem/read", bind(readFile, ["path"])],
    ["ai/filesystem/read-many", bind(readFiles, ["paths"])],
    ["ai/filesystem/list", bind(listFiles, ["path"])],
    ["ai/filesystem/write", bind(writeFile, ["path"], true)],
    ["ai/filesystem/create", bind(createFile, ["path"], true)],
    ["ai/filesystem/mkdir", bind(makeDirectory, ["path"], true)],
    ["ai/filesystem/remove", bind(removePath, ["path"], true)],
    ["ai/filesystem/rename", bind(renamePath, ["from", "to"], true)],
    ["ai/filesystem/apply-patch", bind(applyPatch, ["directory"], true)],
    ["ai/git/status", bind(gitStatus, ["path"])],
  ])
}
