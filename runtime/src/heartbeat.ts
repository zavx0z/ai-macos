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

/** Heartbeat обслуживает только незавершённую Native operation, не простой desktop. */
export function startRuntimeHeartbeat(options: {
  native: Pick<NativeAdapter, "heartbeat">
  generation: NativeGeneration
  onFailure(error: RuntimeHeartbeatFailure): void
  active?: boolean
  intervalMs?: number
  deadlineMs?: number
  monotonicNow?: () => number
}): { setActive(active: boolean): void, stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 250
  const deadlineMs = options.deadlineMs ?? 500
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 250
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 500) throw new Error("Heartbeat cadence выходит за watchdog budget")
  let stopped = false
  let active = options.active ?? true
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let control: AbortController | undefined
  let pending: Promise<void> | undefined
  const monotonicNow = options.monotonicNow ?? (() => performance.now())

  const kick = () => {
    if (!stopped && active && pending === undefined) pending = beat()
  }
  const beat = async () => {
    const ownEpoch = epoch
    const startedAt = monotonicNow()
    const request = { requestId: `heartbeat:${crypto.randomUUID()}`, ...options.generation,
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString() }
    const controller = new AbortController()
    control = controller
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
      // Поздняя ошибка уже завершённой operation не отравляет следующую/простой.
      if (!stopped && active && epoch === ownEpoch) {
        stopped = true
        const elapsedMs = milliseconds(monotonicNow() - startedAt)
        options.onFailure(cause instanceof RuntimeHeartbeatFailure ? cause
          : new RuntimeHeartbeatFailure("adapter", elapsedMs, Math.max(0, elapsedMs - deadlineMs), cause))
      }
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      signal.removeEventListener("abort", onAbort)
      control = undefined
      pending = undefined
      if (!stopped && active) {
        if (epoch !== ownEpoch) queueMicrotask(kick)
        else {
          timer = setTimeout(() => { timer = undefined; kick() }, intervalMs)
          timer.unref?.()
        }
      }
    }
  }
  kick()
  return {
    setActive(next) {
      if (stopped || active === next) return
      active = next
      epoch++
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (!active) control?.abort(new Error("Native operation завершена"))
      else kick()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      control?.abort(new Error("Runtime heartbeat остановлен"))
      await pending
    },
  }
}

function milliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
}
