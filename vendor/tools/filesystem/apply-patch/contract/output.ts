/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface ApplyPatchOutput {
  directory: string
  applied: boolean
  changes: {operation: "add" | "update" | "delete" | "move"; path: string; from?: string; bytes: number}[]
}
