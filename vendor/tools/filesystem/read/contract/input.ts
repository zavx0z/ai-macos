/** Standalone tool input. Authorization belongs to the calling host. */
export interface ReadFileInput {
  /** Absolute host path. Existing parent symlinks are canonicalized; a final symlink is rejected. */
  path: string
  /** Byte offset, default 0. */
  offset?: number
  /** Default 65536; maximum 8388608. */
  maxBytes?: number
  /** Use base64 for binary data or byte ranges splitting UTF-8 characters. */
  encoding?: "utf8" | "base64"
}
