import {
  observedEventSchema,
  type ObservedEvent,
  type ObserverCoverage,
} from "@meta/shared/contracts"
import type { NativeBrokerAdapter } from "@meta/native"
import {
  nativeObserverRequestSchema,
  type NativeObservedEvent,
  type NativeObserverSnapshot,
} from "@meta/native/protocol"
import { randomIdSource, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export const OBSERVER_HUB_LIMITS = Object.freeze({
  maxSubscribers: 128,
  maxEventsPerSubscriber: 256,
  maxBytesPerSubscriber: 1024 * 1024,
  maxHistoryEvents: 1_000,
  maxHistoryBytes: 1024 * 1024,
  controlTimeoutMs: 1_000,
  closeMs: 1_000,
})

export type NativeObserverClient = Pick<
  NativeBrokerAdapter,
  "events" | "observer" | "generation" | "loadedBuildId"
>

type EventEntry = {
  event: ObservedEvent
  bytes: number
}

type Subscriber = {
  queue: EventEntry[]
  bytes: number
  signal?: AbortSignal
  onAbort?: () => void
  waiter?: {
    resolve: (value: IteratorResult<ObservedEvent>) => void
    reject: (error: Error) => void
  }
  closed: boolean
  error?: Error
}

export class RuntimeNativeObserverHub {
  readonly #native: NativeObserverClient
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #snapshot: NativeObserverSnapshot
  readonly #diagnostic: (event: ObservedEvent) => void
  readonly #onGap: (error: Error) => void
  readonly #maxSubscribers: number
  readonly #maxEventsPerSubscriber: number
  readonly #maxBytesPerSubscriber: number
  readonly #maxHistoryEvents: number
  readonly #maxHistoryBytes: number
  readonly #controlTimeoutMs: number
  readonly #closeMs: number
  readonly #readerAbort = new AbortController()
  readonly #subscribers = new Set<Subscriber>()
  readonly #history: EventEntry[] = []
  #historyBytes = 0
  #historyBeforeCursor: string
  #nextSequence: number
  #cursor: string
  #coverage: ObserverCoverage
  #reader: Promise<void> | undefined
  #gap: Error | undefined
  #closed = false
  #coveragePending: Promise<ObserverCoverage> | undefined
  #pulse: Promise<void> | undefined
  #wake: (() => void) | undefined

  constructor(options: {
    native: NativeObserverClient
    snapshot: NativeObserverSnapshot
    now?: RuntimeClock
    ids?: RuntimeIdSource
    diagnostic?: (event: ObservedEvent) => void
    onGap?: (error: Error) => void
    maxSubscribers?: number
    maxEventsPerSubscriber?: number
    maxBytesPerSubscriber?: number
    maxHistoryEvents?: number
    maxHistoryBytes?: number
    controlTimeoutMs?: number
    closeMs?: number
  }) {
    const generation = options.native.generation
    if (
      generation === undefined
      || options.snapshot.coverage.runtimeEpoch !== generation.runtimeEpoch
      || options.snapshot.coverage.loginSessionId !== generation.loginSessionId
      || options.snapshot.coverage.nativeGeneration !== generation.nativeGeneration
    ) {
      throw new Error("Observer hub snapshot принадлежит другой native generation")
    }
    this.#native = options.native
    this.#snapshot = structuredClone(options.snapshot)
    this.#coverage = structuredClone(options.snapshot.coverage)
    this.#nextSequence = options.snapshot.coverage.nextSequence
    this.#cursor = options.snapshot.coverage.cursor
    this.#historyBeforeCursor = options.snapshot.coverage.cursor
    this.#clock = options.now ?? systemClock
    this.#ids = options.ids ?? randomIdSource
    this.#diagnostic = options.diagnostic ?? (() => undefined)
    this.#onGap = options.onGap ?? (() => undefined)
    this.#maxSubscribers = limit(options.maxSubscribers, OBSERVER_HUB_LIMITS.maxSubscribers, 1, 1_024)
    this.#maxEventsPerSubscriber = limit(options.maxEventsPerSubscriber, OBSERVER_HUB_LIMITS.maxEventsPerSubscriber, 1, 1_000)
    this.#maxBytesPerSubscriber = limit(options.maxBytesPerSubscriber, OBSERVER_HUB_LIMITS.maxBytesPerSubscriber, 128, 8 * 1024 * 1024)
    this.#maxHistoryEvents = limit(options.maxHistoryEvents, OBSERVER_HUB_LIMITS.maxHistoryEvents, 1, 10_000)
    this.#maxHistoryBytes = limit(options.maxHistoryBytes, OBSERVER_HUB_LIMITS.maxHistoryBytes, 128, 8 * 1024 * 1024)
    this.#controlTimeoutMs = limit(options.controlTimeoutMs, OBSERVER_HUB_LIMITS.controlTimeoutMs, 1, 5_000)
    this.#closeMs = limit(options.closeMs, OBSERVER_HUB_LIMITS.closeMs, 1, 5_000)
  }

  get observerInstanceRef(): string {
    return this.#snapshot.observerInstanceRef
  }

  start(): void {
    if (this.#closed) throw new Error("Observer hub закрыт")
    if (this.#reader !== undefined) return
    this.#reader = this.#consume()
  }

  subscribe(options: {
    signal?: AbortSignal
    afterCursor?: string
  } = {}): AsyncIterable<ObservedEvent> {
    if (this.#closed) throw new Error("Observer hub закрыт")
    if (this.#gap !== undefined) throw this.#gap
    if (this.#subscribers.size >= this.#maxSubscribers) {
      throw new Error("Observer hub subscriber budget исчерпан")
    }
    const subscriber: Subscriber = {
      queue: this.#historyAfter(options.afterCursor),
      bytes: 0,
      signal: options.signal,
      closed: false,
    }
    subscriber.bytes = subscriber.queue.reduce((total, entry) => total + entry.bytes, 0)
    if (
      subscriber.queue.length > this.#maxEventsPerSubscriber
      || subscriber.bytes > this.#maxBytesPerSubscriber
    ) {
      throw new Error("Observer replay превышает subscriber budget")
    }
    this.#subscribers.add(subscriber)
    const onAbort = () => this.#closeSubscriber(subscriber)
    subscriber.onAbort = onAbort
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const hub = this
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const next = await hub.#next(subscriber)
            if (next.done) return
            yield next.value
          }
        } finally {
          hub.#closeSubscriber(subscriber)
        }
      },
    }
  }

  async coverage(signal?: AbortSignal): Promise<ObserverCoverage> {
    if (signal?.aborted) return this.#unavailableCoverage(String(signal.reason ?? "Observer coverage отменена"), false)
    // Одно native control-обращение на hub. Отмена одного caller не отменяет
    // общий запрос другого caller и не создаёт конкурентные observer commands.
    if (this.#coveragePending === undefined) {
      const pending = this.#readCoverage().finally(() => {
        if (this.#coveragePending === pending) this.#coveragePending = undefined
      })
      this.#coveragePending = pending
    }
    try { return structuredClone(await abortable(this.#coveragePending, signal)) }
    catch (error) { return this.#unavailableCoverage(error instanceof Error ? error.message : String(error), false) }
  }

  async #readCoverage(): Promise<ObserverCoverage> {
    if (this.#gap !== undefined) return this.#unavailableCoverage(this.#gap.message, true)
    if (this.#closed) return this.#unavailableCoverage("Observer hub закрыт", true)
    if (this.#reader === undefined) return this.#unavailableCoverage("Observer hub consumer не запущен", false)
    const generation = this.#native.generation
    if (generation === undefined) return this.#unavailableCoverage("Native generation недоступна", true)
    const signal = this.#readerAbort.signal
    const requestedSequence = this.#nextSequence
    const requestedCursor = this.#cursor
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason ?? "observer coverage caller cancelled")
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(() => controller.abort(new Error("Observer coverage timeout")), this.#controlTimeoutMs)
    try {
      const deadlineAt = new Date(this.#clock.now().getTime() + this.#controlTimeoutMs).toISOString()
      const request = nativeObserverRequestSchema.parse({
        kind: "observer",
        protocolVersion: "1",
        requestId: this.#ids.next("observer-coverage"),
        ...generation,
        command: "coverage",
        deadlineAt,
        observerInstanceRef: this.#snapshot.observerInstanceRef,
      })
      const response = await abortable(this.#native.observer(request, {
        signal: controller.signal,
        checkpoint: () => { controller.signal.throwIfAborted() },
      }), controller.signal)
      if (!response.ok) return this.#unavailableCoverage(response.error.message, false)
      if (response.snapshot.observerInstanceRef !== this.#snapshot.observerInstanceRef) {
        return this.#markGap("Observer coverage response содержит foreign instance")
      }
      const coverage = response.snapshot.coverage
      if (coverage.coverageStartCursor !== this.#snapshot.coverage.coverageStartCursor) {
        return this.#markGap("Observer coverage start cursor изменился внутри instance")
      }
      if (coverage.gapDetected || coverage.droppedEvents !== 0) {
        return this.#markGap(coverage.reason ?? "Native observer сообщил потерю событий")
      }
      if (coverage.nextSequence < requestedSequence) {
        return this.#markGap("Native observer coverage отстаёт от sequence на момент запроса")
      }
      if (coverage.state !== "ready") return structuredClone(coverage)
      // Ответ control и PUSH доставляются независимо. Ожидаем доставку до
      // зафиксированной отметки, не объявляя транспортное отставание потерей.
      while (this.#nextSequence < coverage.nextSequence) {
        this.#pulse ??= new Promise<void>(resolve => { this.#wake = resolve })
        await abortable(this.#pulse, controller.signal)
      }
      controller.signal.throwIfAborted()
      const expectedCursor = coverage.nextSequence === requestedSequence ? requestedCursor
        : coverage.nextSequence === this.#nextSequence ? this.#cursor
        : this.#history.find(entry => entry.event.sequence === coverage.nextSequence - 1)?.event.cursor
      if (expectedCursor === undefined) {
        return this.#unavailableCoverage("Observer coverage watermark вытеснен из bounded history", false)
      }
      if (coverage.cursor !== expectedCursor) {
        return this.#markGap("Observer coverage cursor расходится с принятым watermark")
      }
      this.#coverage = structuredClone(coverage)
      return structuredClone(coverage)
    } catch (error) {
      return this.#unavailableCoverage(
        error instanceof Error ? error.message : "Observer coverage query failed",
        false,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#readerAbort.abort("observer hub closed")
    await this.#coveragePending
    for (const subscriber of this.#subscribers) this.#closeSubscriber(subscriber)
    if (this.#reader !== undefined) {
      await withTimeout(this.#reader, this.#closeMs).catch(() => undefined)
    }
  }

  async #consume(): Promise<void> {
    try {
      for await (const raw of this.#native.events(this.#readerAbort.signal)) {
        if (this.#readerAbort.signal.aborted) break
        const { observerInstanceRef, ...eventValue } = raw as NativeObservedEvent
        const event = observedEventSchema.parse(eventValue)
        if (observerInstanceRef === undefined) {
          try { this.#diagnostic(structuredClone(event)) }
          catch { /* Диагностический consumer не влияет на observer sequence. */ }
          continue
        }
        if (observerInstanceRef !== this.#snapshot.observerInstanceRef) {
          this.#markGap(`Foreign observer instance ${observerInstanceRef}`)
          return
        }
        if (
          event.runtimeEpoch !== this.#snapshot.coverage.runtimeEpoch
          || event.loginSessionId !== this.#snapshot.coverage.loginSessionId
          || event.nativeGeneration !== this.#snapshot.coverage.nativeGeneration
          || event.sequence !== this.#nextSequence
          || event.cursor === this.#cursor
          || event.eventId !== event.cursor
          || !event.cursor.startsWith(`${this.#snapshot.coverage.coverageStartCursor}:s`)
        ) {
          this.#markGap("Observer event нарушает generation/sequence/cursor continuity")
          return
        }
        const immutable = deepFreeze(structuredClone(event))
        const entry = { event: immutable, bytes: new TextEncoder().encode(JSON.stringify(immutable)).byteLength }
        if (entry.bytes > this.#maxHistoryBytes) {
          this.#markGap("Observer event превышает bounded history budget")
          return
        }
        // История нужна для повторного чтения. Уже доставленные события можно
        // вытеснить; непрерывность защищают sequence и отдельные очереди подписчиков.
        while (
          this.#history.length >= this.#maxHistoryEvents
          || this.#historyBytes + entry.bytes > this.#maxHistoryBytes
        ) {
          const evicted = this.#history.shift()!
          this.#historyBytes -= evicted.bytes
          this.#historyBeforeCursor = evicted.event.cursor
        }
        this.#history.push(entry)
        this.#historyBytes += entry.bytes
        this.#nextSequence++
        this.#cursor = event.cursor
        this.#notifyProgress()
        for (const subscriber of this.#subscribers) {
          if (
            subscriber.queue.length >= this.#maxEventsPerSubscriber
            || subscriber.bytes + entry.bytes > this.#maxBytesPerSubscriber
          ) {
            this.#markGap("Observer hub subscriber overflow")
            return
          }
          if (subscriber.waiter !== undefined) {
            const waiter = subscriber.waiter
            subscriber.waiter = undefined
            waiter.resolve({ done: false, value: immutable })
          } else {
            subscriber.queue.push(entry)
            subscriber.bytes += entry.bytes
          }
        }
      }
      if (!this.#readerAbort.signal.aborted) this.#markGap("Native observer event stream завершился")
    } catch (error) {
      if (!this.#readerAbort.signal.aborted) {
        this.#markGap(error instanceof Error ? error.message : "Native observer event stream failed")
      }
    }
  }

  #notifyProgress(): void {
    const wake = this.#wake
    this.#wake = undefined
    this.#pulse = undefined
    wake?.()
  }

  #next(subscriber: Subscriber): Promise<IteratorResult<ObservedEvent>> {
    if (subscriber.error !== undefined) return Promise.reject(subscriber.error)
    const entry = subscriber.queue.shift()
    if (entry !== undefined) {
      subscriber.bytes -= entry.bytes
      return Promise.resolve({ done: false, value: entry.event })
    }
    if (subscriber.closed) return Promise.resolve({ done: true, value: undefined })
    if (subscriber.waiter !== undefined) return Promise.reject(new Error("Observer subscriber имеет concurrent next"))
    return new Promise((resolve, reject) => { subscriber.waiter = { resolve, reject } })
  }

  #historyAfter(afterCursor: string | undefined): EventEntry[] {
    if (afterCursor === undefined || afterCursor === this.#cursor) return []
    if (afterCursor === this.#historyBeforeCursor) return [...this.#history]
    const index = this.#history.findIndex(entry => entry.event.cursor === afterCursor)
    if (index < 0) throw new Error("Observer afterCursor отсутствует в bounded hub history")
    return this.#history.slice(index + 1)
  }

  #closeSubscriber(subscriber: Subscriber, error?: Error): void {
    if (subscriber.closed) return
    subscriber.closed = true
    subscriber.error = error
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort!)
    this.#subscribers.delete(subscriber)
    if (subscriber.waiter !== undefined) {
      const waiter = subscriber.waiter
      subscriber.waiter = undefined
      if (error !== undefined) waiter.reject(error)
      else waiter.resolve({ done: true, value: undefined })
    }
  }

  #markGap(message: string): ObserverCoverage {
    if (this.#gap === undefined) {
      this.#gap = new Error(message)
      this.#readerAbort.abort(this.#gap)
      for (const subscriber of [...this.#subscribers]) this.#closeSubscriber(subscriber, this.#gap)
      try { this.#onGap(this.#gap) }
      catch { /* Gap остаётся terminal независимо от callback. */ }
    }
    return this.#unavailableCoverage(this.#gap.message, true)
  }

  #unavailableCoverage(reason: string, gap: boolean): ObserverCoverage {
    return {
      ...structuredClone(this.#coverage),
      state: "unavailable",
      gapDetected: gap || this.#gap !== undefined || this.#coverage.gapDetected,
      reason: reason.slice(0, 1_024),
    }
  }
}

function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`Observer hub limit должен быть в пределах ${minimum}..${maximum}`)
  }
  return selected
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = "Observer hub close timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  signal.throwIfAborted()
  let onAbort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Observer ожидание отменено"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([work, stopped]) }
  finally { signal.removeEventListener("abort", onAbort) }
}
