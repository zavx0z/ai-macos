export interface FileEntry {
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size: number
  mode: number
  modifiedAt: string
}
