export type RuntimeRotationStatus = {
  state: "running" | "restart-needed" | "draining" | "blocked" | "restarting"
  reason?: string
}

/** Меняет процессы только через подтверждённый drain; action replay отсутствует. */
export function startRuntimeRotation(configuration: {
  managed: boolean
  reason(): string | undefined
  seal(): void
  drain(signal: AbortSignal): Promise<void>
  close(): Promise<void>
  exit(): void
  intervalMs?: number
  deadlineMs?: number
}) {
  const options = Object.freeze({ ...configuration })
  const intervalMs = options.intervalMs ?? 1000
  const deadlineMs = options.deadlineMs ?? 15_000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 5000
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw new Error("Rotation bounds вне диапазона")
  let status: RuntimeRotationStatus = { state: "running" }
  let pending: Promise<void> | undefined
  let stopped = false
  let controller: AbortController | undefined

  const check = () => {
    if (stopped || pending !== undefined || status.state !== "running") return
    const reason = options.reason()
    if (reason === undefined) return
    options.seal()
    if (!options.managed) { status = { state: "restart-needed", reason }; return }
    status = { state: "draining", reason }
    controller = new AbortController()
    const signal = controller.signal
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const deadline = setTimeout(() => controller?.abort(new Error("Rotation drain deadline")), deadlineMs)
    pending = (async () => {
      try {
        await Promise.race([options.drain(signal), aborted])
        signal.throwIfAborted()
        status = { state: "restarting", reason }
        await Promise.race([options.close(), aborted])
        signal.throwIfAborted()
        options.exit()
      } catch {
        status = { state: "blocked", reason: "Cleanup не подтверждён; exit/replacement запрещён" }
      } finally {
        clearTimeout(deadline)
        signal.removeEventListener("abort", onAbort)
        pending = undefined
      }
    })()
  }
  const timer = setInterval(check, intervalMs)
  timer.unref?.()
  return {
    status: () => ({ ...status }),
    check,
    retryAfterCleanup() { if (!stopped && status.state === "blocked") { status = { state: "running" }; check() } },
    stop() { stopped = true; clearInterval(timer) },
  }
}
