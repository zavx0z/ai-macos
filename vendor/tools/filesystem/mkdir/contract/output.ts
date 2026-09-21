/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface MakeDirectoryOutput {
  path: string
  created: boolean
}
