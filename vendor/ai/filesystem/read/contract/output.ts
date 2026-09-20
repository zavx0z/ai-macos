/** Filesystem paths in results are absolute; no workspace identity is returned. */
export interface ReadFileOutput {
  path: string
  content: string
  encoding: "utf8" | "base64"
  offset: number
  bytesRead: number
  size: number
  truncated: boolean
  /** Only present as a hash after reading a whole file; otherwise null. */
  contentHash: string | null
}
