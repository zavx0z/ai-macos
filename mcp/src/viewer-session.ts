import { createHash, randomUUID } from "node:crypto"

export type ViewerContent =
  | { kind: "text", service: string, text: string }
  | { kind: "image", service: string, data: string, mimeType: string, caption: string }

export function viewerScope(meta?: Record<string, unknown>): string | undefined {
  const session = meta?.["openai/session"]
  if (typeof session !== "string" || session.length === 0) return undefined
  // Метаданные нужны для разделения бесед, а не вместо аутентификации подключения.
  return createHash("sha256").update(JSON.stringify([
    meta?.["openai/organization"], meta?.["openai/subject"], session,
  ])).digest("hex")
}

type Session = {
  scope: string
  id: string
  token: string
  version: number
  order: number
  content?: ViewerContent
  touchedAt: number
  mountId?: string
  deliveredVersion: number
  displayedVersion: number
  displayMode: string
  waits: number
  pending?: { finish(): void, cancel(): void }
}

/** Ограниченное состояние одного просмотра на беседу; без polling и общих кадров. */
export class ViewerSessions {
  readonly #sessions = new Map<string, Session>()
  #closed = false

  get(scope: string | undefined): Session {
    if (!scope) throw new Error("VIEWER_SCOPE_UNAVAILABLE: хост не передал openai/session")
    if (this.#closed) throw new Error("VIEWER_CLOSED")
    const existing = this.#sessions.get(scope)
    if (existing) {
      existing.touchedAt = Date.now()
      return existing
    }
    for (const [key, value] of this.#sessions) {
      if (!value.pending && Date.now() - value.touchedAt > 30 * 60_000) this.#sessions.delete(key)
    }
    if (this.#sessions.size >= 8) throw new Error("VIEWER_CAPACITY: достигнут предел активных бесед")
    const value: Session = { scope, id: randomUUID(), token: randomUUID(), version: 0, order: 0,
      touchedAt: Date.now(), deliveredVersion: 0, displayedVersion: 0, displayMode: "unknown", waits: 0 }
    this.#sessions.set(scope, value)
    return value
  }

  open(scope: string | undefined) {
    const value = this.get(scope)
    return { viewerId: value.id, accessToken: value.token, ...this.#snapshot(value, -1) }
  }

  publish(scope: string | undefined, content: ViewerContent, order?: number) {
    if (Buffer.byteLength(JSON.stringify(content)) > 4 * 1024 * 1024) throw new Error("VIEWER_CONTENT_TOO_LARGE")
    const value = this.get(scope)
    if (order !== undefined && order <= value.order) return { viewerId: value.id, version: value.version, discarded: true }
    value.order = order ?? value.order + 1
    value.content = structuredClone(content)
    value.version++
    value.pending?.finish()
    return { viewerId: value.id, version: value.version, service: content.service }
  }

  status(scope: string | undefined) {
    const value = scope ? this.#sessions.get(scope) : undefined
    return { scopeAvailable: !!scope, viewerId: value?.id ?? null, version: value?.version ?? 0,
      mounted: !!value?.mountId, mountId: value?.mountId ?? null,
      deliveredVersion: value?.deliveredVersion ?? 0, displayedVersion: value?.displayedVersion ?? 0,
      displayMode: value?.displayMode ?? "unknown", pending: !!value?.pending, waits: value?.waits ?? 0 }
  }

  async next(input: { viewerId: string, accessToken: string, after: number, mountId?: string,
    displayedVersion?: number, displayMode?: string, waitMs?: number, release?: boolean }, signal: AbortSignal) {
    const value = [...this.#sessions.values()].find(item => item.id === input.viewerId && item.token === input.accessToken)
    if (!value || this.#closed) throw new Error("VIEWER_SESSION_UNAVAILABLE: откройте просмотр заново")
    if (input.mountId) {
      if (value.mountId && value.mountId !== input.mountId) throw new Error("VIEWER_ALREADY_MOUNTED: просмотр уже открыт")
      value.mountId = input.mountId
      value.displayedVersion = Math.max(value.displayedVersion, Math.min(input.displayedVersion ?? 0, value.version))
      value.displayMode = input.displayMode ?? value.displayMode
    }
    if (input.release) {
      if (!input.mountId || input.mountId !== value.mountId) throw new Error("VIEWER_FOREIGN_MOUNT")
      value.pending?.cancel()
      value.mountId = undefined
      return this.#snapshot(value, value.version)
    }
    value.touchedAt = Date.now()
    signal.throwIfAborted()
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 20_000, 20_000))
    if (value.version <= input.after && waitMs > 0) {
      if (value.pending) throw new Error("VIEWER_WAIT_EXISTS: один ожидающий запрос на просмотр")
      value.waits++
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", cancel)
          value.pending = undefined
        }
        const finish = () => {
          cleanup()
          resolve()
        }
        const cancel = () => {
          cleanup()
          reject(new Error("VIEWER_WAIT_CANCELLED"))
        }
        const timer = setTimeout(finish, waitMs)
        value.pending = { finish, cancel }
        signal.addEventListener("abort", cancel, { once: true })
      })
    }
    value.deliveredVersion = value.version
    return this.#snapshot(value, input.after)
  }

  close() {
    this.#closed = true
    for (const value of this.#sessions.values()) value.pending?.cancel()
    this.#sessions.clear()
  }

  #snapshot(value: Session, after: number) {
    return { version: value.version, changed: value.version > after,
      ...(value.version > after && value.content ? { content: structuredClone(value.content) } : {}) }
  }
}
