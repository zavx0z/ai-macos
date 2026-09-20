import { CdpBrowserTransport, CdpHttp, CdpTransportError, type CdpSession, type CdpSessionOptions, type CdpTarget } from "@meta/shared"
import { CdpBrowserDriver } from "./adapter.ts"
import { discoverExistingChrome, type ExistingChromeEndpoint } from "./existing-discovery.ts"

export type ExistingChromeOptions = {
  userDataDir: string
  approvalTimeoutMs?: number
  /** Dependency injection for isolated tests; not part of Runtime's wire configuration. */
  discover?: (userDataDir: string) => Promise<ExistingChromeEndpoint>
  socketFactory?: CdpSessionOptions["socketFactory"]
}

type TargetInfo = { targetId: string; type: string; title: string; url: string }
type Attachment = { promise: Promise<string>; sessionId?: string }

/** Reuses the existing capture/DOM/AX driver; only endpoint discovery and session transport differ. */
export class ExistingChromeDriver extends CdpBrowserDriver {
  private readonly existing: ExistingChromeConnection
  constructor(options: ExistingChromeOptions) {
    const connection = new ExistingChromeConnection(options)
    super(connection)
    this.existing = connection
  }
  override async disconnect(): Promise<void> { await this.existing.disconnect() }
}

/**
 * Implements the complete endpoint surface expected by CdpBrowserDriver.
 * The inherited HTTP implementation is never called; no /json/* request, launcher or retry exists here.
 */
export class ExistingChromeConnection extends CdpHttp {
  private transport?: CdpBrowserTransport
  private connecting = false
  private attempt = 0
  private readonly attachments = new Map<string, Attachment>()
  private readonly detached = new Set<string>()
  private readonly destroyed = new Set<string>()

  constructor(private readonly options: ExistingChromeOptions) { super() }

