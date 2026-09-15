export type QuarantinedRestartReceipt = Readonly<{
  state: "restart-safe-quarantined"
  journalDurable: true
  operationIds: readonly string[]
  nativeExit: { pid: number, exitConfirmed: true, exitCode: number }
}>

/** Завершает owned actor, но никогда не объявляет cleanup старых операций complete. */
export async function prepareQuarantinedRestart(options: {
  seal(): void
  retain(signal: AbortSignal): Promise<{ journalDurable: true, operationIds: readonly string[] }>
  stopOwnedNative(signal: AbortSignal): Promise<{ pid: number, exitConfirmed: boolean, exitCode: number | null }>
  persistExit(receipt: QuarantinedRestartReceipt): Promise<void>
  signal?: AbortSignal
  deadlineMs?: number
}): Promise<QuarantinedRestartReceipt> {
  const deadlineMs = options.deadlineMs ?? 15_000
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw new Error("Recovery restart deadline вне bounds")
  options.signal?.throwIfAborted()
  options.seal()
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error("Recovery restart deadline")), deadlineMs)
  const signal = controller.signal
  let abortListener!: () => void
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(signal.reason)
    signal.addEventListener("abort", abortListener, { once: true })
    if (signal.aborted) abortListener()
  })
  try {
    const retained = await Promise.race([options.retain(signal), aborted])
    signal.throwIfAborted()
    if (retained.journalDurable !== true) throw new Error("Recovery restart не имеет durable quarantine")
    const exited = await Promise.race([options.stopOwnedNative(signal), aborted])
    signal.throwIfAborted()
    if (!exited.exitConfirmed || exited.exitCode === null || !Number.isSafeInteger(exited.pid) || exited.pid < 1) throw new Error("Owned native exit не подтверждён")
    const receipt: QuarantinedRestartReceipt = Object.freeze({ state: "restart-safe-quarantined", journalDurable: true,
      operationIds: Object.freeze([...retained.operationIds]), nativeExit: Object.freeze({ pid: exited.pid, exitConfirmed: true, exitCode: exited.exitCode }) })
    await Promise.race([options.persistExit(receipt), aborted])
    signal.throwIfAborted()
    return receipt
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abortListener)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
