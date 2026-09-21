/** Standalone tool input. Authorization belongs to the calling host. */
export interface RenamePathInput {
  /** Absolute source path. */
  from: string
  /** Absolute destination. No overwrite or implicit parent creation. */
  to: string
}
