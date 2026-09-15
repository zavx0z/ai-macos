import { nativeLifecycleAckMatches, type NativeAdapter, type NativeGeneration } from "@meta/shared/contracts"

export type RuntimeHeartbeatFailureClass = "deadline" | "invalid-ack" | "adapter"

export class RuntimeHeartbeatFailure extends Error {
  constructor(
    readonly failureClass: RuntimeHeartbeatFailureClass,
    readonly elapsedMs: number,
    readonly timerLagMs: number,
    cause?: unknown,
  ) {
    super(`Native heartbeat ${failureClass}`, cause === undefined ? {} : { cause })
    this.name = "RuntimeHeartbeatFailure"
  }
}

export function runtimeHeartbeatFailureReason(failure: RuntimeHeartbeatFailure): string {
  return `Native heartbeat ${failure.failureClass}; elapsedMs=${failure.elapsedMs}; timerLagMs=${failure.timerLagMs}`
}

export function startRuntimeHeartbeat(options: {
  native: Pick<NativeAdapter, "heartbeat">
  generation: NativeGeneration
  onFailure(error: RuntimeHeartbeatFailure): void
  intervalMs?: number
  deadlineMs?: number
  monotonicNow?: () => number
}): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 250
  const deadlineMs = options.deadlineMs ?? 500
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 250
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 500) throw new Error("Heartbeat cadence выходит за watchdog budget")
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let control: AbortController | undefined
  let pending: Promise<void> | undefined
  const monotonicNow = options.monotonicNow ?? (() => performance.now())

  const beat = async () => {
    if (stopped) return
    const startedAt = monotonicNow()
    const request = { requestId: `heartbeat:${crypto.randomUUID()}`, ...options.generation,
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString() }
    control = new AbortController()
    const controller = control
    const signal = controller.signal
    let deadline: ReturnType<typeof setTimeout> | undefined
    let onAbort!: () => void
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        deadline = setTimeout(() => {
          const elapsedMs = milliseconds(monotonicNow() - startedAt)
          controller.abort(new RuntimeHeartbeatFailure("deadline", elapsedMs, Math.max(0, elapsedMs - deadlineMs)))
        }, deadlineMs)
      })
      const ack = await Promise.race([options.native.heartbeat(request, { signal, checkpoint() { signal.throwIfAborted() } }), cancelled])
      if (!nativeLifecycleAckMatches(request, ack) || !ack.accepted || ack.quarantined) {
        throw new RuntimeHeartbeatFailure("invalid-ack", milliseconds(monotonicNow() - startedAt), 0)
      }
    } catch (cause) {
      if (!stopped) {
        stopped = true
        const elapsedMs = milliseconds(monotonicNow() - startedAt)
        const failure = cause instanceof RuntimeHeartbeatFailure
          ? cause
          : new RuntimeHeartbeatFailure("adapter", elapsedMs, Math.max(0, elapsedMs - deadlineMs), cause)
        options.onFailure(failure)
      }
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      signal.removeEventListener("abort", onAbort)
      if (!stopped) {
        timer = setTimeout(() => { pending = beat() }, intervalMs)
        timer.unref?.()
      }
    }
  }
  pending = beat()
  return { async stop() {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    control?.abort(new Error("Runtime heartbeat остановлен"))
    await pending
  } }
}

function milliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
}
