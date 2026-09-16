import type { QuarantinedRestartReceipt } from "./restart-quarantined.ts"

export type RuntimeRotationStatus = {
  state: "running" | "restart-needed" | "draining" | "blocked" | "restarting"
  reason?: string
  recovery?: "restart-safe-quarantined"
}

/** Меняет процессы только через подтверждённый drain; action replay отсутствует. */
export function startRuntimeRotation(configuration: {
  managed: boolean
  reason(): string | undefined
  seal(): void
  drain(signal: AbortSignal): Promise<void>
  prepareRecoveryRestart?(signal: AbortSignal): Promise<QuarantinedRestartReceipt>
  close(): Promise<void>
  exit(): void
  deadlineMs?: number
  drainDeadlineMs?: number
}) {
  const options = Object.freeze({ ...configuration })
  const deadlineMs = options.deadlineMs ?? 15_000
  const drainDeadlineMs = options.drainDeadlineMs ?? (options.prepareRecoveryRestart === undefined
    ? deadlineMs : Math.max(1, Math.min(5000, Math.floor(deadlineMs / 3))))
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || !Number.isSafeInteger(drainDeadlineMs) || drainDeadlineMs < 1 || drainDeadlineMs > deadlineMs
    || options.prepareRecoveryRestart !== undefined && drainDeadlineMs >= deadlineMs) throw new Error("Rotation bounds вне диапазона или без резерва для recovery")
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
        let quarantined = false
        try { await Promise.race([drainPhase(options.drain, signal, drainDeadlineMs), aborted]) }
        catch (error) {
          signal.throwIfAborted()
          if (options.prepareRecoveryRestart === undefined) throw error
          const retained = await Promise.race([options.prepareRecoveryRestart(signal), aborted])
          if (retained.state !== "restart-safe-quarantined" || !retained.journalDurable || !retained.nativeExit.exitConfirmed) throw new Error("Recovery restart не подтверждён")
          quarantined = true
        }
        signal.throwIfAborted()
        status = { state: "restarting", reason, ...(quarantined ? { recovery: "restart-safe-quarantined" as const } : {}) }
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
  return {
    status: () => ({ ...status }),
    check,
    retryAfterCleanup() { if (!stopped && status.state === "blocked") { status = { state: "running" }; check() } },
    stop() { stopped = true },
  }
}

/** Отмена drain phase не отменяет общий budget для recovery; поздний результат игнорируется. */
async function drainPhase(drain: (signal: AbortSignal) => Promise<void>, overall: AbortSignal, budgetMs: number): Promise<void> {
  const controller = new AbortController()
  const signal = controller.signal
  const onOverallAbort = () => controller.abort(overall.reason)
  overall.addEventListener("abort", onOverallAbort, { once: true })
  if (overall.aborted) onOverallAbort()
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const timer = setTimeout(() => controller.abort(new Error("Rotation drain phase deadline")), budgetMs)
  try {
    await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return drain(signal) }), aborted])
    signal.throwIfAborted()
  } catch (error) {
    controller.abort(error)
    throw error
  } finally {
    clearTimeout(timer)
    overall.removeEventListener("abort", onOverallAbort)
    signal.removeEventListener("abort", onAbort)
  }
}
