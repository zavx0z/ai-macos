/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface WriteFileOutput {
  path: string
  bytes: number
  contentHash: string
}
