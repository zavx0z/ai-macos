import type {
  ActionRequest,
  AuditStage,
  DesktopActionAdapter,
  DesktopActionResult,
  ExactWindow,
  ScreenshotEvidence,
  WindowIdentity,
} from "./contracts.ts"
import { LeaseStore } from "./lease-store.ts"

function sameIdentity(a: WindowIdentity | null | undefined, b: WindowIdentity | null | undefined) {
  return a != null && b != null && a.pid === b.pid && a.windowId === b.windowId
}

function identityOf(value: WindowIdentity): WindowIdentity {
  return { pid: value.pid, windowId: value.windowId }
}

class Mutex {
  private tail = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    const previous = this.tail
    this.tail = previous.then(() => next)
    await previous
    try { return await fn() } finally { release() }
  }
}

export class DesktopActionTransaction {
  private readonly lock = new Mutex()
  private readonly idempotency = new Map<string, DesktopActionResult>()

  constructor(
    private readonly adapter: DesktopActionAdapter,
    private readonly leases = new LeaseStore(),
  ) {}

  async execute(request: ActionRequest): Promise<DesktopActionResult> {
    if (request.idempotencyKey) {
      const previous = this.idempotency.get(request.idempotencyKey)
      if (previous) return structuredClone(previous)
    }
    const result = await this.lock.run(() => this.executeLocked(request))
    if (request.idempotencyKey) this.idempotency.set(request.idempotencyKey, structuredClone(result))
    return result
  }

