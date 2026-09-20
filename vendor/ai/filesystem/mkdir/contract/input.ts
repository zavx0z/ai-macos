/** Standalone tool input. Authorization belongs to the calling host. */
export interface MakeDirectoryInput {
  /** Absolute directory path. */
  path: string
  /** Default false. With true, repetition returns created:false. */
  recursive?: boolean
}
