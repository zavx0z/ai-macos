/** Trusted source checkout used only for structural metadata. It is not a filesystem tool root. */
export interface DiscoveryInput {
  repositoryRoot: string
  /** Доверенный источник упакованных текстовых метаданных. */
  readSource?: (name: string, optional?: boolean) => string | null
  runnable: ReadonlySet<string>
}