  override async version(signal?: AbortSignal): ReturnType<CdpHttp["version"]> {
    if (this.connecting) throw new Error("CHROME_CONNECT_IN_PROGRESS: do not issue another connection request")
    this.connecting = true
    try {
      await this.disconnect()
      const attempt = ++this.attempt
      this.assertAttempt(attempt, signal)
      const discover = this.options.discover ?? discoverExistingChrome
      const endpoint = await discover(this.options.userDataDir)
      this.assertAttempt(attempt, signal)
      const approvalTimeoutMs = this.options.approvalTimeoutMs ?? 20_000
      if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 1 || approvalTimeoutMs > 25_000) throw new Error("Invalid Chrome approval timeout")
      const transport = new CdpBrowserTransport(endpoint.webSocketUrl, {
        connectTimeoutMs: approvalTimeoutMs,
        socketFactory: this.options.socketFactory,
      })
      this.transport = transport
      transport.root.subscribe<{ sessionId: string }>("Target.detachedFromTarget", event => {
        if (typeof event.sessionId === "string") this.detached.add(event.sessionId)
      })
      transport.root.subscribe<{ targetId: string }>("Target.targetDestroyed", event => {
        if (typeof event.targetId === "string") this.destroyed.add(event.targetId)
      })
      try {
        const version = await this.command<{ product: string; protocolVersion: string; userAgent: string }>(transport, "Browser.getVersion", {}, signal)
        const major = typeof version.product === "string" ? /^Chrome\/(\d+)\./.exec(version.product) : null
        if (!major || Number(major[1]) < 144 || typeof version.protocolVersion !== "string" || typeof version.userAgent !== "string") {
          throw new Error("CHROME_VERSION_UNSUPPORTED: existing-session mode requires Chrome 144 or newer")
        }
        const current = await discover(this.options.userDataDir)
        this.assertAttempt(attempt, signal)
        if (current.webSocketUrl !== endpoint.webSocketUrl || current.userDataDir !== endpoint.userDataDir) {
          throw new CdpTransportError("disconnected", "CHROME_DISCOVERY_CHANGED: endpoint changed during approval; refresh before reconnecting")
        }
        await this.command(transport, "Target.setDiscoverTargets", { discover: true }, signal)
        return {
          Browser: version.product,
          "Protocol-Version": version.protocolVersion,
          "User-Agent": version.userAgent,
          "WebKit-Version": /AppleWebKit\/([^\s]+)/.exec(version.userAgent)?.[1] ?? "",
          webSocketDebuggerUrl: endpoint.webSocketUrl,
        }
      } catch (error) {
        transport.close() // Initiate cleanup; Runtime recovery still verifies physical disconnect.
        throw error
      }
    } finally { this.connecting = false }
  }

  override async list(signal?: AbortSignal): Promise<CdpTarget[]> {
    const transport = this.connected()
    const result = await this.command<{ targetInfos: unknown[] }>(transport, "Target.getTargets", {}, signal)
    if (!Array.isArray(result.targetInfos) || result.targetInfos.length > 4_096) throw new Error("Invalid CDP target inventory")
    return result.targetInfos.map(info => this.target(transport, targetInfo(info)))
  }

  override async newTab(url = "about:blank", signal?: AbortSignal): Promise<CdpTarget> {
    const transport = this.connected()
    const created = await this.command<{ targetId: string }>(transport, "Target.createTarget", { url }, signal)
    if (typeof created.targetId !== "string") throw new Error("CDP did not return created targetId")
    const result = await this.command<{ targetInfo: unknown }>(transport, "Target.getTargetInfo", { targetId: created.targetId }, signal)
    return this.target(transport, targetInfo(result.targetInfo))
  }

  override async closeTab(targetId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.command<{ success: boolean }>(this.connected(), "Target.closeTarget", { targetId }, signal)
    if (result.success !== true) throw new Error("CDP did not acknowledge target closure")
    this.destroyed.add(targetId)
  }

  override async activateTab(targetId: string, signal?: AbortSignal): Promise<void> {
    await this.command(this.connected(), "Target.activateTarget", { targetId }, signal)
  }

  async disconnect(): Promise<void> {
    ++this.attempt
    const transport = this.transport
    if (transport) await transport.disconnect()
    if (this.transport === transport) {
      this.transport = undefined
      this.attachments.clear()
      this.detached.clear()
      this.destroyed.clear()
    }
  }

  private assertAttempt(attempt: number, signal?: AbortSignal): void {
    if (signal?.aborted || attempt !== this.attempt) throw new CdpTransportError("aborted", "Chrome connection attempt was cancelled")
  }

  private connected(): CdpBrowserTransport {
    if (!this.transport || this.transport.closed) throw new CdpTransportError("disconnected", "Chrome is not connected; an explicit connect-instance is required")
    return this.transport
  }

  private assertCurrent(transport: CdpBrowserTransport): void {
    if (transport !== this.transport || transport.closed) throw new CdpTransportError("disconnected", "Stale Chrome transport; refresh instance and target references")
  }

  private async command<T = unknown>(transport: CdpBrowserTransport, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    this.assertCurrent(transport)
    try {
      const result = await transport.root.send<T>(method, params, { signal })
      this.assertCurrent(transport)
      return result
    } catch (error) {
      if (error instanceof CdpTransportError && error.code !== "protocol-error") transport.close()
      throw error
    }
  }

  private target(transport: CdpBrowserTransport, info: TargetInfo): CdpTarget {
    const target: CdpTarget = { id: info.targetId, type: info.type, title: info.title, url: info.url, webSocketDebuggerUrl: transport.url }
    Object.defineProperty(target, "sessionFactory", {
      enumerable: false,
      value: async (options: CdpSessionOptions): Promise<CdpSession> => {
        this.assertCurrent(transport)
        if (options.signal?.aborted) throw new CdpTransportError("aborted", "CDP target operation aborted before attach")
        if (this.destroyed.has(info.targetId)) throw new CdpTransportError("disconnected", "CDP target was destroyed")
        let attachment = this.attachments.get(info.targetId)
        if (!attachment) {
          const record: Attachment = {
            promise: this.command<{ sessionId: string }>(transport, "Target.attachToTarget", { targetId: info.targetId, flatten: true }, options.signal).then(result => {
              if (typeof result.sessionId !== "string" || !result.sessionId || result.sessionId.length > 512) throw new Error("Invalid CDP attachment sessionId")
              record.sessionId = result.sessionId
              return result.sessionId
            }),
          }
          attachment = record
          this.attachments.set(info.targetId, record)
        }
        const sessionId = await attachment.promise
        this.assertCurrent(transport)
        if (this.detached.has(sessionId) || this.destroyed.has(info.targetId)) {
          throw new CdpTransportError("disconnected", "CDP attachment was detached; do not reuse its target reference")
        }
        if (options.signal?.aborted) throw new CdpTransportError("aborted", "CDP target operation aborted after attach")
        return transport.session(sessionId, options)
      },
    })
    return target
  }
}

function targetInfo(value: unknown): TargetInfo {
  if (!value || typeof value !== "object") throw new Error("Invalid CDP target")
  const info = value as Record<string, unknown>
  for (const key of ["targetId", "type", "title", "url"] as const) if (typeof info[key] !== "string") throw new Error(`Invalid CDP target ${key}`)
  if (!(info.targetId as string).length || (info.targetId as string).length > 512) throw new Error("Invalid CDP targetId")
  return info as TargetInfo
}
