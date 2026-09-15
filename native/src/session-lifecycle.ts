import type { AdapterControl, NativeDrainAck, NativeDrainRequest, NativeGeneration } from "@meta/shared/contracts"
import { NativeBrokerAdapter } from "./adapter.ts"

export interface NativeRotationAuthority {
  prepare(adapter: NativeBrokerAdapter): Promise<{ request: NativeDrainRequest, control: AdapterControl }>
  retainAndAuthorize(adapter: NativeBrokerAdapter, ack: NativeDrainAck): Promise<void>
  createReplacement(previous: NativeGeneration, loadedBuildId: string): Promise<NativeBrokerAdapter>
  invalidateAndReinventory(previous: NativeGeneration, replacement: NativeBrokerAdapter): Promise<void>
  quarantine(reason: Error): Promise<void>
}

export class NativeSessionLifecycle {
  #rotating = false
  constructor(readonly authority: NativeRotationAuthority) {}

  async rotate(current: NativeBrokerAdapter): Promise<NativeBrokerAdapter> {
    if (this.#rotating) throw new Error("Native generation rotation уже выполняется")
    this.#rotating = true
    let replacement: NativeBrokerAdapter | undefined
    try {
      const previous = current.generation
      if (previous === undefined) throw new Error("Rotation требует verified native handshake")
      const loadedBuildId = current.loadedBuildId
      const prepared = await this.authority.prepare(current)
      current.sealForRotation()
      const ack = await current.drain(prepared.request, prepared.control)
      if (!ack.accepted || ack.quarantined || ack.cleanup !== "complete" || ack.activeOperationIds.length !== 0) {
        throw new Error("Native rotation drain не подтвердил quiescence")
      }
      const state = current.sessionState
      if (state.pendingRequests || state.pendingBinaries || state.pendingLedgerWrites) {
        throw new Error("Native rotation получила новые pending resources во время drain")
      }
      await this.authority.retainAndAuthorize(current, ack)
      const retainedState = current.sessionState
      if (retainedState.pendingRequests || retainedState.pendingBinaries || retainedState.pendingLedgerWrites) {
        throw new Error("Native rotation получила pending resources до сохранения terminal receipts")
      }
      await current.close()
      replacement = await this.authority.createReplacement(previous, loadedBuildId)
      const next = replacement.generation
      if (next === undefined || next.nativeGeneration === previous.nativeGeneration
        || next.runtimeEpoch !== previous.runtimeEpoch || next.loginSessionId !== previous.loginSessionId
        || replacement.loadedBuildId !== loadedBuildId || replacement.adapterInstanceRef === current.adapterInstanceRef) {
        throw new Error("Native replacement не подтвердил новый instance/generation и прежний loaded build")
      }
      await this.authority.invalidateAndReinventory(previous, replacement)
      return replacement
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      await this.authority.quarantine(error)
      throw error
    } finally {
      this.#rotating = false
    }
  }
}
