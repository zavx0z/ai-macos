/** JSON envelope shared by an embedded lazy MCP host and the optional HTTP adapter. */
export interface ToolRequest {
  node?: string
  action?: "run"
  input?: Record<string, unknown>
}

export interface ToolInvocation {
  readonly node: string
  /** Detached, deeply frozen arguments. Not a mutable reference to the caller's request. */
  readonly input: Readonly<Record<string, unknown>>
  /** Absolute lexical targets; this list does not assert existence or permission. */
  readonly paths: readonly string[]
  readonly effect: "read" | "write"
}

/** Host dependencies, never fields in a remote request. */
export interface DispatcherInput {
  /** Проверяется непосредственно перед синхронным исполнением. */
  signal?: AbortSignal
  /** Доверенный источник упакованных текстовых метаданных. */
  readSource?: (name: string, optional?: boolean) => string | null

  /** Trusted source tree for lazy descriptions, not an execution workspace. */
  repositoryRoot: string
  /** Must return true for each run. Missing, false, undefined or thrown approval never executes a tool. */
  authorize?: (invocation: ToolInvocation) => boolean | Promise<boolean>
}
