export type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
  description?: string
  faviconUrl?: string
}

export class CdpHttp {
  constructor(public host = "localhost", public port = 9222) {}

  private base() { return `http://${this.host}:${this.port}` }

  async version(): Promise<{ Browser: string; "Protocol-Version": string; "User-Agent": string; "WebKit-Version": string; webSocketDebuggerUrl?: string }> {
    const res = await fetch(`${this.base()}/json/version`)
    if (!res.ok) throw new Error(`CDP /json/version: ${res.status}`)
    return await res.json() as any
  }

  async list(): Promise<CdpTarget[]> {
    const res = await fetch(`${this.base()}/json/list`)
    if (!res.ok) throw new Error(`CDP /json/list: ${res.status}`)
    return await res.json() as CdpTarget[]
  }

  async newTab(url: string = "about:blank"): Promise<CdpTarget> {
    const res = await fetch(`${this.base()}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
    if (!res.ok) throw new Error(`CDP /json/new: ${res.status}`)
    return await res.json() as CdpTarget
  }

  async closeTab(id: string): Promise<void> {
    const res = await fetch(`${this.base()}/json/close/${id}`)
    if (!res.ok) throw new Error(`CDP /json/close: ${res.status}`)
  }

  async activateTab(id: string): Promise<void> {
    const res = await fetch(`${this.base()}/json/activate/${id}`)
    if (!res.ok) throw new Error(`CDP /json/activate: ${res.status}`)
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class CdpSession {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, Pending>()
  private ready: Promise<void>
  private closed = false

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ready = new Promise<void>((resolve, reject) => {
      const onOpen = () => { this.ws.removeEventListener("error", onErr); resolve() }
      const onErr = () => { this.ws.removeEventListener("open", onOpen); reject(new Error(`CDP WS error: ${url}`)) }
      this.ws.addEventListener("open", onOpen, { once: true })
      this.ws.addEventListener("error", onErr, { once: true })
    })
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: { code: number; message: string } }
        if (msg.id != null) {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        }
      } catch {
        // ignore parse errors
      }
    })
    this.ws.addEventListener("close", () => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error("CDP session closed"))
      this.pending.clear()
    })
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("CDP session is closed")
    await this.ready
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    if (!this.closed) this.ws.close()
    this.closed = true
  }
}

export async function withSession<T>(target: CdpTarget, fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const session = new CdpSession(target.webSocketDebuggerUrl)
  try {
    return await fn(session)
  } finally {
    session.close()
  }
}
