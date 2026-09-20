export type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
  description?: string
  faviconUrl?: string
  /** Internal target-session binding; never accepted from a wire request. */
  sessionFactory?: (options: CdpSessionOptions) => Promise<CdpSession>
}

export type CdpTransportErrorCode =
  | "http-error"
  | "connect-timeout"
  | "command-timeout"
  | "aborted"
  | "disconnected"
  | "message-too-large"
  | "protocol-error"

export class CdpTransportError extends Error {
  constructor(
    readonly code: CdpTransportErrorCode,
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "CdpTransportError"
  }
}

export type CdpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type CdpHttpOptions = {
  requestTimeoutMs?: number
  maxResponseBytes?: number
  fetch?: CdpFetch
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

export class CdpHttp {
  private readonly requestTimeoutMs: number
  private readonly fetchImpl: CdpFetch
  private readonly maxResponseBytes: number

  constructor(
    public host = "localhost",
    public port = 9222,
    options: CdpHttpOptions = {},
  ) {
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? 8 * 1024 * 1024, 64 * 1024 * 1024))
  }

  private base() {
    return `http://${this.host}:${this.port}`
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => controller.abort(init.signal?.reason)
    init.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetchImpl(`${this.base()}${path}`, {
            ...init,
            signal: controller.signal,
          })
          return await consume(response)
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            controller.abort("deadline")
            reject(new CdpTransportError(
              "command-timeout",
              `CDP HTTP ${path} timed out after ${this.requestTimeoutMs}ms`,
            ))
          }, this.requestTimeoutMs)
        }),
      ])
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof CdpTransportError)) {
        throw new CdpTransportError(
          init.signal?.aborted && !timedOut ? "aborted" : "command-timeout",
          init.signal?.aborted && !timedOut
            ? `CDP HTTP ${path} aborted`
            : `CDP HTTP ${path} timed out after ${this.requestTimeoutMs}ms`,
        )
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      init.signal?.removeEventListener("abort", onAbort)
    }
  }

  async version(signal?: AbortSignal): Promise<{ Browser: string; "Protocol-Version": string; "User-Agent": string; "WebKit-Version": string; webSocketDebuggerUrl?: string }> {
    return await this.request("/json/version", { signal }, async (response) => {
      if (!response.ok) throw new CdpTransportError("http-error", `CDP /json/version: ${response.status}`)
      return await this.readJson(response, "/json/version") as any
    })
  }

  async list(signal?: AbortSignal): Promise<CdpTarget[]> {
    return await this.request("/json/list", { signal }, async (response) => {
      if (!response.ok) throw new CdpTransportError("http-error", `CDP /json/list: ${response.status}`)
      return await this.readJson(response, "/json/list") as CdpTarget[]
    })
  }

  async newTab(url: string = "about:blank", signal?: AbortSignal): Promise<CdpTarget> {
    return await this.request(`/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal }, async (response) => {
      if (!response.ok) throw new CdpTransportError("http-error", `CDP /json/new: ${response.status}`)
      return await this.readJson(response, "/json/new") as CdpTarget
    })
  }

  async closeTab(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/json/close/${encodeURIComponent(id)}`, { signal }, async (response) => {
      if (!response.ok) throw new CdpTransportError("http-error", `CDP /json/close: ${response.status}`)
    })
  }

  async activateTab(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/json/activate/${encodeURIComponent(id)}`, { signal }, async (response) => {
      if (!response.ok) throw new CdpTransportError("http-error", `CDP /json/activate: ${response.status}`)
    })
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    if (!response.body) return JSON.parse(await response.text())
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > this.maxResponseBytes) {
          await reader.cancel("response-too-large").catch(() => {})
          throw new CdpTransportError("message-too-large", `CDP HTTP ${path} exceeds ${this.maxResponseBytes} bytes`)
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const joined = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(joined))
  }
}

type CdpMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

type CdpSocket = Pick<WebSocket, "addEventListener" | "removeEventListener" | "send" | "close">

export type CdpSessionOptions = {
  connectTimeoutMs?: number
  commandTimeoutMs?: number
  signal?: AbortSignal
  socketFactory?: (url: string) => CdpSocket
  maxIncomingMessageBytes?: number
}

export type CdpCommandOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type CdpEventHandler<T = unknown> = (params: T) => void

export class CdpSession {
  private readonly ws: CdpSocket
  private readonly commandTimeoutMs: number
  private readonly maxIncomingMessageBytes: number
  private id = 0
  private pending = new Map<number, Pending>()
  private subscriptions = new Map<string, Set<CdpEventHandler>>()
  private eventWaiters = new Set<{ reject: (error: Error) => void; cleanup: () => void }>()
  private ready: Promise<void>
  private rejectReady: (error: Error) => void = () => {}
  private closed = false
  private closeReason: Error | null = null
  private readonly externalSignal?: AbortSignal
  private readonly onExternalAbort: () => void

  constructor(readonly url: string, options: CdpSessionOptions = {}) {
    this.commandTimeoutMs = boundedTimeout(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
    this.maxIncomingMessageBytes = Math.max(1_024, Math.min(options.maxIncomingMessageBytes ?? 8 * 1024 * 1024, 96 * 1024 * 1024))
    this.externalSignal = options.signal
    this.onExternalAbort = () => this.close(new CdpTransportError("aborted", "CDP session aborted"))
    this.ws = options.socketFactory?.(url) ?? new WebSocket(url)

    const connectTimeoutMs = boundedTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ws.removeEventListener("open", onOpen)
        this.ws.removeEventListener("error", onError)
        error ? reject(error) : resolve()
      }
      const onOpen = () => settle()
      const onError = () => settle(new CdpTransportError("disconnected", `CDP WS error: ${url}`))
      const timer = setTimeout(() => {
        const error = new CdpTransportError(
          "connect-timeout",
          `CDP WS connection timed out after ${connectTimeoutMs}ms`,
        )
        settle(error)
        this.close(error)
      }, connectTimeoutMs)
      this.ws.addEventListener("open", onOpen, { once: true })
      this.ws.addEventListener("error", onError, { once: true })
      this.rejectReady = (error) => settle(error)
    })

    this.ws.addEventListener("message", this.onMessage)
    this.ws.addEventListener("close", this.onClose, { once: true })
    this.ws.addEventListener("error", this.onSocketError)
    this.externalSignal?.addEventListener("abort", this.onExternalAbort, { once: true })
    this.ready.catch(() => {})
    if (this.externalSignal?.aborted) this.onExternalAbort()
  }

  private readonly onMessage = (event: MessageEvent) => {
    let message: CdpMessage
    try {
      const payload = String(event.data)
      if (Buffer.byteLength(payload) > this.maxIncomingMessageBytes) {
        this.close(new CdpTransportError(
          "message-too-large",
          `CDP WS message exceeds ${this.maxIncomingMessageBytes} bytes`,
        ))
        return
      }
      message = JSON.parse(payload) as CdpMessage
    } catch {
      return
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.cleanup()
      if (message.error) {
        pending.reject(new CdpTransportError(
          "protocol-error",
          `CDP ${message.error.code}: ${message.error.message}`,
          pending.method,
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (!message.method) return
    for (const handler of this.subscriptions.get(message.method) ?? []) {
      try {
        handler(message.params)
      } catch {
        // Ошибка одного подписчика не должна ломать transport или соседние подписки.
      }
    }
  }

  private readonly onClose = () => {
    this.finishClose(this.closeReason ?? new CdpTransportError("disconnected", "CDP session closed"))
  }

  private readonly onSocketError = () => {
    if (this.closed) return
    this.close(new CdpTransportError("disconnected", `CDP WS error: ${this.url}`))
  }

  private finishClose(error: Error): void {
    if (!this.closed) this.closed = true
    this.closeReason = error
    this.rejectReady(error)
    for (const [, pending] of this.pending) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiter of [...this.eventWaiters]) {
      waiter.cleanup()
      waiter.reject(error)
    }
    this.eventWaiters.clear()
    this.subscriptions.clear()
    this.ws.removeEventListener("message", this.onMessage)
    this.ws.removeEventListener("error", this.onSocketError)
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort)
  }

  subscribe<T = unknown>(method: string, handler: CdpEventHandler<T>): () => void {
    if (this.closed) throw this.closeReason ?? new CdpTransportError("disconnected", "CDP session is closed")
    let handlers = this.subscriptions.get(method)
    if (!handlers) {
      handlers = new Set()
      this.subscriptions.set(method, handlers)
    }
    handlers.add(handler as CdpEventHandler)
    return () => {
      handlers?.delete(handler as CdpEventHandler)
      if (handlers?.size === 0) this.subscriptions.delete(method)
    }
  }

  async waitForEvent<T = unknown>(
    method: string,
    options: CdpCommandOptions & { predicate?: (params: T) => boolean } = {},
  ): Promise<T> {
    const timeoutMs = boundedTimeout(options.timeoutMs, this.commandTimeoutMs)
    return await new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe = () => {}
      const signal = options.signal
      const cleanup = () => {
        this.eventWaiters.delete(waiter)
        unsubscribe()
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new CdpTransportError("aborted", `CDP event ${method} aborted`, method))
      }
      unsubscribe = this.subscribe<T>(method, (params) => {
        if (options.predicate && !options.predicate(params)) return
        cleanup()
        resolve(params)
      })
      const waiter = { reject, cleanup }
      this.eventWaiters.add(waiter)
      timer = setTimeout(() => {
        cleanup()
        reject(new CdpTransportError(
          "command-timeout",
          `CDP event ${method} timed out after ${timeoutMs}ms`,
          method,
        ))
      }, timeoutMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpCommandOptions = {},
  ): Promise<T> {
    if (this.closed) throw this.closeReason ?? new CdpTransportError("disconnected", "CDP session is closed")
    await this.waitUntilReady(options.signal)
    if (this.closed) throw this.closeReason ?? new CdpTransportError("disconnected", "CDP session is closed")

    const id = ++this.id
    const timeoutMs = boundedTimeout(options.timeoutMs, this.commandTimeoutMs)
    const signal = options.signal
    return await new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        reject(new CdpTransportError("aborted", `CDP ${method} aborted`, method))
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
      })
      timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new CdpTransportError(
          "command-timeout",
          `CDP ${method} timed out after ${timeoutMs}ms`,
          method,
        ))
      }, timeoutMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(reason = new CdpTransportError("disconnected", "CDP session closed by owner")): void {
    if (this.closed) return
    this.closeReason = reason
    this.finishClose(reason)
    try {
      this.ws.close()
    } catch {
      // Локальная очистка уже завершена; ошибка close не меняет её результат.
    }
  }

  private async waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.ready
      return
    }
    if (signal.aborted) throw new CdpTransportError("aborted", "CDP command aborted before connect")
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup()
        reject(new CdpTransportError("aborted", "CDP command aborted before connect"))
      }
      const cleanup = () => signal.removeEventListener("abort", onAbort)
      signal.addEventListener("abort", onAbort, { once: true })
      this.ready.then(
        () => {
          cleanup()
          resolve()
        },
        (error) => {
          cleanup()
          reject(error)
        },
      )
    })
  }
}

export async function withSession<T>(
  target: CdpTarget,
  fn: (session: CdpSession) => Promise<T>,
  options: CdpSessionOptions = {},
): Promise<T> {
  const session = target.sessionFactory
    ? await target.sessionFactory(options)
    : new CdpSession(target.webSocketDebuggerUrl, options)
  try {
    return await fn(session)
  } finally {
    session.close()
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.round(value), 30_000))
}
