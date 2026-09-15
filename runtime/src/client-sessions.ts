import {
  runtimeClientSessionSchema,
  type ClientSessionAuthority,
  type RuntimeClientSession,
  type RuntimeGeneration,
} from "@meta/shared/contracts"
import { randomIdSource, sha256, systemClock, type RuntimeClock, type RuntimeIdSource } from "./primitives.ts"

export type RuntimeClientCredential = {
  session: RuntimeClientSession
  bearerToken: string
  resumptionToken: string
}

type StoredSession = {
  session: RuntimeClientSession
  lineageId: string
  bearerDigest: string
  resumptionDigest: string
  disconnected: boolean
  revoked: boolean
}

export class ClientSessionRegistry implements ClientSessionAuthority {
  readonly #generation: RuntimeGeneration
  readonly #clock: RuntimeClock
  readonly #ids: RuntimeIdSource
  readonly #sessions = new Map<string, StoredSession>()
  readonly #bearerIndex = new Map<string, string>()
  readonly #resumptionIndex = new Map<string, string>()

  constructor(
    generation: RuntimeGeneration,
    options: { clock?: RuntimeClock, ids?: RuntimeIdSource } = {},
  ) {
    this.#generation = generation
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIdSource
  }

  open(principalId: string, ttlMs = 5 * 60 * 1_000): RuntimeClientCredential {
    return this.#open(principalId, this.#ids.next("lineage"), ttlMs)
  }

  #open(principalId: string, lineageId: string, ttlMs: number): RuntimeClientCredential {
    const now = this.#clock.now()
    const bearerToken = this.#ids.next("bearer")
    const resumptionToken = this.#ids.next("resume")
    const session = runtimeClientSessionSchema.parse({
      clientSessionId: this.#ids.next("client"),
      principalId,
      ...this.#generation,
      authenticationGeneration: this.#ids.next("auth"),
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    })
    const stored: StoredSession = {
      session,
      lineageId,
      bearerDigest: sha256(bearerToken),
      resumptionDigest: sha256(resumptionToken),
      disconnected: false,
      revoked: false,
    }
    this.#sessions.set(session.clientSessionId, stored)
    this.#bearerIndex.set(stored.bearerDigest, session.clientSessionId)
    this.#resumptionIndex.set(stored.resumptionDigest, session.clientSessionId)
    return { session, bearerToken, resumptionToken }
  }

  authenticate(bearerToken: string): RuntimeClientSession {
    const stored = this.#byDigest(this.#bearerIndex, sha256(bearerToken))
    this.#assertStoredActive(stored, this.#clock.now())
    if (stored.disconnected) throw new Error("Client session отключена")
    return stored.session
  }

  resume(resumptionToken: string, ttlMs = 5 * 60 * 1_000): RuntimeClientCredential {
    const previous = this.#byDigest(this.#resumptionIndex, sha256(resumptionToken))
    this.#assertStoredActive(previous, this.#clock.now())
    previous.disconnected = true
    this.#bearerIndex.delete(previous.bearerDigest)
    this.#resumptionIndex.delete(previous.resumptionDigest)
    return this.#open(previous.session.principalId, previous.lineageId, ttlMs)
  }

  disconnect(clientSessionId: string): void {
    const stored = this.#sessions.get(clientSessionId)
    if (stored !== undefined) {
      stored.disconnected = true
      this.#bearerIndex.delete(stored.bearerDigest)
    }
  }

  revokePrincipal(principalId: string): void {
    for (const stored of this.#sessions.values()) {
      if (stored.session.principalId !== principalId) continue
      stored.revoked = true
      this.#bearerIndex.delete(stored.bearerDigest)
      this.#resumptionIndex.delete(stored.resumptionDigest)
    }
  }

  async assertActive(session: RuntimeClientSession, now: Date): Promise<void> {
    const stored = this.#sessions.get(session.clientSessionId)
    if (stored === undefined || canonicalSession(stored.session) !== canonicalSession(session)) {
      throw new Error("Client session не зарегистрирована runtime")
    }
    this.#assertStoredActive(stored, now)
    if (stored.disconnected) throw new Error("Client session отключена")
  }

  lineage(session: RuntimeClientSession): string {
    const stored = this.#sessions.get(session.clientSessionId)
    if (stored === undefined || canonicalSession(stored.session) !== canonicalSession(session)) {
      throw new Error("Client session не зарегистрирована runtime")
    }
    return stored.lineageId
  }

  #byDigest(index: Map<string, string>, digest: string): StoredSession {
    const sessionId = index.get(digest)
    const stored = sessionId === undefined ? undefined : this.#sessions.get(sessionId)
    if (stored === undefined) throw new Error("Неверный client credential")
    return stored
  }

  #assertStoredActive(stored: StoredSession, now: Date): void {
    if (stored.revoked) throw new Error("Client session отозвана")
    if (
      stored.session.runtimeEpoch !== this.#generation.runtimeEpoch
      || stored.session.loginSessionId !== this.#generation.loginSessionId
    ) {
      throw new Error("Client session принадлежит другой runtime generation")
    }
    if (now.getTime() >= Date.parse(stored.session.expiresAt)) throw new Error("Client session истекла")
  }
}

function canonicalSession(session: RuntimeClientSession): string {
  return JSON.stringify(session)
}
