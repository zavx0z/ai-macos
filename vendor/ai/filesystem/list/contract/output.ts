import type {FileEntry} from "../../shared/types.ts"

/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface ListFilesOutput {
  path: string
  entries: FileEntry[]
  truncated: boolean
  depthLimited: boolean
}
