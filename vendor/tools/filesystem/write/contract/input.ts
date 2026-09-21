/** Standalone tool input. Authorization belongs to the calling host. */
export interface WriteFileInput {
  /** Absolute path of an existing regular file. */
  path: string
  content: string
  encoding?: "utf8" | "base64"
  /** Lowercase SHA-256; conflict detection, not a cross-process lock. */
  expectedHash?: string
}
