/** Единственный absolute deadline передаётся вниз вместе с локальным AbortSignal.
 * Метаданные не входят в wire DTO и не принимаются от удалённого клиента. */
const deadlines = new WeakMap<AbortSignal, number>()

export function signalDeadline(signal: AbortSignal | undefined): number | undefined {
  return signal === undefined ? undefined : deadlines.get(signal)
}

export function bindDeadline(signal: AbortSignal, deadlineAtMs: number): void {
  if (!Number.isFinite(deadlineAtMs)) throw new Error("Invalid operation deadline")
  const previous = deadlines.get(signal)
  if (previous !== undefined && previous !== deadlineAtMs) throw new Error("Deadline уже установлен")
  deadlines.set(signal, deadlineAtMs)
}

export function operationDeadline(signal: AbortSignal | undefined, fallbackMs: number, now = Date.now()): string {
  return new Date(signalDeadline(signal) ?? now + fallbackMs).toISOString()
}
