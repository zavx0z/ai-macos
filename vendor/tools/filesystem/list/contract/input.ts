/** Standalone tool input. Authorization belongs to the calling host. */
export interface ListFilesInput {
  /** Absolute directory path; never inferred from process.cwd(). */
  path: string
  recursive?: boolean
  /** Default 3; range 1..10. */
  maxDepth?: number
  /** Default 1000; range 1..5000. Truncation is not pagination. */
  maxEntries?: number
}
