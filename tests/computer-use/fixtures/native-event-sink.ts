import { createFixtureDeferred, type FixtureDeferred } from "./deferred"

export interface FixtureFence {
  runtimeEpoch: string
  nativeGeneration: string
  counter: number
}

export interface FixtureTargetState {
  focusRevision: number
  observationRevision: number
}

export interface FixtureNativeRequest {
  operationId: string
  fence: FixtureFence
  expectedTarget: FixtureTargetState
}

export interface FixtureNativeResult {
  dispatch: "none" | "attempted" | "finished" | "unknown"
  cleanup: "complete" | "unknown"
  errorCode?:
    | "target-stale"
    | "observation-stale"
    | "operation-outcome-unknown"
}

export class FakeNativeEventSink {
  readonly events: string[] = []
  activeDispatches = 0
  maxActiveDispatches = 0
  private beforeEvent?: FixtureDeferred<void>
  private afterEvent?: FixtureDeferred<void>
  private nextOutcome: FixtureNativeResult = {
    dispatch: "finished",
    cleanup: "complete"
  }

  holdBeforeEvent(): void {
    this.beforeEvent = createFixtureDeferred<void>()
  }

  releaseBeforeEvent(): void {
    this.beforeEvent?.resolve()
    this.beforeEvent = undefined
  }

  holdAfterEvent(): void {
    this.afterEvent = createFixtureDeferred<void>()
  }

  releaseAfterEvent(): void {
    this.afterEvent?.resolve()
    this.afterEvent = undefined
  }

  returnNext(outcome: FixtureNativeResult): void {
    this.nextOutcome = outcome
  }

  async dispatch(
    request: FixtureNativeRequest,
    readTarget: () => FixtureTargetState
  ): Promise<FixtureNativeResult> {
    this.activeDispatches += 1
    this.maxActiveDispatches = Math.max(
      this.maxActiveDispatches,
      this.activeDispatches
    )

    try {
      await this.beforeEvent?.promise

      const actual = readTarget()
      if (actual.focusRevision !== request.expectedTarget.focusRevision) {
        return {
          dispatch: "none",
          cleanup: "complete",
          errorCode: "target-stale"
        }
      }
      if (actual.observationRevision !== request.expectedTarget.observationRevision) {
        return {
          dispatch: "none",
          cleanup: "complete",
          errorCode: "observation-stale"
        }
      }

      this.events.push(`attempt:${request.operationId}`)
      await this.afterEvent?.promise
      const outcome = this.nextOutcome
      this.nextOutcome = { dispatch: "finished", cleanup: "complete" }
      return outcome
    } finally {
      this.activeDispatches -= 1
    }
  }
}
