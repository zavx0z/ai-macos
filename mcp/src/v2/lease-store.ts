import type { Candidate, ExactWindow, WindowIdentity } from "./contracts.ts"

type Lease = {
  handle: string
  epoch: string
  identity: WindowIdentity
  app: string
  title: string
  expiresAtMs: number
}

export class LeaseStore {
  private readonly leases = new Map<string, Lease>()

  constructor(private readonly ttlMs = 30_000, private readonly now = () => Date.now()) {}

  issue(epoch: string, window: ExactWindow): Lease {
    const handle = `win_${crypto.randomUUID().replaceAll("-", "")}`
    const lease: Lease = {
      handle,
      epoch,
      identity: { pid: window.pid, windowId: window.windowId },
      app: window.app,
      title: window.title,
      expiresAtMs: this.now() + this.ttlMs,
    }
    this.leases.set(handle, lease)
    return lease
  }

  get(handle: string): Lease | null {
    const lease = this.leases.get(handle)
    if (!lease) return null
    if (lease.expiresAtMs <= this.now()) {
      this.leases.delete(handle)
      return null
    }
    return lease
  }

  candidate(epoch: string, window: ExactWindow): Candidate {
    const lease = this.issue(epoch, window)
    return {
      handle: lease.handle,
      app: window.app,
      title: window.title,
      bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
    }
  }
}
