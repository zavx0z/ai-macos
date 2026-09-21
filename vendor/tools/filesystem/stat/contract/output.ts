import type {FileEntry} from "../../shared/types.ts"

/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface StatPathOutput {
  entry: FileEntry
}
