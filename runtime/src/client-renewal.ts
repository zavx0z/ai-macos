export type ClientSessionTiming = { authenticatedAt: string, expiresAt: string }

/** Обновляет credential только между calls; действие никогда не повторяется. */
export class ClientRenewalCoordinator {
  readonly #now: () => number
  readonly #renew: (signal: AbortSignal) => Promise<ClientSessionTiming>
  readonly #closedSignal = new AbortController()
  readonly #idleWaiters = new Set<() => void>()
  #timing?: ClientSessionTiming
  #timer?: ReturnType<typeof setTimeout>
  #renewing?: Promise<void>
  #active = 0
  #closed = false
  #deferred = false

  constructor(options: { now?: () => number, renew(signal: AbortSignal): Promise<ClientSessionTiming> }) {
    this.#now = options.now ?? Date.now
    this.#renew = options.renew
  }

  setCredential(timing: ClientSessionTiming): void {
    const start = Date.parse(timing.authenticatedAt)
    const end = Date.parse(timing.expiresAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 2 * 60 * 60 * 1000) throw new Error("Invalid client session timing")
    if (this.#closed) return
    this.#timing = { ...timing }
    this.#schedule()
  }

  async enter(requiredMs: number, callerSignal?: AbortSignal): Promise<{ signal: AbortSignal, release(): void }> {
    if (!Number.isSafeInteger(requiredMs) || requiredMs < 0 || requiredMs > 180_000) throw new Error("Client call budget вне bounds")
    const signal = AbortSignal.any([this.#closedSignal.signal, ...(callerSignal === undefined ? [] : [callerSignal])])
    signal.throwIfAborted()
    if (this.#timing === undefined) throw new Error("Client credential ещё не установлен")
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      if (this.#renewing !== undefined) await abortable(this.#renewing, signal)
      if (Date.parse(this.#timing.expiresAt) - this.#now() > requiredMs + this.#margin()) {
        this.#active++
        let released = false
        return { signal, release: () => {
          if (released) return
          released = true
          this.#active--
          if (this.#active !== 0) return
          for (const wake of this.#idleWaiters) wake()
          this.#idleWaiters.clear()
          if (this.#deferred) { this.#deferred = false; this.#automatic() }
        } }
      }
      await this.#idle(signal)
      await abortable(this.#refresh(), signal)
    }
    throw new Error("Client credential TTL недостаточен для method budget")
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#closedSignal.abort(new Error("Runtime client закрыт"))
  }

  async renewNow(signal = this.#closedSignal.signal): Promise<void> {
    await this.#idle(signal)
    await abortable(this.#refresh(), signal)
  }

  #margin(): number {
    return this.#timing === undefined ? 0 : Math.min(60_000, Math.max(1, Math.floor((Date.parse(this.#timing.expiresAt) - Date.parse(this.#timing.authenticatedAt)) / 5)))
  }

  #schedule(delayMs?: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    if (this.#closed || this.#timing === undefined) return
    const delay = delayMs ?? Math.max(1, Date.parse(this.#timing.expiresAt) - this.#now() - this.#margin())
    this.#timer = setTimeout(() => this.#automatic(), delay)
    this.#timer.unref?.()
  }

  #automatic(): void {
    if (this.#closed) return
    if (this.#active > 0) { this.#deferred = true; return }
    void this.#refresh().catch(() => this.#schedule(1000))
  }

  #refresh(): Promise<void> {
    if (this.#renewing !== undefined) return this.#renewing
    if (this.#closed || this.#active > 0) return Promise.reject(new Error("Client renewal требует idle connection"))
    const pending = this.#renew(this.#closedSignal.signal).then(timing => { this.setCredential(timing) })
    this.#renewing = pending
    void pending.finally(() => { if (this.#renewing === pending) this.#renewing = undefined }).catch(() => undefined)
    return pending
  }

  async #idle(signal: AbortSignal): Promise<void> {
    if (this.#active === 0) return
    let wake!: () => void
    const idle = new Promise<void>(resolve => { wake = resolve; this.#idleWaiters.add(wake) })
    try { await abortable(idle, signal) }
    finally { this.#idleWaiters.delete(wake) }
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([promise, aborted]) }
  finally { signal.removeEventListener("abort", onAbort) }
}
