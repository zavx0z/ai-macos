/** Ограниченный grace относится к lineage; reconnect отменяет только ещё не начатый cleanup. */
export class ClientDisconnectGrace {
  readonly #entries = new Map<string, { timer?: ReturnType<typeof setTimeout>, controller?: AbortController, pending?: Promise<void> }>()
  #closed = false
  constructor(readonly options: {
    cleanup(lineageId: string, signal: AbortSignal): Promise<void>
    failed(lineageId: string, error: Error): void
    graceMs?: number
    cleanupMs?: number
  }) {
    this.options = Object.freeze({ ...options })
    for (const value of [options.graceMs ?? 30_000, options.cleanupMs ?? 5000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error("Client grace bounds вне диапазона")
    }
  }

  connected(lineageId: string): void {
    const entry = this.#entries.get(lineageId)
    if (entry?.pending !== undefined) return
    if (entry?.timer !== undefined) clearTimeout(entry.timer)
    this.#entries.delete(lineageId)
  }

  get pendingCount(): number { return this.#entries.size }

  async drain(): Promise<void> {
    this.#closed = true
    for (const entry of this.#entries.values()) if (entry.timer !== undefined) clearTimeout(entry.timer)
    await Promise.all([...this.#entries.values()].map(entry => entry.pending))
    this.#entries.clear()
  }

  disconnected(lineageId: string): void {
    if (this.#closed || this.#entries.has(lineageId)) return
    if (this.#entries.size >= 10_000) throw new Error("Client grace capacity exceeded")
    const entry: { timer?: ReturnType<typeof setTimeout>, controller?: AbortController, pending?: Promise<void> } = {}
    entry.timer = setTimeout(() => {
      entry.controller = new AbortController()
      const signal = entry.controller.signal
      const deadline = setTimeout(() => entry.controller?.abort(new Error("Client cleanup deadline")), this.options.cleanupMs ?? 5000)
      let onAbort!: () => void
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      })
      entry.pending = Promise.race([Promise.resolve().then(() => this.options.cleanup(lineageId, signal)), aborted])
        .catch(error => { if (!this.#closed) this.options.failed(lineageId, error instanceof Error ? error : new Error(String(error))) })
        .finally(() => {
          clearTimeout(deadline)
          signal.removeEventListener("abort", onAbort)
          this.#entries.delete(lineageId)
        })
    }, this.options.graceMs ?? 30_000)
    entry.timer.unref?.()
    this.#entries.set(lineageId, entry)
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const entry of this.#entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.controller?.abort(new Error("Client grace закрыт"))
    }
    await Promise.all([...this.#entries.values()].map(entry => entry.pending))
    this.#entries.clear()
  }
}
