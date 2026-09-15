import {
  runtimeClientSessionSchema,
  z,
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

export const storedClientSessionSchema = z.strictObject({
  session: runtimeClientSessionSchema,
  lineageId: z.string().min(1).max(127),
  bearerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resumptionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resumptionExpiresAt: z.iso.datetime({ offset: true }).optional(),
  disconnected: z.boolean(), revoked: z.boolean(),
})
export type StoredClientSession = z.infer<typeof storedClientSessionSchema>
type StoredSession = StoredClientSession

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

  #open(principalId: string, lineageId: string, ttlMs: number, resumeToken?: string): RuntimeClientCredential {
    if (this.#sessions.size >= 10_000) throw new Error("Client session capacity достигнута")
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120 * 60 * 1000) throw new Error("Client TTL вне bounds")
    const now = this.#clock.now()
    const bearerToken = this.#ids.next("bearer")
    const resumptionToken = resumeToken ?? this.#ids.next("resume")
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
      resumptionExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
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
    const previous = this.#resumable(resumptionToken)
    const credential = this.#open(previous.session.principalId, previous.lineageId, ttlMs, resumptionToken)
    previous.disconnected = true
    previous.revoked = true
    this.#bearerIndex.delete(previous.bearerDigest)
    return credential
  }

  resumptionLineage(resumptionToken: string): string { return this.#resumable(resumptionToken).lineageId }

  #resumable(resumptionToken: string): StoredSession {
    const previous = this.#byDigest(this.#resumptionIndex, sha256(resumptionToken))
    if (previous.revoked || previous.session.loginSessionId !== this.#generation.loginSessionId
      || this.#clock.now().getTime() >= Date.parse(previous.resumptionExpiresAt ?? previous.session.expiresAt)) throw new Error("Resumption credential отозван, истёк или принадлежит другой login session")
    return previous
  }

  snapshot(): StoredClientSession[] { return structuredClone([...this.#sessions.values()]) }

  restore(values: readonly StoredClientSession[]): void {
    if (this.#sessions.size > 0) throw new Error("Client snapshot восстанавливается только при startup")
    const records = z.array(storedClientSessionSchema).max(10_000).parse(values)
    const ids = new Set<string>()
    const resumptions = new Set<string>()
    for (const stored of records) {
      if (stored.session.loginSessionId !== this.#generation.loginSessionId || ids.has(stored.session.clientSessionId)) throw new Error("Client snapshot содержит foreign login или duplicate session")
      ids.add(stored.session.clientSessionId)
      if (!stored.revoked) {
        if (resumptions.has(stored.resumptionDigest)) throw new Error("Client snapshot содержит duplicate active resumption")
        resumptions.add(stored.resumptionDigest)
      }
    }
    for (const stored of records) {
      this.#sessions.set(stored.session.clientSessionId, stored)
      if (!stored.revoked) this.#resumptionIndex.set(stored.resumptionDigest, stored.session.clientSessionId)
      if (!stored.revoked && !stored.disconnected && stored.session.runtimeEpoch === this.#generation.runtimeEpoch) this.#bearerIndex.set(stored.bearerDigest, stored.session.clientSessionId)
    }
  }

  historicalLineage(clientSessionId: string, principalId: string): string | undefined {
    const stored = this.#sessions.get(clientSessionId)
    return stored?.session.principalId === principalId ? stored.lineageId : undefined
  }

  expiredSessions(now: Date): RuntimeClientSession[] {
    return [...this.#sessions.values()].filter(stored => !stored.disconnected && !stored.revoked
      && stored.session.runtimeEpoch === this.#generation.runtimeEpoch && now.getTime() >= Date.parse(stored.session.expiresAt))
      .map(stored => structuredClone(stored.session))
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
    if (stored.revoked) throw new Error(stored.disconnected ? "Client session отключена и отозвана" : "Client session отозвана")
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
