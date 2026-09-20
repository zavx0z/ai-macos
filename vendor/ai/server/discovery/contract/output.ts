/** Lazy structural descriptions; reading a contract or scenario never executes it. */
export interface DiscoveryOutput {
  describe(node?: string, view?: string): unknown
  has(node: string): boolean
}
