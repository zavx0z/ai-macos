import { CdpSession, CdpTransportError, type CdpSessionOptions } from "./cdp.ts"

type Socket = ReturnType<NonNullable<CdpSessionOptions["socketFactory"]>>
type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; [key: string]: unknown }
type PendingRoute = { channel: Channel; localId: number }

/** One physical browser WebSocket; logical sockets reuse CdpSession's deadlines and cleanup. */
export class CdpBrowserTransport {
  readonly root: CdpSession
  private readonly socket: Socket
  private readonly channels = new Set<Channel>()
  private readonly routes = new Map<number, PendingRoute>()
  private nextId = 0
  private opened = false
  private stopped = false
  private physicalClosed = false
  private resolveDisconnected: () => void = () => {}
  private readonly disconnected = new Promise<void>(resolve => { this.resolveDisconnected = resolve })
  private readonly maxBytes: number

  constructor(readonly url: string, options: CdpSessionOptions = {}) {
    this.maxBytes = Math.max(1_024, Math.min(options.maxIncomingMessageBytes ?? 8 * 1024 * 1024, 96 * 1024 * 1024))
    this.socket = options.socketFactory?.(url) ?? new WebSocket(url)
    this.socket.addEventListener("open", this.onOpen)
    this.socket.addEventListener("message", this.onMessage)
    this.socket.addEventListener("close", this.onClose)
    this.socket.addEventListener("error", this.onError)
    this.root = new CdpSession(url, { ...options, socketFactory: () => this.channel().socket })
  }

  get closed(): boolean { return this.stopped }

  /** Closing a logical target session releases only this caller's listeners and pending commands. */
  session(sessionId: string, options: CdpSessionOptions = {}): CdpSession {
    if (!sessionId || sessionId.length > 512) throw new Error("Invalid CDP sessionId")
    if (this.stopped) throw new CdpTransportError("disconnected", "Browser transport is closed; explicit reconnect required")
    return new CdpSession(this.url, { ...options, socketFactory: () => this.channel(sessionId).socket })
  }

  /** Initiates close and invalidates local handles; not proof of physical socket closure. */
  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.socket.removeEventListener("open", this.onOpen)
    this.socket.removeEventListener("message", this.onMessage)
    this.socket.removeEventListener("error", this.onError)
    this.routes.clear()
    for (const channel of [...this.channels]) this.release(channel)
    try { this.socket.close() } catch { /* disconnect() still requires the close event. */ }
  }

  /** Driver cleanup completes only after the physical WebSocket close event. Never Browser.close. */
  async disconnect(timeoutMs = 5_000): Promise<void> {
    this.close()
    if (this.physicalClosed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.disconnected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CdpTransportError("command-timeout", "CDP physical disconnect was not confirmed")), Math.max(1, Math.min(timeoutMs, 5_000)))
        }),
      ])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private channel(sessionId?: string): Channel {
    if (this.stopped) throw new CdpTransportError("disconnected", "Browser transport is closed")
    const channel = new Channel(sessionId, message => this.send(channel, message), () => {
      if (sessionId === undefined) this.close()
      else this.release(channel)
    })
    this.channels.add(channel)
    if (this.opened) queueMicrotask(() => { if (this.channels.has(channel)) channel.dispatchEvent(new Event("open")) })
    return channel
  }

  private release(channel: Channel): void {
    if (!this.channels.delete(channel)) return
    for (const [id, route] of this.routes) if (route.channel === channel) this.routes.delete(id)
    channel.dispatchEvent(new Event("close"))
  }

  private send(channel: Channel, data: string): void {
    if (this.stopped || !this.opened || !this.channels.has(channel)) throw new CdpTransportError("disconnected", "CDP logical channel is closed")
    const message = JSON.parse(data) as Message
    if (!Number.isSafeInteger(message.id) || typeof message.method !== "string") throw new Error("Invalid CDP command envelope")
    if (this.routes.size >= 4_096) throw new CdpTransportError("protocol-error", "Too many pending CDP commands")
    const id = ++this.nextId
    if (!Number.isSafeInteger(id)) { this.close(); throw new Error("CDP command ID exhausted") }
    this.routes.set(id, { channel, localId: message.id! })
    try {
      const { sessionId: _ignored, ...command } = message
      this.socket.send(JSON.stringify({ ...command, id, ...(channel.sessionId === undefined ? {} : { sessionId: channel.sessionId }) }))
    } catch (error) {
      this.routes.delete(id)
      throw error
    }
  }

  private readonly onOpen = () => {
    this.opened = true
    for (const channel of this.channels) channel.dispatchEvent(new Event("open"))
  }

  private readonly onClose = () => {
    this.physicalClosed = true
    this.socket.removeEventListener("close", this.onClose)
    this.resolveDisconnected()
    this.close()
  }
  private readonly onError = () => this.close()

  private readonly onMessage = (event: MessageEvent) => {
    if (this.stopped) return
    const data = String(event.data)
    if (Buffer.byteLength(data) > this.maxBytes) {
      this.root.close(new CdpTransportError("message-too-large", `CDP browser message exceeds ${this.maxBytes} bytes`))
      return
    }
    let message: Message
    try {
      const value: unknown = JSON.parse(data)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid envelope")
      message = value as Message
    } catch {
      this.root.close(new CdpTransportError("protocol-error", "Malformed CDP browser message"))
      return
    }
    if (message.id !== undefined) {
      const route = this.routes.get(message.id)
      if (!route) return // Late response after cancellation/close; never deliver it to another caller.
      if (message.sessionId !== route.channel.sessionId) {
        this.root.close(new CdpTransportError("protocol-error", "CDP response sessionId does not match the dispatched command"))
        return
      }
      this.routes.delete(message.id)
      route.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...message, id: route.localId }) }))
      return
    }
    if (typeof message.method !== "string") return
    for (const channel of [...this.channels]) {
      if (channel.sessionId === message.sessionId) channel.dispatchEvent(new MessageEvent("message", { data }))
    }
    if (message.sessionId === undefined && message.method === "Target.detachedFromTarget") {
      const detached = message.params?.sessionId
      if (typeof detached === "string") for (const channel of [...this.channels]) {
        if (channel.sessionId === detached) this.release(channel)
      }
    }
  }
}

/** EventTarget is the local event source, not a second network connection. */
class Channel extends EventTarget {
  readonly socket: Socket
  constructor(readonly sessionId: string | undefined, send: (message: string) => void, close: () => void) {
    super()
    this.socket = {
      addEventListener: this.addEventListener.bind(this) as Socket["addEventListener"],
      removeEventListener: this.removeEventListener.bind(this) as Socket["removeEventListener"],
      send: data => {
        if (typeof data !== "string") throw new Error("CDP sends text envelopes only")
        send(data)
      },
      close,
    }
  }
}
