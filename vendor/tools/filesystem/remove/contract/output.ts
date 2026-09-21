/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface RemovePathOutput {
  path: string
  removed: true
}
