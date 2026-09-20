import { structurallyEqual, canonicalRecoveryJson, nativeViewAdmissionSchema, type RuntimeClientSession, type NativeViewAdmission } from "@meta/shared/contracts"
import type { RuntimeCore, RuntimeViewAdmissionContext } from "./core.ts"
import type { AgentViewGuard, AgentViewTicket, AgentViewAdmissionProof, AgentViewTarget } from "./agent-view-guard.ts"
import { canonicalJson, sha256 } from "./primitives.ts"

type CurrentView = { ticket: AgentViewTicket, target: AgentViewTarget }
type RequestView = { view: CurrentView, lineageId: string, targetId: string, mode: "ui-action" | "keyboard",
  admitted?: AgentViewAdmissionProof, admissionPending?: Promise<AgentViewAdmissionProof> }
export type BoundAgentViewProof = { proof: AgentViewAdmissionProof }

/** Ticket и request association живут только в host, не принимаются из agent DTO. */
export class AgentViewBindings {
  readonly #views = new Map<string, CurrentView>()
  readonly #requests = new Map<string, RequestView>()
  constructor(readonly core: RuntimeCore, readonly guard: Pick<AgentViewGuard, "forLineage">) {}

  async observe<T>(session: RuntimeClientSession, targetId: string, target: AgentViewTarget,
    capture: () => Promise<T>, complete: (value: T) => boolean): Promise<T> {
    await this.core.clients.assertActive(session, new Date())
    const lineage = this.core.clients.lineage(session)
    const key = canonicalJson([lineage, targetId])
    this.#retire(key, "Fresh observation заменяет прежний view")
    this.#prune()
    if (this.#views.size >= 4096) throw new Error("Agent view association capacity exceeded")
    const scope = this.guard.forLineage(lineage)
    const draft = await scope.beginObservation(targetId, target)
    try {
      const value = await capture()
      if (!complete(value)) { scope.cancelObservation(draft); return value }
      const ticket = await scope.commitObservation(draft)
      this.#views.set(key, { ticket, target: structuredClone(target) })
      return value
    } catch (error) { scope.cancelObservation(draft); throw error }
  }

  async run<T>(session: RuntimeClientSession, targetId: string, clientRequestId: string, mode: "ui-action" | "keyboard",
    action: () => Promise<T>): Promise<T> {
    await this.core.clients.assertActive(session, new Date())
    const lineageId = this.core.clients.lineage(session)
    const key = canonicalJson([lineageId, clientRequestId])
    const viewKey = canonicalJson([lineageId, targetId])
    const view = this.#views.get(viewKey)
    if (view === undefined) throw new Error("Action требует fresh observe этого target")
    if (this.#requests.has(key) || this.#requests.size >= 128) throw new Error("Agent view request association занята")
    const binding: RequestView = { view, lineageId, targetId, mode }
    this.#requests.set(key, binding)
    try { return await action() }
    finally {
      try {
        if (binding.admitted !== undefined) {
          const operation = await this.core.getOperationByRequest(session, clientRequestId)
          const scope = this.guard.forLineage(lineageId)
          if (operation !== undefined) await scope.settleOperation(view.ticket, operation).catch(() => undefined)
          this.#retire(viewKey, "Действие потребило view или outcome неизвестен", view)
        }
      } finally { this.#requests.delete(key) }
    }
  }

  readonly authorize = async (context: RuntimeViewAdmissionContext): Promise<BoundAgentViewProof> => {
    await context.control.checkpoint()
    const key = canonicalJson([context.lineageId, context.wire.clientRequestId])
    const binding = this.#requests.get(key)
    if (binding === undefined || !structurallyEqual(binding.view.target, context.wire.target)) throw new Error("Native operation не привязана к exact trusted view request")
    const keyboard = context.operation.method === "input.execute" && ["text", "key", "shortcut"].includes(context.operation.actionKind ?? "")
    if ((binding.mode === "keyboard") !== keyboard) throw new Error("Native method/action не совпадает с view request mode")
    binding.admissionPending ??= (async () => {
      const scope = this.guard.forLineage(binding.lineageId)
      return scope.admit(binding.view.ticket, context.wire.operationId, context.wire.deadlineAt)
    })()
    const proof = await binding.admissionPending
    binding.admitted = proof
    await context.control.checkpoint()
    if (proof.operationId !== context.wire.operationId || proof.targetId !== binding.targetId) throw new Error("View proof содержит другой operation/target")
    return { proof }
  }

  readonly authorizeNative = async (context: RuntimeViewAdmissionContext): Promise<NativeViewAdmission> => {
    const { proof } = await this.authorize(context)
    return nativeViewAdmissionSchema.parse({
      version: "1", contextSha256: sha256(canonicalRecoveryJson(context.wire)), viewNonce: proof.viewNonce,
      observerInstanceRef: proof.observerInstanceRef, coverageStartCursor: proof.expectedCoverageStartCursor,
      baselineCursor: proof.baselineCursor, baselineNextSequence: proof.baselineNextSequence,
      observedCursor: proof.observedCursor, observedNextSequence: proof.observedNextSequence,
      admissionCursor: proof.admissionCursor, admissionNextSequence: proof.admissionNextSequence,
      expiresAt: new Date(Math.min(Date.parse(proof.expiresAt), Date.parse(context.wire.deadlineAt))).toISOString(),
    })
  }

  releaseLineage(lineageId: string): void {
    for (const key of this.#views.keys()) {
      if ((JSON.parse(key) as [string, string])[0] === lineageId) this.#retire(key, "Client lineage закрыта")
    }

  }

  #retire(key: string, reason: string, expected?: CurrentView): void {
    const view = expected ?? this.#views.get(key)
    if (view === undefined) return
    const [lineage] = JSON.parse(key) as [string, string]
    const scope = this.guard.forLineage(lineage)
    // Освобождаем только захваченный ticket, даже если key уже указывает на новый observe.
    try {
      scope.invalidateView(view.ticket, reason)
    } finally {
      if (this.#views.get(key) === view) this.#views.delete(key)
    }
  }
  #prune(): void {
    for (const [key, view] of this.#views) if (view.ticket.expiresAt !== undefined && Date.now() >= Date.parse(view.ticket.expiresAt)) this.#retire(key, "Agent view истёк", view)
  }
}