  private async executeLocked(request: ActionRequest): Promise<DesktopActionResult> {
    const started = this.adapter.now()
    const boundedByMs = Math.min(Math.max(request.deadlineMs ?? 12_000, 1_000), 30_000)
    const deadline = started + boundedByMs
    const correlationId = crypto.randomUUID()
    const audit: AuditStage[] = []
    let delivery: DesktopActionResult["delivery"] = { status: "not_attempted" }
    let effect: DesktopActionResult["effect"] = { status: "not_checked" }
    let verification: DesktopActionResult["verification"] = { status: "not_run" }
    let restoration: DesktopActionResult["restoration"] = { status: "not_needed" }
    let artifact: DesktopActionResult["artifact"]
    let image: ScreenshotEvidence | undefined
    let target: ExactWindow | undefined
    let targetHandle: string | undefined
    let previous: WindowIdentity | null = null
    let actionError: Error | undefined

    const mark = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
      const at = this.adapter.now()
      try {
        if (at >= deadline) throw new Error(`deadline exceeded before ${stage}`)
        const value = await fn()
        audit.push({ stage, outcome: "ok", atMs: at - started, durationMs: this.adapter.now() - at })
        return value
      } catch (error) {
        audit.push({ stage, outcome: "failed", atMs: at - started, durationMs: this.adapter.now() - at, detail: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }

    const markRestoration = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
      const at = this.adapter.now()
      try {
        const value = await fn()
        audit.push({ stage, outcome: "ok", atMs: at - started, durationMs: this.adapter.now() - at })
        return value
      } catch (error) {
        audit.push({ stage, outcome: "failed", atMs: at - started, durationMs: this.adapter.now() - at, detail: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }

    const finish = (status: DesktopActionResult["status"], error?: DesktopActionResult["error"]): DesktopActionResult => ({
      status,
      correlationId,
      ...(target && targetHandle ? { target: { handle: targetHandle, app: target.app, title: target.title } } : {}),
      delivery,
      effect,
      verification,
      restoration,
      ...(artifact ? { artifact } : {}),
      ...(error ? { error } : {}),
      audit,
      timings: { totalMs: this.adapter.now() - started, boundedByMs },
      ...(image ? { _image: image } : {}),
    })

    let initial
    try {
      initial = await mark("observe", () => this.adapter.observe(request.app))
    } catch (error) {
      return finish("action_failed", this.typed("adapter_unavailable", error, "Check system_health and service readiness", correlationId))
    }

    if (request.targetHandle) {
      const lease = this.leases.get(request.targetHandle)
      if (!lease || lease.epoch !== initial.epoch) {
        return finish("rejected_stale_target", this.typed("stale_target", "Target handle is expired or from another service epoch", "Repeat the action with app to obtain fresh candidates", correlationId))
      }
      target = initial.windows.find((window) => sameIdentity(window, lease.identity))
      targetHandle = lease.handle
      if (!target) {
        return finish("rejected_stale_target", this.typed("target_closed", "The selected window no longer exists", "Refresh target candidates and select again", correlationId))
      }
    } else {
      const app = request.app?.trim()
      if (!app) return finish("target_not_found", this.typed("invalid_target", "Provide app or targetHandle", "Pass the canonical visible application name", correlationId))
      if (initial.windows.length === 0) {
        return finish("target_not_found", this.typed("target_not_found", `No visible window for ${app}`, "Ask the user to open the app or choose another visible target; do not launch it automatically", correlationId))
      }
      if (initial.windows.length > 1) {
        const candidates = initial.windows.map((window) => this.leases.candidate(initial.epoch, window))
        return finish("needs_target", {
          code: "needs_target",
          message: `Multiple visible windows match ${app}`,
          nextAction: "Ask the user which candidate to use, then repeat with targetHandle",
          candidates,
          correlationId,
        })
      }
      target = initial.windows[0]!
      const lease = this.leases.issue(initial.epoch, target)
      targetHandle = lease.handle
    }

    const beforeTitle = target.title
    try {
      previous = (await mark("save_previous_focus", () => this.adapter.focused())).focused
      await mark("focus_exact_target", () => this.adapter.focusExact(identityOf(target!)))

      await mark("pre_dispatch_guard", async () => {
        const [fresh, focus] = await Promise.all([this.adapter.observe(), this.adapter.focused()])
        const lease = this.leases.get(targetHandle!)
        if (!lease || fresh.epoch !== lease.epoch) throw new Error("target lease became stale")
        if (!fresh.windows.some((window) => sameIdentity(window, target))) throw new Error("target closed before dispatch")
        if (!sameIdentity(focus.focused, target)) throw new Error("exact target is not focused before dispatch")
        const current = fresh.windows.find((window) => sameIdentity(window, target))!
        if (request.verifyTitlePrefix && !current.title.startsWith(request.verifyTitlePrefix)) {
          throw new Error("verification title prefix does not match the fresh target")
        }
      })

      await mark("dispatch_shortcut", () => this.adapter.shortcut(request.shortcut))
      delivery = { status: "delivered" }

      if (request.shortcut.toLowerCase().replaceAll(" ", "") === "cmd+r" && request.verifyTitlePrefix) {
        try {
          const changed = await mark("verify_title_change", async () => {
            const verifyDeadline = Math.min(deadline, this.adapter.now() + 2_000)
            while (this.adapter.now() < verifyDeadline) {
              const observed = await this.adapter.observe()
              const current = observed.windows.find((window) => sameIdentity(window, target))
              if (!current) throw new Error("target closed during effect verification")
              if (current.title !== beforeTitle && current.title.startsWith(request.verifyTitlePrefix!)) return current.title
              await this.adapter.sleep(100)
            }
            return null
          })
          if (changed != null) {
            effect = { status: "confirmed", evidence: { kind: "window_title_changed", before: beforeTitle, after: changed } }
            verification = { status: "confirmed" }
          } else {
            effect = { status: "unconfirmed" }
            verification = { status: "unconfirmed" }
          }
        } catch (error) {
          effect = { status: "check_failed", error: error instanceof Error ? error.message : String(error) }
          verification = { status: "failed" }
        }
      }
    } catch (error) {
      actionError = error instanceof Error ? error : new Error(String(error))
      if (audit.some((entry) => entry.stage === "dispatch_shortcut" && entry.outcome === "failed")) delivery = { status: "unknown", error: actionError.message }
      else if (delivery.status === "not_attempted") delivery = { status: "not_attempted", error: actionError.message }
      else delivery = { status: "failed", error: actionError.message }
    }

    if (target) {
      try {
        const caption = `Post-action evidence for ${target.app} window ${target.windowId}`
        image = await mark("capture_post_action", () => this.adapter.capture(identityOf(target!), caption))
        artifact = { kind: "screenshot", mimeType: "image/png", imageIncluded: true, caption }
      } catch (error) {
        audit.push({ stage: "screenshot_artifact", outcome: "failed", atMs: this.adapter.now() - started, durationMs: 0, detail: error instanceof Error ? error.message : String(error) })
      }
    }

    try {
      if (previous && !sameIdentity(previous, target)) {
        const observed = await this.adapter.observe()
        if (!observed.windows.some((window) => sameIdentity(window, previous))) {
          restoration = { status: "previous_target_gone", error: "previous focused window closed before restoration" }
        } else {
          await markRestoration("restore_previous_focus", () => this.adapter.focusExact(previous!))
          const restored = await this.adapter.focused()
          restoration = sameIdentity(restored.focused, previous)
            ? { status: "restored" }
            : { status: "failed", error: "restoration focus verification failed" }
        }
      }
    } catch (error) {
      restoration = { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }

    if (actionError) {
      const stale = actionError.message.includes("stale") || actionError.message.includes("closed before dispatch")
      return finish(stale ? "rejected_stale_target" : "action_failed", this.typed(stale ? "stale_target" : "action_failed", actionError, stale ? "Refresh the target and retry" : "Inspect audit stages and service health", correlationId))
    }
    if (effect.status !== "confirmed") return finish("delivered_unverified")
    if (restoration.status === "failed" || restoration.status === "previous_target_gone") return finish("verified_restoration_failed")
    return finish("verified")
  }

  private typed(code: string, error: unknown, nextAction: string, correlationId: string) {
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
      nextAction,
      correlationId,
    }
  }
}
