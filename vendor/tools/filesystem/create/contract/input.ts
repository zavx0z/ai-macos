/** Standalone tool input. Authorization belongs to the calling host. */
export interface CreateFileInput {
  /** Absolute path of a new file. Existing destinations are never replaced. */
  path: string
  content: string
  encoding?: "utf8" | "base64"
  /** Default false. I/O failure may leave newly created parents. */
  createParents?: boolean
}
