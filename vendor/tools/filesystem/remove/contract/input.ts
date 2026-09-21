/** Standalone tool input. Authorization belongs to the calling host. */
export interface RemovePathInput {
  /** Absolute path. The final symlink is unlinked, not followed. */
  path: string
  /** Default false; required to remove a nonempty directory. */
  recursive?: boolean
}
