/** Read-only Git operation. No registration, session or workspace context. */
export interface GitStatusInput {
  /** Absolute checkout directory containing .git. Ancestor repositories are not selected implicitly. */
  path: string
  /** Default 1000; range 1..5000. */
  maxEntries?: number
}
