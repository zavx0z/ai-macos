/** Optional HTTP listener configuration, not universal tool arguments. */
export interface ServerInput {
  /** Absolute allowed directories. No aliases or tool-visible registration. Required to avoid widening an old configuration silently. */
  allowedDirectories: string[]
  token: string
  hostname?: string
  /** Default 8787; 0 asks the OS for a free port in integration tests. */
  port?: number
  repositoryRoot?: string
  log?: boolean
}
