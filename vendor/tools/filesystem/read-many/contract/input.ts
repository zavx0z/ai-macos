/** Standalone tool input. Authorization belongs to the calling host. */
export interface ReadFilesInput {
  /** 1..50 absolute paths; files may belong to different directories. */
  paths: string[]
  encoding?: "utf8" | "base64"
  /** Default 65536; maximum 8388608. */
  maxBytesPerFile?: number
  /** Default 2097152; maximum 8388608. */
  maxTotalBytes?: number
}
