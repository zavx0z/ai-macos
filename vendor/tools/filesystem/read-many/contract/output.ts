import type {ReadFileOutput} from "../../read/contract/output.ts"

/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface ReadFilesOutput {
  files: ({path: string; result: ReadFileOutput} | {path: string; error: {code: string; message: string}})[]
  bytesRead: number
  remainingBytes: number
  truncated: boolean
}
