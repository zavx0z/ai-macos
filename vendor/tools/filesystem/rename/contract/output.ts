/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface RenamePathOutput {
  from: string
  to: string
  renamed: true
}
