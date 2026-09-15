import { nativeLifecycleAckMatches, type NativeAdapter, type NativeGeneration } from "@meta/shared/contracts"

export function startRuntimeHeartbeat(options: {
  native: Pick<NativeAdapter, "heartbeat">
  generation: NativeGeneration
  onFailure(error: Error): void
  intervalMs?: number
  deadlineMs?: number
}): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 250
  const deadlineMs = options.deadlineMs ?? 500
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 250
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 500) throw new Error("Heartbeat cadence выходит за watchdog budget")
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let control: AbortController | undefined
  let pending: Promise<void> | undefined

  const beat = async () => {
    if (stopped) return
    const request = { requestId: `heartbeat:${crypto.randomUUID()}`, ...options.generation,
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString() }
    control = new AbortController()
    const signal = control.signal
    let deadline: ReturnType<typeof setTimeout> | undefined
    let onAbort!: () => void
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        deadline = setTimeout(() => control?.abort(new Error("Native heartbeat deadline")), deadlineMs)
      })
      const ack = await Promise.race([options.native.heartbeat(request, { signal, checkpoint() { signal.throwIfAborted() } }), cancelled])
      if (!nativeLifecycleAckMatches(request, ack) || !ack.accepted || ack.quarantined) throw new Error("Native heartbeat не подтвердил current generation liveness")
    } catch (cause) {
      if (!stopped) {
        stopped = true
        options.onFailure(cause instanceof Error ? cause : new Error(String(cause)))
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
