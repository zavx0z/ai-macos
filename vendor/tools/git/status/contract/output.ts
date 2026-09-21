export interface GitStatusOutput {
  /** Absolute checkout path; entry paths retain Git's checkout-relative format. */
  path: string
  branch: string
  entries: {index: string; worktree: string; path: string; originalPath?: string}[]
  truncated: boolean
}
