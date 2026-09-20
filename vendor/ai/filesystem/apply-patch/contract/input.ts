/** Standalone tool input. Authorization belongs to the calling host. */
export interface ApplyPatchInput {
  /** Absolute directory for the relative paths embedded in the patch. Not a registered workspace. */
  directory: string
  /** Begin Patch format; paths cannot escape directory, including through symlinks. */
  patch: string
  /** Plan and validate without writing files or creating parents. */
  dryRun?: boolean
}
