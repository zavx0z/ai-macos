export type WindowIdentity = { pid: number; windowId: number }

export type ExactWindow = WindowIdentity & {
  app: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

export type WindowObservation = {
  epoch: string
  observedAt: string
  windows: ExactWindow[]
}

export type ScreenshotEvidence = {
  data: string
  mimeType: "image/png"
  width?: number
  height?: number
  caption: string
}

export interface DesktopActionAdapter {
  observe(app?: string): Promise<WindowObservation>
  focused(): Promise<{ epoch: string; focused: WindowIdentity | null }>
  focusExact(identity: WindowIdentity): Promise<void>
  shortcut(shortcut: string): Promise<void>
  capture(identity: WindowIdentity, caption: string): Promise<ScreenshotEvidence>
  sleep(ms: number): Promise<void>
  now(): number
}

export type ActionRequest = {
  app?: string
  targetHandle?: string
  shortcut: string
  verifyTitlePrefix?: string
  deadlineMs?: number
  idempotencyKey?: string
}

export type Candidate = {
  handle: string
  app: string
  title: string
  bounds: { x: number; y: number; width: number; height: number }
  expiresAt: string
}

export type TypedError = {
  code: string
  message: string
  nextAction: string
  candidates?: Candidate[]
  correlationId: string
}

export type AuditStage = {
  stage: string
  outcome: "ok" | "skipped" | "failed"
  atMs: number
  durationMs: number
  detail?: string
}

export type DesktopActionResult = {
  status:
    | "target_not_found"
    | "needs_target"
    | "rejected_stale_target"
    | "action_failed"
    | "delivered_unverified"
    | "verified"
    | "verified_without_artifact"
    | "verified_restoration_failed"
  correlationId: string
  target?: { handle: string; app: string; title: string }
  delivery: { status: "not_attempted" | "delivered" | "failed" | "unknown"; error?: string }
  effect: {
    status: "not_checked" | "confirmed" | "unconfirmed" | "check_failed"
    evidence?: { kind: "window_title_changed"; before: string; after: string }
    error?: string
  }
  verification: { status: "not_run" | "confirmed" | "unconfirmed" | "failed" }
  restoration: {
    status: "not_needed" | "restored" | "previous_target_gone" | "failed"
    error?: string
  }
  artifact?: {
    kind: "screenshot"
    mimeType: "image/png"
    imageIncluded: true
    caption: string
  }
  error?: TypedError
  audit: AuditStage[]
  timings: { totalMs: number; boundedByMs: number }
  _image?: ScreenshotEvidence
}
